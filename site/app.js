import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import {loadPollenGeometries} from './pollen/geometry.js';
import {createPollenScene} from './pollen/scene.js';
import {createSceneShell} from './pollen/shell.js';
import {createModelicaPoseView} from './pollen/pose-view.js';
import {createCameraFollower} from './pollen/camera-follow.js';
import {VARIANTS,DEFAULT_VARIANT,materialHookFor} from './pollen/variants.js';
import { createSensorPreview } from './sensor-preview.js';
import { sensorInputs } from './sensor-inputs.js';
import { createWalkingControls } from './walking-controls.js';
import {modelDrafts} from './model-drafts.js';

const $ = id => document.getElementById(id);
let robotView;
let physicsWorker;
let physicsReady=false;
let physicsTime = 0;
let renderedFrame;
let physicsRequest = 0;
let physicsPending;
let physicsGeneration=0;
let replayGeneration = 0;
let walkGeneration=0,walkRun,walkTimer,walkStopping=false;
function showWalkRate(sample){
  if(sample&&Number.isFinite(sample.factor)&&sample.wallSeconds>0)$('simulation-speed').textContent='Live speed: '+sample.factor.toFixed(2)+'× real time · '+sample.simulatedSeconds.toFixed(2)+' s simulated / '+sample.wallSeconds.toFixed(2)+' s elapsed';
}
const walking=createWalkingControls({
  button:$('walk-mode'),status:$('walk-command'),
  canRun:()=>!!physicsWorker&&physicsReady&&!walkStopping,
  start:startWalking,pause:pauseWalking,update:updateWalking,
  setRunning:active=>$('step-simulation').disabled=active||walkStopping||!physicsReady,
  onError:error=>stopPhysics('Walking stopped: '+error.message)
});
function stopPhysics(message = 'Simulation stopped. Pose controls restored.') {
  replayGeneration++;
  physicsGeneration++;
  walkGeneration++;walkRun=undefined;walkStopping=false;clearTimeout(walkTimer);
  $('simulation-speed').textContent='Live speed: —';
  physicsReady=false; walking.finish(); $('walk-mode').disabled=true;
  physicsWorker?.terminate(); physicsWorker = undefined;
  if (physicsPending) { clearTimeout(physicsPending.timer); physicsPending.reject(new Error(message)); physicsPending = undefined; }
  robotView?.restore();
  $('prepare-simulation').disabled = false;
  $('step-simulation').disabled = true;
  $('stop-simulation').disabled = true;
  $('simulation-status').textContent = message;
  $('view-mode').textContent = '3D pose explorer · kinematics';
  $('telemetry-status').textContent = 'No live Modelica telemetry.';
}
function physicsCommand(message, limit = 360000) {
  if (physicsPending) return Promise.reject(new Error('A simulation command is already running.'));
  return new Promise((resolve, reject) => {
    const id = ++physicsRequest;
    const timer = setTimeout(() => stopPhysics('Simulation exceeded its time budget. No new pose was applied.'), limit);
    physicsPending = {id, resolve, reject, timer};
    physicsWorker.postMessage({...message, id});
  });
}
async function showPhysics(command) {
  const worker=physicsWorker,generation=physicsGeneration;
  if ((command.type === 'step'||command.type === 'policy_step') && renderedFrame) command.inputs = sensorInputs(renderedFrame, physicsTime);
  const state = await physicsCommand(command);
  if(physicsWorker!==worker||physicsGeneration!==generation)return;
  applyPhysics(state);
  return state;
}
function applyPhysics(state) {
  robotView.apply(state);
  physicsTime = state.time;
  showSensors(state);
  $('view-mode').textContent = 'Modelica simulation · t = ' + state.time.toFixed(3) + ' s';
  $('simulation-status').textContent = state.preparation ? (['prebuilt','precompiled-runtime'].includes(state.preparation.plant)&&state.preparation.controller==='prebuilt'?'Simulation ready · compiled models loaded.':'Simulation ready · edited source compiled.') : state.control ? 'Pretrained Pollen velstand · Modelica physics.' : 'Standing controller · Modelica physics.';
}
function watchWalking(){clearTimeout(walkTimer);walkTimer=setTimeout(()=>stopPhysics('Simulation exceeded its time budget. No new pose was applied.'),360000);}
function walkingInputs(){return renderedFrame?sensorInputs(renderedFrame,physicsTime):null;}
function updateWalking(twist=walking.command()){
  if(!walkRun||walkStopping)return;
  try{physicsWorker.postMessage({type:'walk_input',generation:walkRun.generation,sequence:++walkRun.inputSequence,twist,inputs:walkingInputs()});}
  catch(error){stopPhysics('Walking stopped: '+error.message);}
}
async function startWalking(twist){
  if(walkRun||walkStopping)throw Error('Walking is already running.');
  const run={generation:++walkGeneration,inputSequence:0,displaySequence:0};walkRun=run;$('simulation-speed').textContent='Live speed: measuring…';watchWalking();
  try{await physicsCommand({type:'walk_start',generation:run.generation,mode:'realtime',twist,inputs:walkingInputs()});}
  catch(error){if(walkGeneration!==run.generation)return;if(walkRun===run)walkRun=undefined;clearTimeout(walkTimer);throw error;}
}
async function pauseWalking(){
  const run=walkRun;if(!run)return;
  walkStopping=true;$('step-simulation').disabled=true;
  try{const state=await physicsCommand({type:'walk_stop',generation:run.generation});if(state.frame&&state.frame.time>physicsTime)applyPhysics(state.frame);showWalkRate(state.speed);}
  finally{if(walkGeneration===run.generation){if(walkRun===run)walkRun=undefined;walkStopping=false;clearTimeout(walkTimer);$('step-simulation').disabled=!physicsReady;}}
}
function walkingMessage(data){
  if(!['walk_frame','walk_done','walk_error'].includes(data.type))return false;
  if(data.generation!==walkRun?.generation)return true;
  if(data.type==='walk_error'){stopPhysics('Walking stopped: '+data.error);return true;}
  if(data.type==='walk_done'){
    if(data.frame&&data.frame.time>physicsTime)applyPhysics(data.frame);showWalkRate(data.speed);
    walkRun=undefined;clearTimeout(walkTimer);if(!walkStopping)walking.finish(data.reason);return true;
  }
  if(!Number.isSafeInteger(data.sequence)||data.sequence<=walkRun.displaySequence)return true;
  walkRun.displaySequence=data.sequence;applyPhysics(data.result);showWalkRate(data.speed);watchWalking();
  physicsWorker.postMessage({type:'walk_ack',generation:data.generation,sequence:data.sequence});return true;
}
async function prepareSimulation() {
  if (!robotView) return;
  if(physicsWorker||physicsPending)stopPhysics();
  const generation=++physicsGeneration;let worker;
  $('prepare-simulation').disabled = true;
  $('stop-simulation').disabled = false;
  $('simulation-status').textContent = 'Preparing simulation · default models are precompiled…';
  try {
    await globalThis.microduckSourcesReady;
    if(physicsGeneration!==generation)return;
    worker=new Worker(new URL('./physics.worker.js', import.meta.url), {type: 'module'});physicsWorker=worker;
    worker.onmessage = ({data}) => {
      if(physicsWorker!==worker)return;
      try{if(walkingMessage(data))return;}catch(error){stopPhysics('Simulation stopped: '+error.message);return;}
      if (!physicsPending || physicsPending.id !== data.id) return;
      const pending = physicsPending; physicsPending = undefined; clearTimeout(pending.timer);
      data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
    };
    worker.onerror = event => {if(physicsWorker===worker)stopPhysics('Simulation worker failed: ' + event.message);};
    const sources = Object.fromEntries(sourceFiles.map(name =>
      [name, name === selectedFile ? $('editor').value : savedDraft(name) ?? originals.get(name)]));
    const state=await physicsCommand({type: 'prepare', sources, model: 'MicroduckJawLocked'});
    if(physicsGeneration!==generation||physicsWorker!==worker)return;
    applyPhysics(state);
    physicsReady=true; $('walk-mode').disabled=false;
    $('step-simulation').disabled = false;
  } catch (error) { if(physicsGeneration!==generation||(worker&&physicsWorker!==worker))return;stopPhysics('Simulation unavailable: ' + error.message);throw error; }
}
$('prepare-simulation').onclick=()=>prepareSimulation().catch(()=>{});
$('step-simulation').onclick = async () => {
  const generation=physicsGeneration;
  $('step-simulation').disabled = true;
  try { await showPhysics({type: 'step', time: physicsTime + 0.02}); if(physicsGeneration===generation)$('step-simulation').disabled = false; }
  catch (error) { if(physicsGeneration===generation)stopPhysics('Simulation stopped: ' + error.message); }
};
$('stop-simulation').onclick = () => stopPhysics();

