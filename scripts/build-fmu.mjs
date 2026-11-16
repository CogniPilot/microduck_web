import {pageBuildInputs} from './fmu-page-inputs.mjs';
// Build step: an FMI 3 Layered-Standard WebAssembly FMU (.fmu) -> the files the page serves.
//
//   node scripts/build-fmu.mjs <model.fmu> <out-dir> [--sources <site/sources> --source-model <Class>] [--jco <jco-transpile dist/index.js>]
//
// Reads modelDescription.xml and the fmi-ls-wasm manifest, transpiles the co-simulation
// component with @bytecodealliance/jco-transpile (async instantiation, multi-memory, no
// optimiser, no JS translation of core modules), checks that every emitted core module is
// byte-identical to the one embedded in the component (a pre-initialised memory image must
// travel unchanged), and writes content-hashed files plus one JSON index that the worker
// loads (model name, instantiation token, files, value-reference table). Any mismatch
// fails the build; nothing is written unless every check passes.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inflateRawSync, crc32} from 'node:zlib';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const JCO_TRANSPILE_VERSION = '0.23.0';
export const LS_NAME = 'org.modelica.fmi-ls-wasm';
export const INDEX_SCHEMA = 1;
// The component imports the page may satisfy: the FMI callbacks and the WASI p2 interfaces
// of the fmi-ls-wasm target. The session provides stdout/stderr and insecure-seed and
// traps every other WASI function; anything outside this set fails the build.
export const ALLOWED_IMPORTS = Object.freeze({
  fmi: {version: /^3\.0\.0$/, interfaces: ['fmi:fmi3/types', 'fmi:fmi3/callbacks', 'fmi:fmi3/intermediate-update-callbacks']},
  wasi: {version: /^0\.2\.[0-9]+$/, interfaces: ['wasi:cli/environment', 'wasi:cli/exit', 'wasi:cli/stdin', 'wasi:cli/stdout',
    'wasi:cli/stderr', 'wasi:cli/terminal-input', 'wasi:cli/terminal-output', 'wasi:cli/terminal-stdin', 'wasi:cli/terminal-stdout',
    'wasi:cli/terminal-stderr', 'wasi:clocks/monotonic-clock', 'wasi:clocks/wall-clock', 'wasi:filesystem/types',
    'wasi:filesystem/preopens', 'wasi:io/error', 'wasi:io/poll', 'wasi:io/streams', 'wasi:random/insecure-seed']},
});
export const REQUIRED_EXPORTS = Object.freeze(['fmi:fmi3/common@3.0.0', 'fmi:fmi3/co-simulation@3.0.0']);
export const TRANSPILE_OPTIONS = Object.freeze({instantiation: 'async', multiMemory: true, minify: true,
  base64Cutoff: 0, wasiShim: false, optimize: false, js: false, emitTypescriptDeclarations: false});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Error('build-fmu: ' + message); };

// ---- zip (the FMU container): stored and deflated entries, CRC and sizes checked ----
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--)
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) fail('not a zip archive (no end of central directory)');
  const count = view.getUint16(end + 10, true), directory = view.getUint32(end + 16, true);
  if (count === 0xffff || directory === 0xffffffff) fail('zip64 archives are not supported');
  const entries = new Map();
  for (let i = 0, p = directory; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) fail('corrupt zip central directory');
    const flags = view.getUint16(p + 8, true), method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true), compressed = view.getUint32(p + 20, true), size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    if (flags & 1) fail('encrypted zip entry: ' + name);
    if (name.startsWith('/') || name.split('/').some(part => part === '..' || part === '') || name.includes('\\'))
      fail('unsafe zip entry name: ' + name);
    if (entries.has(name)) fail('duplicate zip entry: ' + name);
    if (view.getUint32(local, true) !== 0x04034b50) fail('corrupt zip local header: ' + name);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressed);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : fail(`zip method ${method} for ${name}`);
    if (data.length !== size || crc32(data) !== crc) fail('zip entry fails its size or CRC check: ' + name);
    entries.set(name, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return entries;
}

