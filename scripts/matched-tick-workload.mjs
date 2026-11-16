// Shared by rumoca-tick.mjs and mujoco-tick.mjs: workload constants, the per-tick input law, the page-side named readout,
// argument and progress validation, input-manifest verification, statistics and the result writer.
import fs from 'node:fs';
import crypto from 'node:crypto';

export const SCHEMA = 'matched-tick-result/2';
export const TICK_SECONDS = 0.02;
export const TICKS = 500;
export const WARMUP = 10;
export const TICKS_MAX = 2000;
export const AMPLITUDE = 0.05;
// Progress tolerance (s) between the engine's actual time after tick n and n * TICK_SECONDS. Chosen: far below the 2 ms and
// 5 ms engine steps (a skipped step fails) and far above the accumulated rounding of 4 x 0.005 over 2000 additions (about 1e-11).
export const TIME_TOL = 1e-6;
// Engine A drives 15 servos (index 9, zero-based, is the jaw); engine B has 14 actuators in the order of constants.js
// JOINT_NAMES. B actuator j takes the offset of A servo B_FROM_A[j].
export const B_FROM_A = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14];

export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const fileSha = (path) => sha256(fs.readFileSync(path));
export const delta = (t, i) => AMPLITUDE * Math.sin(2 * Math.PI * t + i);

// `--key value` pairs; unknown keys, duplicate keys and a missing value are errors.
export function parseArgs(argv, defaults, allowed) {
  const out = { ...defaults }, seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) throw new Error(`bad argument ${argv[i]}`);
    const key = argv[i].slice(2);
    if (!allowed.includes(key)) throw new Error(`unknown argument --${key}`);
    if (seen.has(key)) throw new Error(`duplicate argument --${key}`);
    seen.add(key);
    out[key] = argv[i + 1];
  }
  return out;
}

// Digits only; no sign, space, exponent, hex or empty text.
export function parseCount(name, text, min, max) {
  if (!/^[0-9]{1,7}$/.test(String(text))) throw new Error(`--${name} must be digits only`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`--${name} must be in ${min}..${max}`);
  return n;
}
export function runShape(a) {
  const ticks = parseCount('ticks', a.ticks, 1, TICKS_MAX);
  const warmup = parseCount('warmup', a.warmup, 0, ticks - 1);
  return { ticks, warmup };
}

// sha256sum-format manifest: "<64 hex>  <absolute path>" per line; anything else, or a repeated path, is an error.
export function loadManifest(path) {
  const map = new Map();
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    const m = /^([0-9a-f]{64})  (\/.+)$/.exec(line);
    if (!m || map.has(m[2])) throw new Error(`bad or repeated manifest line: ${line.slice(0, 120)}`);
    map.set(m[2], m[1]);
  }
  if (map.size === 0) throw new Error('empty manifest');
  return map;
}
// observed: { path: sha256 of the bytes the driver actually loaded }. Every one must be listed with the same digest.
export function verifyInputs(manifest, observed) {
  const bad = [];
  for (const [path, digest] of Object.entries(observed)) if (manifest.get(path) !== digest) bad.push(path);
  if (bad.length) throw new Error('inputs differ from the manifest or are not listed: ' + bad.join(' '));
}

// sha256 over little-endian doubles of base[k] + delta(t, idx[k]) for every tick 1..ticks (base null: the deltas alone).
export function targetsChecksum(base, idx, ticks) {
  const buffer = Buffer.alloc(8 * idx.length * ticks);
  let at = 0;
  for (let tick = 1; tick <= ticks; tick++) {
    const t = TICK_SECONDS * tick;
    for (let k = 0; k < idx.length; k++) {
      buffer.writeDoubleLE((base === null ? 0 : base[k]) + delta(t, idx[k]), at);
      at += 8;
    }
  }
  return sha256(buffer);
}

// The same expression as the product's createReadout (site/session-readout.js lines 12-16): one object per call.
export const namedObject = (names, values) =>
  Object.fromEntries(names.map((name, i) => [name, Number.isFinite(values[i]) ? values[i] : null]));

export const allFinite = (values) => values.length > 0 && Array.prototype.every.call(values, Number.isFinite);

// After the loop: the engine's own time after each tick must be finite, strictly increasing and within TIME_TOL of the target.
export function checkProgress(simTimes, ticks) {
  const failures = [];
  let completed = 0, prev = 0, ok = true;
  for (let k = 0; k < ticks; k++) {
    const t = simTimes[k], target = TICK_SECONDS * (k + 1);
    if (!(Number.isFinite(t) && t > prev && Math.abs(t - target) <= TIME_TOL)) {
      if (ok) failures.push(`tick ${k + 1}: engine time ${t} (previous ${prev}, target ${target}, tolerance ${TIME_TOL})`);
      ok = false;
    }
    if (ok) completed = k + 1;
    prev = Number.isFinite(t) ? t : prev;
  }
  return { completedTicks: completed, finalHorizonSeconds: simTimes[ticks - 1], tolerance: TIME_TOL, failures };
}

export function stats(series, from) {
  const s = Float64Array.from(series.subarray(from)).sort();
  const n = s.length;
  if (n < 1) throw new Error('no counted ticks');
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  return { min: s[0], median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2, mean: sum / n, p95: s[Math.ceil(0.95 * n) - 1], max: s[n - 1] };
}

// One result shape for both engines. `timing` holds the four preallocated per-tick arrays (milliseconds); `simTimes` the engine
// time read after each tick (outside the measured interval); `failures` the driver's final-state failures. Returns accepted.
export function finish(head, timing, simTimes, failures, ticks, warmup, rawPath, outPath) {
  const progress = checkProgress(simTimes, ticks);
  const all = [...failures, ...progress.failures];
  const result = {
    schema: SCHEMA,
    ...head,
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform}-${process.arch}`,
    accepted: all.length === 0 && progress.completedTicks === ticks,
    acceptanceFailures: all,
    progress: { completedTicks: progress.completedTicks, finalHorizonSeconds: progress.finalHorizonSeconds, toleranceSeconds: progress.tolerance },
    perTickMs: {
      total: stats(timing.total, warmup),
      inputs: stats(timing.inputs, warmup),
      advance: stats(timing.advance, warmup),
      readout: stats(timing.readout, warmup),
    },
    ticks,
    warmup,
    counted: ticks - warmup,
    endedAt: new Date().toISOString(),
  };
  if (rawPath) {
    const block = new Float64Array(5 * ticks);
    block.set(timing.total, 0); block.set(timing.inputs, ticks); block.set(timing.advance, 2 * ticks); block.set(timing.readout, 3 * ticks); block.set(simTimes, 4 * ticks);
    fs.writeFileSync(rawPath, Buffer.from(block.buffer), { flag: 'wx' });
    result.rawTicksFile = { path: rawPath, layout: 'little-endian float64, five consecutive blocks of `ticks` values: total, inputs, advance, readout (ms), engine time after the tick (s)' };
  }
  const text = JSON.stringify(result, null, 1);
  if (outPath) fs.writeFileSync(outPath, text, { flag: 'wx' });
  console.log(text);
  return result.accepted;
}
