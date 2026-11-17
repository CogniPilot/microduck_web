import {normalizer} from './ars.js';

// The training loop around an ARS learner: each iteration evaluates every candidate W in
// parallel through `rollout(policy) -> {value, stats}`, updates W, merges the episodes'
// observation statistics only after that update is accepted, then evaluates the updated mean
// policy once with the normalization a saved policy carries. An iteration is atomic: a refused
// rollout or update, or Stop, leaves W and the statistics as they were. Results depend only on
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
        let results;
        // A refused rollout or Stop abandons this iteration whole: W and the statistics stay.
        try { results = await Promise.all(proposal.candidates.flatMap(c => [c.plus, c.minus].map(w => rollout(residualPolicy(w, proposal.scale))))); }
        catch (error) { ars.discard(); throw error; }
        if (stopped) { ars.discard(); break; }
        const returns = proposal.candidates.map((c, k) => ({plus: results[2 * k].value, minus: results[2 * k + 1].value}));
        let spread;
        try { ({spread} = ars.update(proposal, returns)); }
        catch (error) { ars.discard(); throw error; }
        // The episodes' observation statistics join only after an accepted update, in candidate order.
        for (const r of results) ars.stats.merge({count: r.stats.count, mean: r.stats.mean, m2: r.stats.m2});
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
