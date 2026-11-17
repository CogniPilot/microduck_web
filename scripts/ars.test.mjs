import test from 'node:test';
import assert from 'node:assert/strict';
import {createRandom, createStats, normalizer, residual, createArs, loadArs} from '../site/ars.js';

test('the random stream is reproducible from its seed and from a snapshot', () => {
  const a = createRandom(7), b = createRandom(7);
  const first = Array.from({length: 5}, () => a.normal());
  assert.deepEqual(first, Array.from({length: 5}, () => b.normal()));
  const resumed = createRandom(7, a.snapshot());
  assert.deepEqual(Array.from({length: 5}, () => resumed.normal()), Array.from({length: 5}, () => a.normal()));
  assert.notDeepEqual(first, Array.from({length: 5}, () => createRandom(8).normal()));
});

test('merged statistics equal statistics of the whole batch', () => {
  const random = createRandom(3), rows = Array.from({length: 40}, () => [random.normal() * 2 + 1, random.normal() * 0.5 - 3]);
  const whole = createStats(2), left = createStats(2), right = createStats(2);
  rows.forEach(r => whole.add(r));
  rows.slice(0, 13).forEach(r => left.add(r));
  rows.slice(13).forEach(r => right.add(r));
  left.merge(right.snapshot());
  const a = whole.snapshot(), b = left.snapshot();
  assert.equal(b.count, 40);
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(a.mean[i] - b.mean[i]) < 1e-12);
    assert.ok(Math.abs(a.m2[i] - b.m2[i]) < 1e-9);
  }
});

test('zero weights leave the pretrained action unchanged', () => {
  const ars = createArs({actions: 14, observations: 61});
  const scale = normalizer(ars.stats.snapshot());
  const out = residual(ars.weights(), scale, Float64Array.from({length: 61}, (_, i) => i - 30), 14);
  assert.deepEqual(Array.from(out), new Array(14).fill(0));
});

test('an update steps along the top directions, scaled by their return spread', () => {
  const ars = createArs({actions: 1, observations: 2, directions: 3, top: 2, stepSize: 0.5, noise: 0.1, seed: 11});
  const proposal = ars.propose();
  const returns = [{plus: 3, minus: 1}, {plus: 0, minus: 0.5}, {plus: 2, minus: 4}];
  const {chosen, spread} = ars.update(proposal, returns);
  assert.deepEqual(chosen, [2, 0]);
  const used = [2, 4, 3, 1], mean = 2.5;
  assert.ok(Math.abs(spread - Math.sqrt(used.reduce((s, v) => s + (v - mean) ** 2, 0) / 4)) < 1e-15);
  const factor = 0.5 / (2 * spread), expected = [0, 1].map(i =>
    factor * ((2 - 4) * proposal.candidates[2].delta[i] + (3 - 1) * proposal.candidates[0].delta[i]));
  // Same terms; the implementation accumulates per direction, so compare within rounding.
  Array.from(ars.weights()).forEach((w, i) => assert.ok(Math.abs(w - expected[i]) <= 1e-14 * Math.abs(expected[i]), `weight ${i}: ${w} vs ${expected[i]}`));
  assert.equal(ars.iteration(), 1);
  assert.throws(() => ars.update(proposal, returns), /stale iteration/);
  assert.throws(() => createArs({actions: 1, observations: 2, directions: 3, top: 2}).update({...proposal, iteration: 0}, [{plus: NaN, minus: 0}, {plus: 0, minus: 0}, {plus: 0, minus: 0}]), /finite/);
});

