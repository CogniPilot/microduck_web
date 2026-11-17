// Browser training page: trains a residual on the pretrained walking policy with ARS, using
// real rollouts of the whole-system FMU in dedicated workers. Every number shown comes from
// those rollouts; nothing is simulated or replayed.
import {createArs, loadArs, normalizer} from './ars.js';
import {createTrainer, createBestTracker, residualPolicy} from './trainer.js';
import {createTrainingPool} from './training-pool.js';
import {TASKS} from './rollout.js';
import {fetchWithRetry} from './fetch-retry.js';

const $ = id => document.getElementById(id);
const TASK = 'walkForward', SAVE_KEY = 'microduck-training-v2', MAX_SAVED_BYTES = 200000, WORKERS = 1;
const config = {actions: 14, observations: 61, directions: 8, top: 4, stepSize: 0.02, noise: 0.03, seed: 1};
let pool, preparing, ars = createArs(config), trainer, baseline = null, running = false, stopping = false;
// The best evaluated complete checkpoint of this learner's lineage, kept only for Save best:
// training always continues from the current learner.
const best = createBestTracker();

const log = line => { $('train-log').textContent += line + '\n'; };
const status = text => { $('train-status').textContent = text; };
const busy = value => {
  running = value;
  for (const id of ['train-start', 'train-evaluate', 'train-save', 'train-restore']) $(id).disabled = value;
  $('train-save-best').disabled = value || !best.best();
  $('train-stop').disabled = !value;
};

async function pageSources() {
  const manifest = await fetchWithRetry('./sources/manifest.json');
  if (!manifest.ok) throw Error('Source manifest unavailable (HTTP ' + manifest.status + ').');
  const files = await manifest.json();
  const texts = await Promise.all(files.map(async name => {
    const response = await fetchWithRetry('./sources/' + name.split('/').map(encodeURIComponent).join('/'));
    if (!response.ok) throw Error('Could not load source ' + name);
    return [name, await response.text()];
  }));
  return Object.fromEntries(texts);
}