// ---- XML: the subset FMI descriptions use (elements, attributes, comments, entities) ----
const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
const unescape = text => text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name) =>
  name[0] === '#' ? String.fromCodePoint(Number(name[1] === 'x' ? '0' + name.slice(1) : name.slice(1)))
    : ENTITIES[name] ?? fail('unknown XML entity ' + whole));
export function parseXml(text) {
  const root = {name: '#document', attributes: {}, children: []}, stack = [root];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open < 0) { if (text.slice(i).trim()) fail('XML text outside elements'); break; }
    if (text.slice(i, open).trim() && stack.length === 1) fail('XML text outside the root element');
    if (text.startsWith('<?', open)) { i = text.indexOf('?>', open) + 2; if (i < 2) fail('unclosed XML declaration'); continue; }
    if (text.startsWith('<!--', open)) { i = text.indexOf('-->', open) + 3; if (i < 3) fail('unclosed XML comment'); continue; }
    if (text.startsWith('<!', open)) fail('XML DTD and CDATA are not supported');
    const close = text.indexOf('>', open);
    if (close < 0) fail('unclosed XML tag');
    const tag = text.slice(open + 1, close);
    i = close + 1;
    if (tag.startsWith('/')) {
      const element = stack.pop();
      if (stack.length === 0 || element.name !== tag.slice(1).trim()) fail('mismatched XML end tag </' + tag.slice(1) + '>');
      continue;
    }
    const selfClosing = tag.endsWith('/'), body = selfClosing ? tag.slice(0, -1) : tag;
    const name = body.match(/^[^\s/>]+/)?.[0] ?? fail('empty XML tag');
    const element = {name, attributes: {}, children: []};
    const rest = body.slice(name.length);
    const attribute = /\s*([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/gy;
    let match, consumed = 0;
    while ((match = attribute.exec(rest))) {
      if (Object.hasOwn(element.attributes, match[1])) fail('duplicate XML attribute ' + match[1]);
      element.attributes[match[1]] = unescape(match[3] ?? match[4]);
      consumed = attribute.lastIndex;
    }
    if (rest.slice(consumed).trim()) fail('malformed XML attributes in <' + name + '>');
    if (stack.length === 1 && root.children.length) fail('XML has more than one root element');
    stack.at(-1).children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 1 || root.children.length !== 1) fail('XML must have exactly one closed root element');
  return root.children[0];
}

// ---- modelDescription.xml -> name, token, value-reference table ----
const FMI_TYPES = new Set(['Float32', 'Float64', 'Int8', 'UInt8', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64',
  'UInt64', 'Boolean', 'String', 'Binary', 'Enumeration', 'Clock']);
