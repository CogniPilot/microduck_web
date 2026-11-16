import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {openFmuSession, preloadFmu, loadFmuIndex, scalarTable, offeredFmu, checkSimulationInterface, FmuFault, INSECURE_SEED,
  SIMULATION_INPUTS, SIMULATION_OUTPUTS} from '../site/fmu-session.js';
import {fixtures, standInFmu, buildToDirectory, loadTranspiler, fileFetch, bits, fakeFmuDirectory} from './fmu-test-support.mjs';

const transpiler = await loadTranspiler();
const needsBuild = {skip: transpiler.skip};
const reference = JSON.parse(await readFile(path.join(fixtures, 'standin-wasmtime-trace.json'), 'utf8'));

let built;
const standIn = async () => built ??= await buildToDirectory(await standInFmu());
const quiet = () => { const lines = []; return {lines, log: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line)}; };
async function open(build = built, options = {}) {
  const base = pathToFileURL(build.dir + '/');
  const index = await loadFmuIndex(new URL(build.indexFile, base), build.indexSha256, {fetch: fileFetch});
  return openFmuSession({index, base, fetch: fileFetch, console: quiet(), ...options});
}
// The Wasmtime fixture's trace: do-step(t, 0.1) five times, a row of the given names at each point.
function trace(session, names, dt = 0.1, steps = 5) {
  const read = session.bind_outputs(JSON.stringify(names)), rows = [];
  const row = () => ({time: session.time(), bits: [...session.read_bound(read)].map(bits)});
  rows.push(row());
  for (let i = 0; i < steps; i++) { session.step(dt); rows.push(row()); }
  return rows;
}

test('array variables expand to row-major element names', () => {
  const table = scalarTable([{name: 'R', vr: 7, type: 'Float64', causality: 'output', dimensions: [2, 3]}, {name: 'a', vr: 1, type: 'Boolean', causality: 'input'}]);
  assert.deepEqual([...table.keys()], ['R[1,1]', 'R[1,2]', 'R[1,3]', 'R[2,1]', 'R[2,2]', 'R[2,3]', 'a']);
  assert.equal(table.get('R[2,1]').offset, 3);
  assert.throws(() => scalarTable([{name: 'v', vr: 1, dimensions: [1]}, {name: 'v[1]', vr: 2}]), /collide/);
});

test('stand-in: every traced value is bit-identical to the Wasmtime reference', needsBuild, async () => {
  await standIn();
  const session = await open();
  const rows = trace(session, reference.provenance.names);
  assert.deepEqual(rows, reference.rows);
  session.free();
});

test('stand-in: arrays, inputs, state_json and receipt follow the model', needsBuild, async () => {
  await standIn();
  const session = await open();
  const write = session.bind_inputs(JSON.stringify(['u']));
  session.write_bound(write, Float64Array.of(1));
  session.advance_to(0.02);
  const state = JSON.parse(session.state_json());
  assert.equal(state.time, 0.02);
  assert.deepEqual(Object.keys(state.values), ['x', 'der(x)', ...Array.from({length: 8}, (_, i) => `xs[${i + 1}]`)]);
  for (let k = 1; k <= 8; k++) assert.equal(state.values[`xs[${k}]`], k * state.values.x);
  assert.equal(state.values['der(x)'], -state.values.x + 1);
  assert.equal(state.values.x, 1, 'x stays at the equilibrium of u = 1');
  assert.deepEqual(JSON.parse(session.input_names()), ['u']);
  assert.equal(JSON.parse(session.execution_receipt_json()).engine, 'fmi3-ls-wasm');
  assert.throws(() => session.bind_inputs(JSON.stringify(['x'])), /Not an FMU input/);
  assert.throws(() => session.bind_inputs(JSON.stringify(['u', 'u'])), /Duplicate/);
  assert.throws(() => session.bind_outputs(JSON.stringify(['nope'])), /Unknown FMU variable/);
  assert.throws(() => session.write_bound(write, Float64Array.of(NaN)), /finite/);
  assert.throws(() => session.advance_to(0.01), /backwards/);
  session.free();
  session.free();
  assert.throws(() => session.time() && session.advance_to(1), /closed/);
});

