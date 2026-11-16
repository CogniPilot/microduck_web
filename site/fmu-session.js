import {sha256Hex} from './sha256.js';
import {PAGE_INPUT_GROUPS, PAGE_OUTPUT_GROUPS, PAGE_OPTIONAL_OUTPUTS, scalarNames, canonicalJson, WHOLE_MODEL, PAGE_FIXED_VALUES} from './fmu-page-contract.js';
// A simulation session backed by a prebuilt FMI 3 Layered-Standard WebAssembly FMU,
// transpiled at build time (scripts/build-fmu.mjs). It offers the surface the worker
// uses from an SDK session (bind_inputs/write_bound, bind_outputs/read_bound,
// advance_to, time, state_json, execution_receipt_json, input_names, reset, free)
// on top of the FMI co-simulation calls: set-* with value references resolved once
// from modelDescription.xml, do-step carrying the returned last-successful-time,
// and get-*. The FMU owns the model, its solver and its value references.

// Two memories in one module: true only where WebAssembly multi-memory is supported,
// which every linked FMU guest needs (its model library defines a private memory).
const MULTI_MEMORY_PROBE = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 5, 5, 2, 0, 0, 0, 0);
export function supportsMultiMemory() {
 try { return WebAssembly.validate(MULTI_MEMORY_PROBE); } catch { return false; }
}

const READ = {Float64: 'getFloat64', Int64: 'getInt64', Boolean: 'getBoolean'};
const WRITE = {Float64: 'setFloat64', Int64: 'setInt64', Boolean: 'setBoolean'};
const SCALAR_TYPES = Object.keys(READ);

export class FmuFault extends Error {}

// Accepted do-step outcome: last-successful-time within this many ordered-binary64 ULP of
// current + size (the guest computes the same sum; a few ULP allow other summation orders).
export const STEP_TIME_ULPS = 4n;
const orderedBits = value => {
 const view = new DataView(new ArrayBuffer(8));
 view.setFloat64(0, value);
 const bits = view.getBigInt64(0);
 return bits < 0n ? -(bits & 0x7fffffffffffffffn) : bits;
};
// Number of representable doubles between a and b (both finite).
export function ulpDistance(a, b) {
 const d = orderedBits(a) - orderedBits(b);
 return d < 0n ? -d : d;
}

// Pure outcome check after the caller validates a finite advancing target.
// Shared with source-only controls; the session owns the sticky fault.
export function stepOutcomeError(from, size, result) {
 const target = from + size, reached = result?.lastSuccessfulTime;
 if (typeof reached !== 'number' || !Number.isFinite(reached) || !(reached > from) || ulpDistance(reached, target) > STEP_TIME_ULPS)
  return `FMU do-step of ${size} from t=${from} reached ${reached}, not strictly advancing within ${STEP_TIME_ULPS} ULP of ${target}`;
 if (result.terminateSimulation || result.earlyReturn || result.eventHandlingNeeded)
  return `FMU stopped at t=${reached} (terminate-simulation ${result.terminateSimulation}, early-return ${result.earlyReturn}, event-handling-needed ${result.eventHandlingNeeded})`;
 return null;
}

// Compiled core modules by URL AND the full expected sha256: a second session (prepare after
// a fault, or a new page model) reuses a module only if it was verified against that digest.
const compiledModules = new Map();
// Verified glue bytes received ahead of a session (preloadFmu), keyed the same way.
const verifiedGlue = new Map();
const verifiedKey = (url, sha256) => url + '#sha256=' + sha256;
// A cached promise keeps its rejection for its awaiting session, but an unawaited
// preload failure is not an unhandled rejection; a failed entry leaves the cache.
function cacheOnce(cache, key, start) {
 if (!cache.has(key)) {
  const pending = start().catch(error => { cache.delete(key); throw error; });
  pending.catch(() => {});
  cache.set(key, pending);
 }
 return cache.get(key);
}

// ---- WASI: every function traps, except stdout/stderr, which reach the console, and ----
// insecure-seed. The guest's standard-library hash maps ask for that seed inside
// instantiate-co-simulation. It is a fixed constant so that every instance and every
// visit gives bit-identical results (a build-time snapshot freezes whatever seed it got
// anyway); nothing in a simulation may depend on it. Drop it once guests stop asking.
export const INSECURE_SEED = Object.freeze([0x6d6963726f6475n, 0x636b2d666d75n]);
const trap = key => { throw new WebAssembly.RuntimeError('WASI import is not provided to FMUs: ' + key); };
function trappingInterface(name, members = {}) {
 return new Proxy(members, {get(target, member) {
  if (typeof member !== 'string' || member === 'then') return undefined;
  if (Object.hasOwn(target, member)) return target[member];
  // Resource types are looked up as classes; give each one that traps when made.
  if (/^[A-Z]/.test(member)) return class { constructor() { trap(name + '#' + member); } };
  return () => trap(name + '#' + member);
 }});
}
function createWasi(names, log) {
 const lines = [];
 class Pollable { ready() { return true; } block() {} }
 class OutputStream {
  constructor(sink) { this.sink = sink; this.pending = ''; this.decoder = new TextDecoder(); }
  checkWrite() { return 65536n; }
  write(bytes) {
   this.pending += this.decoder.decode(bytes, {stream: true});
   const parts = this.pending.split('\n');
   this.pending = parts.pop();
   for (const line of parts) { lines.push(line); if (lines.length > 50) lines.shift(); this.sink(line); }
  }
  blockingWriteAndFlush(bytes) { this.write(bytes); }
  flush() {}
  blockingFlush() {}
  subscribe() { return new Pollable(); }
 }
 const stdout = new OutputStream(line => log.log('[fmu stdout] ' + line));
 const stderr = new OutputStream(line => log.error('[fmu stderr] ' + line));
 const provided = {
  'wasi:random/insecure-seed': {insecureSeed: () => [...INSECURE_SEED]},
  'wasi:io/streams': {OutputStream},
  'wasi:io/poll': {Pollable},
  'wasi:cli/stdout': {getStdout: () => stdout},
  'wasi:cli/stderr': {getStderr: () => stderr},
 };
 const imports = {};
 for (const versioned of names) {
  const name = versioned.replace(/@[0-9.]+$/, '');
  if (name.startsWith('wasi:')) imports[name] = trappingInterface(name, provided[name]);
 }
 return {imports, lines};
}

