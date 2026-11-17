import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrainingPool} from '../site/training-pool.js';

// A worker stand-in that answers prepare at once and each rollout after `delay` ms with the
// residual's first weight, so results can be matched to their requests.
function fakeWorkers({delay = 1, fail = () => false} = {}) {
  const made = [];
  const createWorker = () => {
    const worker = {
      messages: [], inFlight: 0, maxInFlight: 0, terminated: false,
      postMessage(message) {
        this.messages.push(message);
        if (message.type === 'prepare') { queueMicrotask(() => this.onmessage({data: {id: message.id, result: {ready: true}}})); return; }
        this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        setTimeout(() => {
          this.inFlight--;
          if (this.terminated) return;
          const data = fail(message) ? {id: message.id, error: 'Simulation refused the step.'}
            : {id: message.id, result: {value: message.residual?.weights?.[0] ?? -1, task: message.task}};
          this.onmessage({data});
        }, delay);
      },
      terminate() { this.terminated = true; }
    };
    made.push(worker);
    return worker;
  };
  return {made, createWorker};
}
const prepare = {type: 'prepare', sources: {}, model: 'MicroduckJawLocked', requireFmu: true};

test('each worker prepares its own plant before any rollout', async () => {
  const f = fakeWorkers(), pool = createTrainingPool({size: 3, createWorker: f.createWorker, prepare});
  await pool.start();
  assert.equal(pool.size(), 3);
  for (const w of f.made) assert.deepEqual(w.messages.map(m => m.type), ['prepare']);
  assert.equal(f.made[0].messages[0].requireFmu, true);
  pool.close();
});

test('rollouts spread over the workers, one at a time each, and keep their results', async () => {
  const f = fakeWorkers({delay: 3}), pool = createTrainingPool({size: 2, createWorker: f.createWorker, prepare});
  await pool.start();
  const results = await Promise.all([1, 2, 3, 4, 5].map(k => pool.rollout('walkForward', {weights: [k]})));
  assert.deepEqual(results.map(r => r.value), [1, 2, 3, 4, 5]);
  assert.ok(f.made.every(w => w.maxInFlight === 1));
  assert.ok(f.made.every(w => w.messages.some(m => m.type === 'rollout')), 'both workers used');
  assert.equal(results[0].task, 'walkForward');
  pool.close();
});

test('a refused rollout rejects only itself; close rejects the rest and stops the workers', async () => {
  const f = fakeWorkers({delay: 5, fail: m => m.residual?.weights?.[0] === 2});
  const pool = createTrainingPool({size: 1, createWorker: f.createWorker, prepare});
  await pool.start();
  const first = pool.rollout('walkForward', {weights: [1]}), second = pool.rollout('walkForward', {weights: [2]});
  assert.equal((await first).value, 1);
  await assert.rejects(second, /refused the step/);
  const pending = pool.rollout('walkForward', {weights: [3]}), queued = pool.rollout('walkForward', {weights: [4]});
  pool.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(queued, /closed/);
  assert.ok(f.made.every(w => w.terminated));
  await assert.rejects(pool.rollout('walkForward', null), /closed/);
});

test('a worker that never answers times out and closes the pool: nothing more runs on it', async () => {
  let terminated = 0;
  const pool = createTrainingPool({size: 1, prepare, timeoutMs: 20,
    createWorker: () => ({postMessage(m) { if (m.type === 'prepare') queueMicrotask(() => this.onmessage({data: {id: m.id, result: {}}})); }, terminate() { terminated++; }})});
  await pool.start();
  const running = pool.rollout('walkForward', null), queued = pool.rollout('walkForward', null);
  await assert.rejects(running, /timed out/);
  await assert.rejects(queued, /closed: a training worker timed out/);
  assert.equal(terminated, 1);
  assert.equal(pool.closed(), 'a training worker timed out');
  await assert.rejects(pool.rollout('walkForward', null), /closed/);
});

test('a crashed worker closes the pool and rejects its running rollout', async () => {
  const f = fakeWorkers({delay: 50}), pool = createTrainingPool({size: 1, createWorker: f.createWorker, prepare});
  await pool.start();
  const running = pool.rollout('walkForward', {weights: [1]});
  f.made[0].onerror(new Event('error'));
  await assert.rejects(running, /closed: a training worker crashed/);
  assert.ok(f.made[0].terminated);
});

test('a failed preparation closes the pool', async () => {
  const pool = createTrainingPool({size: 2, prepare,
    createWorker: () => ({postMessage(m) { queueMicrotask(() => this.onmessage({data: {id: m.id, error: 'FMU did not load'}})); }, terminate() {}})});
  await assert.rejects(pool.start(), /FMU did not load/);
  assert.equal(pool.closed(), 'worker preparation failed');
  await assert.rejects(pool.rollout('walkForward', null), /closed/);
});

test('Stop during preparation rejects start and terminates the workers being prepared', async () => {
  let terminated = 0;
  const pool = createTrainingPool({size: 2, prepare,
    createWorker: () => ({postMessage() {}, terminate() { terminated++; }})});
  const starting = pool.start();
  pool.close();
  await assert.rejects(starting, /closed: stopped/);
  assert.equal(terminated, 2);
  await assert.rejects(pool.rollout('walkForward', null), /closed: stopped/);
});

test('Stop closes the pool at once, without waiting for the running episode', async () => {
  const f = fakeWorkers({delay: 10000}), pool = createTrainingPool({size: 1, createWorker: f.createWorker, prepare});
  await pool.start();
  const running = pool.rollout('walkForward', {weights: [1]}), started = Date.now();
  pool.close();
  await assert.rejects(running, /closed: stopped/);
  assert.ok(Date.now() - started < 1000);
  assert.ok(f.made[0].terminated);
});