test('stand-in: reset returns to the initial state and stales bindings', needsBuild, async () => {
  await standIn();
  const session = await open();
  const first = trace(session, reference.provenance.names);
  const read = session.bind_outputs('["x"]');
  session.reset();
  assert.throws(() => session.read_bound(read), /Stale/);
  assert.deepEqual(trace(session, reference.provenance.names), first);
  session.free();
});

test('stand-in: two fresh instances driven identically are bit-identical', needsBuild, async () => {
  await standIn();
  const drive = async () => {
    const session = await open(), write = session.bind_inputs('["u"]'), out = [];
    for (let i = 0; i < 20; i++) { session.write_bound(write, Float64Array.of(Math.sin(i))); session.advance_to((i + 1) * 0.02); out.push(session.state_json()); }
    session.free();
    return out;
  };
  assert.deepEqual(await drive(), await drive());
});

test('stand-in: a component trap fails the session; a new session works', needsBuild, async () => {
  await standIn();
  const log = quiet(), session = await open(built, {console: log});
  // 2^25 + 1 references to the 8-element xs ask the guest for 2^28 + 8 doubles: Rust's
  // capacity check panics; its panic path reaches a WASI import that traps.
  const refs = new Uint32Array(2 ** 25 + 1).fill(4);
  assert.throws(() => session.read_references(refs), error => error instanceof FmuFault
    && /get-Float64 failed .*RuntimeError: WASI import is not provided to FMUs: wasi:cli\/environment#getEnvironment/.test(error.message));
  assert.match(session.fault, /RuntimeError/);
  for (const operation of [() => session.advance_to(0.1), () => session.advance_to(session.time()), () => session.state_json(),
    () => session.read_references(Uint32Array.of(2)), () => session.bind_outputs('["x"]')]) assert.throws(operation, FmuFault);
  assert.throws(() => session.reset(), /Prepare the simulation again/);
  session.free();
  const next = await open();
  assert.deepEqual(trace(next, reference.provenance.names), reference.rows);
  next.free();
});

test('stand-in: loading refuses an index, glue or core module that is not the build', needsBuild, async () => {
  // A build of its own: compiled modules are cached per URL once verified.
  const built = await buildToDirectory(await standInFmu());
  const base = pathToFileURL(built.dir + '/');
  await assert.rejects(loadFmuIndex(new URL(built.indexFile, base), '0'.repeat(64), {fetch: fileFetch}), /does not match its build/);
  const index = await loadFmuIndex(new URL(built.indexFile, base), built.indexSha256, {fetch: fileFetch});
  const core = Object.values(index.coreModules).sort((a, b) => b.bytes - a.bytes)[0].file;
  const original = await readFile(path.join(built.dir, core));
  try {
    const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
    await writeFile(path.join(built.dir, core), changed);
    await assert.rejects(openFmuSession({index, base, fetch: fileFetch, console: quiet()}), /core module .* does not match its build/);
  } finally { await writeFile(path.join(built.dir, core), original); }
  await assert.rejects(openFmuSession({index: {...index, glue: {...index.glue, sha256: '0'.repeat(64)}}, base, fetch: fileFetch, console: quiet()}), /glue does not match/);
  const narrowed = {...index, imports: index.imports.filter(name => !name.startsWith('wasi:cli/exit'))};
  await assert.rejects(openFmuSession({index: narrowed, base, fetch: fileFetch, console: quiet()}), /outside its build manifest: wasi:cli\/exit/);
  await rm(built.dir, {recursive: true, force: true});
});

test('the session keeps its FMI instance private and refuses work when closed (H2)', needsBuild, async () => {
  await standIn();
  const session = await open();
  assert.equal('fmi' in session, false, 'no raw FMI instance on the session');
  assert.deepEqual([...session.read_references(Uint32Array.of(2, 0))], [1, 0]);
  const read = session.bind_outputs('["x"]'), write = session.bind_inputs('["u"]');
  session.free();
  for (const operation of [() => session.advance_to(session.time()), () => session.step(0.1), () => session.bind_outputs('["x"]'),
    () => session.bind_inputs('["u"]'), () => session.read_bound(read), () => session.write_bound(write, Float64Array.of(1)),
    () => session.read_values('["x"]'), () => session.state_json(), () => session.read_references(Uint32Array.of(2)), () => session.reset()])
    assert.throws(operation, /closed/);
  assert.equal(session.time(), 0, 'time stays readable as metadata');
});

test('a warm module cache is bound to the full expected sha256 (H1)', needsBuild, async () => {
  const build = await buildToDirectory(await standInFmu());
  const base = pathToFileURL(build.dir + '/');
  const index = await loadFmuIndex(new URL(build.indexFile, base), build.indexSha256, {fetch: fileFetch});
  (await openFmuSession({index, base, fetch: fileFetch, console: quiet()})).free();
  const [name, entry] = Object.entries(index.coreModules).sort((a, b) => b[1].bytes - a[1].bytes)[0];
  // Same URL, different expectation: must be verified again, not served from the cache.
  const expectingOther = {...index, coreModules: {...index.coreModules, [name]: {...entry, sha256: 'a'.repeat(64)}}};
  await assert.rejects(openFmuSession({index: expectingOther, base, fetch: fileFetch, console: quiet()}), /does not match its build/);
  // Cache-hit control: same URL and same digest reuse the module verified earlier, even if the file changed since.
  const file = path.join(build.dir, entry.file), original = await readFile(file);
  try {
    await writeFile(file, Buffer.from('not wasm'));
    const again = await openFmuSession({index, base, fetch: fileFetch, console: quiet()});
    assert.deepEqual(trace(again, reference.provenance.names), reference.rows);
    again.free();
  } finally { await writeFile(file, original); }
  await rm(build.dir, {recursive: true, force: true});
});

// ---- host contracts on a scripted fake component ----
const ulp = (x, n) => { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, x); view.setBigUint64(0, view.getBigUint64(0) + BigInt(n)); return view.getFloat64(0); };
const scalarModel = [{name: 'time', vr: 0, type: 'Float64', causality: 'independent'}, {name: 'y', vr: 1, type: 'Float64', causality: 'output'}];
const reachedBy = 'doStep(current, step) { const r = super.doStep(current, step); r.lastSuccessfulTime = globalThis.fakeFmu.reached?.(current, step) ?? r.lastSuccessfulTime; return r; }';