// ---- value-reference table from the build index (modelDescription.xml, parsed once) ----
function elementNames(variable) {
 const dimensions = variable.dimensions ?? [];
 const count = dimensions.reduce((product, extent) => product * extent, 1);
 if (!dimensions.length) return [variable.name];
 // FMI 3 array values are serialised in row-major order.
 return Array.from({length: count}, (_, offset) => {
  const index = [];
  for (let d = dimensions.length - 1, rest = offset; d >= 0; d--) { index.unshift(rest % dimensions[d] + 1); rest = Math.floor(rest / dimensions[d]); }
  return variable.name + '[' + index.join(',') + ']';
 });
}
export function scalarTable(variables) {
 const table = new Map();
 for (const variable of variables) {
  const names = elementNames(variable);
  names.forEach((name, offset) => {
   if (table.has(name)) throw Error('FMU variable names collide: ' + name);
   table.set(name, {variable, offset, count: names.length});
  });
 }
 return table;
}

function checkIndex(index) {
 if (index?.schema !== 1 || index.format !== 'fmi3-ls-wasm-transpiled') throw Error('Unsupported FMU index.');
 for (const key of ['modelName', 'instantiationToken']) if (typeof index[key] !== 'string' || !index[key]) throw Error('Invalid FMU index: ' + key);
 if (typeof index.glue?.file !== 'string' || !index.coreModules || !Array.isArray(index.variables) || !Array.isArray(index.imports)) throw Error('Invalid FMU index.');
 return index;
}

const digest = sha256Hex;
async function download(fetchFile, url, what) {
 const response = await fetchFile(url);
 if (!response.ok) throw Error(`FMU ${what} download failed: ${response.status}`);
 return response;
}
// A response body read to its end, reporting each chunk's size as it arrives.
async function readCounted(body, onBytes) {
 const reader = body.getReader(), chunks = [];
 let total = 0;
 for (;;) {
  const {done, value} = await reader.read();
  if (done) break;
  chunks.push(value); total += value.byteLength; onBytes(value.byteLength);
 }
 const bytes = new Uint8Array(total);
 let at = 0;
 for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
 return bytes.buffer;
}
async function verified(bytes, sha256, what) {
 const actual = await digest(bytes);
 if (actual !== sha256) throw Error(`FMU ${what} does not match its build: sha256 ${actual}, expected ${sha256}`);
 return bytes;
}

// The index is named by the page manifest together with its sha256; everything else
// (glue, core modules, imports, value references) is bound to the index by hash.
export async function loadFmuIndex(url, sha256, {fetch: fetchFile = globalThis.fetch} = {}) {
 if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw Error('FMU index needs its sha256.');
 const bytes = await verified(await (await download(fetchFile, url, 'index')).arrayBuffer(), sha256, 'index');
 return checkIndex(JSON.parse(new TextDecoder().decode(bytes)));
}

// The plan for one set of names: one get/set call per value type, each with the
// value references in first-seen order, and where every requested scalar lands.
function plan(table, names, accept) {
 const groups = new Map(), places = [];
 names.forEach((name, position) => {
  const entry = table.get(name);
  if (!entry) throw Error('Unknown FMU variable: ' + name);
  accept?.(entry, name);
  const {variable, offset, count} = entry;
  if (!SCALAR_TYPES.includes(variable.type)) throw Error(`FMU variable ${name} has type ${variable.type}, which the page cannot read or write`);
  let group = groups.get(variable.type);
  if (!group) groups.set(variable.type, group = {type: variable.type, refs: [], starts: new Map(), size: 0});
  if (!group.starts.has(variable.vr)) { group.starts.set(variable.vr, {start: group.size, count, covered: new Set()}); group.refs.push(variable.vr); group.size += count; }
  const slot = group.starts.get(variable.vr);
  slot.covered.add(offset);
  places.push({position, group, index: slot.start + offset});
 });
 const list = [...groups.values()].map(group => ({type: group.type, refs: Uint32Array.from(group.refs), size: group.size,
  complete: [...group.starts.values()].every(slot => slot.covered.size === slot.count)}));
 const at = new Map(list.map((group, i) => [groups.get(group.type), i]));
 return {groups: list, group: Int32Array.from(places, place => at.get(place.group)), index: Int32Array.from(places, place => place.index)};
}

