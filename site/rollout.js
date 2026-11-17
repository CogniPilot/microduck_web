import {createStats} from './ars.js';

// Training tasks on the live plant. An episode is round(seconds / 0.02) policy ticks from reset
// at the task's twist. Return = trunk progress along world x in metres
// (bodyPosition[1,1] = trunk.r_0[1], Microduck.mo:221, last frame minus reset frame)
// - residualCost * (sum over ticks of the squared residual actions, rad^2) / ticks taken
// - fallPenalty (in metres) if the plant reports fallen; a fall ends the episode at that tick.
// Any refused step rejects the whole episode (the error propagates; no partial return).
export const TASKS = Object.freeze({
  walkForward: Object.freeze({twist: [0.3, 0, 0], seconds: 3, residualCost: 0.01, fallPenalty: 1})
});
export const TICK_S = 0.02;

// The action written to policyAction: the pretrained action plus the residual. A zero residual
// component leaves the pretrained Float32 value itself (no -0 + 0 = +0 change), so W = 0
// reproduces the accepted policy bit for bit.
export function appliedAction(raw, extra) {
  if (!extra) return raw;
  return Float32Array.from(raw, (value, i) => extra[i] === 0 ? value : value + extra[i]);
}

const trunkX = frame => {
  const x = frame?.bodies?.[0]?.position?.[0];
  if (!Number.isFinite(x)) throw Error('The plant frame has no trunk position.');
  return x;
};

// One episode: reset, then 20 ms policy ticks with the residual policy applied.
// reset() -> frame; step({time, twist, residual}) -> {frame, observation, residual}.
export async function runEpisode({reset, step, task, residualPolicy = null, observations = 61}) {
  const stats = createStats(observations), start = await reset();
  if (start.time !== 0) throw Error('Episode reset did not return time zero.');
  const ticks = Math.round(task.seconds / TICK_S), x0 = trunkX(start);
  let frame = start, cost = 0, fell = null, taken = 0;
  for (let t = 0; t < ticks; t++) {
    const target = Math.round((t + 1) * TICK_S * 1e9) / 1e9;
    const result = await step({time: target, twist: task.twist, residual: residualPolicy});
    frame = result.frame;
    // A malformed frame rejects the episode; it never becomes a training reward.
    if (!Number.isFinite(frame?.time) || Math.abs(frame.time - target) > 1e-9) throw Error('A training tick returned an unexpected simulation time.');
    const fallen = frame.outputs?.fallen;
    if (!(typeof fallen === 'boolean' || fallen === 0 || fallen === 1)) throw Error('A training tick did not report whether the robot fell.');
    const observation = result.observation;
    if (observation?.length !== observations || !Array.from(observation).every(Number.isFinite)) throw Error('A training tick returned an invalid observation.');
    if (result.residual && (result.residual.length !== 14 || !Array.from(result.residual).every(Number.isFinite))) throw Error('A training tick returned an invalid residual.');
    stats.add(observation);
    if (result.residual) for (const r of result.residual) cost += r * r;
    taken = t + 1;
    if (fallen === true || fallen === 1) { fell = t; break; }
  }
  const progress = trunkX(frame) - x0;
  const value = progress - task.residualCost * cost / taken - (fell === null ? 0 : task.fallPenalty);
  const snapshot = stats.snapshot();
  return {value, progress, fell, ticks: taken, stats: {count: snapshot.count, mean: Array.from(snapshot.mean), m2: Array.from(snapshot.m2)}};
}
