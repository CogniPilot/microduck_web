import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readZip, parseXml, readModelDescription, readLayeredManifest, checkCoreIdentity, componentInterface, buildFmu,
  embeddedCoreModules, TRANSPILE_OPTIONS, writeBuildFiles, sourceHashes} from './build-fmu.mjs';
import {writeFile as writeFileAsync} from 'node:fs/promises';
import {packZip, standInFmu, standInDescription, layeredManifest, loadTranspiler, STANDIN_TOKEN} from './fmu-test-support.mjs';

const transpiler = await loadTranspiler();
const needsBuild = {skip: transpiler.skip};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('zip entries round-trip and a corrupted entry fails its CRC', () => {
  const zip = packZip({'a.txt': 'alpha', 'dir/b.bin': Uint8Array.of(0, 1, 2)});
  const entries = readZip(zip);
  assert.equal(new TextDecoder().decode(entries.get('a.txt')), 'alpha');
  assert.deepEqual([...entries.get('dir/b.bin')], [0, 1, 2]);
  const stored = packZip({'x': 'x'.repeat(100)});
  stored[40] ^= 0xff;
  assert.throws(() => readZip(stored), /build-fmu/);
  assert.throws(() => readZip(packZip({'../evil': 'x'})), /unsafe zip entry/);
});

test('XML subset: entities, comments, refusals', () => {
  const root = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; &#x41;"><b/><c y=\'2\'></c></a>');
  assert.equal(root.attributes.x, '1 & A');
  assert.deepEqual(root.children.map(child => child.name), ['b', 'c']);
  for (const bad of ['<a><b></a>', '<a/><b/>', '<a x="1" x="2"/>', '<!DOCTYPE a><a/>', '<a>'])
    assert.throws(() => parseXml(bad), /build-fmu/, bad);
});

test('model description: value references, causality, dimensions and starts', () => {
  const model = readModelDescription(standInDescription());
  assert.equal(model.instantiationToken, STANDIN_TOKEN);
  assert.equal(model.modelIdentifier, 'StandIn');
  assert.deepEqual(model.variables.map(v => [v.name, v.vr, v.causality]),
    [['time', 0, 'independent'], ['u', 1, 'input'], ['x', 2, 'output'], ['der(x)', 3, 'local'], ['xs', 4, 'output']]);
  assert.deepEqual(model.variables[4].dimensions, [8]);
  assert.deepEqual(model.variables[2].start, [1]);
  const variable = body => `<fmiModelDescription fmiVersion="3.0" modelName="M" instantiationToken="t"><CoSimulation modelIdentifier="M"/><ModelVariables>${body}</ModelVariables></fmiModelDescription>`;
  assert.deepEqual(readModelDescription(variable('<Boolean name="b" valueReference="1" causality="input" start="true false"><Dimension start="2"/></Boolean>')).variables[0].start, [1, 0]);
  assert.throws(() => readModelDescription(variable('<Float64 name="a" valueReference="1"/><Float64 name="b" valueReference="1"/>')), /duplicate valueReference/);
  // Integer starts keep their exact decimal form (H6).
  assert.deepEqual(readModelDescription(variable('<Int64 name="k" valueReference="1" start="9007199254740993 -9223372036854775808"><Dimension start="2"/></Int64>')).variables[0].start,
    ['9007199254740993', '-9223372036854775808']);
  assert.deepEqual(readModelDescription(variable('<UInt64 name="u" valueReference="1" start="18446744073709551615"/>')).variables[0].start, ['18446744073709551615']);
  assert.throws(() => readModelDescription(variable('<Int64 name="k" valueReference="1" start="1.5"/>')), /invalid start for k/);
  assert.throws(() => readModelDescription(variable('<Float64 name="a" valueReference="1"><Dimension valueReference="9"/></Float64>')), /structural/);
  assert.throws(() => readModelDescription(variable('').replace('fmiVersion="3.0"', 'fmiVersion="2.0"')), /not an FMI 3/);
  assert.throws(() => readModelDescription(variable('').replace(' instantiationToken="t"', '')), /instantiationToken/);
  assert.equal(readLayeredManifest(layeredManifest).version, '0.1.0');
  assert.throws(() => readLayeredManifest(layeredManifest.replace('org.modelica.fmi-ls-wasm', 'other')), /is not org.modelica/);
});