// The page boundary is Float64. Int64 values cross it only when exactly representable
// (|v| <= 2^53 - 1); anything else is refused, never rounded.
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
function toNumber(type, values) {
 if (type === 'Float64') return values;
 if (type === 'Boolean') return Float64Array.from(values, value => value ? 1 : 0);
 return Float64Array.from(values, value => {
  if (value > SAFE || value < -SAFE) throw Error(`Int64 value ${value} of FMU variable is outside the page's exactly representable range (|v| <= 2^53 - 1)`);
  return Number(value);
 });
}
// One requested input value in the guest's representation, validated before any setter runs.
function toCell(type, value) {
 if (type === 'Float64') return value;
 if (type === 'Boolean') { if (value !== 0 && value !== 1) throw Error('Boolean FMU input must be 0 or 1.'); return value === 1; }
 if (!Number.isSafeInteger(value)) throw Error('Int64 FMU input must be an integer.');
 return BigInt(value);
}
// A write buffer in the guest's representation; untouched cells of a partly written array
// come from the guest unchanged (BigInt for Int64).
function buffer(type, size, current) {
 if (type === 'Int64') return current ? BigInt64Array.from(current) : new BigInt64Array(size);
 if (type === 'Boolean') return current ? Array.from(current, Boolean) : new Array(size).fill(false);
 return current ? Float64Array.from(current) : new Float64Array(size);
}

// Write a JSON number as Rust's state_json does: finite bits kept (including -0), nonfinite null.
const jsonNumber = value => Number.isFinite(value) ? (Object.is(value, -0) ? '-0' : JSON.stringify(value)) : 'null';

// FMI statuses reach JS as returned strings (set-*, lifecycle calls) or as the thrown
// error value of result<_, status> (get-*, do-step): jco-transpile 0.23 glue throws the
// bare status string, other releases a ComponentError carrying it as `payload`.
const STATUSES = new Set(['ok', 'warning', 'discard', 'error', 'fatal']);
const statusOf = error => typeof error === 'string' && STATUSES.has(error) ? error
 : error && typeof error === 'object' && Object.hasOwn(error, 'payload') && STATUSES.has(error.payload) ? error.payload : undefined;

// Import the glue from the verified bytes, so the code that runs is the code that was hashed.
async function importVerified(bytes) {
 const blob = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(new Blob([bytes], {type: 'text/javascript'})) : undefined;
 try { if (blob) return await import(blob); }
 catch (error) { if (!/blob|scheme|ERR_UNSUPPORTED/i.test(String(error?.code ?? error))) throw error; }
 finally { if (blob) URL.revokeObjectURL(blob); }
 // Engines that cannot import blob: URLs (Node) take a data: URL of the same bytes.
 let binary = '';
 for (let i = 0; i < bytes.byteLength; i += 32768) binary += String.fromCharCode(...new Uint8Array(bytes, i, Math.min(32768, bytes.byteLength - i)));
 return import('data:text/javascript;base64,' + btoa(binary));
}

// A core module is compiled while it downloads; a tee of the same bytes is hashed and
// the module is used only when the hash is the one the build recorded.
async function compileVerified(fetchFile, url, sha256, compileTimes, onBytes = () => {}) {
 const response = await download(fetchFile, url, 'core module');
 const started = performance.now();
 const [compileBranch, hashBranch] = response.body.tee();
 const [module] = await Promise.all([
  WebAssembly.compileStreaming(new Response(compileBranch, {headers: {'content-type': 'application/wasm'}})),
  readCounted(hashBranch, onBytes).then(bytes => verified(bytes, sha256, 'core module ' + url)),
 ]);
 compileTimes?.push({url, ms: performance.now() - started});
 return module;
}

/**
 * Start receiving and compiling an offered FMU's glue and core modules in this worker
 * before any session asks for them, so a later openFmuSession reuses them instead of
 * starting its downloads after the page has prepared. Every file is verified against the
 * index exactly as a session verifies it. Nothing is imported or instantiated and no page
 * source is checked: only offeredFmu and a session decide whether the FMU is used.
 * Best effort: on any failure the session downloads and compiles as before.
 */
export async function preloadFmu({model, base, fetch: fetchFile = globalThis.fetch}) {
 const manifest = await (await download(fetchFile, new URL('manifest.json', base), 'manifest')).json();
 const entry = manifest?.version === 1 ? manifest.models?.[model]?.fmu : undefined;
 if (typeof entry?.index !== 'string' || !supportsMultiMemory()) return false;
 const indexUrl = new URL(entry.index, base);
 const index = await loadFmuIndex(indexUrl, entry.sha256, {fetch: fetchFile});
 const fileUrl = file => new URL(file, indexUrl).href;
 for (const core of Object.values(index.coreModules)) {
  const url = fileUrl(core.file);
  cacheOnce(compiledModules, verifiedKey(url, core.sha256), () => compileVerified(fetchFile, url, core.sha256));
 }
 const glueUrl = fileUrl(index.glue.file);
 cacheOnce(verifiedGlue, verifiedKey(glueUrl, index.glue.sha256), async () =>
  verified(await readCounted((await download(fetchFile, glueUrl, 'glue')).body, () => {}), index.glue.sha256, 'glue'));
 return true;
}

