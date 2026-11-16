// Pure recording components and public XML; no transpiler, model or Wasm execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {openFmuSession,FmuFault} from '../site/fmu-session.js';
import {fakeFmuDirectory,fileFetch} from './fmu-test-support.mjs';

const variables=[{name:'rows',vr:9,type:'Int64',causality:'calculatedParameter',variability:'fixed',initial:'calculated'},
 {name:'columns',vr:10,type:'Int64',causality:'parameter',variability:'fixed',initial:'exact',start:['32']}];
const body=`exitInitializationMode() {
 this.log(['initialized']);this.initialized=true;
 this.values.set(9,[globalThis.fixedRows??24n]);this.values.set(10,[32n]);return 'ok';
}
getInt64(refs) {
 if(!this.initialized)throw Error('read before initialization');
 this.log(['getInt64',[...refs]]);
 if(globalThis.fixedReadError)throw 'error';
 if(globalThis.fixedReadShort)return BigInt64Array.of(24n);
 return super.getInt64(refs);
}
reset(){this.initialized=false;return 'ok';}
[Symbol.dispose](){this.log(['disposed']);}`;
const open=async (fake,fixedValues={rows:24,columns:32})=>openFmuSession({index:fake.index,
 base:pathToFileURL(fake.dir+'/'),fetch:fileFetch,console:{log(){},warn(){},error(){}},fixedValues});

test('typed fixed getters run after initialization and reset without setters',async()=>{
 const fake=await fakeFmuDirectory({variables,instance:body});
 try{
  const expected={rows:24,columns:32};const session=await open(fake,expected);
  expected.rows=99; // Caller mutation cannot weaken later reset expectations.
  assert.deepEqual(globalThis.fakeFmu.calls,[['initialized'],['getInt64',[9,10]]]);
  session.reset();assert.deepEqual(globalThis.fakeFmu.calls.slice(-2),[['initialized'],['getInt64',[9,10]]]);
  assert.equal(globalThis.fakeFmu.calls.some(([name])=>name.startsWith('set')),false);
  session.free();
 }finally{await rm(fake.dir,{recursive:true,force:true});}
});

test('wrong initialized dimensions, short results and getter refusals never publish a session',async()=>{
 const fake=await fakeFmuDirectory({variables,instance:body});
 try{
  for(const [key,value,message]of [['fixedRows',23n,/rows=23, expected 24/],
    ['fixedReadShort',true,/returned 1 values for 2/],['fixedReadError',true,/returned error/]]){
   globalThis[key]=value;
   await assert.rejects(open(fake),message);assert.deepEqual(globalThis.fakeFmu.calls.at(-1),['disposed']);
   delete globalThis[key];
  }
 }finally{delete globalThis.fixedRows;delete globalThis.fixedReadShort;delete globalThis.fixedReadError;
  await rm(fake.dir,{recursive:true,force:true});}
});

test('reset dimension mismatch faults the session before subsequent use',async()=>{
 const fake=await fakeFmuDirectory({variables,instance:body});
 try{
  const session=await open(fake);globalThis.fixedRows=25n;
  assert.throws(()=>session.reset(),/rows=25, expected 24/);
  assert.throws(()=>session.read_values('["rows"]'),FmuFault);assert.throws(()=>session.reset(),/Prepare the simulation again/);
  session.free();
 }finally{delete globalThis.fixedRows;await rm(fake.dir,{recursive:true,force:true});}
});

test('tunable/input/wrong-type/unsafe expected values refuse rather than weakening fixed contract',async()=>{
 for(const change of [{variability:'tunable'},{causality:'input'},{type:'String'}]){
  const fake=await fakeFmuDirectory({variables:variables.map(v=>v.name==='rows'?{...v,...change}:v),instance:body});
  try{await assert.rejects(open(fake),/fixed-value validation failed/);}
  finally{await rm(fake.dir,{recursive:true,force:true});}
 }
 const fake=await fakeFmuDirectory({variables,instance:body});
 try{await assert.rejects(open(fake,{rows:Number.MAX_SAFE_INTEGER+1,columns:32}),/must be an integer/);}
 finally{await rm(fake.dir,{recursive:true,force:true});}
});
