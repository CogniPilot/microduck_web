import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import {loadPollenGeometries} from './pollen/geometry.js';
import {createPollenScene} from './pollen/scene.js';
import {createSceneShell} from './pollen/shell.js';
import {createModelicaPoseView} from './pollen/pose-view.js';
import {createCameraFollower} from './pollen/camera-follow.js';
import {createLanding} from './pollen/landing.js';
import {VARIANTS,DEFAULT_VARIANT,materialHookFor} from './pollen/variants.js';
import { createSensorPreview } from './sensor-preview.js';
import { sensorInputs } from './sensor-inputs.js';
import { createWalkingControls } from './walking-controls.js';
import {modelDrafts} from './model-drafts.js';
import {fetchWithRetry} from './fetch-retry.js';
import {createSoundtrack} from './soundtrack.js';

const $ = id => document.getElementById(id);
// `?fmu=require` (FMU qualification): the worker refuses instead of falling back to the SDK.
const REQUIRE_FMU = new URLSearchParams(globalThis.location?.search ?? '').get('fmu') === 'require';
// Source editing and the in-browser compiler are disabled for now (owner, Nov 15): the page
// loads only the simulation runtime. editor.js is not loaded, so no language server starts.
const EDITING_DISABLED = true;
let robotView;
let physicsWorker;
const newPhysicsWorker=()=>new Worker(new URL('./physics.worker.js', import.meta.url), {type: 'module'});
// The physics worker the page opens with: it starts receiving and compiling the offered FMU
// at once, and the first preparation adopts it instead of starting a worker of its own.
let openingWorker;
try{openingWorker=newPhysicsWorker();openingWorker.postMessage({type:'preload',model:'MicroduckJawLocked'});}catch{openingWorker=undefined;}
let physicsReady=false;
let physicsTime = 0;
let fmuFallback='';
let renderedFrame;
let physicsRequest = 0;
let physicsPending;
let physicsGeneration=0;
let autoWalkGeneration=-1;
let physicsReset;
let replayGeneration = 0;
let replayFrame;
// The generation of the running preview, if any, and whether the page may still start
// live preparation by itself (once, after the preview's first frame is drawn).
let previewGeneration = -1, autoPrepare = true;
const previewing = () => previewGeneration === replayGeneration;
// A live session owns the page from the moment preparation starts (before its worker
// exists, while sources load) until it stops; stopPhysics ends it by bumping
// physicsGeneration.
let preparingGeneration = -1;
const liveOwned = () => !!physicsWorker || !!physicsPending || physicsReady || preparingGeneration === physicsGeneration;
// The landing: until "Waddle in" the robot stands still and looks at the pointer, while the
// simulation prepares; its first frame is held back and shown when the scene is entered.
let sceneEntered = false, heldFrame, landing, leaveLanding = () => {};
// Replaced by the view with one that also drops a camera / ToF capture still in flight.
let invalidateSensorFrames = () => { renderedFrame = undefined; };
// Live preparation awaits this; it settles once the source manifest and files are read.
let settleSources;
globalThis.microduckSourcesReady ??= new Promise((resolve, reject) => { settleSources = {resolve, reject}; });
globalThis.microduckSourcesReady.catch(() => {});
let walkGeneration=0,walkRun,walkTimer,walkStopping=false;
function showWalkRate(sample){
  if(sample&&Number.isFinite(sample.factor)&&sample.wallSeconds>0)$('simulation-speed').textContent='Live speed: '+sample.factor.toFixed(2)+'× real time · '+sample.simulatedSeconds.toFixed(2)+' s simulated / '+sample.wallSeconds.toFixed(2)+' s elapsed';
}
const walking=createWalkingControls({
  button:$('walk-mode'),status:$('walk-command'),
  canRun:()=>!!physicsWorker&&physicsReady&&!walkStopping,
  start:startWalking,pause:pauseWalking,update:updateWalking,
  setRunning:active=>$('step-simulation').disabled=active||walkStopping||!!physicsReset||!physicsReady,
  onError:error=>stopPhysics('Walking stopped: '+error.message)
});
function setDriveEnabled(enabled) {
  document.querySelectorAll('[data-drive]').forEach(control => { control.disabled = !enabled; });
}
setDriveEnabled(false);
// Ends any recording or preview; the next frame drawn is live or the pose explorer.
function endReplay() {
  replayGeneration++;
  if (replayFrame !== undefined) cancelAnimationFrame(replayFrame);
  replayFrame = undefined;
  $('preview-label').hidden = true;
}
function lockPoseControls(disabled) {
  document.querySelectorAll('#joints input, #reset-pose').forEach(input => { input.disabled = disabled; });
}
// keepPreview ends the live session only: a running recorded preview stays, labelled
// with the failure, and Prepare stays available to retry.
function stopPhysics(message = 'Simulation stopped. Pose controls restored.', {keepPreview = false} = {}) {
  keepPreview &&= previewing();
  if (!keepPreview) endReplay();
  physicsGeneration++;autoWalkGeneration=-1;
  physicsReset=undefined;$('reset-simulation').disabled=true;
  walkGeneration++;walkRun=undefined;walkStopping=false;clearTimeout(walkTimer);
  $('simulation-speed').textContent='Live speed: —';
  physicsReady=false; heldFrame=undefined; walking.finish(); $('walk-mode').disabled=true; setDriveEnabled(false);
  physicsWorker?.terminate(); physicsWorker = undefined;
  if (physicsPending) { clearTimeout(physicsPending.timer); physicsPending.reject(new Error(message)); physicsPending = undefined; }
  $('prepare-simulation').disabled = false;
  $('step-simulation').disabled = true;
  fmuFallback='';
  $('simulation-status').textContent = message;
  if (keepPreview) {
    $('preview-label').textContent = 'Recorded preview — not live · live simulation failed to load';
    return;
  }
  robotView?.restore();
  $('stop-simulation').disabled = true;
  $('view-mode').textContent = '3D pose explorer · kinematics';
  $('telemetry-status').textContent = 'No live Modelica telemetry.';
}
function physicsCommand(message, limit = 360000) {
  if (physicsPending) return Promise.reject(new Error('A simulation command is already running.'));
  let pending;
  const promise=new Promise((resolve, reject) => {
    const id = ++physicsRequest;
    const timer = setTimeout(() => stopPhysics('Simulation exceeded its time budget. No new pose was applied.', {keepPreview: true}), limit);
    pending=physicsPending = {id, resolve, reject, timer};
    try{physicsWorker.postMessage({...message, id});}
    catch(error){clearTimeout(timer);physicsPending=undefined;reject(error);}
  });
  pending.promise=promise;return promise;
}
async function showPhysics(command) {
  const worker=physicsWorker,generation=physicsGeneration;
  if ((command.type === 'step'||command.type === 'policy_step') && renderedFrame) command.inputs = sensorInputs(renderedFrame, physicsTime);
  const state = await physicsCommand(command);
  if(physicsWorker!==worker||physicsGeneration!==generation)return;
  applyPhysics(state);
  return state;
}
// A visible warning while the live simulation cannot load, with its reason.
function showSimulationWarning(reason) {
  const warning = $('simulation-warning');
  const text = String(reason).replace(/^(Error: )+/, '').trim();
  warning.textContent = 'Live simulation unavailable: ' + text + (/[.!?]$/.test(text) ? '' : '.') +
    (EDITING_DISABLED ? ' No in-browser compiler was started.' : '');
  warning.hidden = false;
}
function applyPhysics(state) {
  robotView.apply(state);
  physicsTime = state.time;
  showSensors(state);
  if(state.preparation&&$('load-progress'))$('load-progress').hidden=true;
  if(state.preparation)$('simulation-warning').hidden=true;
  const isFmu=state.preparation?.plant==='fmu'||state.execution?.engine==='fmi3-ls-wasm';
  if(state.execution)globalThis.microduckExecutionReceipt=state.execution;
  if(state.preparation)fmuFallback=state.preparation.fmu_fallback??'';
  $('view-mode').textContent = (isFmu?'Whole-system FMU simulation':'Modelica simulation') + ' · t = ' + state.time.toFixed(3) + ' s';
  $('simulation-status').textContent = (isFmu ? (state.preparation?'Simulation ready · whole-system FMU loaded.':state.control?'Pretrained Pollen velstand · whole-system FMU.':'Whole-system FMU · manual control.') : state.preparation ? (['prebuilt','precompiled-runtime'].includes(state.preparation.plant)&&state.preparation.controller==='prebuilt'?'Simulation ready · compiled models loaded.':'Simulation ready · edited source compiled.') : state.control ? 'Pretrained Pollen velstand · Modelica physics.' : 'Standing controller · Modelica physics.') + (fmuFallback?' FMU unavailable; using SDK: '+fmuFallback:'');
}
function watchWalking(){clearTimeout(walkTimer);walkTimer=setTimeout(()=>stopPhysics('Simulation exceeded its time budget. No new pose was applied.'),360000);}
function walkingInputs(){return renderedFrame?sensorInputs(renderedFrame,physicsTime):null;}
function updateWalking(twist=walking.command()){
  if(!walkRun||walkStopping||physicsReset)return;
  try{physicsWorker.postMessage({type:'walk_input',generation:walkRun.generation,sequence:++walkRun.inputSequence,twist,inputs:walkingInputs()});}
  catch(error){stopPhysics('Walking stopped: '+error.message);}
}
async function startWalking(twist){
  if(physicsReset)throw Error('Simulation reset is in progress.');
  if(walkRun||walkStopping)throw Error('Walking is already running.');
  const run={generation:++walkGeneration,inputSequence:0,displaySequence:0};walkRun=run;$('simulation-speed').textContent='Live speed: measuring…';watchWalking();
  try{await physicsCommand({type:'walk_start',generation:run.generation,mode:'realtime',twist,inputs:walkingInputs()});}
  catch(error){if(walkGeneration!==run.generation)return;if(walkRun===run)walkRun=undefined;clearTimeout(walkTimer);throw error;}
}
async function pauseWalking(){
  const run=walkRun;if(!run)return;
  const worker=physicsWorker,generation=physicsGeneration;
  walkStopping=true;$('step-simulation').disabled=true;
  try{const state=await physicsCommand({type:'walk_stop',generation:run.generation});if(worker!==physicsWorker||generation!==physicsGeneration)return;if(!physicsReset){if(state.frame&&state.frame.time>physicsTime)applyPhysics(state.frame);showWalkRate(state.speed);}}
  finally{if(walkGeneration===run.generation){if(walkRun===run)walkRun=undefined;walkStopping=false;clearTimeout(walkTimer);$('step-simulation').disabled=!physicsReady;}}
}
// The FMU loading display: downloaded megabytes, then each later phase by name.
const LOAD_STEPS={download:'Downloading the simulation',compile:'Compiling WebAssembly',construct:'Constructing the model',initialize:'Initializing'};
function showLoadProgress({phase,received,total}){
  const bar=$('load-progress');if(!bar)return;
  bar.hidden=false;
  if(phase==='download'&&total){bar.max=total;bar.value=received;}else bar.removeAttribute('value');
  const mb=bytes=>(bytes/1e6).toFixed(1);
  $('simulation-status').textContent=LOAD_STEPS[phase]+(phase==='download'&&total?' · '+mb(received)+' / '+mb(total)+' MB':'')+'…';
}
function walkingMessage(data){
  if(!['walk_frame','walk_done','walk_error'].includes(data.type))return false;
  if(data.generation!==walkRun?.generation)return true;
  if(data.type==='walk_error'){stopPhysics('Walking stopped: '+data.error);return true;}
  if(data.type==='walk_done'){
    if(!physicsReset){if(data.frame&&data.frame.time>physicsTime)applyPhysics(data.frame);showWalkRate(data.speed);}
    walkRun=undefined;clearTimeout(walkTimer);if(!walkStopping)walking.finish(data.reason);return true;
  }
  if(!Number.isSafeInteger(data.sequence)||data.sequence<=walkRun.displaySequence)return true;
  walkRun.displaySequence=data.sequence;if(!physicsReset){applyPhysics(data.result);showWalkRate(data.speed);}watchWalking();
  physicsWorker.postMessage({type:'walk_ack',generation:data.generation,sequence:data.sequence});return true;
}
async function enterSimulation() {
  if (!robotView || physicsReset) return;
  if (!sceneEntered) { sceneEntered = true; leaveLanding(); }
  if (physicsReady && physicsWorker) {
    const show = heldFrame; heldFrame = undefined; show?.();
    const generation=physicsGeneration,worker=physicsWorker;
    await physicsPending?.promise;
    if(physicsGeneration!==generation||physicsWorker!==worker||physicsReset||!physicsReady)return;
    await walking.begin(); return;
  }
  if (preparingGeneration === physicsGeneration) { autoWalkGeneration=physicsGeneration; return; }
  await prepareSimulation({autoStart:true});
}
async function prepareSimulation({autoStart=false,hold=false}={}) {
  if (!robotView) return;
  if(physicsWorker||physicsPending)stopPhysics();
  const generation=++physicsGeneration;let worker;
  preparingGeneration = generation;
  autoWalkGeneration=autoStart?generation:-1;
  $('reset-simulation').disabled = true;
  $('prepare-simulation').disabled = true;
  $('stop-simulation').disabled = false;
  $('simulation-status').textContent = 'Preparing simulation · default models are precompiled…';
  $('preview-label').textContent = 'Recorded preview — not live · loading live simulation…';
  lockPoseControls(true);
  try {
    const mark=name=>{(globalThis.microduckLoadMarks??={})[name]=performance.timeOrigin+performance.now();};
    mark('prepare_requested');
    await globalThis.microduckSourcesReady;
    mark('sources_ready');
    if(physicsGeneration!==generation)return;
    worker=openingWorker??newPhysicsWorker();openingWorker=undefined;physicsWorker=worker;
    worker.onmessage = ({data}) => {
      if(physicsWorker!==worker)return;
      if(data.type==='load_progress'){showLoadProgress(data);return;}
      try{if(walkingMessage(data))return;}catch(error){stopPhysics('Simulation stopped: '+error.message);return;}
      if (!physicsPending || physicsPending.id !== data.id) return;
      const pending = physicsPending; physicsPending = undefined; clearTimeout(pending.timer);
      data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
    };
    worker.onerror = event => {if(physicsWorker===worker)stopPhysics('Simulation worker failed: ' + event.message, {keepPreview: true});};
    const sources = Object.fromEntries(sourceFiles.map(name =>
      [name, name === editorFile ? $('editor').value : savedDraft(name) ?? originals.get(name)]));
    mark('prepare_posted');
    // With editing disabled the page runs only the precompiled FMU: a refusal is shown, never
    // quietly replaced by the in-browser compiler.
    const state=await physicsCommand({type: 'prepare', sources, model: 'MicroduckJawLocked', ...((REQUIRE_FMU || EDITING_DISABLED) && {requireFmu: true})});
    if(physicsGeneration!==generation||physicsWorker!==worker)return;
    const show=()=>{endReplay(); invalidateSensorFrames(); applyPhysics(state);};
    // Before the scene is entered, the landing pose stays; the ready frame waits for entry.
    if(hold&&!sceneEntered){heldFrame=show;$('load-progress').hidden=true;$('simulation-warning').hidden=true;$('simulation-status').textContent='Simulation ready · Waddle in to walk.';}
    else show();
    physicsReady=true; $('walk-mode').disabled=false; setDriveEnabled(true);
    $('reset-simulation').disabled = false;
    $('step-simulation').disabled = false;
    if(autoWalkGeneration===generation){autoWalkGeneration=-1;await walking.begin();}
  } catch (error) { if(physicsGeneration!==generation||(worker&&physicsWorker!==worker))return;stopPhysics('Simulation unavailable: ' + error.message, {keepPreview: true});showSimulationWarning(error.message);throw error; }
}
// prepareSimulation shows its own failure in the status line (and the preview label)
// before it rejects; the rejection is also logged.
const prepareFailed = error => console.warn('Live simulation failed to load:', error);
$('prepare-simulation').onclick=()=>prepareSimulation().catch(prepareFailed);
$('step-simulation').onclick = async () => {
  if (!physicsReady || !physicsWorker) return;
  const generation=physicsGeneration;
  $('step-simulation').disabled = true;
  try { await showPhysics({type: 'step', time: physicsTime + 0.02}); if(physicsGeneration===generation)$('step-simulation').disabled = false; }
  catch (error) { if(physicsGeneration===generation)stopPhysics('Simulation stopped: ' + error.message); }
};
$('stop-simulation').onclick = () => stopPhysics();
async function resetSimulation(){
  if(!physicsReady||!physicsWorker||physicsReset)return;
  const run={worker:physicsWorker,generation:++physicsGeneration};physicsReset=run;
  const current=()=>physicsReset===run&&physicsWorker===run.worker&&physicsGeneration===run.generation;
  const pending=physicsPending?.promise;
  physicsReady=false;walking.finish();setDriveEnabled(false);
  $('reset-simulation').disabled=true;$('step-simulation').disabled=true;$('walk-mode').disabled=true;
  $('simulation-speed').textContent='Live speed: —';$('simulation-status').textContent='Resetting simulation…';
  endReplay();invalidateSensorFrames();
  try{
    // Finish the existing owner before sending pause/reset; old continuations cannot apply.
    if(pending)await pending;
    if(!current())return;
    await pauseWalking();
    if(!current())return;
    walkGeneration++;walkRun=undefined;walkStopping=false;clearTimeout(walkTimer);
    invalidateSensorFrames();
    const state=await physicsCommand({type:'reset'});
    if(!current())return;
    if(state?.time!==0)throw Error('Simulation reset did not return time zero.');
    applyPhysics(state);physicsReady=true;
  }catch(error){if(current())stopPhysics('Simulation reset failed: '+error.message);}
  finally{
    if(current()){
      physicsReset=undefined;$('reset-simulation').disabled=!physicsReady;
      $('step-simulation').disabled=!physicsReady;$('walk-mode').disabled=!physicsReady;setDriveEnabled(physicsReady);
    }
  }
}
$('reset-simulation').onclick=resetSimulation;