test('do-step time: 4 ordered-binary64 ULP of current + size, finite advancing target (H4)', async () => {
  const fake = await fakeFmuDirectory({variables: scalarModel, instance: reachedBy});
  const fresh = async reached => { globalThis.fakeFmu.reached = reached; globalThis.fakeFmu.calls = []; return open(fake); };
  const steps = () => globalThis.fakeFmu.calls.filter(call => call[0] === 'doStep').length;
  // Near zero: 1e-16 for a target of 1e-20 is a different communication point.
  let session = await fresh(() => 1e-16);
  assert.throws(() => session.step(1e-20), FmuFault);
  assert.equal(session.time(), 0, 'a refused outcome leaves the accepted time');
  // Ordinary: within 4 ULP accepted (and carried exactly), 5 ULP refused.
  session = await fresh((c, s) => ulp(c + s, 4));
  session.step(0.1);
  assert.equal(session.time(), ulp(0.1, 4));
  session = await fresh((c, s) => ulp(c + s, 5));
  assert.throws(() => session.step(0.1), FmuFault);
  // A one-representable-step target must still return strictly after the carried time.
  session = await fresh(undefined);
  session.step(1);
  session.step(2 ** -52);
  assert.equal(session.time(), ulp(1, 1), 'the exact next-double outcome advances');
  session.free();
  for (const outcome of [current => current, current => ulp(current, -1)]) {
    session = await fresh((current, size) => current === 1 ? outcome(current) : current + size);
    session.step(1);
    const bound = session.bind_outputs('["y"]');
    assert.throws(() => session.step(2 ** -52), FmuFault);
    assert.equal(session.time(), 1, 'a nonadvancing returned outcome preserves the accepted time');
    assert.throws(() => session.advance_to(1), FmuFault);
    assert.throws(() => session.step(2 ** -52), FmuFault);
    assert.throws(() => session.read_bound(bound), FmuFault);
    assert.throws(() => session.reset(), /Prepare the simulation again/);
    session.free();
  }
  // Overflow and non-advancing targets are refused before the guest is entered, without failing the session.
  session = await fresh(undefined);
  session.step(1.5e308);
  assert.throws(() => session.step(1.5e308), /target .* is not finite/);
  assert.throws(() => session.advance_to(Infinity), /finite/);
  session.advance_to(1.5e308);
  assert.equal(steps(), 1, 'the refused steps did not enter the guest');
  session = await fresh(undefined);
  session.step(1);
  assert.throws(() => session.step(1e-20), /does not advance/);
  assert.equal(steps(), 1, 'the refused step did not enter the guest');
  assert.equal(session.fault, undefined);
  session.advance_to(1);
  assert.equal(session.time(), 1, 'advance_to the current time is accepted on a live session');
  // Rejected flags keep the last accepted time.
  globalThis.fakeFmu.reached = undefined;
  const flagged = await fakeFmuDirectory({variables: scalarModel, instance: 'doStep(c, s) { const r = super.doStep(c, s); r.earlyReturn = true; return r; }'});
  session = await open(flagged);
  assert.throws(() => session.step(0.1), /early-return true/);
  assert.equal(session.time(), 0);
  await rm(fake.dir, {recursive: true, force: true});
  await rm(flagged.dir, {recursive: true, force: true});
});

