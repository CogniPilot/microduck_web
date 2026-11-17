import {normalizer} from './ars.js';

// The training loop around an ARS learner: each iteration evaluates every candidate W in
// parallel through `rollout(policy) -> {value, stats}`, updates W, merges the episodes'
// observation statistics only after that update is accepted, then evaluates the updated mean
// policy once with the normalization a saved policy carries. An iteration is atomic: it starts
// from a full checkpoint of the learner (W, iteration, statistics, random state), and a refused
// rollout, update or evaluation, or Stop, at any point before the iteration completes restores
// that checkpoint. A stopped run therefore continues exactly as an uninterrupted one would.
// Results depend only on the candidates, never on which rollout finished first.
export function residualPolicy(weights, scale) {
  return {weights: Array.from(weights), mean: Array.from(scale.mean), scale: Array.from(scale.scale)};
}

// The best evaluated complete learner so far: the whole checkpoint (W, normalization
// statistics, random state, configuration, iteration) of the iteration whose committed
// mean-policy evaluation has the highest return. A candidate episode's return never counts, and
// an iteration that does not complete never reaches it. It only records: training always
// continues from the current learner.
export function createBestTracker() {
  let best = null;
  return {
    offer(entry, checkpoint) {
      if (!Number.isFinite(entry.evaluation)) return false;
      if (best && !(entry.evaluation > best.evaluation)) return false;
      best = {iteration: entry.iteration, evaluation: entry.evaluation, progress: entry.progress, checkpoint: structuredClone(checkpoint)};
      return true;
    },
    best: () => best && {...best, checkpoint: structuredClone(best.checkpoint)},
    reset() { best = null; }
  };
}

export function createTrainer({ars, rollout, best = null}) {
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
        const checkpoint = ars.save();
        let entry;
        try {
          const proposal = ars.propose();
          const results = await Promise.all(proposal.candidates.flatMap(c => [c.plus, c.minus].map(w => rollout(residualPolicy(w, proposal.scale)))));
          if (stopped) { ars.restore(checkpoint); break; }
          const returns = proposal.candidates.map((c, k) => ({plus: results[2 * k].value, minus: results[2 * k + 1].value}));
          const {spread, updated} = ars.update(proposal, returns);
          // The episodes' observation statistics join only after an accepted update, in candidate order.
          for (const r of results) ars.stats.merge({count: r.stats.count, mean: r.stats.mean, m2: r.stats.m2});
          // Once this evaluation returns the iteration is complete and kept, even if Stop came during it.
          const evaluation = await evaluate();
          entry = {iteration: ars.iteration(), evaluation: evaluation.value, progress: evaluation.progress,
            fell: evaluation.fell, best: Math.max(...returns.flatMap(r => [r.plus, r.minus])), spread, updated};
        } catch (error) { ars.restore(checkpoint); throw error; }
        // Committed: the learner now is exactly what this entry evaluated.
        best?.offer(entry, ars.save());
        history.push(entry);
        onIteration({...entry});
      }
      return history.map(entry => ({...entry}));
    }
  };
}
