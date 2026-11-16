import test from 'node:test';
import assert from 'node:assert/strict';
import {checkFmuPageFrame,auditFmuWorkerTrace,installFmuReceiptCapture} from './fmu-browser-receipts.mjs';
const index={instantiationToken:'stand-in-token'};
const frame=(time=0)=>({time,execution:{engine:'fmi3-ls-wasm',model:'MicroduckWholeSystem',refusal:null,instantiation_token:index.instantiationToken}});
const prepared=()=>({...frame(),preparation:{controller:'fmu',plant:'fmu',model:'MicroduckWholeSystem',selected_model:'MicroduckJawLocked'}});
function trace(){return{schema:'fmu-browser-worker-trace/1',overflow:false,events:[
 {direction:'command',data:{id:1,type:'prepare'}},{direction:'reply',data:{id:1,result:prepared()}},
 {direction:'command',data:{id:2,type:'step'}},{direction:'reply',data:{id:2,result:frame(.02)}},
 {direction:'command',data:{id:3,type:'walk_start',generation:7}},{direction:'reply',data:{id:3,result:{generation:7,time:.02,mode:'realtime'}}},
 {direction:'reply',data:{type:'walk_frame',generation:7,sequence:1,result:frame(.04)}},
 {direction:'command',data:{type:'walk_ack',generation:7,sequence:1}},
 {direction:'command',data:{id:4,type:'walk_stop',generation:7}},
 {direction:'reply',data:{type:'walk_done',generation:7,time:.04,frame:frame(.04),reason:'paused'}},
 {direction:'reply',data:{id:4,result:{generation:7,time:.04,frame:frame(.04),reason:'paused'}}},
 {direction:'terminate'}].map(e=>({worker:1,...e}))};}
test('UI motion or missing fallback field cannot replace exact actual FMU preparation and receipts',()=>{
 assert.equal(checkFmuPageFrame(prepared(),index,{prepare:true}).time,0);
 for(const key of ['engine','model','instantiation_token','refusal']){const f=prepared();delete f.execution[key];assert.throws(()=>checkFmuPageFrame(f,index,{prepare:true}));}
 for(const engine of ['interpreter','wasm_program','rumoca-fmi3-ls-wasm'])assert.throws(()=>checkFmuPageFrame({...prepared(),execution:{...frame().execution,engine}},index,{prepare:true}));
 for(const change of [{plant:'prebuilt'},{controller:'prebuilt'},{model:'MicroduckJawLocked'},{selected_model:'other'},{fmu_fallback:'load failed'}])assert.throws(()=>checkFmuPageFrame({...prepared(),preparation:{...prepared().preparation,...change}},index,{prepare:true}));
 assert.throws(()=>checkFmuPageFrame(frame(),{instantiationToken:'other'}));assert.throws(()=>checkFmuPageFrame({...frame(),time:NaN},index));
});
test('real start acknowledgement without execution is valid; stale/absent/unacknowledged frames and empty pause never count',()=>{
 assert.equal(auditFmuWorkerTrace(trace(),index).walk,1);
 for(const remove of [1,3,4,5,6,7,8,9,10,11]){const t=trace();t.events.splice(remove,1);assert.throws(()=>auditFmuWorkerTrace(t,index),'missing event '+remove);}
 for(const pos of [4,5,6,7,8,9,10]){const t=trace();if(pos===5||pos===10)t.events[pos].data.result.generation=6;else t.events[pos].data.generation=6;assert.throws(()=>auditFmuWorkerTrace(t,index),'stale event '+pos);}
 const duplicate=trace();duplicate.events.splice(8,0,structuredClone(duplicate.events[6]),structuredClone(duplicate.events[7]));assert.throws(()=>auditFmuWorkerTrace(duplicate,index),/sequence/);
 const mismatched=trace();mismatched.events[10].data.result.time=.06;mismatched.events[10].data.result.frame.time=.06;assert.throws(()=>auditFmuWorkerTrace(mismatched,index),/match actual walk done/);
 const changedFrame=trace();changedFrame.events[10].data.result.frame.outputs={score:1};assert.throws(()=>auditFmuWorkerTrace(changedFrame,index),/match actual walk done/);
 const pause=trace();pause.events[10].data.result={};assert.throws(()=>auditFmuWorkerTrace(pause,index));
 const bad=trace();bad.events[6].data.result.execution.engine='wasm_program';assert.throws(()=>auditFmuWorkerTrace(bad,index));
 const wrongPause=trace();wrongPause.events[10].data.result.frame.execution.instantiation_token='wrong';assert.throws(()=>auditFmuWorkerTrace(wrongPause,index));
 const overflow=trace();overflow.overflow=true;assert.throws(()=>auditFmuWorkerTrace(overflow,index));
 const other=trace();other.events[6].worker=2;assert.throws(()=>auditFmuWorkerTrace(other,index));
});
test('capture forwards exact message/transfer objects and restores no runtime behavior',()=>{
 const oldWorker=globalThis.Worker,oldLocation=globalThis.location,oldTrace=globalThis.__fmuQualificationTrace;
 try{
  class Native{constructor(...args){this.args=args;}addEventListener(type,fn){this.listener=fn;}postMessage(...args){this.sent=args;return 17;}terminate(){this.closed=true;}}
  globalThis.Worker=Native;globalThis.location={href:'http://page.test/microduck_web/'};installFmuReceiptCapture();
  const opts={type:'module'},w=new Worker('./physics.worker.js',opts),message={id:2,type:'prepare',sources:{private:'not copied'},time:.02,inputs:[['u',-0]]},transfer=[];
  assert.equal(w.postMessage(message,transfer),17);assert.equal(w.sent[0],message);assert.equal(w.sent[1],transfer);assert.equal(w.args[1],opts);
  w.listener({data:{id:2,result:prepared()}});w.terminate();assert(w.closed);assert.equal(__fmuQualificationTrace.events.length,3);
  assert(!Object.hasOwn(__fmuQualificationTrace.events[0].data,'sources'));
  assert.equal(__fmuQualificationTrace.events[0].data.time,.02);
  assert(Object.is(__fmuQualificationTrace.events[0].data.inputs[0][1],-0));
  message.inputs[0][1]=1;assert(Object.is(__fmuQualificationTrace.events[0].data.inputs[0][1],-0),'captured input is detached from later mutation');
  const other=new Worker('./another.worker.js');other.postMessage({type:'other'});assert.equal(__fmuQualificationTrace.events.length,3);
 }finally{globalThis.Worker=oldWorker;globalThis.location=oldLocation;globalThis.__fmuQualificationTrace=oldTrace;}
});

