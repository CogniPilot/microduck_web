import fs from 'node:fs';
import test from 'node:test';import assert from 'node:assert/strict';
import {poseFrame} from '../site/policy-contract.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/frame-reference.json',import.meta.url)));
const pattern=/^(cameraTimestamp$|lidarRange\[|lidarValid\[|lidarTimestamp$|imageCentroid\[|imageTargetVisible$|nearestObstacle$|trunkGyro\[|trunkAcceleration\[|headGyro\[|headAcceleration\[|jointPosition\[|jointVelocity\[|commandedPosition\[|motorTorque\[|estimatedCurrent\[|estimatedTemperature\[|stateOfCharge$|score$|fallen$)/;
function valuesFor(frame){const values={...frame.outputs};frame.bodies.forEach((b,i)=>{b.position.forEach((x,j)=>values['bodyPosition['+(i+1)+','+(j+1)+']']=x);b.rotation.forEach((x,j)=>values['bodyRotation['+(i+1)+','+(Math.floor(j/3)+1)+','+(j%3+1)+']']=x);});return values;}
test('all recorded poses and telemetry remain identical with irrelevant internal values',()=>{
 for(const frame of fixture.frames){const values=valuesFor(frame);for(let i=0;i<20000;i++)values['internal.slot['+i+']']=i/8;
 const before=JSON.stringify(values);assert.deepEqual(poseFrame(values,frame.time,pattern),frame);assert.equal(JSON.stringify(values),before);}
});
test('later matching telemetry is included and unrelated values are not read',()=>{
 const frame=fixture.frames[0],values=valuesFor(frame);values['imageCentroid[99]']=42;
 for(let i=0;i<20000;i++)values['internal.slot['+i+']']=i/8;
 let reads=0;const observed=new Proxy(values,{get:(target,key)=>{reads++;return target[key];}});
 const actual=poseFrame(observed,frame.time,pattern);assert.equal(actual.outputs['imageCentroid[99]'],42);assert(reads<2000,'unrelated values were eagerly materialized: '+reads);
});
test('missing and nonfinite body coordinates still refuse',()=>{
 const frame=fixture.frames[0];let values=valuesFor(frame);delete values['bodyPosition[1,1]'];assert.throws(()=>poseFrame(values,frame.time,pattern),/Missing policy observation/);
 values=valuesFor(frame);values['bodyRotation[15,3,3]']=Infinity;assert.throws(()=>poseFrame(values,frame.time,pattern),/Missing policy observation/);
});
