import test from 'node:test';
import assert from 'node:assert/strict';
import {createArs, createStats, residual, loadArs, normalizer} from '../site/ars.js';
import {createTrainer, createBestTracker, residualPolicy} from '../site/trainer.js';

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
    // The visited states, as a real rollout reports them for the learner's normalization.
    const visited = createStats(2);
    for (let t = 0; t < horizon; t++) {
      visited.add(x);
      const u = base(x) + residual(policy.weights, policy, x, 1)[0];
      cost += x[0] * x[0] + x[1] * x[1] + 0.1 * u * u;
      x = [x[0] + dt * x[1] + B[0] * u, x[1] + B[1] * u];
    }
    const {count, mean, m2} = visited.snapshot();
    return {value: -cost, progress: -cost, fell: null, stats: {count, mean: Array.from(mean), m2: Array.from(m2)}};
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

test('a pool closed mid-iteration (Stop or a failed worker) drops that iteration whole', async () => {
  const ars = createArs(config), healthy = lqrRollout([0]);
  let calls = 0;
  // Iteration 3's sixth episode is refused, as a closed pool refuses every running episode.
  const rollout = policy => (++calls === 2 * (2 * config.directions + 1) + 6 ? Promise.reject(Error('The training pool is closed: stopped.')) : healthy(policy));
  const trainer = createTrainer({ars, rollout});
  await trainer.run(2);
  const weights = ars.weights(), stats = ars.stats.snapshot();
  await assert.rejects(trainer.run(5), /closed: stopped/);
  assert.equal(ars.iteration(), 2, 'the learner keeps its last completed iteration');
  assert.deepEqual(ars.weights(), weights);
  assert.deepEqual(ars.stats.snapshot(), stats);
  ars.propose();
});

// Iteration k (1-based) makes 2 * directions candidate episodes and then one evaluation.
const perIteration = 2 * config.directions + 1;
const refuseCall = n => { const healthy = lqrRollout([0]); let calls = 0;
  return policy => (++calls === n ? Promise.reject(Error('The training pool is closed: stopped.')) : healthy(policy)); };

test('a refused evaluation after the update restores the whole iteration, W and statistics included', async () => {
  const ars = createArs(config), trainer = createTrainer({ars, rollout: refuseCall(2 * perIteration + perIteration)});
  await trainer.run(2);
  const before = ars.save();
  await assert.rejects(trainer.run(5), /closed: stopped/);
  assert.deepEqual(ars.save(), before, 'W, iteration, statistics and random state are those of iteration 2');
  assert.equal(trainer.history().length, 2, 'the retained iteration equals the last completed history entry');
});

test('a run stopped mid-iteration and continued equals an uninterrupted run', async () => {
  const uninterrupted = createArs(config);
  await createTrainer({ars: uninterrupted, rollout: lqrRollout([0])}).run(5);
  // Stopped during iteration 3's evaluation, then continued for the remaining 3 iterations.
  const interrupted = createArs(config), trainer = createTrainer({ars: interrupted, rollout: refuseCall(3 * perIteration)});
  await assert.rejects(trainer.run(5), /closed/);
  assert.equal(interrupted.iteration(), 2);
  await trainer.run(3);
  assert.deepEqual(interrupted.save(), uninterrupted.save());
});

test('Stop that lands during the post-update evaluation keeps that completed iteration', async () => {
  const ars = createArs(config);
  let trainer, calls = 0;
  const healthy = lqrRollout([0]);
  trainer = createTrainer({ars, rollout: policy => { if (++calls === perIteration) trainer.stop(); return healthy(policy); }});
  const history = await trainer.run(5);
  assert.equal(history.length, 1);
  assert.equal(ars.iteration(), 1);
});

// The best evaluated checkpoint. Evaluations are every perIteration-th rollout call; `scripted`
// replaces those evaluation returns (and optionally candidate returns) to force a regression.
const bestPerIteration = 2 * config.directions + 1;
function scriptedRollout({evaluations = [], candidate = () => null, refuse = () => false, seen = []}) {
  const healthy = lqrRollout([0]);
  let calls = 0;
  return async policy => {
    const n = ++calls, isEvaluation = n % bestPerIteration === 0, k = n / bestPerIteration - 1;
    if (refuse(n)) throw Error('The training pool is closed: a training worker crashed.');
    const result = await healthy(policy);
    if (isEvaluation) { seen.push({iteration: k + 1, policy}); if (k < evaluations.length) return {...result, value: evaluations[k], progress: evaluations[k]}; }
    else { const override = candidate(n); if (override !== null) return {...result, value: override}; }
    return result;
  };
}

test('a later regression keeps the earlier best complete checkpoint, and training continues from the current learner', async () => {
  const ars = createArs(config), best = createBestTracker(), atIteration = {};
  const trainer = createTrainer({ars, best, rollout: scriptedRollout({evaluations: [1, 3, 2, 2.5]})});
  await trainer.run(4, entry => { atIteration[entry.iteration] = ars.save(); });
  const kept = best.best();
  assert.equal(kept.iteration, 2);
  assert.equal(kept.evaluation, 3);
  assert.deepEqual(kept.checkpoint, atIteration[2], 'the whole learner as it was right after iteration 2 committed');
  assert.equal(ars.iteration(), 4, 'no rollback: the learner is still at iteration 4');
  assert.deepEqual(ars.save(), atIteration[4]);
});

test('the best checkpoint carries the normalization its evaluated weights were evaluated with', async () => {
  const ars = createArs(config), best = createBestTracker(), seen = [];
  await createTrainer({ars, best, rollout: scriptedRollout({evaluations: [1, 3, 2], seen})}).run(3);
  const kept = best.best(), loaded = loadArs(kept.checkpoint);
  const evaluated = seen.find(s => s.iteration === kept.iteration).policy;
  assert.deepEqual(residualPolicy(loaded.weights(), normalizer(loaded.stats.snapshot())), evaluated);
});

test('an iteration that does not commit, or a better candidate return, never replaces the best', async () => {
  const ars = createArs(config), best = createBestTracker();
  // Iteration 2: one candidate returns 100, then its mean evaluation is refused.
  const trainer = createTrainer({ars, best, rollout: scriptedRollout({evaluations: [1, 50],
    candidate: n => (n === bestPerIteration + 1 ? 100 : null), refuse: n => n === 2 * bestPerIteration})});
  await assert.rejects(trainer.run(3), /crashed/);
  const kept = best.best();
  assert.equal(kept.iteration, 1);
  assert.equal(kept.evaluation, 1, 'neither the candidate 100 nor the uncommitted iteration counts');
  assert.equal(ars.iteration(), 1);
  // A tie does not replace: the earliest best stays.
  assert.equal(best.offer({iteration: 9, evaluation: 1, progress: 1}, ars.save()), false);
  // The tracker hands out copies: mutating one cannot alter the kept checkpoint.
  kept.checkpoint.weights[0] = 123;
  assert.notEqual(best.best().checkpoint.weights[0], 123);
});