test('Int64 values are never rounded through Number (H6)', async () => {
  const variables = [{name: 'time', vr: 0, type: 'Float64', causality: 'independent'},
    {name: 'big', vr: 1, type: 'Int64', causality: 'output'}, {name: 'n', vr: 2, type: 'Int64', causality: 'input', dimensions: [2]},
    {name: 'small', vr: 3, type: 'Int64', causality: 'output'}];
  const fake = await fakeFmuDirectory({variables, instance:
    'constructor() { super(); this.values.set(1, [2n ** 53n + 1n]); this.values.set(2, [2n ** 53n + 1n, 0n]); this.values.set(3, [-(2n ** 53n) + 1n]); }'});
  const session = await open(fake);
  assert.deepEqual([...session.read_values('["small"]')], [-(2 ** 53) + 1], 'safe integers are exact');
  assert.throws(() => session.read_values('["big"]'), /Int64 value 9007199254740993 of FMU variable is outside/);
  assert.throws(() => session.state_json(), /outside/);
  assert.equal(session.fault, undefined, 'a representation refusal does not fail the session');
  // A partial write of an Int64 array keeps the untouched element exactly.
  const write = session.bind_inputs('["n[2]"]');
  session.write_bound(write, Float64Array.of(5));
  assert.deepEqual(globalThis.fakeFmu.calls.at(-1), ['setInt64', [2], [2n ** 53n + 1n, 5n]]);
  assert.throws(() => session.write_bound(write, Float64Array.of(2 ** 53)), /Int64 FMU input must be an integer/);
  session.free();
  await rm(fake.dir, {recursive: true, force: true});
});