/**
 * Open an FMU session.
 *   index        parsed and verified index (loadFmuIndex)
 *   base         URL the index's file names are relative to
 *   parameters   {name: value} set in Instantiated state (FMU parameters only)
 *   fixedValues  {name: expected} scalar fixed parameter values verified by typed
 *                getters after initialization and every reset; never setters
 *   fetch        file fetcher; default globalThis.fetch
 *   downloadFirst  qualification timing: receive the glue and every core module not already
 *                compiled in this worker before verifying, importing or compiling any of
 *                them, so all later work starts after the last required byte. The receipt
 *                then carries {downloads_end_ms, compiled, reused} (worker clock).
 * Any status other than ok/warning from a lifecycle call or do-step, any trap and any
 * other exception from the component FAILS the session: every later call throws the
 * same FmuFault and recovery is a new session (the worker's prepare), never a reset
 * that resumes the old timeline.
 */
export async function openFmuSession({index, base, parameters = {}, instanceName = 'microduck', console: log = globalThis.console,
 fetch: fetchFile = globalThis.fetch, downloadFirst = false, fixedValues = {}, onProgress = () => {}} = {}) {
 checkIndex(index);
 // Load phases on the worker clock, carried in the receipt: where the page's load time goes.
 const opened = performance.now(), phases = {}, compileTimes = [];
 const phase = name => { phases[name] = performance.now() - opened; };
 // Progress for a loading display: downloaded bytes of the glue and every core module
 // (decompressed, as the index records them), then each later phase as it begins.
 const totalBytes = index.glue.bytes + Object.values(index.coreModules).reduce((sum, entry) => sum + entry.bytes, 0);
 let receivedBytes = 0, lastReport = 0;
 const onBytes = count => {
  receivedBytes += count;
  const now = performance.now();
  if (now - lastReport >= 100) { lastReport = now; onProgress({phase: 'download', received: receivedBytes, total: totalBytes}); }
 };
 onProgress({phase: 'download', received: 0, total: totalBytes});
 // Retain the caller's expected scalar values for the session/reset lifetime.
 fixedValues = {...fixedValues};
 if (!supportsMultiMemory()) throw Error('This engine lacks WebAssembly multi-memory, which the FMU needs.');
 const table = scalarTable(index.variables);
 const fileUrl = file => new URL(file, base).href;
 const moduleKey = entry => verifiedKey(fileUrl(entry.file), entry.sha256);
 const glueKey = verifiedKey(fileUrl(index.glue.file), index.glue.sha256);
 // Files a preload already holds or is receiving count as received for progress.
 receivedBytes = Object.values(index.coreModules).filter(entry => compiledModules.has(moduleKey(entry)))
  .reduce((sum, entry) => sum + entry.bytes, verifiedGlue.has(glueKey) ? index.glue.bytes : 0);
 const body = async (file, what) => readCounted((await download(fetchFile, fileUrl(file), what)).body, onBytes);
 let startup, received;
 if (downloadFirst) {
  const pending = Object.values(index.coreModules).filter(entry => !compiledModules.has(moduleKey(entry)));
  const [glueBody, ...coreBodies] = await Promise.all([verifiedGlue.has(glueKey) ? undefined : body(index.glue.file, 'glue'),
   ...pending.map(entry => body(entry.file, 'core module'))]);
  received = {glue: glueBody, cores: new Map(pending.map((entry, i) => [moduleKey(entry), coreBodies[i]]))};
  startup = {downloads_end_ms: performance.now(), compiled: pending.length, reused: Object.keys(index.coreModules).length - pending.length};
  phase('downloads_received');
  onProgress({phase: 'compile', received: receivedBytes, total: totalBytes});
 }
 const compileReceived = async (key, entry) => {
  const bytes = await verified(received.cores.get(key), entry.sha256, 'core module ' + entry.file);
  const started = performance.now(), module = await WebAssembly.compile(bytes);
  compileTimes.push({url: fileUrl(entry.file), ms: performance.now() - started});
  return module;
 };
 const getCoreModule = name => {
  const entry = index.coreModules[name];
  if (!entry) return Promise.reject(Error('FMU glue requested a core module outside its build: ' + name));
  const url = fileUrl(entry.file), key = moduleKey(entry);
  return cacheOnce(compiledModules, key, () => received?.cores.has(key) ? compileReceived(key, entry)
   : compileVerified(fetchFile, url, entry.sha256, compileTimes, onBytes));
 };
 const glueBytes = received?.glue ? await verified(received.glue, index.glue.sha256, 'glue')
  : await (verifiedGlue.get(glueKey) ?? verified(await body(index.glue.file, 'glue'), index.glue.sha256, 'glue'));
 received = received && {cores: received.cores};
 const glue = await importVerified(glueBytes);
 phase('glue_ready');
 const messages = [];
 // Co-Simulation is instantiated with event mode and early return off, so the only callback
 // the FMU may use is logMessage. Clock and preemption callbacks belong to Scheduled
 // Execution and intermediate updates to early return: each refuses, and the trap fails the
 // session, rather than answering a call this contract never makes.
 const refuse = name => () => { throw Error('FMU called ' + name + ', which this Co-Simulation contract does not offer'); };
 const callbacks = {
  logMessage: (instance, status, category, message) => { messages.push({instance, status, category, message}); (status === 'error' || status === 'fatal' ? log.error : log.log)(`[fmu ${category}] ${message}`); },
  clockUpdate: refuse('clock-update'), lockPreemption: refuse('lock-preemption'), unlockPreemption: refuse('unlock-preemption'),
 };

 let component, wasi, fmu, time, fault, generation = 0, closed = false;
 const startTime = index.defaultExperiment?.startTime ?? 0;
 const describe = error => {
  const stderr = wasi?.lines.length ? ' (guest stderr: ' + wasi.lines.slice(-3).join(' | ') + ')' : '';
  return `${error?.name ?? typeof error}: ${error?.message ?? error}${stderr}`;
 };
 const fail = message => { fault ??= message; throw new FmuFault(fault); };
 // Every timeline, read, write and binding operation first requires a live session.
 const live = () => { if (closed) throw Error('FMU session is closed.'); if (fault) throw new FmuFault(fault); };
 // kind 'get' and 'set': an error status is a refusal of that call (the guest's typed
 // setters are transactional); 'lifecycle' and 'step': any status beyond warning fails
 // the session. Exceptions that are not statuses (traps, glue errors) always fail it.
 const call = (what, kind, run) => {
  if (closed) throw Error('FMU session is closed.');
  if (fault) throw new FmuFault(fault);
  let result;
  try { result = run(); }
  catch (error) {
   const status = statusOf(error);
   if (status === undefined) fail(`FMU ${what} failed at t=${time}: ${describe(error)}`);
   if (kind === 'get' && status !== 'fatal') throw Error(`FMU ${what} returned ${status}`);
   fail(`FMU ${what} returned ${status} at t=${time}`);
  }
  if (typeof result === 'string' && STATUSES.has(result)) {
   if (result === 'warning') log.warn?.(`FMU ${what} returned warning at t=${time}`);
   else if (result !== 'ok') {
    if (kind === 'set' && result !== 'fatal') throw Error(`FMU ${what} returned ${result}`);
    fail(`FMU ${what} returned ${result} at t=${time}`);
   }
  }
  return result;
 };

 async function instantiateComponent() {
  wasi = createWasi(index.imports, log);
  const provided = {...wasi.imports, 'fmi:fmi3/callbacks': callbacks, 'fmi:fmi3/types': {},
   'fmi:fmi3/intermediate-update-callbacks': {intermediateUpdate: refuse('intermediate-update')}};
  // Only the versioned imports the build recorded. jco-transpile 0.23 glue looks them up
  // by their unversioned names; any other lookup is refused.
  const allowed = new Map(index.imports.map(name => [name.replace(/@[0-9.]+$/, ''), name]));
  const imports = new Proxy({}, {get(_, key) {
   if (typeof key !== 'string' || key === 'then') return undefined;
   const unversioned = key.replace(/@[0-9.]+$/, '');
   if (!allowed.has(unversioned) || (key !== unversioned && allowed.get(unversioned) !== key)) throw Error('FMU glue asked for an import outside its build manifest: ' + key);
   return provided[unversioned] ?? trappingInterface(unversioned);
  }});
  component = await glue.instantiate(getCoreModule, imports);
  const version = component.common.getVersion();
  if (version !== '3.0') throw Error('FMU reports FMI version ' + version);
 }
 function create() {
  fmu = call('instantiate-co-simulation', 'lifecycle', () => component.coSimulation.CoSimulationInstance.instantiateCoSimulation(
   instanceName, index.instantiationToken, '', false, false, false, false, new Uint32Array()));
  if (!fmu) fail('FMU refused to instantiate (token ' + index.instantiationToken + ').');
 }
 // Instantiated -> parameters -> initialization mode -> step mode at the start time.
 function initialise() {
  const names = Object.keys(parameters);
  if (names.length) {
   const parameterPlan = plan(table, names, ({variable}, name) => {
    if (variable.causality !== 'parameter' || !['fixed', 'tunable'].includes(variable.variability)) throw Error('Not an FMU parameter: ' + name);
   });
   writePlan(parameterPlan, Float64Array.from(names, name => parameters[name]), 'parameter');
  }
  call('enter-initialization-mode', 'lifecycle', () => fmu.enterInitializationMode(undefined, startTime, undefined));
  call('exit-initialization-mode', 'lifecycle', () => fmu.exitInitializationMode());
  time = startTime;
  // Calculated parameters correctly have no XML start. Read their settled
  // values before exposing the session; repeat this after reset as well.
  try {
   const names = Object.keys(fixedValues);
   if (names.length) {
    const fixedPlan = plan(table, names, ({variable}, name) => {
     if ((variable.dimensions ?? []).length || !['parameter', 'calculatedParameter'].includes(variable.causality) ||
         (variable.variability ?? 'fixed') !== 'fixed') throw Error('Not a scalar fixed FMU parameter: ' + name);
     toCell(variable.type, fixedValues[name]);
     if (!Number.isFinite(fixedValues[name])) throw Error('Invalid fixed FMU value: ' + name);
    });
    const values = readPlan(fixedPlan);
    names.forEach((name, i) => {
     if (!Object.is(values[i], fixedValues[name])) throw Error(`FMU fixed value ${name}=${values[i]}, expected ${fixedValues[name]}`);
    });
   }
  } catch (error) { fail('FMU fixed-value validation failed: ' + error.message); }
 }
 function readPlan(p) {
  const results = p.groups.map(group => toNumber(group.type, call('get-' + group.type, 'get', () => fmu[READ[group.type]](group.refs))));
  p.groups.forEach((group, i) => { if (results[i].length !== group.size) fail(`FMU get-${group.type} returned ${results[i].length} values for ${group.size}`); });
  const out = new Float64Array(p.index.length);
  for (let i = 0; i < out.length; i++) out[i] = results[p.group[i]][p.index[i]];
  return out;
 }
 function writePlan(p, values, what = 'input') {
  if (!(values instanceof Float64Array) || values.length !== p.index.length) throw Error(`FMU ${what} frame has ${values?.length} values for ${p.index.length} names`);
  for (const value of values) if (!Number.isFinite(value)) throw Error(`FMU ${what} values must be finite.`);
  const cells = Array.from(values, (value, i) => toCell(p.groups[p.group[i]].type, value));
  // Partially written array variables keep their other elements: read them first.
  const buffers = p.groups.map(group => buffer(group.type, group.size,
   group.complete ? undefined : call('get-' + group.type, 'get', () => fmu[READ[group.type]](group.refs))));
  for (let i = 0; i < cells.length; i++) buffers[p.group[i]][p.index[i]] = cells[i];
  // One setter per type. The guest's setters are each transactional, but there is no
  // transaction across them: a refusal after an earlier setter succeeded leaves the frame
  // partly applied, which fails the session (a new prepare starts clean). No rollback.
  p.groups.forEach((group, i) => {
   try { call('set-' + group.type, 'set', () => fmu[WRITE[group.type]](group.refs, buffers[i])); }
   catch (error) {
    if (i === 0 || error instanceof FmuFault) throw error;
    fail(`FMU ${what} frame partly applied at t=${time}: ${p.groups.slice(0, i).map(g => 'set-' + g.type).join(', ')} succeeded, then ${error.message}`);
   }
  });
 }

 // do-step from the carried time. Before the guest is entered, current + size must be
 // finite and later than current (else the call is refused and the session stays live).
 // The outcome is accepted only if last-successful-time is within STEP_TIME_ULPS of
 // current + size, strictly later than current, and no termination, event handling or early return is flagged; only
 // then is the time carried. Anything else fails the session at the last accepted time.
 function doStep(size) {
  const from = time, target = from + size;
  if (!Number.isFinite(target)) throw Error(`FMU step target ${from} + ${size} is not finite.`);
  if (!(target > from)) throw Error(`FMU step of ${size} from t=${from} does not advance the time.`);
  const result = call('do-step', 'step', () => fmu.doStep(from, size, false));
  const error = stepOutcomeError(from, size, result);
  if (error) fail(error);
  time = result.lastSuccessfulTime;
 }

 await instantiateComponent();
 phase('component_instantiated');
 onProgress({phase: 'construct'});
 try { create(); phase('fmi_instantiated'); onProgress({phase: 'initialize'}); initialise(); phase('initialized'); }
 catch (error) { try { fmu?.[Symbol.dispose]?.(); } catch {} throw error; }

 const bindings = new Map();
 let nextBinding = 1;
 const bind = p => { const id = nextBinding++; bindings.set(id, {generation, plan: p}); return id; };
 const bound = id => {
  const binding = bindings.get(id);
  if (!binding || binding.generation !== generation) throw Error('Stale FMU binding.');
  return binding.plan;
 };
 const parseNames = json => {
  const names = JSON.parse(json);
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) throw Error('FMU names must be a JSON array of strings.');
  return names;
 };
 const stateNames = [...table].filter(([, {variable}]) => SCALAR_TYPES.includes(variable.type) &&
  !['input', 'independent'].includes(variable.causality)).map(([name]) => name);
 const statePlan = plan(table, stateNames);
 const inputNames = [...table].filter(([, {variable}]) => variable.causality === 'input').map(([name]) => name);

 return {
  // Metadata, readable in any state: the last accepted time, names, the receipt, the fault.
  time: () => time,
  input_names: () => JSON.stringify(inputNames),
  variable_names: () => JSON.stringify([...table.keys()]),
  execution_receipt_json: () => JSON.stringify({engine: 'fmi3-ls-wasm', refusal: null, model: index.modelName, instantiation_token: index.instantiationToken,
   ...(startup && {startup}), load: {phases_ms: phases, compiled_modules: compileTimes.length,
    compile_ms_max: Math.max(0, ...compileTimes.map(entry => entry.ms)),
    compile_ms_sum: compileTimes.reduce((sum, entry) => sum + entry.ms, 0)}}),
  get fault() { return fault; },
  get messages() { return messages; },
  // One do-step to an absolute time (the worker's call): the step size is target - t.
  advance_to(target) {
   live();
   if (!Number.isFinite(target)) throw Error('FMU advance target must be finite.');
   if (target < time) throw Error(`FMU cannot advance backwards from t=${time} to ${target}.`);
   // The current time on a live session: nothing to step.
   if (target !== time) doStep(target - time);
  },
  // One do-step of a given size, as FMI hosts usually drive it.
  step(size) {
   live();
   if (!(Number.isFinite(size) && size > 0)) throw Error('FMU step size must be positive and finite.');
   doStep(size);
  },
  bind_inputs(json) {
   live();
   const names = parseNames(json);
   if (new Set(names).size !== names.length) throw Error('Duplicate FMU input names.');
   return bind(plan(table, names, ({variable}, name) => { if (variable.causality !== 'input') throw Error('Not an FMU input: ' + name); }));
  },
  write_bound(id, values) { live(); writePlan(bound(id), values); },
  bind_outputs(json) { live(); return bind(plan(table, parseNames(json))); },
  read_bound(id) { live(); return readPlan(bound(id)); },
  read_values(json) { live(); return readPlan(plan(table, parseNames(json))); },
  // Current public page worker API; all conversion/lookup completes before setters.
  set_inputs(json) {
   live();
   const rows = JSON.parse(json);
   if (!Array.isArray(rows) || !rows.every(row => Array.isArray(row) && row.length === 2 &&
       typeof row[0] === 'string' && typeof row[1] === 'number' && Number.isFinite(row[1])))
    throw Error('FMU inputs must be finite named numeric pairs.');
   const names = rows.map(row => row[0]);
   if (new Set(names).size !== names.length) throw Error('Duplicate FMU input names.');
   const p = plan(table, names, ({variable}, name) => {
    if (variable.causality !== 'input') throw Error('Not an FMU input: ' + name);
   });
   writePlan(p, Float64Array.from(rows, row => row[1]));
  },
  // Diagnostic read of Float64 value references, through the same fault owner as every call.
  read_references(refs) {
   live();
   if (!(refs instanceof Uint32Array)) throw Error('FMU value references must be a Uint32Array.');
   return Float64Array.from(call('get-Float64', 'get', () => fmu.getFloat64(refs)));
  },
  state_json() {
   live();
   const values = readPlan(statePlan);
   return '{"time":' + jsonNumber(time) + ',"values":{' + stateNames.map((name, i) => JSON.stringify(name) + ':' + jsonNumber(values[i])).join(',') + '}}';
  },
  // Back to the initial state through FMI reset; bindings issued before become stale.
  // A failed session cannot be reset: the worker reports the fault and prepares again.
  reset() {
   if (closed) throw Error('FMU session is closed.');
   if (fault) throw new FmuFault(fault + ' Prepare the simulation again.');
   generation++;
   call('reset', 'lifecycle', () => fmu.reset());
   initialise();
  },
  free() {
   if (closed) return;
   try { if (!fault) fmu?.terminate(); } catch {}
   try { fmu?.[Symbol.dispose]?.(); } catch {}
   closed = true;
   fmu = component = undefined;
  },
 };
}

