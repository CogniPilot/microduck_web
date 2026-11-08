// Transport rendered pixels and ranges. Modelica owns image processing.
export function sensorInputs(frame, simulationTime, rows = 24, columns = 32) {
  const {width, height, rgba, ranges, valid} = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      !Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 ||
      rows > height || columns > width || rgba?.length !== width * height * 4 ||
      ranges?.length !== 64 || valid?.length !== 64 || !Number.isFinite(simulationTime))
    throw new Error('Incomplete rendered sensor frame.');
  const inputs = [];
  // Area-average the top-down RGBA raster; no recognition occurs here.
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const totals = [0, 0, 0];
    let count = 0;
    for (let y = Math.floor(row * height / rows); y < Math.floor((row + 1) * height / rows); y++)
      for (let x = Math.floor(column * width / columns); x < Math.floor((column + 1) * width / columns); x++) {
        const offset = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const value = rgba[offset + channel];
          if (!Number.isFinite(value) || value < 0 || value > 255) throw new Error('Invalid RGB pixel.');
          totals[channel] += value;
        }
        count++;
      }
    totals.forEach((total, channel) => inputs.push([
      `cameraRGB[${row + 1},${column + 1},${channel + 1}]`, total / (count * 255)]));
  }
  inputs.push(['cameraTimestamp', simulationTime], ['lidarTimestamp', simulationTime]);
  for (let index = 0; index < 64; index++) {
    const distance = ranges[index];
    const hit = valid[index] === true;
    if (hit && (!Number.isFinite(distance) || distance < 0 || distance > 4))
      throw new Error('Invalid ToF range.');
    const coordinate = `${Math.floor(index / 8) + 1},${index % 8 + 1}`;
    inputs.push([`lidarRange[${coordinate}]`, hit ? distance : 4]);
    inputs.push([`lidarValid[${coordinate}]`, hit ? 1 : 0]);
  }
  return inputs;
}
