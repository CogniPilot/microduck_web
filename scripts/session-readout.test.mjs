import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createReadout,plantReadoutName,telemetryPattern,observationNames,commandNames} from '../site/session-readout.js';
import {poseFrame} from '../site/policy-contract.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/frame-reference.json',import.meta.url)));

function valuesFor(frame){
 const values={...frame.outputs};
 frame.bodies.forEach((body,i)=>{
  body.position.forEach((value,j)=>values[`bodyPosition[${i+1},${j+1}]`]=value);
  body.rotation.forEach((value,j)=>values[`bodyRotation[${i+1},${Math.floor(j/3)+1},${j%3+1}]`]=value);
 });
 return values;
}
function sessionFor(values){
 return {variable_names:()=>JSON.stringify(Object.keys(values)),input_names:()=>JSON.stringify(['hostInput']),
  read_values:json=>Float64Array.from(JSON.parse(json),name=>{if(!(name in values))throw Error('Unknown session value: '+name);return values[name];})};
}
test('all retained pose, telemetry, sensor and status outputs match the JSON path',()=>{
 for(const frame of fixture.frames){
  const values=valuesFor(frame);values['policyJointHome[1]']=0.25;values['policyJointHalfRange[1]']=1.5;
  values['imageCentroid[99]']=42;values['unusedRuntimeValue']=123;
  const session=sessionFor(values),read=createReadout(session,Object.keys(values).filter(plantReadoutName));
  const actual=read(),json=JSON.parse(JSON.stringify(values));
  assert.deepEqual(poseFrame(actual,frame.time,telemetryPattern),poseFrame(json,frame.time,telemetryPattern));
  assert.equal(actual['policyJointHome[1]'],.25);assert.equal(actual['policyJointHalfRange[1]'],1.5);
  assert(!('unusedRuntimeValue' in actual));
 }
});
test('later telemetry values are reread without a state JSON call',()=>{
 const values={'imageCentroid[99]':1,hostInput:2},session=sessionFor(values);
 let calls=0,request;const original=session.read_values;session.read_values=json=>{calls++;request=json;return original(json);};
 session.state_json=()=>{throw Error('full-state JSON was called');};
 const read=createReadout(session,Object.keys(values).filter(plantReadoutName));
 assert.equal(read()['imageCentroid[99]'],1);values['imageCentroid[99]']=9;
 assert.equal(read()['imageCentroid[99]'],9);assert.equal(calls,2);assert.equal(request,'["imageCentroid[99]"]');
});
test('every policy observation and command value is retained in its declared read',()=>{
 const names=[...observationNames,...commandNames],values=Object.fromEntries(names.map((name,i)=>[name,i/7]));
 const session=sessionFor(values);
 for(const selected of [observationNames,commandNames]){
  const actual=createReadout(session,selected)();
  assert.deepEqual(actual,Object.fromEntries(selected.map(name=>[name,values[name]])));
 }
 assert.equal(observationNames.length,61);assert.equal(commandNames.length,19);
});
test('typed projection preserves Rust JSON finite bits, nulls and insertion order',()=>{
 // serde_json writes -0.0; JSON.stringify would erase it and is not the oracle.
 const parsed=JSON.parse('{"jointPosition[2]":-0.0,"jointPosition[10]":1.25,"infinite":null,"nan":null,"negativeInfinite":null,"finite":5e-324}');
 const values={...parsed,infinite:Infinity,nan:NaN,negativeInfinite:-Infinity};
 const actual=createReadout(sessionFor(values),Object.keys(parsed))();
 assert.deepEqual(Object.keys(actual),Object.keys(parsed));
 for(const name of Object.keys(parsed))assert(Object.is(actual[name],parsed[name]),name);
});
test('missing values, unavailable binding and malformed typed results refuse',()=>{
 assert.throws(()=>createReadout({},[]),/unavailable/);
 assert.throws(()=>createReadout(sessionFor({}),['missing'])(),/Unknown session value/);
 for(const result of [[],new Float64Array(0),new Float32Array([1])]){
  assert.throws(()=>createReadout({read_values:()=>result},['x'])(),/Invalid typed session/);
 }
});