// ---- the page's whole simulation as one FMU ----
// The FMU holds the plant and MicroduckPolicyInterface connected inside; only the policy
// network stays in JavaScript. The worker writes the command and the held previous values,
// reads the observation, writes the network's actions, steps, and reads the pose. The
// controller's plant-facing inputs and the plant's policy-position inputs are bound inside.
const indexed = (name, count) => Array.from({length: count}, (_, i) => `${name}[${i + 1}]`);
export const SIMULATION_INPUTS = Object.freeze(['forwardVelocity', 'lateralVelocity', 'steeringRate', 'hasPreviousPositionCommand',
 ...indexed('previousPolicyAction', 14), ...indexed('previousCommand', 3), ...indexed('previousPositionCommand', 15), ...indexed('policyAction', 14)]);
export const SIMULATION_OUTPUTS = Object.freeze([...indexed('policyObservation', 61), ...indexed('positionCommand', 15),
 ...indexed('filteredCommand', 3), 'clippedPolicyActions',
 ...Array.from({length: 45}, (_, i) => `bodyPosition[${Math.floor(i / 3) + 1},${i % 3 + 1}]`),
 ...Array.from({length: 135}, (_, i) => `bodyRotation[${Math.floor(i / 9) + 1},${Math.floor(i / 3) % 3 + 1},${i % 3 + 1}]`)]);
