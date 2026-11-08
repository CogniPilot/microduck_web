import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { STLLoader } from './vendor/STLLoader.js';
import { createSensorPreview } from './sensor-preview.js';
import { sensorInputs } from './sensor-inputs.js';
import { createWalkingControls } from './walking-controls.js';

const $ = id => document.getElementById(id);
let robotView;
let physicsWorker;
let physicsReady=false;
let physicsTime = 0;
let renderedFrame;
let physicsRequest = 0;
let physicsPending;
let replayGeneration = 0;
const walking=createWalkingControls({
  button:$('walk-mode'),status:$('walk-command'),
  canRun:()=>!!physicsWorker&&physicsReady,
  step:twist=>showPhysics({type:'policy_step',time:physicsTime+0.02,twist}),
  setRunning:active=>$('step-simulation').disabled=active||!physicsReady,
  onError:error=>stopPhysics('Walking stopped: '+error.message)
});
function stopPhysics(message = 'Simulation stopped. Pose controls restored.') {
  replayGeneration++;
  physicsReady=false; walking.stop(); $('walk-mode').disabled=true;
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
  if ((command.type === 'step'||command.type === 'policy_step') && renderedFrame) command.inputs = sensorInputs(renderedFrame, physicsTime);
  const state = await physicsCommand(command);
  robotView.apply(state);
  physicsTime = state.time;
  showSensors(state);
  $('view-mode').textContent = 'Modelica simulation · t = ' + state.time.toFixed(3) + ' s';
  $('simulation-status').textContent = state.preparation ? (state.preparation.plant==='prebuilt'&&state.preparation.controller==='prebuilt'?'Simulation ready · compiled models loaded.':'Simulation ready · edited source compiled.') : state.control ? 'Pretrained Pollen velstand · Modelica physics.' : 'Standing controller · Modelica physics.';
  return state;
}
$('prepare-simulation').onclick = async () => {
  if (!robotView) return;
  $('prepare-simulation').disabled = true;
  $('stop-simulation').disabled = false;
  $('simulation-status').textContent = 'Preparing simulation · default models are precompiled…';
  try {
    await globalThis.microduckSourcesReady;
    physicsWorker = new Worker(new URL('./physics.worker.js', import.meta.url), {type: 'module'});
    physicsWorker.onmessage = ({data}) => {
      if (!physicsPending || physicsPending.id !== data.id) return;
      const pending = physicsPending; physicsPending = undefined; clearTimeout(pending.timer);
      data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
    };
    physicsWorker.onerror = event => stopPhysics('Simulation worker failed: ' + event.message);
    const sources = Object.fromEntries(sourceFiles.map(name =>
      [name, name === selectedFile ? $('editor').value : savedDraft(name) ?? originals.get(name)]));
    await showPhysics({type: 'prepare', sources, model: 'Microduck'});
    physicsReady=true; $('walk-mode').disabled=false;
    $('step-simulation').disabled = false;
  } catch (error) { stopPhysics('Simulation unavailable: ' + error.message); }
};
$('step-simulation').onclick = async () => {
  $('step-simulation').disabled = true;
  try { await showPhysics({type: 'step', time: physicsTime + 0.02}); $('step-simulation').disabled = false; }
  catch (error) { stopPhysics('Simulation stopped: ' + error.message); }
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
let selectedFile = 'Microduck.mo';
function savedDraft(name) {
  try { return localStorage.getItem('microduck-lab-draft-v2-named:' + name); }
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
    localStorage.setItem('microduck-lab-draft-v2-named:' + selectedFile, $('editor').value);
    $('editor-status').textContent = 'Draft saved in this browser.';
  } catch { $('editor-status').textContent = 'Draft is in this tab; use Download to keep it.'; }
};
$('reset-file').onclick = async () => {
  try { localStorage.removeItem('microduck-lab-draft-v2-named:' + selectedFile); } catch {}
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
function box(size, position, color, parent) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({color, roughness: 0.85}));
  mesh.position.fromArray(position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

async function initializeView() {
  const container = $('canvas');
  let viewDirty = true;
  const invalidate = () => { viewDirty = true; };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1a252c');
  scene.fog = new THREE.Fog('#1a252c', 3, 9);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.005, 20);
  camera.up.set(0, 0, 1);
  camera.position.set(0.43, -0.48, 0.33);
  const renderer = new THREE.WebGLRenderer({antialias: false, alpha: false});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0.13);
  controls.enableDamping = true;
  controls.addEventListener('change', () => { viewDirty = true; });
  controls.minDistance = 0.13;
  controls.maxDistance = 5;
  scene.add(new THREE.HemisphereLight(0xf7fff1, 0x829574, 2.2));
  const sun = new THREE.DirectionalLight(0xfff7df, 3);
  sun.position.set(1, -1, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {left: -1, right: 1, top: 1, bottom: -1, near: 0.01, far: 5});
  sun.shadow.bias = -0.0001;
  scene.add(sun);
  box([6, 6, 0.03], [0, 0, -0.019], '#35453e', scene);
  const grid = new THREE.GridHelper(6, 60, 0x536554, 0x3e5145);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.002;
  scene.add(grid);
  // Park meshes are a visual preview until the terrain dynamics are connected.
  box([0.7, 0.45, 0.09], [0.8, 0.65, 0.045], '#b4c1aa', scene);
  const bank = box([0.65, 0.45, 0.045], [0.17, 0.65, 0.045], '#b9c5ae', scene);
  bank.rotation.y = -0.14;
  box([0.05, 0.9, 0.13], [-0.6, 0.8, 0.065], '#9dae92', scene);
  const board = new THREE.Group();
  board.position.set(0.28, 0.02, 0);
  scene.add(board);
  box([0.18, 0.075, 0.007], [0, 0, 0.029], '#667e51', board);
  box([0.14, 0.065, 0.001], [0, 0, 0.033], '#324232', board);
  for (const x of [-0.06, 0.06]) for (const y of [-0.044, 0.044]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 20),
      new THREE.MeshStandardMaterial({color: '#efeee0', roughness: 0.7}));
    wheel.position.set(x, y, 0.012);
    wheel.castShadow = true;
    board.add(wheel);
  }
  $('board-toggle').onchange = () => { board.visible = $('board-toggle').checked; invalidate(); };
  $('frame-robot').onclick = () => {
    controls.target.set(0, 0, 0.13);
    camera.position.set(0.43, -0.48, 0.33);
  };
  $('frame-park').onclick = () => {
    controls.target.set(0.15, 0.35, 0.04);
    camera.position.set(1.6, -1.9, 1.5);
  };
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
    $('sensor-status').textContent = sensorToggle.checked ? 'Starting camera / ToF…' : 'Rendering off · enable to view camera / ToF.';
  };
  renderer.setAnimationLoop(now => {
    controls.update();
    if (viewDirty) { renderer.render(scene, camera); viewDirty = false; }
    if (sensorToggle.checked && sensorPreview && !sensorReadPending) {
      sensorReadPending = true;
      const preview = sensorPreview, generation = sensorGeneration;
      preview.capture(now).then(frame => {
        if (frame && sensorToggle.checked && generation === sensorGeneration) {
          renderedFrame = frame;
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
  const sensors = await loadRobot(scene, invalidate);
  if (sensors.camera && sensors.tof) sensorPreview = createSensorPreview(renderer, scene, sensors.camera, sensors.tof, $('camera-frame'), $('lidar-frame'));
  globalThis.microduckSensorStats = sensorPreview?.stats;
  invalidate();
}

async function loadRobot(scene, invalidate) {
  const response = await fetch('./robot.xml');
  if (!response.ok) throw new Error('Robot description could not be loaded');
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Invalid robot description');
  const assets = new Map([...xml.querySelectorAll('asset > mesh')].map(mesh =>
    [mesh.getAttribute('name') || mesh.getAttribute('file').split('/').pop().replace(/\.[^.]+$/, ''), {file: mesh.getAttribute('file'),
      scale: vector(mesh.getAttribute('scale'), [1, 1, 1])}]));
  const colors = new Map([...xml.querySelectorAll('asset > material')].map(material =>
    [material.getAttribute('name'), vector(material.getAttribute('rgba'), [0.6, 0.65, 0.55, 1])]));
  const loader = new STLLoader();
  const geometryCache = new Map();
  const joints = [];
  const visualBodies = new Map();
  const sensors = {};
  const robot = new THREE.Group();
  scene.add(robot);
  function geometry(file) {
    const name = file.split('/').pop();
    if (!geometryCache.has(name)) geometryCache.set(name,
      loader.loadAsync('./assets/' + encodeURIComponent(name)));
    return geometryCache.get(name);
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
      const mesh = new THREE.Mesh(await geometry(definition.file), new THREE.MeshStandardMaterial({
        color: new THREE.Color(r, g, b), roughness: 0.72,
        metalness: 0.08, opacity, transparent: opacity < 1
      }));
      mesh.scale.fromArray(definition.scale);
      transform(mesh, geom);
      mesh.castShadow = true;
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
  $('loading').remove();
  // Explicit viewer wire order; it does not assemble the Modelica robot.
  const bodyNames = ["trunk_base", "yaw2roll", "hip_l", "upper_leg_left", "leg", "ankle_left", "neck", "neck_pitch", "yaw_roll_motion", "jaw_soft", "bearing_roll", "hip_l_2", "upper_leg_right", "leg_2", "ankle_right"];
  const matrix = new THREE.Matrix4();
  robotView = {
    apply(state) {
      if (!Number.isFinite(state.time) || state.bodies?.length !== bodyNames.length)
        throw new Error('Invalid Modelica body-pose frame.');
      // Validate the entire frame before moving any geometry.
      state.bodies.forEach((pose, i) => {
        if (!visualBodies.has(bodyNames[i]) || pose.position?.length !== 3 || pose.rotation?.length !== 9 ||
            ![...pose.position, ...pose.rotation].every(Number.isFinite)) throw new Error('Incomplete Modelica body pose.');
      });
      state.bodies.forEach((pose, i) => {
        const object = visualBodies.get(bodyNames[i]).visuals;
        scene.add(object);
        object.position.fromArray(pose.position);
        const r = pose.rotation;
        matrix.set(r[0],r[1],r[2],0, r[3],r[4],r[5],0, r[6],r[7],r[8],0, 0,0,0,1);
        object.quaternion.setFromRotationMatrix(matrix);
      });
      document.querySelectorAll('#joints input, #reset-pose').forEach(input => input.disabled = true);
      invalidate();
    },
    restore() {
      for (const {visuals, parent} of visualBodies.values()) {
        parent.add(visuals); visuals.position.set(0,0,0); visuals.quaternion.identity();
      }
      document.querySelectorAll('#joints input, #reset-pose').forEach(input => input.disabled = false);
      invalidate();
    }
  };
  $('prepare-simulation').disabled = false;
  return sensors;
}

loadSource(selectedFile).catch(error => $('editor-status').textContent = error.message);
initializeView().catch(error => {
  $('loading').textContent = '3D view unavailable: ' + error.message;
  $('view-mode').textContent = 'Source editor remains available below';
});


