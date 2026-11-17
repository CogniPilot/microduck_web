// Augmented Random Search, V2-t (Mania, Guy & Recht 2018): trains a linear policy term from
// episode returns alone. Here it learns the residual W (actions x observations) added to the
// pretrained policy's action, on observations normalized by running statistics; W = 0 is the
// pretrained policy unchanged. Each iteration evaluates W +/- noise*delta_k for `directions`
// Gaussian deltas, keeps the `top` directions by their better return, and steps along
// sum (r+ - r-) delta_k scaled by stepSize / (top * std of those returns).

// Seeded uniform [0, 1) (mulberry32) and standard normals (Box-Muller). The whole stream,
// including a pending Box-Muller value, is part of the saved state, so a resumed run draws
// exactly the perturbations an uninterrupted one would.
export function createRandom(seed, {state = seed >>> 0, spare = null} = {}) {
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    let u = 0;
    while (u === 0) u = uniform();
    const radius = Math.sqrt(-2 * Math.log(u)), angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
  return {uniform, normal, snapshot: () => ({state, spare})};
}

// Running observation statistics (count, mean, sum of squared deviations), mergeable across
// parallel rollouts (Chan et al.).
export function createStats(size) {
  let count = 0;
  const mean = new Float64Array(size), m2 = new Float64Array(size);
  return {
    count: () => count,
    add(observation) {
      count++;
      for (let i = 0; i < size; i++) {
        const delta = observation[i] - mean[i];
        mean[i] += delta / count;
        m2[i] += delta * (observation[i] - mean[i]);
      }
    },
    merge(other) {
      if (!other.count) return;
      const total = count + other.count;
      for (let i = 0; i < size; i++) {
        const delta = other.mean[i] - mean[i];
        mean[i] += delta * other.count / total;
        m2[i] += other.m2[i] + delta * delta * count * other.count / total;
      }
      count = total;
    },
    snapshot: () => ({count, mean: Float64Array.from(mean), m2: Float64Array.from(m2)}),
    restore(saved) { count = saved.count; mean.set(saved.mean); m2.set(saved.m2); }
  };
}

// Observation normalization of ARS V2: x -> (x - mean) * scale with scale = 1 / std. As in the
// paper's implementation, a near-constant coordinate (std < 1e-8), or any coordinate before two
// samples exist, is masked with scale 0: it contributes nothing, so constant or empty statistics
// stay finite and W = 0 still reproduces the pretrained action exactly.
export const MASK_STD = 1e-8;
export function normalizer({count, mean, m2}) {
  const scale = Float64Array.from(m2, value => {
    const std = count > 1 ? Math.sqrt(value / count) : 0;
    return std >= MASK_STD ? 1 / std : 0;
  });
  return {mean: Float64Array.from(mean), scale};
}

// The residual W * ((observation - mean) * scale).
export function residual(weights, scale, observation, actions) {
  const columns = observation.length, out = new Float64Array(actions);
  for (let i = 0; i < columns; i++) {
    const x = scale.scale[i] === 0 ? 0 : (observation[i] - scale.mean[i]) * scale.scale[i];
    if (x === 0) continue;
    for (let a = 0; a < actions; a++) out[a] += weights[a * columns + i] * x;
  }
  return out;
}

// A learner, new or continued from `saved` (a value returned by save()).
export function createArs({actions, observations, directions = 8, top = 4, stepSize = 0.02, noise = 0.03, seed = 1}, saved) {
  if (!(top >= 1 && top <= directions)) throw Error('ARS needs 1 <= top <= directions.');
  const size = actions * observations, stats = createStats(observations);
  const random = createRandom(seed, saved?.random);
  let weights = saved ? Float64Array.from(saved.weights) : new Float64Array(size), iteration = saved?.iteration ?? 0;
  if (weights.length !== size) throw Error('Saved ARS weights do not match the policy shape.');
  if (saved) stats.restore(saved.stats);
  return {
    iteration: () => iteration,
    weights: () => Float64Array.from(weights),
    stats,
    // The candidates of one iteration: for each direction its delta and the two perturbed
    // weight sets, plus the observation normalization frozen for the whole iteration.
    propose() {
      const scale = normalizer(stats.snapshot());
      const candidates = Array.from({length: directions}, () => {
        const delta = Float64Array.from({length: size}, () => random.normal());
        return {delta, plus: weights.map((w, i) => w + noise * delta[i]), minus: weights.map((w, i) => w - noise * delta[i])};
      });
      return {iteration, scale, candidates};
    },
    // returns[k] = {plus, minus} episode returns of candidate k. Observation statistics from
    // those episodes are merged separately through `stats`.
    update(proposal, returns) {
      if (proposal.iteration !== iteration) throw Error('ARS update for a stale iteration.');
      if (returns.length !== directions || !returns.every(r => Number.isFinite(r.plus) && Number.isFinite(r.minus)))
        throw Error('ARS needs one finite (plus, minus) return pair per direction.');
      const order = returns.map((r, k) => k).sort((a, b) =>
        Math.max(returns[b].plus, returns[b].minus) - Math.max(returns[a].plus, returns[a].minus) || a - b);
      const chosen = order.slice(0, top), used = chosen.flatMap(k => [returns[k].plus, returns[k].minus]);
      const average = used.reduce((s, v) => s + v, 0) / used.length;
      const spread = Math.sqrt(used.reduce((s, v) => s + (v - average) ** 2, 0) / used.length);
      // Equal returns carry no direction: the weights stay, the iteration still counts.
      const factor = spread > 0 ? stepSize / (top * spread) : 0;
      const next = Float64Array.from(weights);
      for (const k of chosen) {
        const difference = factor * (returns[k].plus - returns[k].minus), delta = proposal.candidates[k].delta;
        for (let i = 0; i < size; i++) next[i] += difference * delta[i];
      }
      weights = next;
      iteration++;
      return {chosen, spread};
    },
    // Everything needed to evaluate or continue the learned policy, as plain JSON.
    save: meta => ({format: 'microduck-ars', version: 1, actions, observations, directions, top, stepSize, noise, seed,
      iteration, random: random.snapshot(), weights: Array.from(weights),
      stats: (({count, mean, m2}) => ({count, mean: Array.from(mean), m2: Array.from(m2)}))(stats.snapshot()), ...meta})
  };
}

export function loadArs(saved) {
  if (saved?.format !== 'microduck-ars' || saved.version !== 1) throw Error('Not a saved microduck ARS policy.');
  return createArs(saved, saved);
}