// Historical closed-selector fixture contract; current worker supplies checkPageInterface.
const BOUND_INSIDE = Object.freeze(['usePolicyPosition', ...indexed('policyPosition', 15)]);

export function checkSimulationInterface(variables) {
 const table = scalarTable(variables);
 const missingInput = SIMULATION_INPUTS.find(name => table.get(name)?.variable.causality !== 'input');
 if (missingInput) return 'the FMU has no input ' + missingInput;
 const missingOutput = SIMULATION_OUTPUTS.find(name => !table.has(name) || table.get(name).variable.causality === 'input');
 if (missingOutput) return 'the FMU has no output ' + missingOutput;
 const open = BOUND_INSIDE.find(name => table.get(name)?.variable.causality === 'input');
 if (open) return `the FMU leaves ${open} open (a plant-only FMU; the page needs plant and controller in one FMU)`;
 return undefined;
}

/**
 * Decide whether the page manifest offers a usable whole-simulation FMU for `model`.
 * Returns undefined when none is offered (the worker keeps today's path), {fallback}
 * with the reason when one is offered but cannot be used, else {index, base}.
 * Current-page use also supplies its full typed interface and model/options/library
 * contract. Browser library-pin comparison is not proof of compiled library bodies.
 */
export async function offeredFmu({model, sources = {}, base, fetch: fetchFile = globalThis.fetch,
 sourceProvider, expectedPageBinding, interfaceCheck = checkSimulationInterface}) {
 let manifest;
 try { const response = await fetchFile(new URL('manifest.json', base)); if (!response.ok) return undefined; manifest = await response.json(); }
 catch { return undefined; }
 if (manifest?.version !== 1) return {fallback:'unsupported FMU manifest version'};
 const entry = manifest?.models?.[model]?.fmu;
 if (entry === undefined) return undefined;
 if (typeof entry?.index !== 'string') return {fallback: 'invalid FMU entry in the manifest'};
 if (!supportsMultiMemory()) return {fallback: 'this browser lacks WebAssembly multi-memory'};
 let index;
 try { index = await loadFmuIndex(new URL(entry.index, base), entry.sha256, {fetch: fetchFile}); }
 catch (error) { return {fallback: String(error?.message ?? error)}; }
 let sourcePins = {};
 if (sourceProvider) {
  try { ({sources, sourcePins} = await sourceProvider()); }
  catch (error) { return {fallback: String(error?.message ?? error)}; }
 }
 if (expectedPageBinding) {
  const expected = await expectedPageBinding();
  if ((index.defaultExperiment?.startTime ?? 0) !== 0 || expected.selectedModel !== model || index.modelName !== WHOLE_MODEL || index.sourceModel !== WHOLE_MODEL ||
      (!index.pageBinding || canonicalJson(index.pageBinding) !== canonicalJson(expected)))
   return {fallback: 'the FMU whole-model, selected model, default start, standard-library pin or runtime options differ'};
 }
 // Require the full recorded keyset. Editable/wrapper bodies are hashed here;
 // library bytes are the producer's responsibility, compared here by current-build pins.
 const recorded = index.sources;
 if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded) || !Object.keys(recorded).length) return {fallback: 'the FMU index records no page sources'};
 if (typeof index.sourceModel !== 'string' || !index.sourceModel) return {fallback: 'the FMU index does not name the model it was built from'};
 if (!Object.hasOwn(recorded, index.sourceModel + '.mo')) return {fallback: `${index.sourceModel}.mo is not in the FMU's source set`};
 for (const file of Object.keys(sourcePins)) if (Object.hasOwn(sources, file)) return {fallback: 'overlapping FMU body and library-pin source ' + file};
 for (const file of [...Object.keys(sources), ...Object.keys(sourcePins)]) if (!Object.hasOwn(recorded, file)) return {fallback: `page source ${file} is not in the FMU's source set`};
 for (const [file, sha256] of Object.entries(recorded)) {
  if (typeof sources[file] !== 'string' && !Object.hasOwn(sourcePins, file)) return {fallback: 'missing page source ' + file};
  const pinnedLibrary = Object.hasOwn(sourcePins, file);
  if ((pinnedLibrary ? sourcePins[file] : await digest(new TextEncoder().encode(sources[file]))) !== sha256)
   return {fallback: (pinnedLibrary ? 'the FMU standard-library source pin differs: ' : 'edited page source ') + file};
 }
 const mismatch = interfaceCheck(index.variables);
 if (mismatch) return {fallback: mismatch};
 return {index, base: new URL(entry.index, base)};
}