test('core identity is a bijection of hash multisets, duplicates included', () => {
  const a = Uint8Array.of(1), b = Uint8Array.of(2);
  checkCoreIdentity([a, a, b], [['m1', a], ['m2', b], ['m3', a]]);
  // Same members, same count, different multiplicities: membership alone would pass.
  assert.throws(() => checkCoreIdentity([a, a, b], [['m1', a], ['m2', b], ['m3', b]]), /m2, m3 .* 2x, inside the component 1x/);
  assert.throws(() => checkCoreIdentity([a, b], [['m1', a]]), new RegExp(`inside the component 1x sha256 ${sha256(b)}, emitted 0x`));
  assert.throws(() => checkCoreIdentity([a], [['m1', a], ['m2', Uint8Array.of(3)]]), /m2 .* inside the component 0x/);
});

test('component world: versioned imports in the allowed set, both FMI exports', () => {
  const world = items => `package root:component;\n\nworld root {\n${items.map(item => '  ' + item + ';').join('\n')}\n}\n`;
  const exports = ['export fmi:fmi3/common@3.0.0', 'export fmi:fmi3/co-simulation@3.0.0'];
  assert.deepEqual(componentInterface(world(['import wasi:io/poll@0.2.6', 'import fmi:fmi3/callbacks@3.0.0', ...exports])).imports,
    ['fmi:fmi3/callbacks@3.0.0', 'wasi:io/poll@0.2.6']);
  assert.throws(() => componentInterface(world(['import wasi:sockets/tcp@0.2.6', ...exports])), /outside the allowed set: wasi:sockets\/tcp@0.2.6/);
  assert.throws(() => componentInterface(world(['import wasi:io/poll@0.3.0', ...exports])), /outside the allowed set/);
  assert.throws(() => componentInterface(world(['import log: func()', ...exports])), /unsupported component world item/);
  assert.throws(() => componentInterface(world([exports[0]])), /does not export fmi:fmi3\/co-simulation/);
});

test('stand-in FMU: build output is bound to its inputs and byte-identical', needsBuild, async () => {
  const fmu = await standInFmu();
  const {index, indexFile, indexSha256, files} = await buildFmu(fmu, {transpiler, sources: {'A.mo': 'f'.repeat(64)}, sourceModel: 'A'});
  assert.equal(index.modelName, 'StandIn');
  assert.equal(index.instantiationToken, STANDIN_TOKEN);
  assert.equal(index.fmu.sha256, sha256(fmu));
  assert.equal(index.component.sha256, '055c1b22bf8c9e03264f71c8ed97a5bbd1e49de85d3a370452f766cacc45921e');
  assert.deepEqual(index.transpiler, {package: '@bytecodealliance/jco-transpile', version: '0.23.0', options: TRANSPILE_OPTIONS});
  assert.ok(index.imports.includes('wasi:cli/stderr@0.2.6') && index.imports.every(name => /@/.test(name)));
  assert.deepEqual(index.sources, {'A.mo': 'f'.repeat(64)});
  assert.equal(index.sourceModel, 'A');
  assert.equal(sha256(files.get(indexFile)), indexSha256);
  assert.match(indexFile, new RegExp(`^StandIn\\.fmu\\.${indexSha256.slice(0, 16)}\\.json$`));
  const component = readZip(fmu).get('binaries/wasm32-wasip2/StandIn.wasm');
  const embedded = embeddedCoreModules(component).map(sha256).sort();
  assert.deepEqual(Object.values(index.coreModules).map(entry => entry.sha256).sort(), embedded);
  for (const entry of [index.glue, ...Object.values(index.coreModules)]) {
    assert.equal(sha256(files.get(entry.file)), entry.sha256);
    assert.ok(entry.file.includes(entry.sha256.slice(0, 16)));
  }
});

// Two builds in separate processes (fresh transpiler state each) must write the same files,
// byte for byte, so the shipped glue is a function of the FMU and the pinned tool alone.
test('stand-in FMU: independent builds write byte-identical glue, cores and index', needsBuild, async () => {
  const {execFile} = await import('node:child_process');
  const {readFile: read} = await import('node:fs/promises');
  const work = await mkdtemp(path.join(tmpdir(), 'microduck-fmu-repro-'));
  const input = path.join(work, 'StandIn.fmu');
  await writeFileAsync(input, await standInFmu());
  const script = new URL('./build-fmu.mjs', import.meta.url).pathname;
  const build = out => new Promise((resolve, reject) => execFile(process.execPath,
    [script, input, path.join(work, out), ...(process.env.JCO_TRANSPILE ? ['--jco', process.env.JCO_TRANSPILE] : [])],
    {env: {...process.env, JCO_TRANSPILE: ''}}, (error, stdout, stderr) => error ? reject(Error(stderr || error.message)) : resolve()));
  await build('a');
  await build('b');
  const listing = async out => Object.fromEntries(await Promise.all((await readdir(path.join(work, out))).sort()
    .map(async file => [file, sha256(await read(path.join(work, out, file)))])));
  const [a, b] = [await listing('a'), await listing('b')];
  assert.ok(Object.keys(a).some(file => file.endsWith('.js')), 'a glue module was written');
  assert.deepEqual(b, a);
  await rm(work, {recursive: true, force: true});
});

