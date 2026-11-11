// Achieved simulation time per wall second of this live walking interval.
export function createRealtimeFactor(clock=()=>performance.now()) {
  let origin;
  return {
    start(simulatedTime) {
      if (!Number.isFinite(simulatedTime)) throw Error('Invalid simulation time.');
      origin={simulatedTime,wall:clock()};
    },
    sample(simulatedTime) {
      if (!origin || !Number.isFinite(simulatedTime)) return null;
      const simulatedSeconds=simulatedTime-origin.simulatedTime,wallSeconds=(clock()-origin.wall)/1000;
      if (simulatedSeconds<0 || wallSeconds<=0) return null;
      return {factor:simulatedSeconds/wallSeconds,simulatedSeconds,wallSeconds};
    },
    reset() {origin=undefined;}
  };
}