// Recorded playback. A preview loops a recording while the page waits for the live
// simulation: it never stops or blocks a live session, and the first live state ends it.
// A manual recording replaces a live session, as before. Every start and end bumps
// replayGeneration, so a stale fetch, frame callback or error changes nothing.
function validFrames(recording) {
  const frames = recording?.frames;
  if (!Array.isArray(frames) || !frames.length) throw new Error('Recording has no frames.');
  let previous = -Infinity;
  for (const frame of frames) {
    if (!Number.isFinite(frame?.time) || frame.time <= previous) throw new Error('Recording times are not finite and increasing.');
    previous = frame.time;
  }
  return frames;
}
async function fetchRecording(file) {
  const response = await fetch('./recordings/' + file);
  if (!response.ok) throw new Error('Recording unavailable.');
  const recording = await response.json();
  validFrames(recording);
  return recording;
}
function showRecordedFrame(frame, preview) {
  robotView.apply(frame);
  showSensors(frame, true);
  $('view-mode').textContent = (preview ? 'Recorded preview — not live' : 'Recorded native physics') + ' · t = ' + frame.time.toFixed(3) + ' s';
}
async function playRecording(name, {preview = false, first} = {}) {
  if (!robotView) return;
  if (preview && liveOwned()) return;
  if (!preview) stopPhysics();
  const generation = ++replayGeneration;
  try {
    $('stop-simulation').disabled = false;
    const full = fetchRecording(name + '.json');
    if (preview) {
      previewGeneration = generation;
      full.catch(() => {});
      $('preview-label').textContent = 'Recorded preview — not live';
      $('preview-label').hidden = false;
      $('simulation-status').textContent = 'Recorded preview — not live.';
      // The first frame comes from whichever arrives first: the small slice or the recording.
      const head = await Promise.any([first ?? full, full]);
      if (generation !== replayGeneration) return;
      showRecordedFrame(head.frames[0], true);
      // Live preparation starts by itself once, after this frame is drawn, unless the
      // preview was cancelled or a live or manual transition came first.
      if (autoPrepare) {
        autoPrepare = false;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (previewing() && !liveOwned()) prepareSimulation().catch(prepareFailed);
        }));
      }
    }
    const recording = await full;
    if (generation !== replayGeneration) return;
    const frames = recording.frames, start = frames[0].time, duration = frames[frames.length - 1].time - start;
    if (preview && !(duration > 0)) throw new Error('Recording is too short to loop.');
    if (!preview) $('simulation-status').textContent = recording.label + ' · recorded native physics, not a live session.';
    const started = performance.now();
    let index = 0, lap = 0;
    function display(now) {
      replayFrame = undefined;
      if (generation !== replayGeneration) return;
      let elapsed = Math.max(0, (now - started) / 1000);
      if (preview) {
        const current = Math.floor(elapsed / duration);
        if (current !== lap) { lap = current; index = 0; }
        elapsed -= current * duration;
      }
      while (index + 1 < frames.length && frames[index + 1].time - start <= elapsed) index++;
      const frame = frames[index];
      try { showRecordedFrame(frame, preview); }
      catch (error) { recordingFailed(generation, preview, error); return; }
      if (preview || index + 1 < frames.length) replayFrame = requestAnimationFrame(display);
      else $('simulation-status').textContent = recording.label + ' · recording complete (' + frame.time.toFixed(1) + ' s).';
    }
    replayFrame = requestAnimationFrame(display);
  } catch (error) {
    recordingFailed(generation, preview, error.errors?.at(-1) ?? error);
  }
}
// A failure belongs to its own generation only. A failed preview never touches a live
// session that is loading; with none, the page returns to the pose explorer.
function recordingFailed(generation, preview, error) {
  if (generation !== replayGeneration) return;
  if (!preview) { stopPhysics('Recording unavailable: ' + error.message); return; }
  endReplay();
  $('view-mode').textContent = 'Recorded preview unavailable';
  if (liveOwned()) return;
  robotView.restore();
  $('stop-simulation').disabled = true;
  $('simulation-status').textContent = 'Recorded preview unavailable: ' + error.message;
}
$('play-policy').onclick = () => playRecording('pretrained-walk');
$('play-standing').onclick = () => playRecording('standing');
$('play-fall').onclick = () => playRecording('baseline-fall');