function resetTrace(){
 const t=trace();t.events[2].data.time=.02;
 t.events.splice(-1,0,...[
  {direction:'command',data:{id:5,type:'reset'}},{direction:'reply',data:{id:5,result:frame(0)}},
  {direction:'command',data:{id:6,type:'step',time:.02}},{direction:'reply',data:{id:6,result:frame(.02)}}
 ].map(e=>({worker:1,...e})));return t;
}
test('page reset qualification requires actual time-zero receipt and matching complete replay after pause',()=>{
 assert.equal(auditFmuWorkerTrace(resetTrace(),index,{requireReset:true}).replay,1);
 assert.throws(()=>auditFmuWorkerTrace(trace(),index,{requireReset:true}),/reset receipt/);
 assert.throws(()=>auditFmuWorkerTrace(resetTrace(),index),/unexpected reset/);
 for(const pos of [11,12,13,14]){
  const t=resetTrace();t.events.splice(pos,1);assert.throws(()=>auditFmuWorkerTrace(t,index,{requireReset:true}));
 }
 for(const pos of [12,14]){
  const t=resetTrace();t.events[pos].data.result.execution.instantiation_token='other';
  assert.throws(()=>auditFmuWorkerTrace(t,index,{requireReset:true}),/token/);
 }
 const time=resetTrace();time.events[12].data.result.time=.04;assert.throws(()=>auditFmuWorkerTrace(time,index,{requireReset:true}),/reset time is not zero/);
 const values=resetTrace();values.events[14].data.result.outputs={score:1};assert.throws(()=>auditFmuWorkerTrace(values,index,{requireReset:true}),/replay frame/);
 const input=resetTrace();input.events[13].data.inputs=[['forwardVelocity',1]];assert.throws(()=>auditFmuWorkerTrace(input,index,{requireReset:true}),/inputs differ/);
 const early=resetTrace(),moved=early.events.splice(11,2);early.events.splice(8,0,...moved);assert.throws(()=>auditFmuWorkerTrace(early,index,{requireReset:true}),/before completed pause/);
});