test('an input frame across typed setters is atomic or fails the session (H7)', async () => {
  const variables = [{name: 'time', vr: 0, type: 'Float64', causality: 'independent'},
    {name: 'a', vr: 1, type: 'Float64', causality: 'input'}, {name: 'b', vr: 2, type: 'Int64', causality: 'input'}];
  const fake = await fakeFmuDirectory({variables, instance:
    "constructor() { super(); this.values.set(1, [10]); this.values.set(2, [20n]); }\n" +
    "setFloat64(r, v) { if (globalThis.fakeFmu.refuse === 'Float64') { this.log(['setFloat64', [...r], [...v]]); return 'error'; } return super.setFloat64(r, v); }\n" +
    "setInt64(r, v) { if (globalThis.fakeFmu.refuse === 'Int64') { this.log(['setInt64', [...r], [...v]]); return 'discard'; } return super.setInt64(r, v); }"});
  const setters = () => globalThis.fakeFmu.calls.filter(call => /^set/.test(call[0])).map(call => call[0]);
  // Conversion is refused before any setter runs.
  let session = await open(fake);
  const frame = session.bind_inputs('["a","b"]');
  const instance = globalThis.fakeFmu.instances.at(-1);
  const values = () => [instance.values.get(1), instance.values.get(2)];
  assert.deepEqual(values(), [[10], [20n]]);
  globalThis.fakeFmu.calls = [];
  assert.throws(() => session.write_bound(frame, Float64Array.of(1, 1.5)), /Int64 FMU input must be an integer/);
  assert.deepEqual(setters(), []);
  assert.deepEqual(values(), [[10], [20n]], 'conversion refusal changes neither type');
  // The first setter refusing applied nothing: an ordinary refusal, the session stays live.
  globalThis.fakeFmu.refuse = 'Float64';
  assert.throws(() => session.write_bound(frame, Float64Array.of(1, 2)), error => !(error instanceof FmuFault) && /set-Float64 returned error/.test(error.message));
  assert.deepEqual(setters(), ['setFloat64']);
  assert.deepEqual(values(), [[10], [20n]], 'first-setter refusal changes neither type');
  session.advance_to(0.1);
  // A later setter refusing after an earlier one succeeded: the frame is partly applied, so the session fails.
  globalThis.fakeFmu.refuse = 'Int64';
  assert.throws(() => session.write_bound(frame, Float64Array.of(3, 4)), error => error instanceof FmuFault && /partly applied/.test(error.message));
  assert.deepEqual(values(), [[3], [20n]], 'earlier success is retained and the refusing type is unchanged');
  assert.throws(() => session.advance_to(0.2), FmuFault);
  assert.throws(() => session.write_bound(frame, Float64Array.of(5, 6)), FmuFault);
  assert.deepEqual(values(), [[3], [20n]], 'faulted work cannot apply another frame');
  assert.throws(() => session.reset(), /Prepare the simulation again/);
  session.free();
  globalThis.fakeFmu.refuse = undefined;
  await rm(fake.dir, {recursive: true, force: true});
});

test('downloadFirst: every body arrives before any verification or compile; later sessions reuse', needsBuild, async () => {
  const build = await buildToDirectory(await standInFmu());
  const base = pathToFileURL(build.dir + '/');
  const index = await loadFmuIndex(new URL(build.indexFile, base), build.indexSha256, {fetch: fileFetch});
  const events = [];
  const fetch = async url => {
    const response = await fileFetch(url);
    const name = path.basename(new URL(url).pathname);
    // A body counts as received when its last byte arrives, whether it is read as a stream or whole.
    const body = response.body?.pipeThrough(new TransformStream({flush() { events.push(['received', name]); }}));
    return {ok: response.ok, status: response.status, body,
      arrayBuffer: async () => { const bytes = await response.arrayBuffer(); events.push(['received', name]); return bytes; }};
  };
  const {compile, compileStreaming} = WebAssembly;
  WebAssembly.compile = bytes => { events.push(['compile']); return compile(bytes); };
  WebAssembly.compileStreaming = source => { events.push(['compileStreaming']); return compileStreaming(source); };
  try {
    const first = await openFmuSession({index, base, fetch, console: {log() {}, error() {}, warn() {}}, downloadFirst: true});
    const cores = Object.keys(index.coreModules).length;
    assert.ok(cores > 0);
    const lastReceived = events.findLastIndex(([kind]) => kind === 'received');
    assert.equal(events.filter(([kind]) => kind === 'received').length, cores + 1, 'glue and every core module');
    assert.ok(events.slice(0, lastReceived).every(([kind]) => kind === 'received'), 'no compile before the last byte');
    assert.equal(events.filter(([kind]) => kind === 'compile').length, cores);
    assert.ok(!events.some(([kind]) => kind === 'compileStreaming'), 'no streaming compile overlaps a download');
    const {startup} = JSON.parse(first.execution_receipt_json());
    assert.deepEqual([startup.compiled, startup.reused], [cores, 0]);
    assert.ok(Number.isFinite(startup.downloads_end_ms));
    first.advance_to(0.1);
    first.free();
    events.length = 0;
    const later = await openFmuSession({index, base, fetch, console: {log() {}, error() {}, warn() {}}, downloadFirst: true});
    assert.deepEqual(events, [['received', index.glue.file]], 'a later session fetches only the glue and compiles nothing');
    assert.deepEqual(JSON.parse(later.execution_receipt_json()).startup.reused, cores);
    later.free();
    // Without downloadFirst the receipt is unchanged.
    const plain = await openFmuSession({index, base, fetch: fileFetch, console: {log() {}, error() {}, warn() {}}});
    assert.equal(JSON.parse(plain.execution_receipt_json()).startup, undefined);
    plain.free();
  } finally {
    Object.assign(WebAssembly, {compile, compileStreaming});
    await rm(build.dir, {recursive: true, force: true});
  }
});