function showSensors(state, recorded = false) {
  $('sensor-values').textContent = JSON.stringify(state.outputs ?? {}, null, 2);
  $('telemetry-status').textContent = (recorded ? 'Recorded Modelica telemetry at ' : 'Modelica telemetry at ') + state.time.toFixed(3) + ' s';
}

const stages = [
  ['Walking', 'First build reliable standing and walking on flat ground.'],
  ['Balance on board', 'Start aboard a stationary board and learn a stable stance.'],
  ['Downhill coasting', 'Start on the board on a shallow slope and learn to coast.'],
  ['Pushing', 'Keep one foot aboard while the other pushes, then recover the stance.'],
  ['Mount and push', 'Approach the board, mount it, and build forward motion.'],
  ['Complete downhill run', 'Combine mounting, pushing and a controlled downhill run.']
];
stages.forEach(([name, description], i) => {
  const button = document.createElement('button');
  button.className = 'stage' + (i === 0 ? ' active' : '');
  const number = document.createElement('i');
  number.textContent = String(i + 1);
  const label = document.createElement('span');
  label.textContent = name;
  button.append(number, label);
  button.onclick = () => {
    document.querySelectorAll('.stage').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    $('stage-description').textContent = description;
  };
  $('stages').append(button);
});
$('stage-description').textContent = stages[0][1];

