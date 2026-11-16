// The landing duck, adapted from Pollen Robotics' Microduck Simulator (Apache-2.0, revision
// efedf47): app/src/ui/MenuDuck.jsx (sitting stage, pointer aim, idle glances, quack envelope)
// and app/src/game/duck.js (SITTING_POSE, the jaw hinge). Only the kinematic pose moves; the
// live simulation replaces it when the scene is entered.
//
// Frames: Pollen's placer is Y up and faces +Z; this page's robot group is the MJCF frame
// (Z up, +X forward, +Y left) inside a Y-up world where the duck faces +X. The aim angles are
// therefore taken in the robot frame: azimuth about +Z from +X toward +Y, elevation above it.
import {Box3, Group, Quaternion, Vector2, Vector3} from 'three';

// duck.js "SIT" keyframe (head_pitch positive = head down on this model).
export const SITTING_POSE = {
  left_hip_yaw: 0, left_hip_roll: 0, left_hip_pitch: -0.5236, left_knee: 1.0472, left_ankle: 0,
  neck_pitch: 1.02, head_pitch: 0.9, head_yaw: 0, head_roll: 0,
  right_hip_yaw: 0, right_hip_roll: 0, right_hip_pitch: 0.5236, right_knee: -1.0472, right_ankle: 0,
};

// MenuDuck.jsx aim calibration and quack envelope, verbatim.
const SIGN_YAW = 1, SIGN_PITCH = -1;
const SPREAD_YAW = 0.55, SPREAD_PITCH = 0.32;
const QUACK_HOLD_S = 0.3, QUACK_ATTACK_TAU = 0.04, QUACK_RELEASE_TAU = 0.09;

// duck.js jaw hinge: the boss centre of jaw.stl, mesh-local; the beak opens about the robot's
// left-right axis by up to JAW_MAX_OPEN.
const JAW_MESH_NAMES = new Set(['jaw.stl', 'jaw_soft.stl']);
const JAW_MAX_OPEN = 0.32;
const JAW_HINGE_LOCAL = new Vector3(0, 0.00004, 0.0075);

// MenuDuck.jsx stage framing (CAM_POS, CAM_LOOK, CAM_ZOOM at a 32 degree field of view): in front
// of the duck and toward its right, here scaled to this page's camera field of view.
const LOOK_HEIGHT = 0.122;
const VIEW_OFFSET = {forward: 0.43 / 0.78, right: 0.28 / 0.78, up: 0.078 / 0.78};
const STAGE_FOV_DEG = 32;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rand = (a, b) => a + Math.random() * (b - a);

export function createLanding({robot, joints, camera, controls, canvas, invalidate}) {
  const joint = new Map(joints.map(entry => [entry.name, entry]));
  const set = (name, angle) => {
    const entry = joint.get(name);
    if (!entry) return;
    entry.q = clamp(angle, entry.range[0], entry.range[1]);
    entry.pivot.quaternion.setFromAxisAngle(entry.axis, entry.q);
  };
  const jaw = createJawHinge(robot);

  const headPivot = joint.get('head_yaw')?.pivot;
  const headWorld = new Vector3(), toCamera = new Vector3(), robotQuat = new Quaternion();
  const ndc = new Vector2();
  let active = false, frame, lastT = 0, previous = 0, lastMouseT = -Infinity;
  let hasFocus = document.hasFocus(), mouseInside = true;
  let az = 0, el = 0, attention = 0, quackHoldUntil = -Infinity, quackOpen = 0;
  const o1 = rand(0, 6.3), o2 = rand(0, 6.3);

  window.addEventListener('pointermove', event => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    ndc.x = clamp(((event.clientX - r.left) / r.width) * 2 - 1, -2, 2);
    ndc.y = clamp(-(((event.clientY - r.top) / r.height) * 2 - 1), -2, 2);
    lastMouseT = lastT;
    mouseInside = true;
  });
  window.addEventListener('pointerdown', () => { if (active) quackHoldUntil = lastT + QUACK_HOLD_S; });
  window.addEventListener('blur', () => { hasFocus = false; });
  window.addEventListener('focus', () => { hasFocus = true; });
  document.addEventListener('mouseleave', () => { mouseInside = false; });
  document.addEventListener('mouseenter', () => { mouseInside = true; });

  function step(dt, t) {
    lastT = t;
    headPivot.getWorldPosition(headWorld);
    robot.getWorldQuaternion(robotQuat).invert();
    toCamera.copy(camera.position).sub(headWorld).applyQuaternion(robotQuat);
    const azCam = Math.atan2(toCamera.y, toCamera.x);
    const elCam = Math.atan2(toCamera.z, Math.hypot(toCamera.x, toCamera.y));

    // Attention eases toward 1 while the page has focus and the pointer moved recently;
    // otherwise the duck glances lazily around the camera.
    const engaged = hasFocus && mouseInside && t - lastMouseT < 3.0;
    attention += ((engaged ? 1 : 0) - attention) * (1 - Math.exp(-dt / 0.3));
    const azAim = azCam + ndc.x * SPREAD_YAW;
    const elAim = elCam * 0.5 + ndc.y * SPREAD_PITCH;
    const azIdle = azCam + 0.45 * Math.sin(0.21 * t + o1) * Math.sin(0.09 * t + o2) * 2;
    const elIdle = elCam * 0.5 + 0.1 * Math.sin(0.4 * t + o2);
    const kSmooth = 1 - Math.exp(-dt * (2.5 + 7.5 * attention));
    az += (azIdle + (azAim - azIdle) * attention - az) * kSmooth;
    el += (elIdle + (elAim - elIdle) * attention - el) * kSmooth;

    set('neck_pitch', SITTING_POSE.neck_pitch + Math.sin(t * 1.4) * 0.025);
    set('head_yaw', SIGN_YAW * az);
    set('head_pitch', SITTING_POSE.head_pitch + SIGN_PITCH * el);
    set('head_roll', 0.3 * SIGN_YAW * (az - azCam));

    const target = t < quackHoldUntil ? 1 : 0;
    const tau = target > quackOpen ? QUACK_ATTACK_TAU : QUACK_RELEASE_TAU;
    quackOpen += (target - quackOpen) * (1 - Math.exp(-dt / tau));
    jaw.open(quackOpen);
    invalidate();
  }
  const loop = now => {
    frame = requestAnimationFrame(loop);
    const dt = Math.min((now - previous) / 1000, 0.05);
    previous = now;
    step(dt, now / 1000);
  };

  return {
    // Sit the duck on the floor and frame it as Pollen's title stage does, then animate.
    start() {
      if (active || !headPivot) return;
      active = true;
      for (const [name, angle] of Object.entries(SITTING_POSE)) set(name, angle);
      ground(robot);
      frameStage(camera, controls, robot);
      previous = performance.now();
      frame = requestAnimationFrame(loop);
    },
    // The live simulation takes over: stop animating and close the beak.
    stop() {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      jaw.open(0);
      invalidate();
    },
    quack() { quackHoldUntil = lastT + QUACK_HOLD_S; },
  };
}