// A real control problem with a known optimum: a discretized double integrator under a weak
// base controller. ARS learns the residual gain from episode returns only and must close most
// of the gap to the optimal (Riccati) gain's return.
const dt = 0.1, A = [[1, dt], [0, 1]], B = [0.5 * dt * dt, dt], q = 1, r = 0.1, horizon = 60, x0 = [1, 0];
const base = x => -(0.3 * x[0] + 0.3 * x[1]);
function episode(gain, stats) {
  let x = [...x0], cost = 0;
  for (let t = 0; t < horizon; t++) {
    stats?.add(x);
    const u = gain(x);
    cost += q * (x[0] * x[0] + x[1] * x[1]) + r * u * u;
    x = [A[0][0] * x[0] + A[0][1] * x[1] + B[0] * u, A[1][0] * x[0] + A[1][1] * x[1] + B[1] * u];
  }
  return -cost;
}
function riccatiGain() {
  let P = [[q, 0], [0, q]];
  for (let i = 0; i < 5000; i++) {
    const BP = [B[0] * P[0][0] + B[1] * P[1][0], B[0] * P[0][1] + B[1] * P[1][1]];
    const s = r + BP[0] * B[0] + BP[1] * B[1];
    const BPA = [BP[0] * A[0][0] + BP[1] * A[1][0], BP[0] * A[0][1] + BP[1] * A[1][1]];
    const K = [BPA[0] / s, BPA[1] / s];
    const AP = (i, j) => A[0][i] * (P[0][0] * A[0][j] + P[0][1] * A[1][j]) + A[1][i] * (P[1][0] * A[0][j] + P[1][1] * A[1][j]);
    P = [[q + AP(0, 0) - BPA[0] * K[0], AP(0, 1) - BPA[0] * K[1]], [AP(1, 0) - BPA[1] * K[0], q + AP(1, 1) - BPA[1] * K[1]]];
  }
  const BP = [B[0] * P[0][0] + B[1] * P[1][0], B[0] * P[0][1] + B[1] * P[1][1]], s = r + BP[0] * B[0] + BP[1] * B[1];
  const K = [(BP[0] * A[0][0] + BP[1] * A[1][0]) / s, (BP[0] * A[0][1] + BP[1] * A[1][1]) / s];
  return x => -(K[0] * x[0] + K[1] * x[1]);
}

test('ARS learns most of the way from a weak controller to the optimal LQR return', () => {
  const ars = createArs({actions: 1, observations: 2, directions: 8, top: 4, stepSize: 0.05, noise: 0.05, seed: 5});
  const evaluate = weights => {
    const scale = {mean: Float64Array.of(0, 0), std: Float64Array.of(1, 1)};
    return episode(x => base(x) + residual(weights, scale, x, 1)[0]);
  };
  // Observation normalization is frozen per iteration; this problem's scale is already unit.
  ars.stats.restore({count: 0, mean: [0, 0], m2: [0, 0]});
  const baseline = episode(base), optimal = episode(riccatiGain());
  assert.ok(optimal > baseline + 1, 'the problem leaves room to learn');
  const history = [];
  for (let i = 0; i < 300; i++) {
    const proposal = ars.propose();
    const returns = proposal.candidates.map(c => ({plus: evaluate(c.plus), minus: evaluate(c.minus)}));
    ars.update(proposal, returns);
    history.push(evaluate(ars.weights()));
  }
  const learned = history.at(-1), closed = (learned - baseline) / (optimal - baseline);
  assert.ok(learned <= optimal + 1e-9, 'no static linear policy beats the optimal gain');
  assert.ok(closed > 0.9, `closed ${(closed * 100).toFixed(1)}% of the gap (baseline ${baseline.toFixed(3)}, learned ${learned.toFixed(3)}, optimal ${optimal.toFixed(3)})`);
});

test('a saved learner continues exactly as an uninterrupted one', () => {
  const run = (ars, n) => {
    for (let i = 0; i < n; i++) {
      const proposal = ars.propose();
      const step = ars.iteration();
      ars.stats.add([step, -step]);
      ars.update(proposal, proposal.candidates.map((c, k) => ({plus: c.plus[0] + k, minus: c.minus[1] - k})));
    }
    return ars;
  };
  const config = {actions: 1, observations: 2, directions: 4, top: 2, seed: 9};
  const straight = run(createArs(config), 6);
  const half = run(createArs(config), 3);
  const saved = JSON.parse(JSON.stringify(half.save({task: 'test'})));
  assert.equal(saved.task, 'test');
  const resumed = run(loadArs(saved), 3);
  assert.deepEqual(Array.from(resumed.weights()), Array.from(straight.weights()));
  assert.equal(resumed.iteration(), 6);
  assert.deepEqual(resumed.save(), straight.save());
  assert.throws(() => loadArs({format: 'other'}), /Not a saved/);
});
