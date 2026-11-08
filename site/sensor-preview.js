import * as THREE from 'three';
import {readPixelsAsync} from './async-readback.js';

// Scene rendering only. These images/ranges are inputs for future Modelica CV.
export function createSensorPreview(renderer, scene, camera, tofCamera, rgbCanvas, tofCanvas) {
  const width = 320, height = 240, range = 4;
  const rgbTarget = new THREE.WebGLRenderTarget(width, height);
  rgbTarget.texture.colorSpace = THREE.SRGBColorSpace;
  const depthTarget = new THREE.WebGLRenderTarget(8, 8);
  const depthMaterial = new THREE.ShaderMaterial({
    vertexShader: 'varying vec3 sensorPosition; void main(){ vec4 p=modelViewMatrix*vec4(position,1.0); sensorPosition=p.xyz; gl_Position=projectionMatrix*p; }',
    fragmentShader: '#include <packing>\nvarying vec3 sensorPosition; void main(){ gl_FragColor=packDepthToRGBA(min(length(sensorPosition)/4.0,0.999999)); }',
    blending: THREE.NoBlending
  });
  const rgb = new Uint8Array(width * height * 4), packed = new Uint8Array(8 * 8 * 4);
  rgbCanvas.width = width; rgbCanvas.height = height;
  tofCanvas.width = 8; tofCanvas.height = 8;
  const rgbContext = rgbCanvas.getContext('2d'), tofContext = tofCanvas.getContext('2d');
  // Native da34a221 defaults: robotd-params Quality::Q720p30 and tofd --hz 15.
  // Preview resolution is independent of these capture cadences.
  const cameraPeriod = 1000 / 30, tofPeriod = 1000 / 15;
  let lastCamera = -Infinity, lastTof = -Infinity, pending = false;
  let ranges = [], valid = [], rgba;
  const cameraTimes = [], tofTimes = [];
  const gl = renderer.getContext();
  const asynchronous = renderer.capabilities.isWebGL2;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const stats = {cameraTargetFps:30, tofTargetHz:15, cameraFrames:0, tofFrames:0,
    cameraFps:0, tofHz:0, readback:asynchronous?'webgl2_async':'webgl1_sync',
    renderer:gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER)};
  const rate = (times, now) => {
    times.push(now);
    while(times.length > 2 && times[0] < now - 2000) times.shift();
    return times.length > 1 ? (times.length - 1) * 1000 / (times.at(-1) - times[0]) : 0;
  };
  const read = (target, w, h, bytes) => asynchronous ? readPixelsAsync(gl,w,h,bytes) :
    Promise.resolve(renderer.readRenderTargetPixels(target,0,0,w,h,bytes));
  return {
    stats,
    async capture(now, force = false) {
      if (pending) return undefined;
      const cameraDue = force || now - lastCamera >= cameraPeriod;
      const tofDue = force || now - lastTof >= tofPeriod;
      if (!cameraDue && !tofDue) return undefined;
      pending = true;
      const oldTarget = renderer.getRenderTarget(), oldOverride = scene.overrideMaterial, oldBackground = scene.background;
      const reads = [];
      try {
        scene.updateMatrixWorld(true);
        if (cameraDue) {
          renderer.setRenderTarget(rgbTarget); renderer.render(scene, camera);
          reads.push(read(rgbTarget,width,height,rgb)); lastCamera = now;
        }
        if (tofDue) {
          scene.background = new THREE.Color('white'); scene.overrideMaterial = depthMaterial;
          renderer.setRenderTarget(depthTarget); renderer.render(scene, tofCamera);
          reads.push(read(depthTarget,8,8,packed)); lastTof = now;
        }
      } catch (error) {
        for (const operation of reads) operation.catch(() => {});
        pending = false; throw error;
      } finally {
        // Restore immediately, before yielding for GPU completion, so the main
        // viewer can render normally while both reads are outstanding.
        scene.background = oldBackground; scene.overrideMaterial = oldOverride;
        renderer.setRenderTarget(oldTarget);
      }
      try {
        await Promise.all(reads);
        const completed = performance.now();
        if (cameraDue) {
          const image = rgbContext.createImageData(width, height);
          for (let row = 0; row < height; row++) image.data.set(rgb.subarray(row * width * 4, (row + 1) * width * 4), (height - row - 1) * width * 4);
          rgbContext.putImageData(image, 0, 0);
          rgba = image.data;
          stats.cameraFrames++; stats.cameraFps = rate(cameraTimes,completed);
        }
        if (tofDue) {
          ranges = []; valid = [];
          for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) {
            const offset = ((7 - row) * 8 + column) * 4;
            // Inverse of the pinned Three.js packing shader's packDepthToRGBA.
            const distance = range * (packed[offset] / 16777216 + packed[offset + 1] / 65536 + packed[offset + 2] / 256 + packed[offset + 3]) / 256;
            const hit = distance >= tofCamera.near && distance < range - 0.0001;
            ranges.push(hit ? distance : null); valid.push(hit);
            tofContext.fillStyle = hit ? `hsl(${220 * distance / range} 65% 55%)` : '#36414b';
            tofContext.fillRect(column, row, 1, 1);
          }
          stats.tofFrames++; stats.tofHz = rate(tofTimes,completed);
        }
        // The RGBA copy belongs to this completed frame; the next capture may
        // reuse the GPU staging arrays without changing a delivered frame.
        return {renderer: 'Three.js', width, height, rgba, range_m:range,
          ranges, valid, wall_timestamp_ms:now, camera_updated:cameraDue, tof_updated:tofDue};
      } finally { pending = false; }
    }
  };
}