initializeView().catch(error => {
  $('loading').textContent = '3D view unavailable: ' + error.message;
  $('view-mode').textContent = 'Source editor remains available below';
});
// Source initialization settles the readiness promise however it ends: a failed or
// malformed manifest, or any step before the source loader starts, rejects it.
async function loadManifest() {
  const response = await fetchWithRetry('./sources/manifest.json');
  if (!response.ok) throw new Error('Source manifest unavailable (HTTP ' + response.status + ').');
  const files = await response.json();
  if (!Array.isArray(files) || !files.length || !files.every(name => typeof name === 'string' && name))
    throw new Error('Source manifest is malformed.');
  return files;
}
function sourceStep(step) {
  try { return step(); }
  catch (error) { settleSources?.reject(error); throw error; }
}
const sourceFiles = await loadManifest().catch(error => { settleSources?.reject(error); throw error; });
const originals = new Map();
const drafts = sourceStep(() => modelDrafts({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)},{readOnly:EDITING_DISABLED}));
const previousDrafts = sourceStep(() => drafts.previous(sourceFiles));
sourceStep(() => {
  if (!Object.keys(previousDrafts).length) return;
  $('previous-drafts').hidden=false;
  $('download-previous-drafts').onclick=()=>{
    const data=JSON.stringify({format:'microduck-modelica-drafts',version:2,files:previousDrafts},null,2);
    const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='microduck-previous-drafts.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
});
let selectedFile = 'Microduck.mo';
// The file the editor holds. Until a file is in the editor, preparation sends that file's
// draft or original: the sources can be ready before the editor is filled.
let editorFile;
function savedDraft(name) {
  try { return drafts.get(name); }
  catch { return null; }
}
async function loadSource(name) {
  if (!originals.has(name)) {
    const response = await fetchWithRetry('./sources/' + encodeURIComponent(name));
    if (!response.ok) throw new Error('Could not load ' + name);
    originals.set(name, await response.text());
  }
  if (selectedFile !== name) return;
  const draft = savedDraft(name);
  $('editor').value = draft ?? originals.get(name);editorFile = name;
  $('editor').dispatchEvent(new Event('input'));
  updateFileSelection();
  $('editor-status').textContent = draft === null ? 'Original source.' : 'Local draft restored.';
}
sourceStep(() => {
  sourceFiles.forEach(name => $('source-file').add(new Option(name, name)));
  $('source-file').value = selectedFile;
});
function updateFileSelection() {
  document.querySelectorAll('#file-browser button[data-path]').forEach(button =>
    button.classList.toggle('selected', button.dataset.path === selectedFile));
  globalThis.microduckSourceEditor?.setWorkspaceSources(
    Object.fromEntries(sourceFiles.filter(name => originals.has(name)).map(name =>
      [name, savedDraft(name) ?? originals.get(name)])), selectedFile);
}
function fileTree() {
  const tree = {};
  for (const path of sourceFiles) {
    const parts = path.split('/'); let node = tree;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = path;
  }
  function append(node, parent) {
    for (const [name, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        const button = document.createElement('button');
        button.textContent = name; button.dataset.path = value; button.title = value;
        button.onclick = () => { selectedFile = value; $('source-file').value = value;
          loadSource(value).catch(error => $('editor-status').textContent = error.message); };
        parent.append(button);
      } else {
        const details = document.createElement('details'); const summary = document.createElement('summary');
        summary.textContent = name; details.append(summary); append(value, details); parent.append(details);
      }
    }
  }
  append(tree, $('file-browser')); updateFileSelection();
}
sourceStep(fileTree);
// A shared source map feeds Rumoca's real language service, including companion packages.
// All at once: the browser schedules the requests, and the main thread (busy drawing the
// 3D view) handles their completions together instead of one small batch per frame.
settleSources?.resolve((async () => {
  await Promise.all(sourceFiles.map(async name => {
    const response = await fetchWithRetry('./sources/' + name.split('/').map(encodeURIComponent).join('/'));
    if (!response.ok) throw new Error('Could not load companion source ' + name);
    originals.set(name, await response.text());
  }));
  updateFileSelection();
})());
document.addEventListener('microduck-editor-ready', updateFileSelection);
$('source-file').onchange = () => {
  selectedFile = $('source-file').value;
  loadSource(selectedFile).catch(error => $('editor-status').textContent = error.message);
};
$('editor').oninput = () => {
  updateFileSelection();
  try {
    drafts.set(selectedFile, $('editor').value);
    $('editor-status').textContent = 'Draft saved in this browser.';
  } catch { $('editor-status').textContent = 'Draft is in this tab; use Download to keep it.'; }
};
$('reset-file').onclick = async () => {
  try { drafts.remove(selectedFile); } catch {}
  await loadSource(selectedFile);
};
$('download-file').onclick = () => {
  const url = URL.createObjectURL(new Blob([$('editor').value], {type: 'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = selectedFile;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
if (EDITING_DISABLED) {
  $('editor').readOnly = true;
  $('check-model').disabled = true;
  $('check-model').title = 'Source editing is disabled in this build.';
}
$('check-model').onclick = async () => {
  const button = $('check-model'); button.disabled = true;
  $('compile-status').textContent = 'Checking the Microduck model in browser WASM…';
  $('compile-errors').hidden = true;
  try {
    await globalThis.microduckSourcesReady;
    const editor = globalThis.microduckSourceEditor;
    if (!editor) throw new Error('The Modelica editor is still loading.');
    await editor.ready;
    const sources = Object.fromEntries(sourceFiles.map(name =>
      [name, name === selectedFile ? $('editor').value : savedDraft(name) ?? originals.get(name)]));
    const source = sources['Microduck.mo']; delete sources['Microduck.mo'];
    const result = await editor.checkModel(source, 'Microduck', sources);
    const warnings = result.__compile_warnings ?? [];
    $('compile-status').textContent = 'Modelica check passed in browser WASM. Solver preparation is a separate check.';
    if (warnings.length) {
      $('compile-errors').textContent = warnings.map(item => (item.code ? item.code + ': ' : '') + item.message).join('\n');
      $('compile-errors').hidden = false;
    }
  } catch (error) {
    $('compile-status').textContent = 'Modelica check failed.';
    $('compile-errors').textContent = error.message;
    $('compile-errors').hidden = false;
  } finally { button.disabled = false; }
};
$('editor').onkeydown = event => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const input = $('editor');
    input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input'));
  }
};

function direct(element, name) { return [...element.children].filter(child => child.tagName === name); }
function vector(value, fallback) {
  const result = value ? value.trim().split(/\s+/).map(Number) : fallback;
  if (!result.every(Number.isFinite)) throw new Error('Non-finite model geometry');
  return result;
}
function transform(object, element) {
  object.position.fromArray(vector(element.getAttribute('pos'), [0, 0, 0]));
  const [w, x, y, z] = vector(element.getAttribute('quat'), [1, 0, 0, 0]);
  object.quaternion.set(x, y, z, w).normalize();
}
async function initializeView() {
  const container = $('canvas');
  let viewDirty = true;
  const invalidate = () => { viewDirty = true; };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 30);
  camera.position.set(0.55,0.35,0.7);
  const renderer = new THREE.WebGLRenderer({antialias:true,alpha:false});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1;
  const soundtrack=createSoundtrack({audio:$('soundtrack'),src:$('soundtrack').dataset.src,button:$('music-toggle'),storage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)}});
  const arena=createPollenScene(scene,renderer),shell=createSceneShell(document,{onEnter:()=>{soundtrack.start();enterSimulation().catch(prepareFailed);}});
  container.append(renderer.domElement);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.target.set(0,0.13,0);controls.enableDamping=true;
  controls.minDistance=.13;controls.maxDistance=5;
  controls.addEventListener('change',()=>{viewDirty=true;});
  $('board-toggle').onchange=()=>{arena.border($('board-toggle').checked);invalidate();};
  const follow=createCameraFollower(camera,controls);
  $('frame-robot').onclick=()=>follow.home();
  $('frame-park').onclick=()=>{follow.hold();controls.target.set(0,.08,0);camera.position.set(2,1.5,2);};
  const resize = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    viewDirty = true;
  };
  new ResizeObserver(resize).observe(container);
  resize();
  let sensorPreview, sensorReadPending = false, lastSensorStatus = -Infinity, sensorGeneration = 0;
  const sensorToggle = $('sensor-rendering');
  invalidateSensorFrames = () => { sensorGeneration++; renderedFrame = undefined; sensorPreview?.reset(); };
  sensorToggle.onchange = () => {
    invalidateSensorFrames();
    updateWalking();
    $('sensor-status').textContent = sensorToggle.checked ? 'Starting camera / ToF…' : 'Rendering off · enable to view camera / ToF.';
  };
  renderer.setAnimationLoop(now => {
    controls.update();
    arena.focus(robotView?.focus??controls.target);
    if (viewDirty) { renderer.render(scene, camera); viewDirty = false; }
    if (sensorToggle.checked && sensorPreview && !sensorReadPending && !physicsReset) {
      sensorReadPending = true;
      const preview = sensorPreview, generation = sensorGeneration;
      preview.capture(now).then(frame => {
        if (frame && sensorToggle.checked && generation === sensorGeneration) {
          renderedFrame = frame;
          updateWalking();
          if (now - lastSensorStatus >= 250) {
            lastSensorStatus = now;
            $('sensor-status').textContent = 'Three.js · RGB ' + preview.stats.cameraFps.toFixed(1) + '/30 fps · ToF ' + preview.stats.tofHz.toFixed(1) + '/15 Hz · 0–4 m';
            $('sensor-status').title = preview.stats.renderer;
            $('rendered-ranges').textContent = JSON.stringify({ranges_m:frame.ranges, valid:frame.valid}, null, 2);
          }
        }
      }).catch(error => {
        // A capture from before a reset or toggle failed: it no longer owns the sensors.
        if (generation !== sensorGeneration || preview !== sensorPreview) return;
        $('sensor-status').textContent = 'Sensor rendering unavailable: ' + error.message;
        sensorPreview = undefined;
      }).finally(() => { sensorReadPending = false; });
    }
  });
  const {sensors, joints, robot} = await loadRobot(scene, invalidate,follow);
  shell.assetsReady();
  landing = createLanding({robot, joints, camera, controls, canvas: renderer.domElement, invalidate});
  // Entering the scene ends the landing and returns the camera to the game view.
  leaveLanding = () => { landing.stop(); follow.home(); };
  if (!sceneEntered) landing.start();
  if (!liveOwned()) prepareSimulation({hold: true}).catch(prepareFailed);
  if (sensors.camera && sensors.tof) sensorPreview = createSensorPreview(renderer, scene, sensors.camera, sensors.tof, $('camera-frame'), $('lidar-frame'));
  globalThis.microduckSensorStats = sensorPreview?.stats;
  invalidate();
}

