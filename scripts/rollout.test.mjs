import test from 'node:test';
import assert from 'node:assert/strict';
import {runEpisode, TASKS, TICK_S, appliedAction} from '../site/rollout.js';

// A stand-in plant with the worker's step/reset contract: the trunk moves forward by the
// residual's first component plus a base speed each tick, and falls when x passes `fallAt`.
function plant({fallAt = Infinity} = {}) {
  let x = 0, time = 0;
  const calls = [];
  const frame = () => ({time, bodies: [{position: [x, 0, 0.2]}], outputs: {fallen: x > fallAt}});
  return {
    calls,
    reset: async () => { x = 0; time = 0; return frame(); },
    step: async ({time: target, twist, residual}) => {
      calls.push({target, twist, residual});
      const applied = residual ? Array.from({length: 14}, (_, i) => [0.5, -0.25][i] ?? 0) : new Array(14).fill(0);
      x += 0.3 * TICK_S + applied[0] * TICK_S;
      time = target;
      return {frame: frame(), observation: [x, time], residual: residual ? applied : null};
    }
  };
}
const task = {...TASKS.walkForward};

test('an episode runs the task duration and returns forward progress', async () => {
  const p = plant();
  const out = await runEpisode({reset: p.reset, step: p.step, task, observations: 2});
  assert.equal(out.ticks, 150);
  assert.equal(out.fell, null);
  assert.ok(Math.abs(out.progress - 0.3 * 3) < 1e-9);
  assert.ok(Math.abs(out.value - out.progress) < 1e-12, 'no residual, no fall: return is progress');
  assert.equal(p.calls.length, 150);
  assert.deepEqual(p.calls[0].twist, [0.3, 0, 0]);
  assert.equal(p.calls.at(-1).target, 3);
  assert.equal(out.stats.count, 150);
});

test('the residual policy is passed to every tick and its size is charged', async () => {
  const p = plant(), policy = {weights: [1], mean: [0], std: [1]};
  const out = await runEpisode({reset: p.reset, step: p.step, task, residualPolicy: policy, observations: 2});
  assert.ok(p.calls.every(c => c.residual === policy));
  const progress = (0.3 + 0.5) * 3, cost = task.residualCost * (0.5 ** 2 + 0.25 ** 2);
  assert.ok(Math.abs(out.progress - progress) < 1e-9);
  assert.ok(Math.abs(out.value - (progress - cost)) < 1e-9);
});

test('a fall ends the episode at that tick and is penalized', async () => {
  const p = plant({fallAt: 0.1});
  const out = await runEpisode({reset: p.reset, step: p.step, task, observations: 2});
  assert.equal(out.fell, out.ticks - 1);
  assert.ok(out.ticks < 150);
  assert.ok(Math.abs(out.value - (out.progress - task.fallPenalty)) < 1e-12);
});

test('a reset that does not return time zero or a mistimed tick is refused', async () => {
  await assert.rejects(runEpisode({reset: async () => ({time: 1, bodies: [{position: [0, 0, 0]}]}), step: async () => ({}), task}), /time zero/);
  const p = plant();
  const late = async args => { const r = await p.step(args); r.frame.time += 0.001; return r; };
  await assert.rejects(runEpisode({reset: p.reset, step: late, task, observations: 2}), /unexpected simulation time/);
});

test('a zero residual leaves the pretrained action bit for bit, including negative zero', () => {
  const raw = Float32Array.of(-0, 0.25, -1.5);
  assert.equal(appliedAction(raw, null), raw);
  const same = appliedAction(raw, Float64Array.of(0, -0, 0));
  assert.ok(Object.is(same[0], -0));
  assert.deepEqual(Array.from(same), Array.from(raw));
  const moved = appliedAction(raw, Float64Array.of(0.5, 0, 0.125));
  assert.deepEqual(Array.from(moved), [0.5, 0.25, -1.375]);
  assert.ok(moved instanceof Float32Array);
});

test('a malformed frame rejects the episode instead of becoming a reward', async () => {
  const malformed = [
    ['time NaN', r => { r.frame.time = NaN; }, /unexpected simulation time/],
    ['fallen missing', r => { delete r.frame.outputs.fallen; }, /whether the robot fell/],
    ['fallen null', r => { r.frame.outputs.fallen = null; }, /whether the robot fell/],
    ['fallen 2', r => { r.frame.outputs.fallen = 2; }, /whether the robot fell/],
    ['observation NaN', r => { r.observation = [NaN, r.observation[1]]; }, /invalid observation/],
    ['observation short', r => { r.observation = [r.observation[0]]; }, /invalid observation/],
    ['residual Infinity', r => { if (r.residual) r.residual[3] = Infinity; }, /invalid residual/],
    ['trunk position NaN', r => { r.frame.bodies[0].position[0] = NaN; }, /trunk position/]
  ];
  for (const [label, corrupt, pattern] of malformed) {
    const p = plant();
    const bad = async args => { const r = await p.step(args); if (args.time > 0.5) corrupt(r); return r; };
    await assert.rejects(runEpisode({reset: p.reset, step: bad, task: {...task, seconds: 1}, residualPolicy: {weights: [1]}, observations: 2}), pattern, label);
  }
  const numeric = plant({fallAt: 0.05});
  const asNumber = async args => { const r = await numeric.step(args); r.frame.outputs.fallen = r.frame.outputs.fallen ? 1 : 0; return r; };
  const out = await runEpisode({reset: numeric.reset, step: asNumber, task, observations: 2});
  assert.ok(out.fell !== null, 'numeric 0/1 fallen is accepted');
});
