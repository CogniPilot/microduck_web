import test from 'node:test';
import assert from 'node:assert/strict';
import {auditFmuPageRecoveryTrace} from './fmu-page-recovery-receipts.mjs';
import {installFmuReceiptCapture} from './fmu-browser-receipts.mjs';
const index={instantiationToken:'synthetic-control-token'};
const frame=time=>({time,outputs:{score:0,fallen:false},execution:{engine:'fmi3-ls-wasm',model:'MicroduckWholeSystem',refusal:null,instantiation_token:index.instantiationToken}});
const prepared=total_ms=>({...frame(0),preparation:{controller:'fmu',plant:'fmu',selected_model:'MicroduckJawLocked',model:'MicroduckWholeSystem',total_ms}});
function trace(){
 const rows=[];
 const command=(worker,id,type,extra={})=>rows.push({worker,direction:'command',data:{id,type,...extra}});
 const reply=(worker,id,result)=>rows.push({worker,direction:'reply',data:{id,result}});
 command(1,1,'prepare');reply(1,1,prepared(50));command(1,2,'step',{time:.02});reply(1,2,frame(.02));
 command(1,3,'walk_start',{generation:7});reply(1,3,{generation:7,time:.02,mode:'realtime'});
 rows.push({worker:1,direction:'reply',data:{type:'walk_frame',generation:7,sequence:1,result:frame(.04)}});
 command(1,undefined,'walk_ack',{generation:7,sequence:1});command(1,4,'walk_stop',{generation:7});
 const done={generation:7,time:.04,frame:frame(.04),reason:'paused'};
 rows.push({worker:1,direction:'reply',data:{type:'walk_done',...done}});reply(1,4,done);
 command(1,5,'reset');reply(1,5,frame(0));command(1,6,'step',{time:.02});reply(1,6,frame(.02));
 rows.push({worker:1,direction:'fault_arm',data:{expectedTime:.04,time:-1}},
  {worker:1,direction:'fault_injection',data:{id:7,type:'step',originalTime:.04,time:-1}});
 command(1,7,'step',{time:-1});rows.push({worker:1,direction:'reply',data:{id:7,error:'Error: FMU cannot advance backwards from t=0.02 to -1.'}},
  {worker:1,direction:'terminate'});
 command(2,8,'prepare');reply(2,8,prepared(75));command(2,9,'step',{time:.02});reply(2,9,frame(.02));rows.push({worker:2,direction:'terminate'});
 return{schema:'fmu-browser-worker-trace/1',overflow:false,events:rows};
}
test('complete unfiltered nominal/refusal/recovery trace requires the actual new-worker frames',()=>{
 const t=trace(),r=auditFmuPageRecoveryTrace(t,index);assert.equal(r.recoveries,1);assert.equal(r.failedWorker,1);assert.equal(r.recoveredWorker,2);
 assert.equal(r.accountedEvents,t.events.length);assert.equal(r.nominal.reset,1);assert.equal(r.nominal.terminated,0);
 assert.match(r.scope,/not guest trap/);
});
test('missing/forged/refused/stale evidence cannot become a recovery success',()=>{
 const first=trace(),arm=first.events.findIndex(e=>e.direction==='fault_arm'),split=first.events.findIndex(e=>e.worker===2);
 for(const at of [arm,arm+1,arm+2,arm+3,arm+4,split,split+1,split+2,split+3,split+4]){
  const t=trace();t.events.splice(at,1);assert.throws(()=>auditFmuPageRecoveryTrace(t,index),'missing event '+at);
 }
 const synthetic=trace();synthetic.events[arm+3].data={id:7,result:frame(.04)};assert.throws(()=>auditFmuPageRecoveryTrace(synthetic,index),/success/);
 const wrong=trace();wrong.events[arm+3].data.error='Error: unrelated failure';assert.throws(()=>auditFmuPageRecoveryTrace(wrong,index),/wrong actual/);
 const token=trace();token.events[split+1].data.result.execution.instantiation_token='old';assert.throws(()=>auditFmuPageRecoveryTrace(token,index),/token/);
 const payload=trace();payload.events[split+3].data.result.outputs.score=1;assert.throws(()=>auditFmuPageRecoveryTrace(payload,index),/complete manual/);
 const fallback=trace();fallback.events[split+1].data.result.preparation.plant='prebuilt';assert.throws(()=>auditFmuPageRecoveryTrace(fallback,index),/fell back/);
 const old=trace();old.events[split+1].worker=1;assert.throws(()=>auditFmuPageRecoveryTrace(old,index),/old worker/);
 const duplicate=trace();duplicate.events[split].data.id=1;duplicate.events[split+1].data.id=1;assert.throws(()=>auditFmuPageRecoveryTrace(duplicate,index),/reused/);
 const extra=trace();extra.events.splice(arm+4,0,{worker:1,direction:'reply',data:{id:7,result:frame(.04)}});assert.throws(()=>auditFmuPageRecoveryTrace(extra,index),/unexpected evidence/);
 const skipped=trace();skipped.events.splice(11,2);assert.throws(()=>auditFmuPageRecoveryTrace(skipped,index));
 const changed=trace();changed.events[arm+1].data.originalTime=.06;assert.throws(()=>auditFmuPageRecoveryTrace(changed,index),/undeclared/);
});
function capture(t,options){
 const names=['Worker','location','__fmuQualificationTrace','__fmuArmCommandRefusal'],old=Object.fromEntries(names.map(n=>[n,{own:Object.hasOwn(globalThis,n),value:globalThis[n]}]));
 t.after(()=>{for(const[n,r]of Object.entries(old))if(r.own)globalThis[n]=r.value;else delete globalThis[n];});
 class NativeWorker{
  constructor(...args){this.args=args;this.listeners=new Map();}
  addEventListener(type,callback){this.listeners.set(type,callback);}
  postMessage(...args){this.sent=args;return 17;}
  terminate(){this.closed=true;}
 }
 globalThis.Worker=NativeWorker;globalThis.location={href:'http://page.test/microduck/'};delete globalThis.__fmuArmCommandRefusal;
 installFmuReceiptCapture(options);return()=>globalThis.__fmuQualificationTrace;
}
test('one declared mutation preserves original command/inputs/transfer and observer-owned worker identity',t=>{
 const current=capture(t,{allowCommandRefusal:true}),w=new Worker('./physics.worker.js',{type:'module'}),message={id:7,type:'step',time:.04,inputs:[['u',-0]]},transfer=[];
 w.__qualificationId=99;globalThis.__fmuArmCommandRefusal(1,.04);assert.throws(()=>globalThis.__fmuArmCommandRefusal(1,.04),/already/);
 assert.equal(w.postMessage(message,transfer),17);assert.equal(message.time,.04);assert.notEqual(w.sent[0],message);
 assert.equal(w.sent[0].time,-1);assert.equal(w.sent[0].id,7);assert.equal(w.sent[0].inputs,message.inputs);assert.equal(w.sent[1],transfer);
 assert.deepEqual(current().events.map(e=>e.direction),['fault_arm','fault_injection','command']);assert(current().events.every(e=>e.worker===1));
 w.listeners.get('message')({data:{id:7,error:'actual fake-worker refusal',worker:99}});w.terminate();
 const next=new Worker('./physics.worker.js');next.__qualificationId=1;const request={id:8,type:'prepare'};next.postMessage(request);
 assert.equal(next.sent[0],request,'consumed arm does not change the replacement command');
 next.listeners.get('message')({data:{id:8,result:prepared(1),worker:1}});
 assert.equal(current().events.at(-1).worker,2,'reply data cannot choose observer identity');
});
test('wrong/dead/repeated targets and non-step commands refuse; default capture is exact passthrough',t=>{
 const current=capture(t,{allowCommandRefusal:true}),w=new Worker('./physics.worker.js'),other=new Worker('./physics.worker.js');
 for(const[id,time]of [[99,.04],[2,.04],[1,NaN],[1,Infinity],[1,-1]])assert.throws(()=>globalThis.__fmuArmCommandRefusal(id,time));
 assert.equal(current().events.length,0);globalThis.__fmuArmCommandRefusal(1,.04);
 assert.throws(()=>w.postMessage({id:1,type:'policy_step',time:.04}),/next manual/);assert.equal(w.sent,undefined);
 w.terminate();assert.throws(()=>globalThis.__fmuArmCommandRefusal(1,.04));other.terminate();
});
test('a terminated first worker cannot be armed even before any fault was declared',t=>{
 capture(t,{allowCommandRefusal:true});const w=new Worker('./physics.worker.js');w.terminate();assert.throws(()=>globalThis.__fmuArmCommandRefusal(1,.04),/not live/);
});
test('default recorder exposes no fault hook and preserves command and transfer objects',t=>{
 const current=capture(t),w=new Worker('./physics.worker.js'),message={id:1,type:'step',time:.04},transfer=[];
 assert.equal(Object.hasOwn(globalThis,'__fmuArmCommandRefusal'),false);w.postMessage(message,transfer);
 assert.equal(w.sent[0],message);assert.equal(w.sent[1],transfer);assert.deepEqual(current().events.map(e=>e.direction),['command']);
});