test('stand-in FMU: a transpiler that alters or drops a core module fails the build', needsBuild, async () => {
  const fmu = await standInFmu();
  const altered = {...transpiler, transpileBytes: async (bytes, options) => {
    const result = await transpiler.transpileBytes(bytes, options);
    const name = Object.keys(result.files).find(file => file.endsWith('.core.wasm'));
    const changed = new Uint8Array(result.files[name]); changed[changed.length - 1] ^= 1;
    return {...result, files: {...result.files, [name]: changed}};
  }};
  await assert.rejects(buildFmu(fmu, {transpiler: altered}), /not byte-identical to the component: emitted fmu\.core\.wasm/);
  const dropped = {...transpiler, transpileBytes: async (bytes, options) => {
    const result = await transpiler.transpileBytes(bytes, options);
    const files = {...result.files}; delete files['fmu.core3.wasm'];
    return {...result, files};
  }};
  await assert.rejects(buildFmu(fmu, {transpiler: dropped}), /emitted 0x/);
});

test('stand-in FMU: missing parts of the archive fail the build', needsBuild, async () => {
  const component = readZip(await standInFmu()).get('binaries/wasm32-wasip2/StandIn.wasm');
  await assert.rejects(buildFmu(packZip({'modelDescription.xml': standInDescription(), 'binaries/wasm32-wasip2/StandIn.wasm': component}), {transpiler}), /no extra\/org.modelica.fmi-ls-wasm\/manifest.xml/);
  await assert.rejects(buildFmu(await standInFmu({description: standInDescription('Other')}), {transpiler}), /no binaries\/wasm32-wasip2\/Other.wasm/);
  await assert.rejects(buildFmu(await standInFmu({component: Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)}), {transpiler}), /not a WebAssembly component/);
});

test('output file names never come from an unchecked modelName (H3)', needsBuild, async () => {
  const safe = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
  const traversal = await buildFmu(await standInFmu({description: standInDescription().replace('modelName="StandIn"', 'modelName="../outside"')}), {transpiler});
  assert.equal(traversal.index.modelName, '../outside', 'the XML name is kept as metadata');
  for (const file of traversal.files.keys()) { assert.match(file, safe); assert.ok(!file.includes('..') && file.startsWith('model.'), file); }
  const qualified = await buildFmu(await standInFmu({description: standInDescription().replace('modelName="StandIn"', 'modelName="Microduck.Walking"')}), {transpiler});
  for (const file of qualified.files.keys()) assert.ok(file.startsWith('Microduck.Walking.') && safe.test(file), file);
  // Containment is checked again when writing, whatever the names.
  const root = await mkdtemp(path.join(tmpdir(), 'microduck-fmu-out-'));
  try {
    const out = path.join(root, 'out');
    for (const name of ['../outside.json', 'sub/x.wasm', '/abs.js', '..', ''])
      await assert.rejects(writeBuildFiles(out, new Map([[name, Uint8Array.of(1)]])), /build-fmu: unsafe output file name/, name);
    assert.deepEqual(await readdir(root), [], 'nothing was written');
    await writeBuildFiles(out, traversal.files);
    assert.deepEqual((await readdir(out)).sort(), [...traversal.files.keys()].sort());
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a source set must be non-empty and contain the model it was built from (H5)', needsBuild, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'microduck-fmu-sources-'));
  try {
    await writeFileAsync(path.join(root, 'manifest.json'), '[]');
    await assert.rejects(sourceHashes(root), /empty sources manifest/);
    await writeFileAsync(path.join(root, 'manifest.json'), '["A.mo"]');
    await writeFileAsync(path.join(root, 'A.mo'), 'model A end A;');
    assert.deepEqual(Object.keys(await sourceHashes(root)), ['A.mo']);
  } finally { await rm(root, {recursive: true, force: true}); }
  const fmu = await standInFmu();
  await assert.rejects(buildFmu(fmu, {transpiler, sources: {'A.mo': 'f'.repeat(64)}}), /needs the model it was built from/);
  await assert.rejects(buildFmu(fmu, {transpiler, sources: {'A.mo': 'f'.repeat(64)}, sourceModel: 'B'}), /B.mo is not in the source set/);
  await assert.rejects(buildFmu(fmu, {transpiler, sources: {}, sourceModel: 'A'}), /empty source set/);
});