test('preloadFmu: a later session receives and compiles nothing again; a refused preload caches nothing', needsBuild, async () => {
  const build = await buildToDirectory(await standInFmu());
  const base = pathToFileURL(build.dir + '/');
  const manifest = sha256 => writeFile(path.join(build.dir, 'manifest.json'),
    JSON.stringify({version: 1, models: {M: {fmu: {index: build.indexFile, sha256}}}}));
  const fetched = [];
  const fetch = url => { fetched.push(path.basename(new URL(url).pathname)); return fileFetch(url); };
  const {compile, compileStreaming} = WebAssembly;
  let compiles = 0;
  WebAssembly.compile = bytes => { compiles++; return compile(bytes); };
  WebAssembly.compileStreaming = source => { compiles++; return compileStreaming(source); };
  try {
    const index = await loadFmuIndex(new URL(build.indexFile, base), build.indexSha256, {fetch: fileFetch});
    const cores = Object.keys(index.coreModules).length;
    await manifest('0'.repeat(64));
    await assert.rejects(preloadFmu({model: 'M', base, fetch}), /does not match its build/);
    assert.equal(compiles, 0, 'an index that is not the build starts nothing');
    await manifest(build.indexSha256);
    fetched.length = 0;
    assert.equal(await preloadFmu({model: 'M', base, fetch}), true);
    const session = await openFmuSession({index, base, fetch, console: quiet(), downloadFirst: true});
    assert.equal(compiles, cores, 'each core module compiled once, by the preload');
    assert.deepEqual(fetched.sort(), ['manifest.json', build.indexFile, index.glue.file,
      ...Object.values(index.coreModules).map(entry => entry.file)].sort(), 'every file received once, by the preload');
    assert.equal(JSON.parse(session.execution_receipt_json()).startup.reused, cores);
    assert.deepEqual(trace(session, reference.provenance.names), reference.rows);
    session.free();
  } finally {
    Object.assign(WebAssembly, {compile, compileStreaming});
    await rm(build.dir, {recursive: true, force: true});
  }
});

test('a callback outside the Co-Simulation contract refuses and fails the session', async () => {
  const variables = [{name: 'time', vr: 0, type: 'Float64', causality: 'independent'},
    {name: 'x', vr: 1, type: 'Float64', causality: 'output'}];
  const fake = await fakeFmuDirectory({variables,
    imports: ['fmi:fmi3/callbacks@3.0.0', 'fmi:fmi3/intermediate-update-callbacks@3.0.0'],
    instance: "doStep(current, step) { const call = globalThis.fakeFmu.call; if (call) call(globalThis.fakeFmu.imports); return super.doStep(current, step); }"});
  const cases = [
    ['intermediate-update', imports => imports['fmi:fmi3/intermediate-update-callbacks'].intermediateUpdate(0, false, false, false, false)],
    ['clock-update', imports => imports['fmi:fmi3/callbacks'].clockUpdate(0)],
    ['lock-preemption', imports => imports['fmi:fmi3/callbacks'].lockPreemption()],
    ['unlock-preemption', imports => imports['fmi:fmi3/callbacks'].unlockPreemption()],
  ];
  for (const [name, call] of cases) {
    const session = await open(fake);
    globalThis.fakeFmu.call = call;
    assert.throws(() => session.advance_to(0.1), error => error instanceof FmuFault && error.message.includes('FMU called ' + name), name);
    assert.throws(() => session.advance_to(0.2), FmuFault, 'the refusal latches');
    globalThis.fakeFmu.call = undefined;
    session.free();
  }
  // logMessage stays the one callback the FMU may use.
  const session = await open(fake, {console: {log() {}, error() {}, warn() {}}});
  globalThis.fakeFmu.call = imports => imports['fmi:fmi3/callbacks'].logMessage(0, 'ok', 'events', 'fine');
  session.advance_to(0.1);
  globalThis.fakeFmu.call = undefined;
  session.free();
  await rm(fake.dir, {recursive: true, force: true});
});

