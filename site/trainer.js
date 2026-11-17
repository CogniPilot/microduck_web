import {normalizer} from './ars.js';

// The training loop around an ARS learner: each iteration evaluates every candidate W in
// parallel through `rollout(policy) -> {value, stats}`, merges the episodes' observation
// statistics, updates W, then evaluates the updated mean policy once with the normalization a
// saved policy carries (the statistics after this iteration's merge). Results depend only on
// the candidates, never on which rollout finished first.
export function residualPolicy(weights, scale) {
  return {weights: Array.from(weights), mean: Array.from(scale.mean), scale: Array.from(scale.scale)};
}

export function createTrainer({ars, rollout}) {
  let stopped = false;
  const history = [];
  const evaluate = () => rollout(residualPolicy(ars.weights(), normalizer(ars.stats.snapshot())));
  return {
    history: () => history.map(entry => ({...entry})),
    stop() { stopped = true; },
    // The baseline: the policy before any update (W = 0 at the start of a run).
    async baseline() {
      const result = await evaluate();
      return {value: result.value, progress: result.progress, fell: result.fell};
    },
    async run(iterations, onIteration = () => {}) {
      stopped = false;
      for (let i = 0; i < iterations && !stopped; i++) {
        const proposal = ars.propose();
        const jobs = proposal.candidates.flatMap(c => [c.plus, c.minus].map(w => rollout(residualPolicy(w, proposal.scale))));
        const results = await Promise.all(jobs);
        if (stopped) break;
        for (const r of results) ars.stats.merge({count: r.stats.count, mean: r.stats.mean, m2: r.stats.m2});
        const returns = proposal.candidates.map((c, k) => ({plus: results[2 * k].value, minus: results[2 * k + 1].value}));
        const {spread} = ars.update(proposal, returns);
        const evaluation = await evaluate();
        const entry = {iteration: ars.iteration(), evaluation: evaluation.value, progress: evaluation.progress,
          fell: evaluation.fell, best: Math.max(...returns.flatMap(r => [r.plus, r.minus])), spread};
        history.push(entry);
        onIteration({...entry});
      }
      return history.map(entry => ({...entry}));
    }
  };
}
