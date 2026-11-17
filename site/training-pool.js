// Physics workers dedicated to training, separate from the interactive walker. Each prepares
// its own whole-system FMU and runs one rollout at a time; rollouts queue for the next free
// worker. A worker message is {id, ...command}; its reply is {id, result} or {id, error}.
// A worker that times out or crashes may still be busy, so either closes the whole pool: its
// workers are terminated, every queued and running rollout rejects, and nothing more runs.
export function createTrainingPool({size = 1, createWorker, prepare, timeoutMs = 600000}) {
  if (!(Number.isInteger(size) && size >= 1)) throw Error('A training pool needs at least one worker.');
  const members = [], queue = [];
  let closed = null;
  const closedError = () => Error('The training pool is closed: ' + closed + '.');
  const fail = reason => {
    if (closed) return;
    closed = reason;
    for (const job of queue.splice(0)) job.reject(closedError());
    for (const member of members) {
      for (const [, entry] of member.pending) { clearTimeout(entry.timer); entry.reject(closedError()); }
      member.pending.clear();
      member.worker.terminate();
    }
  };
  const call = (member, command) => new Promise((resolve, reject) => {
    if (closed) { reject(closedError()); return; }
    const id = ++member.nextId;
    const timer = setTimeout(() => {
      member.pending.delete(id);
      reject(Error('Training worker timed out.'));
      fail('a training worker timed out');
    }, timeoutMs);
    member.pending.set(id, {resolve, reject, timer});
    try { member.worker.postMessage({...command, id}); }
    catch (error) { clearTimeout(timer); member.pending.delete(id); reject(error); }
  });
  const settle = (member, {id, result, error}) => {
    const entry = member.pending.get(id);
    if (!entry) return;
    member.pending.delete(id);
    clearTimeout(entry.timer);
    error === undefined ? entry.resolve(result) : entry.reject(Error(error));
  };
  const pump = () => {
    for (const member of members) {
      if (closed || member.busy || !member.ready || !queue.length) continue;
      const job = queue.shift();
      member.busy = true;
      call(member, job.command).then(job.resolve, job.reject).finally(() => { member.busy = false; pump(); });
    }
  };
  return {
    size: () => members.length,
    // Why the pool closed (Stop, a timeout, a crashed worker), or null while it is open.
    closed: () => closed,
    // Starts the workers and prepares each one's plant; resolves when all are ready. A failed
    // preparation closes the pool.
    async start() {
      for (let i = 0; i < size; i++) {
        const member = {worker: createWorker(), pending: new Map(), nextId: 0, busy: false, ready: false};
        member.worker.onmessage = ({data}) => { if (data && data.id !== undefined) settle(member, data); };
        member.worker.onerror = () => fail('a training worker crashed');
        members.push(member);
      }
      try {
        await Promise.all(members.map(async member => {
          await call(member, prepare);
          member.ready = true;
        }));
      } catch (error) { fail('worker preparation failed'); throw error; }
      pump();
    },
    // One episode of `task` with the residual policy (null = the pretrained policy alone).
    rollout(task, residual) {
      if (closed) return Promise.reject(closedError());
      return new Promise((resolve, reject) => { queue.push({command: {type: 'rollout', task, residual}, resolve, reject}); pump(); });
    },
    // Stops every worker at once, without waiting for a running episode; queued and running
    // rollouts reject.
    close(reason = 'stopped') { fail(reason); }
  };
}
