import * as THREE from 'three';

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
  let last = -Infinity;
  return {
    capture(now, force = false) {
      if (!force && now - last < 500) return undefined;
      last = now;
      const oldTarget = renderer.getRenderTarget(), oldOverride = scene.overrideMaterial, oldBackground = scene.background;
      try {
        scene.updateMatrixWorld(true);
        renderer.setRenderTarget(rgbTarget); renderer.render(scene, camera);
        renderer.readRenderTargetPixels(rgbTarget, 0, 0, width, height, rgb);
        const image = rgbContext.createImageData(width, height);
        for (let row = 0; row < height; row++) image.data.set(rgb.subarray(row * width * 4, (row + 1) * width * 4), (height - row - 1) * width * 4);
        rgbContext.putImageData(image, 0, 0);
        scene.background = new THREE.Color('white'); scene.overrideMaterial = depthMaterial;
        renderer.setRenderTarget(depthTarget); renderer.render(scene, tofCamera);
        renderer.readRenderTargetPixels(depthTarget, 0, 0, 8, 8, packed);
        const ranges = [], valid = [];
        for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) {
          const offset = ((7 - row) * 8 + column) * 4;
          // Inverse of the pinned Three.js packing shader's packDepthToRGBA.
          const distance = range * (packed[offset] / 16777216 + packed[offset + 1] / 65536 + packed[offset + 2] / 256 + packed[offset + 3]) / 256;
          const hit = distance >= tofCamera.near && distance < range - 0.0001;
          ranges.push(hit ? distance : null); valid.push(hit);
          tofContext.fillStyle = hit ? `hsl(${220 * distance / range} 65% 55%)` : '#36414b';
          tofContext.fillRect(column, row, 1, 1);
        }
        return {renderer: 'Three.js', width, height, rgba: image.data, range_m: range, ranges, valid, wall_timestamp_ms: now};
      } finally {
        scene.background = oldBackground; scene.overrideMaterial = oldOverride;
        renderer.setRenderTarget(oldTarget);
      }
    }
  };
}
