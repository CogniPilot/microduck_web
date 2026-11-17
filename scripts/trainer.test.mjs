import test from 'node:test';
import assert from 'node:assert/strict';
import {createArs, residual} from '../site/ars.js';
import {createTrainer} from '../site/trainer.js';

// The LQR problem of ars.test.mjs, served through an asynchronous rollout pool whose episodes
// finish in a scrambled order, as parallel workers do.
const dt = 0.1, B = [0.5 * dt * dt, dt], horizon = 60;
const base = x => -(0.3 * x[0] + 0.3 * x[1]);
function lqrRollout(delays) {
  let call = 0;
  return async policy => {
    const wait = delays[call++ % delays.length];
    await new Promise(resolve => setTimeout(resolve, wait));
    let x = [1, 0], cost = 0;
    const stats = {count: 0, mean: [0, 0], m2: [0, 0]};
    for (let t = 0; t < horizon; t++) {
      const u = base(x) + residual(policy.weights, policy, x, 1)[0];
      cost += x[0] * x[0] + x[1] * x[1] + 0.1 * u * u;
      x = [x[0] + dt * x[1] + B[0] * u, x[1] + B[1] * u];
    }
    return {value: -cost, progress: -cost, fell: null, stats};
  };
}
const config = {actions: 1, observations: 2, directions: 8, top: 4, stepSize: 0.05, noise: 0.05, seed: 5};

test('the trainer improves the evaluated return over the baseline', async () => {
  const trainer = createTrainer({ars: createArs(config), rollout: lqrRollout([0])});
  const baseline = await trainer.baseline();
  const seen = [];
  const history = await trainer.run(120, entry => seen.push(entry.iteration));
  assert.equal(history.length, 120);
  assert.deepEqual(seen, Array.from({length: 120}, (_, i) => i + 1));
  // ars.test.mjs shows this problem leaves more than 1 of return to gain over the baseline.
  assert.ok(history.at(-1).evaluation > baseline.value + 1, `evaluation ${history.at(-1).evaluation} vs baseline ${baseline.value}`);
});

test('completion order of parallel rollouts does not change the result', async () => {
  const ordered = createTrainer({ars: createArs(config), rollout: lqrRollout([0])});
  const scrambled = createTrainer({ars: createArs(config), rollout: lqrRollout([7, 0, 3, 11, 1, 5, 2, 9, 4])});
  const a = await ordered.run(5), b = await scrambled.run(5);
  assert.deepEqual(b, a);
});

test('stop ends training after the current iteration without applying a partial one', async () => {
  const ars = createArs(config);
  const trainer = createTrainer({ars, rollout: lqrRollout([1])});
  const history = await trainer.run(50, entry => { if (entry.iteration === 3) trainer.stop(); });
  assert.equal(history.length, 3);
  assert.equal(ars.iteration(), 3);
});
