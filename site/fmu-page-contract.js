import {sha256Hex} from './sha256.js';
// Exact current-page producer/host contract. No compiler or source-library body import.
export const LEGACY_MODEL = 'MicroduckJawLocked';
export const WHOLE_MODEL = 'MicroduckWholeSystem';
export const WRAPPER_FILE = './fmu-sources/MicroduckWholeSystem.mo';
export const STANDARD_PIN_FILE = 'MSL-SOURCES-PIN.json';
export const STANDARD_PIN_SHA256 = '50c32372348fec7ac96abb85b0d96ee53f9617d886f15a7588efc865cc248c9f';
export const STANDARD_SOURCE_COUNT = 29, PAGE_SOURCE_COUNT = 243;

// Shape-defining values are verified from the initialized FMU, not inferred from XML starts.
export const PAGE_FIXED_VALUES = Object.freeze({cameraRows: 24, cameraColumns: 32});

export const PAGE_INPUT_GROUPS = [["action","Float64",[15]],["usePolicyPosition","Boolean",[]],["policyPosition","Float64",[15]],["cameraRGB","Float64",[24,32,3]],["cameraTimestamp","Float64",[]],["lidarRange","Float64",[8,8]],["lidarValid","Boolean",[8,8]],["lidarTimestamp","Float64",[]],["usePolicyController","Boolean",[]],["forwardVelocity","Float64",[]],["lateralVelocity","Float64",[]],["steeringRate","Float64",[]],["policyAction","Float64",[14]],["previousPolicyAction","Float64",[14]],["previousCommand","Float64",[3]],["previousPositionCommand","Float64",[15]],["hasPreviousPositionCommand","Boolean",[]]];
export const PAGE_OUTPUT_GROUPS = [["imageCentroid","Float64",[2]],["imageTargetVisible","Boolean",[]],["nearestObstacle","Float64",[]],["jointPosition","Float64",[15]],["jointVelocity","Float64",[15]],["policyJointHome","Float64",[14]],["policyJointHalfRange","Float64",[14]],["commandedPosition","Float64",[15]],["motorTorque","Float64",[15]],["estimatedCurrent","Float64",[15]],["estimatedTemperature","Float64",[15]],["stateOfCharge","Float64",[]],["terminalVoltage","Float64",[]],["batteryCurrent","Float64",[]],["trunkGyro","Float64",[3]],["trunkAcceleration","Float64",[3]],["headGyro","Float64",[3]],["headAcceleration","Float64",[3]],["bodyPosition","Float64",[15,3]],["bodyRotation","Float64",[15,3,3]],["cameraOrigin","Float64",[3]],["cameraToWorld","Float64",[3,3]],["lidarOrigin","Float64",[3]],["lidarToWorld","Float64",[3,3]],["score","Float64",[]],["fallen","Boolean",[]],["policyObservation","Float64",[61]],["filteredCommand","Float64",[3]],["positionCommand","Float64",[15]],["normalizedPolicyAction","Float64",[15]],["clippedPolicyActions","Float64",[]]];
// Battery outputs only the electrical servo/battery model publishes. The default
// (MuJoCo-equal, non-electrical) model has no battery; when present they stay exact.
export const PAGE_OPTIONAL_OUTPUTS = Object.freeze(new Set(['terminalVoltage', 'batteryCurrent']));

export function scalarNames(name, dimensions = []) {
 if (!dimensions.length) return [name];
 const count = dimensions.reduce((n, dim) => n * dim, 1);
 return Array.from({length: count}, (_, offset) => {
  const indices = [];
  for (let d = dimensions.length - 1, rest = offset; d >= 0; d--) {
   indices.unshift(rest % dimensions[d] + 1); rest = Math.floor(rest / dimensions[d]);
  }
  return name + '[' + indices.join(',') + ']';
 });
}

// Stable object-key order for a cross-producer options identity; arrays keep their order.
export function canonicalJson(value) {
 if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
 if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
  .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
 if (typeof value === 'number' && !Number.isFinite(value)) throw Error('Nonfinite FMU page option.');
 const result = JSON.stringify(value);
 if (result === undefined) throw Error('Unrepresentable FMU page option.');
 return result;
}

export function wholeModelOptions(plantOptions) {
 const parameters = Object.fromEntries(Object.entries(plantOptions.parameters ?? {})
  .map(([name, value]) => ['plant.' + name, value]));
 return {...plantOptions, parameters};
}

export async function sha256(bytes) { return sha256Hex(bytes); }
export async function pageBinding(plantOptions) {
 return {version: 1, selectedModel: LEGACY_MODEL, model: WHOLE_MODEL,
  pageSourceCount: PAGE_SOURCE_COUNT, standardSourceCount: STANDARD_SOURCE_COUNT,
  sourceCount: PAGE_SOURCE_COUNT + STANDARD_SOURCE_COUNT + 1,
  standardPinSha256: STANDARD_PIN_SHA256,
  optionsSha256: await sha256(new TextEncoder().encode(canonicalJson(wholeModelOptions(plantOptions))))};
}

// Library hashes here are a small current-build contract, not a browser re-read of
// compiled library bodies. The producer verifies the actual 29 bodies separately.
export async function currentPageSources(sources, {fetch: fetchFile = globalThis.fetch,
 base = new URL('./', import.meta.url)} = {}) {
 if (!sources || typeof sources !== 'object' || Array.isArray(sources) ||
     Object.keys(sources).length !== PAGE_SOURCE_COUNT || !Object.values(sources).every(x => typeof x === 'string') ||
     !Object.hasOwn(sources, LEGACY_MODEL + '.mo') || !Object.hasOwn(sources, 'MicroduckPolicyInterface.mo'))
  throw Error('The FMU needs the complete current 243-file editable source set.');
 const get = async file => {
  const response = await fetchFile(new URL(file, base));
  if (!response.ok) throw Error('FMU page contract download failed: ' + file);
  return response;
 };
 const pinBytes = await (await get(STANDARD_PIN_FILE)).arrayBuffer();
 if (await sha256(pinBytes) !== STANDARD_PIN_SHA256) throw Error('The current standard-library source pin changed.');
 const pin = JSON.parse(new TextDecoder().decode(pinBytes));
 if (pin.version !== '4.1.0' || !pin.files || Object.keys(pin.files).length !== STANDARD_SOURCE_COUNT ||
     !Object.values(pin.files).every(x => /^[0-9a-f]{64}$/.test(x))) throw Error('Invalid standard-library source pin.');
 const wrapper = await (await get(WRAPPER_FILE)).text();
 if (!wrapper.length) throw Error('The whole-system Modelica wrapper is empty.');
 return {sources: {...sources, [WHOLE_MODEL + '.mo']: wrapper}, sourcePins: pin.files};
}
