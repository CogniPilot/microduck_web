// Browser training page: trains a residual on the pretrained walking policy with ARS, using
// real rollouts of the whole-system FMU in dedicated workers. Every number shown comes from
// those rollouts; nothing is simulated or replayed.
import {createArs, loadArs, normalizer} from './ars.js';
import {createTrainer, residualPolicy} from './trainer.js';
import {createTrainingPool} from './training-pool.js';
import {TASKS} from './rollout.js';
import {fetchWithRetry} from './fetch-retry.js';

const $ = id => document.getElementById(id);
const TASK = 'walkForward', SAVE_KEY = 'microduck-training-v1';
const config = {actions: 14, observations: 61, directions: 8, top: 4, stepSize: 0.02, noise: 0.03, seed: 1};
let pool, ars = createArs(config), trainer, baseline = null, running = false;

const log = line => { $('train-log').textContent += line + '\n'; };
const status = text => { $('train-status').textContent = text; };
const busy = value => {
  running = value;
  for (const id of ['train-start', 'train-evaluate', 'train-save', 'train-load']) $(id).disabled = value;
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
  const size = Math.max(1, Math.min(8, Number($('train-workers').value) || 1));
  status('Preparing ' + size + ' training worker' + (size > 1 ? 's' : '') + '…');
  const started = performance.now(), sources = await pageSources();
  pool = createTrainingPool({size, prepare: {type: 'prepare', sources, model: 'MicroduckJawLocked', requireFmu: true},
    createWorker: () => new Worker(new URL('./physics.worker.js', import.meta.url), {type: 'module'})});
  await pool.start();
  log(`workers ready: ${size} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

const rollout = policy => pool.rollout(TASK, policy);
const current = () => residualPolicy(ars.weights(), normalizer(ars.stats.snapshot()));
const describe = r => `return ${r.value.toFixed(4)} · progress ${r.progress.toFixed(4)} m · ${r.fell === null ? 'no fall' : 'fell at tick ' + r.fell}`;

async function train() {
  busy(true);
  try {
    await ensurePool();
    trainer = createTrainer({ars, rollout});
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
      log(`iteration ${entry.iteration}: evaluation ${entry.evaluation.toFixed(4)} (progress ${entry.progress.toFixed(4)} m, ${entry.fell === null ? 'no fall' : 'fell'}) · best candidate ${entry.best.toFixed(4)} · spread ${entry.spread.toFixed(4)} · ${((now - last) / 1000).toFixed(1)} s`);
      last = now;
      globalThis.microduckTraining.history.push(entry);
    });
    status(`Trained to iteration ${ars.iteration()}.`);
  } catch (error) { status('Training stopped: ' + error.message); log('error: ' + error.message); }
  finally { busy(false); }
}

async function evaluate() {
  busy(true);
  try {
    await ensurePool();
    const result = await rollout(current());
    log(`evaluation at iteration ${ars.iteration()}: ${describe(result)}`);
    globalThis.microduckTraining.lastEvaluation = result;
    status('Evaluated.');
  } catch (error) { status('Evaluation failed: ' + error.message); }
  finally { busy(false); }
}

function save() {
  const saved = ars.save({task: TASK, taskConfig: TASKS[TASK], savedAt: new Date().toISOString(), baseline: baseline && {value: baseline.value, progress: baseline.progress}});
  const text = JSON.stringify(saved);
  try { localStorage.setItem(SAVE_KEY, text); } catch {}
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url; link.download = `microduck-policy-iter${ars.iteration()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log(`saved learned policy at iteration ${ars.iteration()}`);
  return saved;
}

function load(saved) {
  if (saved.task !== TASK) throw Error('This policy was trained for another task.');
  ars = loadArs(saved);
  log(`loaded learned policy at iteration ${ars.iteration()}`);
}

$('train-start').onclick = train;
$('train-stop').onclick = () => { trainer?.stop(); status('Stopping after the current iteration…'); };
$('train-evaluate').onclick = evaluate;
$('train-save').onclick = save;
$('train-load').onchange = async event => {
  try { load(JSON.parse(await event.target.files[0].text())); } catch (error) { status('Load failed: ' + error.message); }
};
try { const stored = localStorage.getItem(SAVE_KEY); if (stored) { load(JSON.parse(stored)); status('Restored the learned policy saved in this browser.'); } } catch {}
busy(false);

// For the acceptance harness: the same actions as the buttons, and the raw records.
globalThis.microduckTraining = {
  history: [], lastEvaluation: null,
  train: async iterations => { $('train-iterations').value = String(iterations); await train(); },
  evaluate, save, load: saved => load(saved), baseline: () => baseline, iteration: () => ars.iteration(),
  weights: () => Array.from(ars.weights()), running: () => running
};
