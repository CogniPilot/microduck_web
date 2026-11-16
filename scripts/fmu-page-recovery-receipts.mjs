// Qualification-only real-worker command-refusal recovery, not a guest/solver fault.
import assert from 'node:assert/strict';
import {auditFmuWorkerTrace,checkFmuPageFrame} from './fmu-browser-receipts.mjs';

export function auditFmuPageRecoveryTrace(trace,index){
 assert.equal(trace?.schema,'fmu-browser-worker-trace/1');assert.equal(trace.overflow,false);
 assert(Array.isArray(trace.events)&&trace.events.every(e=>Number.isSafeInteger(e.worker)&&e.worker>0),'invalid observer worker identity');
 const ids=[...new Set(trace.events.map(e=>e.worker))];assert.equal(ids.length,2,'recovery requires two actual observer workers');
 const split=trace.events.findIndex(e=>e.worker===ids[1]);
 assert(trace.events.slice(split).every(e=>e.worker===ids[1]),'old worker evidence after replacement');
 const first=trace.events.slice(0,split),second=trace.events.slice(split),arm=first.findIndex(e=>e.direction==='fault_arm');
 assert(arm>0,'missing declared refusal');assert.equal(first.length-arm,5,'unexpected evidence in refusal tail');
 const prefix={schema:trace.schema,overflow:false,events:first.slice(0,arm)};
 const nominal=auditFmuWorkerTrace(prefix,index,{requireReset:true,requireTermination:false});
 const [declared,injected,command,reply,terminated]=first.slice(arm);
 assert.equal(declared.data?.time,-1);assert.equal(declared.data.expectedTime,nominal.time+.02,'arm does not follow nominal replay');
 assert.equal(injected.direction,'fault_injection');assert.deepEqual(injected.data,{id:command.data?.id,type:'step',originalTime:declared.data.expectedTime,time:-1},'undeclared mutation');
 assert.equal(command.direction,'command');assert.equal(command.data?.type,'step');assert.equal(command.data.time,-1);
 assert.equal(reply.direction,'reply');assert.equal(reply.data?.id,command.data.id);assert(!Object.hasOwn(reply.data,'result'),'refusal returned success');
 assert.equal(reply.data.error,`Error: FMU cannot advance backwards from t=${nominal.time} to -1.`,'wrong actual worker refusal');
 assert.equal(terminated.direction,'terminate','failed worker was not terminated');
 assert.equal(second.length,5,'fresh prepare/step/terminate evidence required');
 const commandIds=new Set();
 for(const e of trace.events)if(e.direction==='command'&&e.data.id!==undefined){assert(Number.isSafeInteger(e.data.id)&&!commandIds.has(e.data.id),'reused command identity');commandIds.add(e.data.id);}
 for(const [at,type,prepare]of [[0,'prepare',true],[2,'step',false]]){
  const c=second[at],r=second[at+1];assert.equal(c.direction,'command');assert.equal(c.data?.type,type);assert.equal(r.direction,'reply');
  assert.equal(r.data?.id,c.data.id);assert(!Object.hasOwn(r.data,'error'),'recovery returned an error');
  checkFmuPageFrame(r.data.result,index,{prepare});assert.equal(r.data.result.time,prepare?0:.02);
 }
 assert.equal(second[2].data.time,.02);assert.equal(second[4].direction,'terminate');
 const initial=prefix.events.find(e=>e.direction==='reply'&&e.data?.result?.preparation)?.data.result;
 const manual=prefix.events.find(e=>e.direction==='command'&&e.data?.type==='step');
 const manualReply=prefix.events.find(e=>e.direction==='reply'&&e.data?.id===manual?.data.id)?.data.result;
 const comparablePrepare=frame=>{
  const {preparation,...state}=frame;
  const semantic={...preparation};for(const key of ['total_ms','controller_ms','plant_ms'])delete semantic[key];
  return{...state,preparation:semantic};
 };
 assert.deepEqual(comparablePrepare(second[1].data.result),comparablePrepare(initial),'fresh prepare frame differs');
 assert.deepEqual(second[2].data.inputs,manual.data.inputs,'recovery manual inputs differ');
 assert.deepEqual(second[3].data.result,manualReply,'recovery complete manual frame differs');
 return{scope:'page backward-time command validation refusal, terminate and fresh-worker/reprepare/manual recovery only; not guest trap, solver/sticky fault, internal events or physics parity',nominal,failedWorker:ids[0],recoveredWorker:ids[1],refusals:1,recoveries:1,accountedEvents:first.length+second.length};
}
