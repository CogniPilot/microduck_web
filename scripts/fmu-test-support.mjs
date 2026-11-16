// Shared by the FMU tests: pack a component as an FMI 3 LS wasm .fmu, build it with
// scripts/build-fmu.mjs, and serve the output to site/fmu-session.js from disk.
//
// The build needs @bytecodealliance/jco-transpile 0.23.0 (scripts/fmu-build-dependencies.json):
// set JCO_TRANSPILE to its dist/index.js when it is not installed beside the repository.
// Tests that need it skip with that reason when it cannot be loaded.
import {readFile, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {deflateRawSync, crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {buildFmu, writeBuildFiles} from './build-fmu.mjs';

export const fixtures = fileURLToPath(new URL('./fixtures/fmu/', import.meta.url));
export const STANDIN_TOKEN = 'standin-decay-0001';

// The stand-in component's model, as its source documents it: VR 0 time, VR 1 input u,
// VR 2 state x (der(x) = -x + u, x(0) = 1), VR 3 der(x), VR 4 output xs[8] = k * x.
export const standInDescription = (identifier = 'StandIn') => `<?xml version="1.0" encoding="UTF-8"?>
<fmiModelDescription fmiVersion="3.0" modelName="StandIn" generationTool="test" instantiationToken="${STANDIN_TOKEN}">
  <CoSimulation modelIdentifier="${identifier}" canHandleVariableCommunicationStepSize="true"/>
  <!-- a comment -->
  <ModelVariables>
    <Float64 name="time" valueReference="0" causality="independent" variability="continuous"/>
    <Float64 name="u" valueReference="1" causality="input" variability="continuous" start="0"/>
    <Float64 name="x" valueReference="2" causality="output" variability="continuous" initial="exact" start="1"/>
    <Float64 name="der(x)" valueReference="3" causality="local" variability="continuous" derivative="2"/>
    <Float64 name="xs" valueReference="4" causality="output" variability="continuous">
      <Dimension start="8"/>
    </Float64>
  </ModelVariables>
</fmiModelDescription>
`;
export const layeredManifest = `<?xml version="1.0" encoding="UTF-8"?>
<fmi-ls:fmiLayeredStandardManifest xmlns:fmi-ls="http://fmi-standard.org/fmi-ls-manifest"
  fmi-ls:fmi-ls-name="org.modelica.fmi-ls-wasm" fmi-ls:fmi-ls-version="0.1.0"/>
`;

// A plain zip (deflated entries) of name -> bytes|string.
export function packZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    const packed = deflateRawSync(data), nameBytes = Buffer.from(name), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(header, nameBytes, packed);
    central.push(record, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

export async function standInFmu({description = standInDescription(), component} = {}) {
  component ??= await readFile(path.join(fixtures, 'standin.wasm'));
  return packZip({'modelDescription.xml': description, 'extra/org.modelica.fmi-ls-wasm/manifest.xml': layeredManifest,
    'binaries/wasm32-wasip2/StandIn.wasm': component});
}

let transpiler;
// The pinned transpiler, or a skip reason.
export async function loadTranspiler() {
  if (transpiler) return transpiler;
  const specifier = process.env.JCO_TRANSPILE ?? '@bytecodealliance/jco-transpile';
  try {
    const url = /^[./]/.test(specifier) ? pathToFileURL(path.resolve(specifier)).href : import.meta.resolve(specifier);
    const library = await import(url), tools = await import(new URL('./wasm-tools.js', url).href);
    const {version} = JSON.parse(await readFile(new URL('../package.json', url), 'utf8'));
    return transpiler = {transpileBytes: library.transpileBytes, componentWit: tools.componentWit, version};
  } catch (error) {
    return {skip: `jco-transpile is not available (${error.code ?? error.message}); set JCO_TRANSPILE`};
  }
}

// Build into a fresh temporary directory; returns {dir, index, indexFile, indexSha256}.
export async function buildToDirectory(fmuBytes, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'microduck-fmu-'));
  const built = await buildFmu(fmuBytes, {transpiler: await loadTranspiler(), ...options});
  await writeBuildFiles(dir, built.files);
  return {dir, ...built};
}

// fetch for file: URLs (Node's fetch has none), with the content types a server sends.
export async function fileFetch(url) {
  const file = fileURLToPath(url);
  try {
    const bytes = await readFile(file);
    const type = file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/json';
    return new Response(bytes, {headers: {'content-type': type}});
  } catch { return new Response(null, {status: 404}); }
}

export const bits = value => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true).toString(16).padStart(16, '0');
};

// A build directory whose "glue" is a scripted fake component (no core modules), for host
// contracts no real guest exercises on demand. `instance` is the body of a class extending
// FakeInstance; scripts reach test state through globalThis.fakeFmu, and the host's import
// object, for the recorded `imports`, through globalThis.fakeFmu.imports.
export async function fakeFmuDirectory({variables, instance = '', imports = []}) {
  const glue = `class FakeInstance {
  constructor() { this.values = new Map(); globalThis.fakeFmu.instances.push(this); }
  log(call) { globalThis.fakeFmu.calls.push(call); }
  enterInitializationMode() { return 'ok'; } exitInitializationMode() { return 'ok'; }
  reset() { return 'ok'; } terminate() { return 'ok'; } [Symbol.dispose]() {}
  doStep(current, step) { this.log(['doStep', current, step]); return {lastSuccessfulTime: current + step, eventHandlingNeeded: false, terminateSimulation: false, earlyReturn: false}; }
  get(refs, make) { return make(Array.from(refs).flatMap(vr => this.values.get(vr) ?? [make === Array.from ? false : 0])); }
  set(type, refs, values) { this.log(['set' + type, [...refs], [...values]]); let at = 0; for (const vr of refs) { const n = (this.values.get(vr) ?? [0]).length; this.values.set(vr, Array.from(values).slice(at, at + n)); at += n; } return 'ok'; }
  getFloat64(refs) { return this.get(refs, v => Float64Array.from(v)); } setFloat64(refs, v) { return this.set('Float64', refs, v); }
  getInt64(refs) { return this.get(refs, v => BigInt64Array.from(v, x => BigInt(x))); } setInt64(refs, v) { return this.set('Int64', refs, v); }
  getBoolean(refs) { return this.get(refs, Array.from); } setBoolean(refs, v) { return this.set('Boolean', refs, v); }
}
class Instance extends FakeInstance {
${instance}
}
export async function instantiate(getCoreModule, imports) {
  globalThis.fakeFmu.imports = imports;
  return {common: {getVersion: () => '3.0'}, coSimulation: {CoSimulationInstance: {instantiateCoSimulation: () => new Instance()}}};
}
`;
  const dir = await mkdtemp(path.join(tmpdir(), 'microduck-fmu-fake-'));
  const glueBytes = new TextEncoder().encode(glue);
  const sha = bytes => Buffer.from(createHash('sha256').update(bytes).digest()).toString('hex');
  const index = {schema: 1, format: 'fmi3-ls-wasm-transpiled', modelName: 'Fake', instantiationToken: 'fake',
    glue: {file: 'fake.js', bytes: glueBytes.length, sha256: sha(glueBytes)}, coreModules: {}, imports, variables};
  const json = new TextEncoder().encode(JSON.stringify(index));
  await writeFile(path.join(dir, 'fake.js'), glueBytes);
  await writeFile(path.join(dir, 'fake.fmu.json'), json);
  globalThis.fakeFmu = {instances: [], calls: []};
  return {dir, index, indexFile: 'fake.fmu.json', indexSha256: sha(json)};
}
