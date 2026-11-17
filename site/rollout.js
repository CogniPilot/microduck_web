import {createStats} from './ars.js';

// Training tasks on the live plant. Return = forward progress of the trunk (metres along the
// world x axis) minus residualCost times the mean squared residual action, minus fallPenalty if
// the robot falls; a fall ends the episode at that tick.
export const TASKS = Object.freeze({
  walkForward: Object.freeze({twist: [0.3, 0, 0], seconds: 3, residualCost: 0.01, fallPenalty: 1})
});
export const TICK_S = 0.02;

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
    if (Math.abs(frame.time - target) > 1e-9) throw Error('A training tick returned an unexpected simulation time.');
    stats.add(result.observation);
    if (result.residual) for (const r of result.residual) cost += r * r;
    taken = t + 1;
    if (frame.outputs?.fallen) { fell = t; break; }
  }
  const progress = trunkX(frame) - x0;
  const value = progress - task.residualCost * cost / taken - (fell === null ? 0 : task.fallPenalty);
  const snapshot = stats.snapshot();
  return {value, progress, fell, ticks: taken, stats: {count: snapshot.count, mean: Array.from(snapshot.mean), m2: Array.from(snapshot.m2)}};
}