test('the insecure seed is one fixed constant', () => {
  assert.deepEqual(INSECURE_SEED, [0x6d6963726f6475n, 0x636b2d666d75n]);
  assert(Object.isFrozen(INSECURE_SEED));
});

// The real packaged FMU (not the robot): FMU_REAL=<model.fmu> FMU_REAL_TRACE=<wasmtime trace json>.
const real = process.env.FMU_REAL && process.env.FMU_REAL_TRACE ? {fmu: process.env.FMU_REAL, trace: process.env.FMU_REAL_TRACE} : undefined;
test('real FMU: traced values are bit-identical to Wasmtime, twice, from fresh instances', {skip: transpiler.skip ?? (!real && 'FMU_REAL and FMU_REAL_TRACE are not set')}, async () => {
  const build = await buildToDirectory(new Uint8Array(await readFile(real.fmu)));
  const wasmtime = JSON.parse(await readFile(real.trace, 'utf8'));
  const names = ['time', ...build.index.variables.filter(v => v.type === 'Float64' && v.causality !== 'independent')
    .flatMap(v => [...scalarTable([v]).keys()])];
  const runs = [];
  for (let i = 0; i < 2; i++) { const session = await open(build); runs.push(trace(session, names)); session.free(); }
  assert.deepEqual(runs[0], runs[1]);
  assert.deepEqual(runs[0], wasmtime.rows.map(row => ({time: row.time, bits: row.bits})));
  await rm(build.dir, {recursive: true, force: true});
});

// ---- the page's whole-simulation gate ----
const simulationVariables = () => [
  ...SIMULATION_INPUTS.map((name, i) => ({name, vr: 1 + i, type: name === 'hasPreviousPositionCommand' ? 'Boolean' : 'Float64', causality: 'input'})),
  ...SIMULATION_OUTPUTS.map((name, i) => ({name, vr: 1000 + i, type: 'Float64', causality: 'output'})),
];
test('the whole-simulation interface is checked by name and causality', () => {
  assert.equal(checkSimulationInterface(simulationVariables()), undefined);
  assert.match(checkSimulationInterface(simulationVariables().filter(v => v.name !== 'policyAction[3]')), /no input policyAction\[3\]/);
  assert.match(checkSimulationInterface([...simulationVariables(), {name: 'policyPosition', vr: 5000, type: 'Float64', causality: 'input', dimensions: [15]}]), /plant-only/);
});

test('offeredFmu: none offered, offered, edited sources, wrong hash, plant-only', async () => {
  const sources = {'A.mo': 'model A end A;'};
  const sha = async text => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
  const index = {schema: 1, format: 'fmi3-ls-wasm-transpiled', modelName: 'M', instantiationToken: 't', glue: {file: 'g.js'}, coreModules: {},
    imports: [], variables: simulationVariables(), sourceModel: 'A', sources: {'A.mo': await sha(sources['A.mo'])}};
  const files = {};
  const serve = (manifest, idx) => { files['manifest.json'] = JSON.stringify(manifest); files['i.json'] = JSON.stringify(idx); };
  const fetch = async url => files[String(url).split('/').pop()] === undefined ? new Response(null, {status: 404}) : new Response(files[String(url).split('/').pop()]);
  const base = new URL('http://page.test/prebuilt/');
  serve({version: 1, models: {M: {}}}, index);
  assert.equal(await offeredFmu({model: 'M', sources, base, fetch}), undefined);
  serve({version: 1, models: {M: {fmu: {index: 'i.json', sha256: await sha(JSON.stringify(index))}}}}, index);
  assert.equal((await offeredFmu({model: 'M', sources, base, fetch})).index.modelName, 'M');
  assert.match((await offeredFmu({model: 'M', sources: {'A.mo': 'edited'}, base, fetch})).fallback, /edited page source A.mo/);
  serve({version: 1, models: {M: {fmu: {index: 'i.json', sha256: '0'.repeat(64)}}}}, index);
  assert.match((await offeredFmu({model: 'M', sources, base, fetch})).fallback, /does not match its build/);
  const plantOnly = {...index, variables: [...index.variables, {name: 'usePolicyPosition', vr: 9999, type: 'Boolean', causality: 'input'}]};
  serve({version: 1, models: {M: {fmu: {index: 'i.json', sha256: await sha(JSON.stringify(plantOnly))}}}}, plantOnly);
  assert.match((await offeredFmu({model: 'M', sources, base, fetch})).fallback, /plant-only/);
  files['manifest.json'] = undefined;
  assert.equal(await offeredFmu({model: 'M', sources, base, fetch}), undefined);
});