async function playRecording(name) {
  if (!robotView) return;
  stopPhysics();
  const generation = ++replayGeneration;
  const response = await fetch('./recordings/' + name + '.json');
  if (!response.ok) throw new Error('Recording unavailable.');
  const recording = await response.json();
  if (generation !== replayGeneration) return;
  const frames = recording.frames;
  if (!frames?.length) throw new Error('Recording has no frames.');
  const started = performance.now();
  let index = 0;
  $('stop-simulation').disabled = false;
  $('simulation-status').textContent = recording.label + ' · recorded native physics, not a live session.';
  function display(now) {
    if (generation !== replayGeneration) return;
    const elapsed = (now - started) / 1000;
    while (index + 1 < frames.length && frames[index + 1].time <= elapsed) index++;
    const frame = frames[index];
    try { robotView.apply(frame); }
    catch (error) { stopPhysics('Recording unavailable: ' + error.message); return; }
    showSensors(frame);
    $('view-mode').textContent = 'Recorded native physics · t = ' + frame.time.toFixed(3) + ' s';
    if (index + 1 < frames.length) requestAnimationFrame(display);
    else $('simulation-status').textContent = recording.label + ' · recording complete (' + frame.time.toFixed(1) + ' s).';
  }
  requestAnimationFrame(display);
}
$('play-policy').onclick = () => playRecording('pretrained-walk').catch(error => stopPhysics(error.message));
$('play-standing').onclick = () => playRecording('standing').catch(error => stopPhysics(error.message));
$('play-fall').onclick = () => playRecording('baseline-fall').catch(error => stopPhysics(error.message));

