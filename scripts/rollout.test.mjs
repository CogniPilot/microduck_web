import test from 'node:test';
import assert from 'node:assert/strict';
import {runEpisode, TASKS, TICK_S} from '../site/rollout.js';

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
      const applied = residual ? [0.5, -0.25] : [0, 0];
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