test('offeredFmu admits only the complete page-source set, including the built model (H5)', async () => {
  const sha = async text => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
  const sources = {'A.mo': 'model A end A;', 'B.mo': 'model B end B;'};
  const recorded = {'A.mo': await sha(sources['A.mo']), 'B.mo': await sha(sources['B.mo'])};
  const files = {}, base = new URL('http://page.test/prebuilt/');
  const fetch = async url => files[String(url).split('/').pop()] === undefined ? new Response(null, {status: 404}) : new Response(files[String(url).split('/').pop()]);
  const offer = async (fields, current = sources) => {
    const index = {schema: 1, format: 'fmi3-ls-wasm-transpiled', modelName: 'M', instantiationToken: 't', glue: {file: 'g.js'}, coreModules: {},
      imports: [], variables: simulationVariables(), ...fields};
    files['manifest.json'] = JSON.stringify({version: 1, models: {M: {fmu: {index: 'i.json', sha256: await sha(JSON.stringify(index))}}}});
    files['i.json'] = JSON.stringify(index);
    return offeredFmu({model: 'M', sources: current, base, fetch});
  };
  assert.ok((await offer({sourceModel: 'A', sources: recorded})).index, 'the complete, unchanged set is admitted');
  assert.match((await offer({sourceModel: 'A', sources: {}})).fallback, /no page sources/);
  assert.match((await offer({sourceModel: 'A', sources: {'A.mo': recorded['A.mo']}})).fallback, /page source B.mo is not in the FMU's source set/);
  assert.match((await offer({sourceModel: 'A', sources: recorded}, {'A.mo': sources['A.mo']})).fallback, /missing page source B.mo/);
  assert.match((await offer({sourceModel: 'A', sources: recorded}, {...sources, 'C.mo': 'model C end C;'})).fallback, /page source C.mo is not in the FMU's source set/);
  assert.match((await offer({sourceModel: 'A', sources: recorded}, {...sources, 'B.mo': 'model B Real x; end B;'})).fallback, /edited page source B.mo/);
  assert.match((await offer({sources: recorded})).fallback, /does not name the model it was built from/);
  assert.match((await offer({sourceModel: 'Z', sources: recorded})).fallback, /Z.mo is not in the FMU's source set/);
});

test.after(async () => { if (built) await rm(built.dir, {recursive: true, force: true}); });


test('current worker set_inputs validates the whole frame before typed setters', async () => {
 const variables=[{name:'u',vr:1,type:'Float64',causality:'input'},
  {name:'flag',vr:2,type:'Boolean',causality:'input'}];
 const fake=await fakeFmuDirectory({variables});
 const session=await open(fake);
 globalThis.fakeFmu.calls=[];
 assert.throws(()=>session.set_inputs('[["u",7],["flag",2]]'),/Boolean/);
 assert.equal(globalThis.fakeFmu.calls.filter(x=>/^set/.test(x[0])).length,0);
 assert.throws(()=>session.set_inputs('[["u",1],["u",2]]'),/Duplicate/);
 assert.throws(()=>session.set_inputs('[["u","3"]]'),/numeric/);
 session.set_inputs('[["u",7],["flag",1]]');
 assert.deepEqual(globalThis.fakeFmu.calls.filter(x=>/^set/.test(x[0])).map(x=>x[0]),['setFloat64','setBoolean']);
 session.free();await rm(fake.dir,{recursive:true,force:true});
});