function showSensors(state) {
  $('sensor-values').textContent = JSON.stringify(state.outputs ?? {}, null, 2);
  $('telemetry-status').textContent = 'Modelica telemetry at ' + state.time.toFixed(3) + ' s';
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

const sourceFiles = await (await fetch('./sources/manifest.json')).json();
const originals = new Map();
const drafts = modelDrafts({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)});
const previousDrafts = drafts.previous(sourceFiles);
if(Object.keys(previousDrafts).length){
  $('previous-drafts').hidden=false;
  $('download-previous-drafts').onclick=()=>{
    const data=JSON.stringify({format:'microduck-modelica-drafts',version:2,files:previousDrafts},null,2);
    const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='microduck-previous-drafts.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
}
let selectedFile = 'Microduck.mo';
function savedDraft(name) {
  try { return drafts.get(name); }
  catch { return null; }
}
async function loadSource(name) {
  if (!originals.has(name)) {
    const response = await fetch('./sources/' + encodeURIComponent(name));
    if (!response.ok) throw new Error('Could not load ' + name);
    originals.set(name, await response.text());
  }
  if (selectedFile !== name) return;
  const draft = savedDraft(name);
  $('editor').value = draft ?? originals.get(name);
  $('editor').dispatchEvent(new Event('input'));
  updateFileSelection();
  $('editor-status').textContent = draft === null ? 'Original source.' : 'Local draft restored.';
}
sourceFiles.forEach(name => $('source-file').add(new Option(name, name)));
$('source-file').value = selectedFile;
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
fileTree();
// A shared source map feeds Rumoca's real language service, including companion packages.
globalThis.microduckSourcesReady = (async () => {
  for (let i = 0; i < sourceFiles.length; i += 8) {
    await Promise.all(sourceFiles.slice(i, i + 8).map(async name => {
      const response = await fetch('./sources/' + name.split('/').map(encodeURIComponent).join('/'));
      if (!response.ok) throw new Error('Could not load companion source ' + name);
      originals.set(name, await response.text());
    }));
  }
  updateFileSelection();
})();
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

const direct = (element, name) => [...element.children].filter(child => child.tagName === name);
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
  const arena=createPollenScene(scene,renderer),shell=createSceneShell(document);
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
  sensorToggle.onchange = () => {
    sensorGeneration++; renderedFrame = undefined;
    updateWalking();
    $('sensor-status').textContent = sensorToggle.checked ? 'Starting camera / ToF…' : 'Rendering off · enable to view camera / ToF.';
  };
  renderer.setAnimationLoop(now => {
    controls.update();
    arena.focus(robotView?.focus??controls.target);
    if (viewDirty) { renderer.render(scene, camera); viewDirty = false; }
    if (sensorToggle.checked && sensorPreview && !sensorReadPending) {
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
        $('sensor-status').textContent = 'Sensor rendering unavailable: ' + error.message;
        sensorPreview = undefined;
      }).finally(() => { sensorReadPending = false; });
    }
  });
  const sensors = await loadRobot(scene, invalidate,follow);
  shell.assetsReady();
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
    lockControls:disabled=>document.querySelectorAll('#joints input, #reset-pose').forEach(input=>input.disabled=disabled)});
  $('prepare-simulation').disabled = false;
  return sensors;
}

loadSource(selectedFile).catch(error => $('editor-status').textContent = error.message);
initializeView().catch(error => {
  $('loading').textContent = '3D view unavailable: ' + error.message;
  $('view-mode').textContent = 'Source editor remains available below';
});