// duck.js groundFullBody: the sitting pose folds the legs under the trunk, so the lowest point
// of the whole robot, not the feet, rests on the floor (world y = 0; robot z is world up).
function ground(robot) {
  robot.updateWorldMatrix(true, true);
  const box = new Box3().setFromObject(robot);
  if (Number.isFinite(box.min.y)) robot.position.z += 0.002 - box.min.y;
  robot.updateWorldMatrix(true, true);
}

function frameStage(camera, controls, robot) {
  const box = new Box3().setFromObject(robot), center = box.getCenter(new Vector3());
  const scale = Math.tan((STAGE_FOV_DEG * Math.PI) / 360) / Math.tan((camera.fov * Math.PI) / 360);
  // Duck forward is world +X, its right is world +Z (MJCF -Y).
  controls.target.set(center.x, LOOK_HEIGHT, center.z);
  camera.position.set(center.x + VIEW_OFFSET.forward / scale, LOOK_HEIGHT + VIEW_OFFSET.up / scale,
    center.z + VIEW_OFFSET.right / scale);
  camera.lookAt(controls.target);
  controls.update();
}

// duck.js setupJawPivot: both jaw meshes move into a pivot on the physical hinge, which turns
// about the robot's left-right axis (+Y in the robot frame) so the beak tip swings down.
function createJawHinge(robot) {
  const meshes = [];
  robot.traverse(object => { if (object.isMesh && JAW_MESH_NAMES.has(object.userData.meshName)) meshes.push(object); });
  if (!meshes.length) return {open() {}};
  const body = meshes[0].parent;
  robot.updateWorldMatrix(true, true);
  const jawMesh = meshes.find(mesh => mesh.userData.meshName === 'jaw.stl') ?? meshes[0];
  const hingeWorld = jawMesh.localToWorld(JAW_HINGE_LOCAL.clone());
  const axisWorld = new Vector3(0, 1, 0).applyQuaternion(robot.getWorldQuaternion(new Quaternion()));
  const bodyInverse = body.getWorldQuaternion(new Quaternion()).invert();
  const hingeLocal = body.worldToLocal(hingeWorld.clone());
  const axis = axisWorld.applyQuaternion(bodyInverse).normalize();
  const pivot = new Group();
  pivot.name = 'jaw_pivot';
  pivot.position.copy(hingeLocal);
  body.add(pivot);
  for (const mesh of meshes) { mesh.position.sub(hingeLocal); pivot.add(mesh); }
  return {open(amount) { pivot.quaternion.setFromAxisAngle(axis, JAW_MAX_OPEN * amount); }};
}
