// Visualization reads Rumoca poses; policy mapping lives in MicroduckPolicyInterface.mo.
function number(values,name) {
 const x=values[name];if(!Number.isFinite(x))throw new Error('Missing policy observation: '+name);return x;
}
export function poseFrame(values,time,outputPattern=/^(jointPosition|jointVelocity|motorTorque|trunkGyro|fallen)/) {
 return {time,bodies:Array.from({length:15},(_,i)=>({
  position:[1,2,3].map(j=>number(values,'bodyPosition['+(i+1)+','+j+']')),
  rotation:[1,2,3].flatMap(j=>[1,2,3].map(k=>number(values,'bodyRotation['+(i+1)+','+j+','+k+']')))
 })),outputs:Object.fromEntries(Object.keys(values).filter(k=>outputPattern.test(k)).map(k=>[k,values[k]]))};
}