// Current page wrapper: full source declarations, including explicit manual inputs
// and BOTH policy selectors. The historical closed-selector fixture gate above is
// not the production page gate. Typed shape/causality checks refuse omissions.
export function checkPageInterface(variables) {
 if (!Array.isArray(variables)) return 'the whole-system FMU needs a typed variable table';
 const members = name => variables.filter(variable => variable?.name === name ||
  (typeof variable?.name === 'string' && variable.name.startsWith(name + '[')));
 const sameShape = (actual, expected) => Array.isArray(actual) && actual.length === expected.length &&
  actual.every((extent, index) => extent === expected[index]);
 for (const [causality, groups] of [['input', PAGE_INPUT_GROUPS], ['output', PAGE_OUTPUT_GROUPS]]) {
  for (const [name, type, shape] of groups) {
   const actual = members(name), expected = new Set(scalarNames(name, shape));
   if (!actual.length && causality === 'output' && PAGE_OPTIONAL_OUTPUTS.has(name)) continue;
   const aggregate = actual.find(variable => variable.name === name);
   // FMI permits an array variable or individually scalarized names. Accept only
   // the exact source shape/member set, never a superset with hidden extra lanes.
   const exactShape = aggregate ? actual.length === 1 && sameShape(aggregate.dimensions ?? [], shape) :
    actual.length === expected.size && new Set(actual.map(variable => variable.name)).size === expected.size &&
    actual.every(variable => expected.has(variable.name) && sameShape(variable.dimensions ?? [], []));
   if (!exactShape || actual.some(variable => variable.causality !== causality || variable.type !== type))
    return `the whole-system FMU needs exact ${type} ${causality} ${name} shape [${shape.join(',')}]`;
  }
 }
 for (const [name, value] of Object.entries(PAGE_FIXED_VALUES)) {
  const actual = members(name), variable = actual[0];
  if (actual.length !== 1 || variable.name !== name || !sameShape(variable.dimensions ?? [], []) ||
      variable.type !== 'Int64' || (variable.variability ?? 'fixed') !== 'fixed')
   return `the whole-system FMU needs scalar fixed Int64 parameter ${name}=${value}`;
  const declared = variable.causality === 'parameter' && (variable.initial ?? 'exact') === 'exact' &&
   variable.start?.length === 1 && String(variable.start[0]) === String(value);
  const calculated = variable.causality === 'calculatedParameter' && (variable.initial ?? 'calculated') === 'calculated' &&
   variable.start === undefined;
  if (!declared && !calculated)
   return `the whole-system FMU needs fixed Int64 parameter ${name}=${value} or its calculated value`;
  // Metadata acceptance never substitutes for the initialized typed getter:
  // the page passes PAGE_FIXED_VALUES to openFmuSession before using the model.
 }
 return undefined;
}