const CAUSALITIES = new Set(['parameter', 'calculatedParameter', 'input', 'output', 'local', 'independent', 'structuralParameter']);
export function readModelDescription(text) {
  const root = parseXml(text);
  if (root.name !== 'fmiModelDescription') fail('modelDescription.xml root is not fmiModelDescription');
  const {fmiVersion, modelName, instantiationToken} = root.attributes;
  if (!/^3\./.test(fmiVersion ?? '')) fail('not an FMI 3 model description: fmiVersion ' + fmiVersion);
  if (!modelName) fail('modelDescription.xml has no modelName');
  if (!instantiationToken) fail('modelDescription.xml has no instantiationToken');
  const coSimulation = root.children.filter(child => child.name === 'CoSimulation');
  if (coSimulation.length !== 1 || !coSimulation[0].attributes.modelIdentifier) fail('the FMU must declare one CoSimulation interface with a modelIdentifier');
  const modelVariables = root.children.filter(child => child.name === 'ModelVariables');
  if (modelVariables.length !== 1) fail('modelDescription.xml must have one ModelVariables element');
  const names = new Set(), references = new Set();
  const variables = modelVariables[0].children.map(element => {
    const {name, valueReference, causality = 'local', variability, start, initial, derivative} = element.attributes;
    if (!FMI_TYPES.has(element.name)) fail('unknown FMI variable type <' + element.name + '>');
    if (!name) fail('variable without a name');
    if (!/^(0|[1-9][0-9]*)$/.test(valueReference ?? '') || Number(valueReference) > 0xffffffff) fail('invalid valueReference for ' + name);
    if (!CAUSALITIES.has(causality)) fail(`unknown causality ${causality} for ${name}`);
    if (names.has(name)) fail('duplicate variable name ' + name);
    if (references.has(valueReference)) fail('duplicate valueReference ' + valueReference);
    names.add(name); references.add(valueReference);
    const dimensions = element.children.filter(child => child.name === 'Dimension').map(dimension => {
      const extent = dimension.attributes.start;
      if (!/^[1-9][0-9]*$/.test(extent ?? '')) fail(`variable ${name} has a dimension without a fixed positive start (structural parameters are not supported)`);
      return Number(extent);
    });
    const variable = {name, vr: Number(valueReference), type: element.name, causality,
      variability: variability ?? (/^Float/.test(element.name) ? 'continuous' : 'discrete')};
    if (initial) variable.initial = initial;
    if (dimensions.length) variable.dimensions = dimensions;
    if (derivative !== undefined) variable.derivative = Number(derivative);
    if (start !== undefined && element.name !== 'String' && element.name !== 'Binary') {
      // Integer starts keep their exact decimal form (a string); Boolean starts are 0/1.
      const integer = /^(U?Int(8|16|32|64)|Enumeration)$/.test(element.name);
      variable.start = start.trim().split(/\s+/).map(value => element.name === 'Boolean'
        ? (value === 'true' || value === '1' ? 1 : value === 'false' || value === '0' ? 0 : fail(`invalid Boolean start for ${name}`))
        : integer ? (/^[+-]?[0-9]+$/.test(value) ? BigInt(value).toString() : fail(`invalid start for ${name}`))
        : Number.isFinite(Number(value)) ? Number(value) : fail(`invalid start for ${name}`));
      const count = dimensions.reduce((product, extent) => product * extent, 1);
      if (variable.start.length !== 1 && variable.start.length !== count) fail(`start of ${name} has ${variable.start.length} values for ${count} elements`);
    }
    return variable;
  });
  const experiment = root.children.find(child => child.name === 'DefaultExperiment')?.attributes ?? {};
  const defaultExperiment = Object.fromEntries(['startTime', 'stopTime', 'stepSize', 'tolerance']
    .filter(key => experiment[key] !== undefined).map(key => [key, Number(experiment[key])]));
  return {fmiVersion, modelName, instantiationToken, modelIdentifier: coSimulation[0].attributes.modelIdentifier,
    defaultExperiment, variables};
}

export function readLayeredManifest(text) {
  const root = parseXml(text);
  if (root.name.replace(/^[^:]*:/, '') !== 'fmiLayeredStandardManifest') fail('the layered-standard manifest has the wrong root element');
  const attribute = key => Object.entries(root.attributes).find(([name]) => name.replace(/^[^:]*:/, '') === key)?.[1];
  if (attribute('fmi-ls-name') !== LS_NAME) fail(`layered standard ${attribute('fmi-ls-name')} is not ${LS_NAME}`);
  return {name: LS_NAME, version: attribute('fmi-ls-version') ?? fail('layered-standard manifest has no version')};
}

// The component's world, as the pinned tool prints it: versioned imports and exports,
// each checked against the allowed set.
export function componentInterface(wit) {
  const world = wit.match(/world\s+[\w-]+\s*\{([^}]*)\}/)?.[1] ?? fail('cannot read the component world');
  const imports = [], exports = [];
  for (const line of world.split('\n').map(text => text.trim()).filter(Boolean)) {
    const match = line.match(/^(import|export)\s+([a-z0-9-]+:[a-z0-9-]+\/[a-z0-9-]+)@([0-9][0-9A-Za-z.+-]*);$/);
    if (!match) fail('unsupported component world item: ' + line);
    (match[1] === 'import' ? imports : exports).push(match[2] + '@' + match[3]);
  }
  for (const name of imports) {
    const [iface, version] = name.split('@'), family = ALLOWED_IMPORTS[iface.split(':')[0]];
    if (!family?.interfaces.includes(iface) || !family.version.test(version)) fail('component import outside the allowed set: ' + name);
  }
  for (const name of REQUIRED_EXPORTS) if (!exports.includes(name)) fail('component does not export ' + name);
  return {imports: imports.sort(), exports: exports.sort()};
}

