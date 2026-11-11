import {createRealtimeFactor} from './realtime-factor.js';
// Policy and physics advance in the worker; display delivery never gates a step.
export function createWalkRunner({step, time, send, schedule, clock=()=>performance.now()}) {
  let current, lastGeneration = 0;
  function controls(twist, inputs) {
    if (!Array.isArray(twist) || twist.length !== 3 || !twist.every(Number.isFinite))
      throw new Error('Invalid walking command.');
    if (inputs !== null && (!Array.isArray(inputs) || inputs.some(row =>
      !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !Number.isFinite(row[1]))))
      throw new Error('Invalid walking sensor inputs.');
    return {twist: [...twist], inputs: inputs?.map(row => [...row]) ?? null};
  }
  function publish(run) {
    if (run.outstanding || !run.frame || run.sent === run.sequence) return;
    run.sent = run.sequence;
    run.outstanding = true;
    send({type: 'walk_frame', generation: run.generation, sequence: run.sent, result: run.frame, speed: run.speed});
  }
  function finish(run) {
    if (run.running || run.busy || run.finished) return;
    run.finished = true;
    const result = {generation: run.generation, time: time(), frame: run.frame, reason: run.reason, speed: run.speed};
    if (run.error) send({type: 'walk_error', generation: run.generation, error: String(run.error)});
    else send({type: 'walk_done', ...result});
    for (const waiter of run.waiters) run.error ? waiter.reject(run.error) : waiter.resolve(result);
    run.waiters.length = 0;
  }
  function next(run) {
    if (!run.running || run.scheduled || run.busy) return;
    run.scheduled = true;
    const delay=run.mode==='realtime'?Math.max(0,run.lastStarted+20-clock()):0;
    schedule(async () => {
      run.scheduled = false;
      if (current !== run || !run.running) { finish(run); return; }
      const started=clock();
      if(run.mode==='realtime'&&started<run.lastStarted+20){next(run);return;}
      run.lastStarted=started;
      run.busy = true;
      try {
        const before = time(), target = before + 0.02;
        const command = {type: 'policy_step', time: target, twist: [...run.control.twist]};
        if (run.control.inputs) command.inputs = run.control.inputs.map(([name, value]) =>
          [name, name === 'cameraTimestamp' || name === 'lidarTimestamp' ? before : value]);
        const frame = await step(command);
        if (!Number.isFinite(frame.time) || Math.abs(frame.time - target) > 1e-10)
          throw new Error('Walking step returned an unexpected simulation time.');
        run.frame = frame;
        run.speed = run.rate.sample(frame.time);
        run.sequence++;
        publish(run);
        if (frame.outputs.fallen) { run.running = false; run.reason = 'fallen'; }
      } catch (error) {
        run.running = false; run.reason = 'error'; run.error = error;
      } finally {
        run.busy = false;
        if (run.running) next(run); else finish(run);
      }
    },delay);
  }
  return {
    isRunning: () => !!current && (current.running || current.busy),
    start({generation, twist, inputs = null, mode='realtime'}) {
      if (!Number.isSafeInteger(generation) || generation <= lastGeneration)
        throw new Error('Stale walking generation.');
      if (current && (current.running || current.busy)) throw new Error('Walking is already running.');
      if(!['realtime','unpaced'].includes(mode))throw new Error('Invalid walking pacing mode.');
      const control = controls(twist, inputs);
      if (!Number.isFinite(time())) throw new Error('Walking requires a prepared simulation.');
      const rate=createRealtimeFactor(clock);rate.start(time());
      const run = {generation, control, mode, rate, speed:null, lastStarted:clock(), sequence: 0, inputSequence: 0, sent: 0,
        running: true, busy: false, scheduled: false, outstanding: false,
        frame: null, reason: 'paused', error: null, finished: false, waiters: []};
      current = run; lastGeneration = generation; next(run);
      return {generation, time: time(), mode};
    },
    update({generation, sequence, twist, inputs = null}) {
      const run = current;
      if (!run?.running || run.generation !== generation || !Number.isSafeInteger(sequence) || sequence <= run.inputSequence)
        return false;
      const control = controls(twist, inputs);
      run.control = control; run.inputSequence = sequence;
      return true;
    },
    acknowledge({generation, sequence}) {
      const run = current;
      if (!run?.running || run.generation !== generation || !run.outstanding || sequence !== run.sent)
        return false;
      run.outstanding = false; publish(run);
      return true;
    },
    stop({generation}) {
      const run = current;
      if (!run || run.generation !== generation) return Promise.reject(new Error('Stale walking generation.'));
      if (run.finished) return run.error ? Promise.reject(run.error) : Promise.resolve({generation, time: time(), frame: run.frame, reason: run.reason});
      run.running = false;
      const result = new Promise((resolve, reject) => run.waiters.push({resolve, reject}));
      finish(run);
      return result;
    }
  };
}
