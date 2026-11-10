// Read the same visible session values without serializing the entire state.
export const telemetryPattern=/^(cameraTimestamp$|lidarRange\[|lidarValid\[|lidarTimestamp$|imageCentroid\[|imageTargetVisible$|nearestObstacle$|trunkGyro\[|trunkAcceleration\[|headGyro\[|headAcceleration\[|jointPosition\[|jointVelocity\[|commandedPosition\[|motorTorque\[|estimatedCurrent\[|estimatedTemperature\[|stateOfCharge$|score$|fallen$)/;
export const plantReadoutName=name=>telemetryPattern.test(name)||/^(bodyPosition\[|bodyRotation\[|policyJointHome\[|policyJointHalfRange\[)/.test(name);
const indexed=(name,count)=>Array.from({length:count},(_,i)=>`${name}[${i+1}]`);
export const observationNames=indexed('policyObservation',61);
export const commandNames=[...indexed('positionCommand',15),...indexed('filteredCommand',3),'clippedPolicyActions'];

export function createReadout(session,names){
 if(typeof session.read_values!=='function')throw Error('Typed session readout is unavailable.');
 const ordered=[...new Set(names)],request=JSON.stringify(ordered);
 return ()=>{
  const values=session.read_values(request);
  if(!(values instanceof Float64Array)||values.length!==ordered.length)throw Error('Invalid typed session readout.');
  // Rust's state_json retains finite f64 bits (including -0), and emits null
  // for nonfinite values. Keep the initial snapshot's insertion order too.
  return Object.fromEntries(ordered.map((name,i)=>[name,Number.isFinite(values[i])?values[i]:null]));
 };
}