// ---- component: every embedded core module, in order, through nested components ----
function leb(bytes, position) {
  let value = 0, shift = 0, byte;
  do { byte = bytes[position++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return [value, position];
}
export function embeddedCoreModules(bytes, modules = []) {
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d || (bytes[6] | (bytes[7] << 8)) !== 1)
    fail('the FMU binary is not a WebAssembly component');
  for (let position = 8; position < bytes.length;) {
    const id = bytes[position];
    const [size, start] = leb(bytes, position + 1);
    if (start + size > bytes.length) fail('truncated component section');
    if (id === 1) modules.push(bytes.subarray(start, start + size));
    else if (id === 4) embeddedCoreModules(bytes.subarray(start, start + size), modules);
    position = start + size;
  }
  return modules;
}

// Byte identity as a bijection: the multiset of emitted core-module hashes must equal the
// multiset of hashes of the modules embedded in the component, duplicates included.
export function checkCoreIdentity(embedded, emitted) {
  const count = list => list.reduce((map, hash) => map.set(hash, (map.get(hash) ?? 0) + 1), new Map());
  const inside = count(embedded.map(bytes => sha256(bytes))), outside = count(emitted.map(([, bytes]) => sha256(bytes)));
  const problems = [];
  for (const [hash, n] of outside) if ((inside.get(hash) ?? 0) !== n)
    problems.push(`emitted ${emitted.filter(([, b]) => sha256(b) === hash).map(([name]) => name).join(', ')} (sha256 ${hash}) ${n}x, inside the component ${inside.get(hash) ?? 0}x`);
  for (const [hash, n] of inside) if (!outside.has(hash))
    problems.push(`inside the component ${n}x sha256 ${hash}, emitted 0x`);
  if (problems.length) fail('core modules are not byte-identical to the component: ' + problems.join('; '));
}

async function loadTranspiler(entry) {
  const specifier = entry ?? process.env.JCO_TRANSPILE ?? '@bytecodealliance/jco-transpile';
  const url = /^[./]/.test(specifier) ? pathToFileURL(path.resolve(specifier)).href : specifier;
  let library;
  try { library = await import(url); }
  catch (error) { fail(`cannot load ${specifier} (${error.message}); pass --jco <@bytecodealliance/jco-transpile ${JCO_TRANSPILE_VERSION} dist/index.js> or set JCO_TRANSPILE`); }
  let version;
  try {
    const packageUrl = new URL('../package.json', import.meta.resolve ? import.meta.resolve(url) : url);
    version = JSON.parse(await readFile(packageUrl, 'utf8')).version;
  } catch { version = undefined; }
  if (version !== JCO_TRANSPILE_VERSION) fail(`jco-transpile ${version ?? '(unknown version)'} is not the pinned ${JCO_TRANSPILE_VERSION}`);
  if (typeof library.transpileBytes !== 'function') fail('jco-transpile has no transpileBytes');
  // componentWit is the same library's wasm-tools build, beside its entry module.
  const tools = await import(new URL('./wasm-tools.js', import.meta.resolve(url)).href);
  if (typeof tools.componentWit !== 'function') fail('jco-transpile has no componentWit');
  return {transpileBytes: library.transpileBytes, componentWit: tools.componentWit, version};
}

// Output names: the model name only when it is a plain Modelica (qualified) identifier,
// else the fixed name 'model'. The XML modelName itself is kept in the index.
const MODEL_FILE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
export const outputBasename = modelName => MODEL_FILE_NAME.test(modelName) && modelName.length <= 100 ? modelName : 'model';
const SAFE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

// Write the build into outDir, each file a plain name inside it (checked again here).
export async function writeBuildFiles(outDir, files) {
  const root = path.resolve(outDir);
  for (const name of files.keys())
    if (!SAFE_FILE.test(name) || name.includes('..') || path.dirname(path.resolve(root, name)) !== root) fail('unsafe output file name ' + JSON.stringify(name));
  await mkdir(root, {recursive: true});
  for (const [name, bytes] of files) await writeFile(path.join(root, name), bytes);
}

const hashed = (file, bytes) => {
  const extension = path.extname(file);
  return `${file.slice(0, -extension.length)}.${sha256(bytes).slice(0, 16)}${extension}`;
};

// Returns {index, indexFile, files: Map(name -> bytes)} without writing anything.
export async function buildFmu(fmuBytes, {sources, sourceModel, pageBinding, jco, transpiler, nativeAdmission} = {}) {
  if (sources !== undefined) {
    if (!sources || typeof sources !== 'object' || !Object.keys(sources).length) fail('empty source set');
    if (typeof sourceModel !== 'string' || !MODEL_FILE_NAME.test(sourceModel)) fail('a source set needs the model it was built from (--source-model)');
    if (!Object.hasOwn(sources, sourceModel + '.mo')) fail(`${sourceModel}.mo is not in the source set`);
  }
  const entries = readZip(fmuBytes);
  const description = entries.get('modelDescription.xml') ?? fail('the FMU has no modelDescription.xml');
  const manifest = entries.get(`extra/${LS_NAME}/manifest.xml`) ?? fail(`the FMU has no extra/${LS_NAME}/manifest.xml`);
  const model = readModelDescription(new TextDecoder('utf-8', {fatal: true}).decode(description));
  const layered = readLayeredManifest(new TextDecoder('utf-8', {fatal: true}).decode(manifest));
  const binary = `binaries/wasm32-wasip2/${model.modelIdentifier}.wasm`;
  const component = entries.get(binary) ?? fail(`the FMU has no ${binary}`);
  const embedded = embeddedCoreModules(component);
  if (!embedded.length) fail('the component embeds no core module');

  const {transpileBytes, componentWit, version} = transpiler ?? await loadTranspiler(jco);
  const world = componentInterface(await componentWit(component));
  const id = 'fmu';
  const result = await transpileBytes(component, {name: id, ...TRANSPILE_OPTIONS});
  const emitted = Object.entries(result.files).map(([name, bytes]) => [name, new Uint8Array(bytes)]);
  const glue = emitted.filter(([name]) => name === id + '.js');
  const cores = emitted.filter(([name]) => name.endsWith('.wasm'));
  const unversioned = world.imports.map(name => name.replace(/@[^@]*$/, '')).sort();
  if (result.imports.some(name => !unversioned.includes(name))) fail('the glue imports differ from the component world: ' + result.imports.join(', '));
  const unexpected = emitted.filter(([name]) => name !== id + '.js' && !name.endsWith('.wasm'));
  if (glue.length !== 1) fail('the transpiler emitted no glue module');
  if (unexpected.length) fail('the transpiler emitted unexpected files: ' + unexpected.map(([name]) => name).join(', '));

  checkCoreIdentity(embedded, cores);

  const files = new Map(), coreModules = {}, base = outputBasename(model.modelName);
  for (const [name, bytes] of cores) {
    const file = hashed(`${base}.${name}`, bytes);
    files.set(file, bytes);
    coreModules[name] = {file, bytes: bytes.length, sha256: sha256(bytes)};
  }
  const glueFile = hashed(`${base}.js`, glue[0][1]);
  files.set(glueFile, glue[0][1]);
  const index = {
    schema: INDEX_SCHEMA, format: 'fmi3-ls-wasm-transpiled', layeredStandard: layered,
    modelName: model.modelName, instantiationToken: model.instantiationToken, modelIdentifier: model.modelIdentifier,
    fmiVersion: model.fmiVersion, defaultExperiment: model.defaultExperiment,
    fmu: {bytes: fmuBytes.length, sha256: sha256(fmuBytes)},
    component: {bytes: component.length, sha256: sha256(component), coreModules: embedded.length},
    transpiler: {package: '@bytecodealliance/jco-transpile', version, options: TRANSPILE_OPTIONS},
    glue: {file: glueFile, bytes: glue[0][1].length, sha256: sha256(glue[0][1])},
    coreModules, imports: world.imports, exports: world.exports,
    variables: model.variables,
  };
  if (sources) Object.assign(index, {sourceModel, sources});
  if (pageBinding) {
    if (model.modelName !== pageBinding.model || sourceModel !== pageBinding.model ||
        Object.keys(sources ?? {}).length !== pageBinding.sourceCount)
      fail('the whole-page FMU model/source count differs from its producer binding');
    index.pageBinding = pageBinding;
  }
  if (nativeAdmission) {
    if (!pageBinding || nativeAdmission.schema !== 1 ||
        nativeAdmission.archiveSha256 !== index.fmu.sha256 ||
        nativeAdmission.componentSha256 !== index.component.sha256 ||
        nativeAdmission.modelDescriptionSha256 !== sha256(description) ||
        nativeAdmission.sourceCount !== pageBinding.sourceCount ||
        nativeAdmission.optionsSha256 !== pageBinding.optionsSha256)
      fail('native admission does not match this artifact/page binding');
    for (const key of ['bindingSha256','smokeSha256','publicIoSha256','exportSha256','sourceSetSha256'])
      if (!/^[0-9a-f]{64}$/.test(nativeAdmission[key] ?? '')) fail('invalid native admission ' + key);
    index.nativeAdmission = nativeAdmission;
  }
  const json = new TextEncoder().encode(JSON.stringify(index, null, 1) + '\n');
  const indexFile = hashed(`${base}.fmu.json`, json);
  files.set(indexFile, json);
  return {index, indexFile, indexSha256: sha256(json), files};
}

// Hashes of ALL the page's Modelica sources, by sources/manifest.json. The worker uses the FMU
// only while the page's source set is exactly this set with these bytes. This records the
// producer's claim; it does not prove that the FMU was compiled from these files.
export async function sourceHashes(directory) {
  const names = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) fail('invalid sources manifest');
  if (!names.length) fail('empty sources manifest');
  const hashes = {};
  for (const name of names) hashes[name] = sha256(await readFile(path.join(directory, name)));
  return hashes;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2), option = name => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const [, value] = args.splice(at, 2);
    return value ?? fail(name + ' needs a value');
  };
  const sourcesDirectory = option('--sources'), sourceModel = option('--source-model'), jco = option('--jco'), pageSite = option('--page-site');
  if (pageSite && (sourcesDirectory || sourceModel)) fail('--page-site owns the full source/model binding; do not combine it with --sources/--source-model');
  const [input, outDir] = args;
  if (!input || !outDir || args.length !== 2) fail('usage: build-fmu.mjs <model.fmu> <out-dir> [--page-site <site> | --sources <dir> --source-model <Class>] [--jco <dist/index.js>]');
  const started = performance.now();
  const {index, indexFile, indexSha256, files} = await buildFmu(new Uint8Array(await readFile(input)),
    {jco, ...(pageSite ? await pageBuildInputs(pageSite) :
      {sourceModel, sources: sourcesDirectory ? await sourceHashes(sourcesDirectory) : undefined})});
  await writeBuildFiles(outDir, files);
  // The page manifest entry (prebuilt/manifest.json models.<model>.fmu), with paths relative to prebuilt/.
  const manifestEntry = {index: path.relative('.', path.join(path.basename(outDir), indexFile)), sha256: indexSha256};
  console.log(JSON.stringify({manifest_entry: manifestEntry, index: indexFile, modelName: index.modelName, instantiationToken: index.instantiationToken,
    files: [...files].map(([file, bytes]) => ({file, bytes: bytes.length})), imports: index.imports,
    core_modules_identical: true, build_ms: Math.round(performance.now() - started)}, null, 1));
}