async function loadRobot(scene, invalidate,follow) {
  const response = await fetch('./robot.xml');
  if (!response.ok) throw new Error('Robot description could not be loaded');
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Invalid robot description');
  const assets = new Map([...xml.querySelectorAll('asset > mesh')].map(mesh =>
    [mesh.getAttribute('name') || mesh.getAttribute('file').split('/').pop().replace(/\.[^.]+$/, ''), {file: mesh.getAttribute('file'),
      scale: vector(mesh.getAttribute('scale'), [1, 1, 1])}]));
  const colors = new Map([...xml.querySelectorAll('asset > material')].map(material =>
    [material.getAttribute('name'), vector(material.getAttribute('rgba'), [0.6, 0.65, 0.55, 1])]));
  const geometries=await loadPollenGeometries();
  const materialForMesh=materialHookFor(VARIANTS[DEFAULT_VARIANT]);
  const materialCache=new Map();
  const joints = [];
  const visualBodies = new Map();
  const sensors = {};
  // The imported hierarchy and all Rumoca body poses use Z up. Pollen's scene uses Y up.
  const modelSpace=new THREE.Group(),robot=new THREE.Group();
  modelSpace.add(robot);scene.add(modelSpace);
  function geometry(file) {
    const name = file.split('/').pop();
    const result=geometries.get(name);
    if(!result)throw Error('Robot GLB is missing geometry: '+name);
    return result;
  }
  async function body(element, parent) {
    const frame = new THREE.Group();
    frame.name = element.getAttribute('name');
    transform(frame, element);
    parent.add(frame);
    let content = frame;
    const joint = direct(element, 'joint')[0];
    if (joint) {
      const origin = vector(joint.getAttribute('pos'), [0, 0, 0]);
      const pivot = new THREE.Group();
      pivot.position.fromArray(origin);
      frame.add(pivot);
      content = new THREE.Group();
      content.position.fromArray(origin.map(value => -value));
      pivot.add(content);
      const axis = new THREE.Vector3(...vector(joint.getAttribute('axis'), [0, 0, 1]));
      if (axis.lengthSq() === 0) throw new Error('Joint has no rotation axis');
      const range = vector(joint.getAttribute('range'), [-Math.PI, Math.PI]);
      const q = Math.max(range[0], Math.min(range[1], 0));
      const state = {name: joint.getAttribute('name'), pivot, axis: axis.normalize(), range, q, initial: q};
      pivot.quaternion.setFromAxisAngle(state.axis, q);
      joints.push(state);
    }
    const visuals = new THREE.Group();
    content.add(visuals);
    visualBodies.set(frame.name, {visuals, parent: content});
    const cameraElement = direct(element, 'camera').find(item => item.getAttribute('name') === 'head_camera');
    if (cameraElement) {
      sensors.camera = new THREE.PerspectiveCamera(60, 4/3, 0.005, 4);
      const cameraSite = direct(element, 'site').find(item => item.getAttribute('name') === 'head_camera');
      transform(sensors.camera, cameraSite ?? cameraElement);
      // The tutorial sensor sites use +X forward; Three.js cameras use -Z.
      if (cameraSite) { sensors.camera.rotateY(-Math.PI / 2); sensors.camera.rotateZ(-Math.PI / 2); }
      visuals.add(sensors.camera);
      sensors.tof = new THREE.PerspectiveCamera(45, 1, 0.005, 4);
      sensors.tof.position.copy(sensors.camera.position); sensors.tof.quaternion.copy(sensors.camera.quaternion);
      const tofSite = direct(element, 'site').find(item => item.getAttribute('name') === 'tof');
      if (tofSite) { transform(sensors.tof, tofSite); sensors.tof.rotateY(-Math.PI / 2); sensors.tof.rotateZ(-Math.PI / 2); }
      visuals.add(sensors.tof);
    }
    await Promise.all(direct(element, 'geom').filter(geom =>
      geom.getAttribute('class') === 'visual' && geom.hasAttribute('mesh')).map(async geom => {
      const definition = assets.get(geom.getAttribute('mesh'));
      if (!definition) throw new Error('Mesh definition is missing');
      const [r, g, b, opacity] = colors.get(geom.getAttribute('material')) ?? [0.6, 0.65, 0.55, 1];
      const spec=materialForMesh(definition.file.split('/').pop(),frame.name,[r,g,b,opacity]);
      const key=JSON.stringify(spec);
      if(!materialCache.has(key))materialCache.set(key,new THREE.MeshStandardMaterial({
        color:new THREE.Color(...spec.color),roughness:spec.roughness??.5,
        metalness:spec.metalness??0,opacity,transparent:opacity<1,envMapIntensity:.45
      }));
      const mesh=new THREE.Mesh(geometry(definition.file),materialCache.get(key));
      mesh.userData.meshName=definition.file.split('/').pop();
      mesh.scale.fromArray(definition.scale);
      transform(mesh, geom);
      mesh.castShadow = false;
      // The millimetre-scale CAD surfaces cast onto the ground; avoiding
      // self-shadow reception prevents shadow-map banding on the shells.
      mesh.receiveShadow = false;
      visuals.add(mesh);
    }));
    for (const child of direct(element, 'body')) await body(child, content);
  }
  const world = xml.querySelector('worldbody');
  if (!world) throw new Error('Robot has no body tree');
  for (const element of direct(world, 'body')) await body(element, robot);
  robot.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(robot);
  if (bounds.isEmpty()) throw new Error('Robot has no visible geometry');
  robot.position.z += -bounds.min.z + 0.002;
  modelSpace.rotation.x=-Math.PI/2;
  modelSpace.updateMatrixWorld(true);
  joints.forEach(joint => {
    const row = document.createElement('div');
    row.className = 'joint';
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = joint.name.replaceAll('_', ' ');
    const output = document.createElement('output');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(joint.range[0]);
    slider.max = String(joint.range[1]);
    slider.step = '0.005';
    slider.value = String(joint.q);
    slider.setAttribute('aria-label', joint.name.replaceAll('_', ' '));
    const update = () => {
      joint.q = Number(slider.value);
      joint.pivot.quaternion.setFromAxisAngle(joint.axis, joint.q);
      output.value = (joint.q * 180 / Math.PI).toFixed(0) + '°';
      invalidate();
    };
    slider.oninput = update;
    joint.reset = () => { slider.value = String(joint.initial); update(); };
    label.append(name, output);
    row.append(label, slider);
    $('joints').append(row);
    update();
  });
  $('reset-pose').onclick = () => joints.forEach(joint => joint.reset());
  $('roster').textContent = world.querySelectorAll('body').length + ' imported bodies · ' +
    joints.length + ' hinges. Mouth articulation is being added to the tutorial model.';
  $('loading').textContent='Visual assets ready.';
  robotView=createModelicaPoseView({modelSpace,visualBodies,invalidate,onPose:position=>follow.update(position),onRestore:()=>follow.restore(),
    lockControls:lockPoseControls});
  $('prepare-simulation').disabled = false;
  return {sensors, joints, robot};
}

loadSource(selectedFile).catch(error => $('editor-status').textContent = error.message);