async function ensurePool() {
  if (pool) return;
  status('Preparing the training worker…');
  const started = performance.now(), sources = await pageSources();
  // Stop may come during any await here: it closes the pool still being prepared, and every
  // continuation checks for it, so a stopped Train or Evaluate never starts work afterwards.
  if (stopping) throw Error('Stopped.');
  // One worker: the qualified configuration. A failed preparation closes the pool; the next
  // Train or Evaluate prepares a fresh one.
  const next = createTrainingPool({size: WORKERS, prepare: {type: 'prepare', sources, model: 'MicroduckJawLocked', requireFmu: true},
    createWorker: () => new Worker(new URL('./physics.worker.js', import.meta.url), {type: 'module'})});
  preparing = next;
  try { await next.start(); } finally { preparing = undefined; }
  if (stopping) { next.close('stopped'); throw Error('Stopped.'); }
  pool = next;
  log(`worker ready in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

const rollout = policy => pool.rollout(TASK, policy);
// After Stop or any failure the pool is closed and dropped: no queued episode keeps running,
// and the learner keeps its last completed iteration.
const dropPool = reason => { pool?.close(reason); pool = undefined; };
const current = () => residualPolicy(ars.weights(), normalizer(ars.stats.snapshot()));
const describe = r => `return ${r.value.toFixed(4)} · progress ${r.progress.toFixed(4)} m · ${r.fell === null ? 'no fall' : 'fell at tick ' + r.fell}`;

async function train() {
  busy(true);
  stopping = false;
  try {
    await ensurePool();
    trainer = createTrainer({ars, rollout, best});
    if (baseline === null) {
      const started = performance.now();
      baseline = await rollout(null);
      log(`baseline (pretrained, no residual): ${describe(baseline)} · ${((performance.now() - started) / 1000).toFixed(1)} s`);
    }
    const iterations = Math.max(1, Number($('train-iterations').value) || 1);
    status(`Training ${iterations} iteration${iterations > 1 ? 's' : ''}…`);
    let last = performance.now();
    await trainer.run(iterations, entry => {
      const now = performance.now();
      log(`iteration ${entry.iteration}: evaluation ${entry.evaluation.toFixed(4)} (progress ${entry.progress.toFixed(4)} m, ${entry.fell === null ? 'no fall' : 'fell'}) · best candidate ${entry.best.toFixed(4)} · spread ${entry.spread.toFixed(4)}${entry.updated ? '' : ' (no update)'} · ${((now - last) / 1000).toFixed(1)} s`);
      last = now;
      globalThis.microduckTraining.history.push(entry);
      showBest();
    });
    // Stop during the last evaluation keeps that completed iteration and ends the run normally.
    if (stopping) { status(`Stopped. The learner keeps iteration ${ars.iteration()}.`); log(`stopped at iteration ${ars.iteration()}`); }
    else status(`Trained to iteration ${ars.iteration()}.`);
  } catch (error) {
    dropPool('training failed');
    if (stopping) { status(`Stopped. The learner keeps iteration ${ars.iteration()}.`); log(`stopped at iteration ${ars.iteration()}`); }
    else { status('Training stopped: ' + error.message); log('error: ' + error.message); }
  }
  finally { busy(false); }
}

async function evaluate() {
  busy(true);
  stopping = false;
  // A failed evaluation leaves no result, never the previous one.
  globalThis.microduckTraining.lastEvaluation = null;
  try {
    await ensurePool();
    const result = await rollout(current());
    log(`evaluation at iteration ${ars.iteration()}: ${describe(result)}`);
    globalThis.microduckTraining.lastEvaluation = result;
    status('Evaluated.');
  } catch (error) { dropPool('evaluation failed'); status(stopping ? 'Stopped.' : 'Evaluation failed: ' + error.message); }
  finally { busy(false); }
}

// Current versus best evaluated iteration; the best is what Save best writes.
function showBest() {
  const kept = best.best(), last = globalThis.microduckTraining?.history.at(-1);
  $('train-best').textContent = kept
    ? `Current: iteration ${ars.iteration()}${last ? `, return ${last.evaluation.toFixed(4)}` : ''} · Best evaluated: iteration ${kept.iteration}, return ${kept.evaluation.toFixed(4)} (${kept.progress.toFixed(4)} m)`
    : `Current: iteration ${ars.iteration()} · no completed iteration evaluated yet`;
  $('train-save-best').disabled = running || !kept;
}

const meta = () => ({task: TASK, taskConfig: TASKS[TASK], savedAt: new Date().toISOString(), baseline: baseline && {value: baseline.value, progress: baseline.progress}});
// Keeps a saved learner in this browser (what Restore reads) and downloads the same bytes.
function store(saved, filename) {
  const text = JSON.stringify(saved);
  try { localStorage.setItem(SAVE_KEY, text); } catch {}
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return saved;
}

function save() {
  const saved = store(ars.save(meta()), `microduck-policy-iter${ars.iteration()}.json`);
  log(`saved learned policy at iteration ${ars.iteration()}`);
  return saved;
}

// Saves the best evaluated complete checkpoint, not the current learner, and says so.
function saveBest() {
  const kept = best.best();
  if (!kept) throw Error('No completed iteration has been evaluated yet.');
  const saved = store({...meta(), best: {iteration: kept.iteration, evaluation: kept.evaluation, progress: kept.progress}, ...kept.checkpoint},
    `microduck-policy-best-iter${kept.iteration}.json`);
  log(`saved best evaluated policy: iteration ${kept.iteration}, return ${kept.evaluation.toFixed(4)} (training continues from iteration ${ars.iteration()})`);
  return saved;
}

// Restores only a learner this page saved in this browser, with the page's own fixed
// configuration; loadArs checks every field before anything is replaced.
function restoreSaved() {
  let text = null;
  try { text = localStorage.getItem(SAVE_KEY); } catch {}
  if (text === null) throw Error('No policy has been saved in this browser.');
  if (text.length > MAX_SAVED_BYTES) throw Error('The saved policy is too large.');
  const saved = JSON.parse(text);
  if (saved.task !== TASK) throw Error('The saved policy was trained for another task.');
  const next = loadArs(saved, config);
  if (next.iteration() !== saved.iteration) throw Error('The saved policy did not restore its iteration.');
  ars = next;
  // A restored learner starts a new lineage: the earlier best and history described another one.
  best.reset();
  globalThis.microduckTraining.history.length = 0;
  log(`restored learned policy at iteration ${ars.iteration()}; best and history start again from it`);
  showBest();
}

$('train-start').onclick = train;
// Stop closes the worker at once; the running iteration is dropped.
$('train-stop').onclick = () => { stopping = true; trainer?.stop(); preparing?.close('stopped'); dropPool('stopped'); status('Stopping…'); };
$('train-evaluate').onclick = evaluate;
$('train-save').onclick = save;
$('train-save-best').onclick = () => { try { saveBest(); status('Saved the best evaluated policy.'); } catch (error) { status('Save best failed: ' + error.message); } };
$('train-restore').onclick = () => { try { restoreSaved(); status('Restored.'); } catch (error) { status('Restore failed: ' + error.message); } };
busy(false);

// For the acceptance harness: the same actions as the buttons, and the raw records.
globalThis.microduckTraining = {
  history: [], lastEvaluation: null,
  train: async iterations => { $('train-iterations').value = String(iterations); await train(); },
  evaluate, save, saveBest, restoreSaved, baseline: () => baseline, iteration: () => ars.iteration(),
  best: () => { const kept = best.best(); return kept && {iteration: kept.iteration, evaluation: kept.evaluation, progress: kept.progress}; },
  weights: () => Array.from(ars.weights()), running: () => running
};
