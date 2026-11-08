// Read the currently bound RGBA/UNSIGNED_BYTE target. The caller owns target
// selection; this helper restores pixel-pack state before returning its promise.
export function readPixelsAsync(gl, width, height, destination, {
  clock = () => performance.now(), schedule = callback => setTimeout(callback, 4),
  maxWaitMs = 5000
} = {}) {
  const size = width * height * 4;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !Number.isSafeInteger(size) || !(destination instanceof Uint8Array) || destination.byteLength !== size ||
      !Number.isFinite(maxWaitMs) || maxWaitMs <= 0)
    return Promise.reject(new Error('Invalid sensor readback extent or deadline.'));
  if (typeof gl.fenceSync !== 'function' || typeof gl.getBufferSubData !== 'function')
    return Promise.reject(new Error('Asynchronous sensor readback requires WebGL2.'));
  const buffer = gl.createBuffer();
  if (!buffer) return Promise.reject(new Error('Could not allocate sensor readback buffer.'));
  let sync;
  const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
  const packNames = [gl.PACK_ALIGNMENT, gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS];
  const packValues = packNames.map(name => gl.getParameter(name));
  try {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
    packNames.forEach((name, index) => gl.pixelStorei(name, index === 0 ? 4 : 0));
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) throw new Error('Could not fence sensor readback.');
    gl.flush();
  } catch (error) {
    if (sync) gl.deleteSync(sync);
    gl.deleteBuffer(buffer);
    return Promise.reject(error);
  } finally {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
    packNames.forEach((name, index) => gl.pixelStorei(name, packValues[index]));
  }
  const deadline = clock() + maxWaitMs;
  return new Promise((resolve, reject) => {
    const finish = error => {
      gl.deleteSync(sync); gl.deleteBuffer(buffer);
      error ? reject(error) : resolve(destination);
    };
    const poll = () => {
      try {
        if (gl.isContextLost()) throw new Error('Sensor render context was lost.');
        const status = gl.clientWaitSync(sync, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) {
          if (clock() >= deadline) throw new Error('Sensor readback exceeded its deadline.');
          schedule(poll); return;
        }
        if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED)
          throw new Error('Sensor readback fence failed.');
        const bound = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        try {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, destination);
          if (gl.getError() !== gl.NO_ERROR) throw new Error('Sensor readback reported a WebGL error.');
        } finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, bound); }
        finish();
      } catch (error) { finish(error); }
    };
    // Yield even when an implementation immediately signals the fence.
    schedule(poll);
  });
}
