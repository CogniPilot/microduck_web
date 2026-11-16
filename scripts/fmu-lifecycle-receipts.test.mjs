import test from 'node:test';
import assert from 'node:assert/strict';
import {auditFmuResetTrace,auditFmuFaultTrace} from './fmu-lifecycle-receipts.mjs';
import {stepOutcomeError} from '../site/fmu-session.js';
const index={instantiationToken:'pure-control-token'};
const frame=time=>({time,outputs:{score:0,fallen:false},execution:{engine:'fmi3-ls-wasm',model:'MicroduckWholeSystem',refusal:null,instantiation_token:index.instantiationToken}});
const prepared=()=>({...frame(0),preparation:{controller:'fmu',plant:'fmu',selected_model:'MicroduckJawLocked',model:'MicroduckWholeSystem'}});
function trace(rows){return{schema:'fmu-browser-worker-trace/1',overflow:false,events:[...rows.flatMap(([command,reply],i)=>[
 {worker:1,direction:'command',data:{id:i+1,...command}},
 {worker:1,direction:'reply',data:{id:i+1,...reply}}]),{worker:1,direction:'terminate'}]};}
const resetTrace=()=>trace([[{type:'prepare'},{result:prepared()}],
 [{type:'step',time:.02,inputs:[['forwardVelocity',0]]},{result:frame(.02)}],
 [{type:'reset'},{result:frame(0)}],
 [{type:'step',time:.02,inputs:[['forwardVelocity',0]]},{result:frame(.02)}]]);
const error='FmuFault: FMU stopped at t=0.02 (terminate-simulation false, early-return false, event-handling-needed true)';
const faultTrace=()=>trace([[{type:'prepare'},{result:prepared()}],
 [{type:'step',time:.02},{error}],[{type:'step',time:.04},{error}],
 [{type:'reset'},{error:error+' Prepare the simulation again.'}],
 [{type:'prepare'},{result:prepared()}],[{type:'step',time:.02},{result:frame(.02)}]]);

test('reset receipt requires initial-state restoration, same-input replay and complete exact frame',()=>{
 assert.equal(auditFmuResetTrace(resetTrace(),index).replay,1);
 for(const pos of [1,3,5,7]){
  const t=resetTrace();t.events[pos].data.result.execution.instantiation_token='other';
  assert.throws(()=>auditFmuResetTrace(t,index),/token/);
 }
 for(const [pos,key,value] of [[5,'time',.02],[5,'outputs',{score:1}],[7,'outputs',{score:-0,fallen:false}]]){
  const t=resetTrace();t.events[pos].data.result[key]=value;assert.throws(()=>auditFmuResetTrace(t,index));
 }
 const changed=resetTrace();changed.events[6].data.inputs[0][1]=1;assert.throws(()=>auditFmuResetTrace(changed,index),/inputs differ/);
 const truncated=resetTrace();truncated.events.splice(5,1);assert.throws(()=>auditFmuResetTrace(truncated,index));
});
test('fault receipts cannot substitute reset or continued success for fresh prepare recovery',()=>{
 assert.equal(auditFmuFaultTrace(faultTrace(),index,{expectedError:/event-handling-needed true/}).recovery,1);
 for(const pos of [3,5,7]){
  const t=faultTrace();t.events[pos].data={id:t.events[pos].data.id,result:frame(.02)};
  assert.throws(()=>auditFmuFaultTrace(t,index,{expectedError:/event-handling-needed true/}));
 }
 const stale=faultTrace();stale.events[11].data.result.execution.instantiation_token='old';
 assert.throws(()=>auditFmuFaultTrace(stale,index,{expectedError:/event-handling-needed true/}),/token/);
 const missing=faultTrace();missing.events.splice(8,2);assert.throws(()=>auditFmuFaultTrace(missing,index,{expectedError:/event/}));
 assert.throws(()=>auditFmuFaultTrace(faultTrace(),index),/expected fault/);
});
test('the actual session outcome check refuses event, early-return and termination flags before time is carried',()=>{
 const ok={lastSuccessfulTime:.02,eventHandlingNeeded:false,earlyReturn:false,terminateSimulation:false};
 assert.equal(stepOutcomeError(0,.02,ok),null);
 for(const [flag,label] of [['eventHandlingNeeded','event-handling-needed'],['earlyReturn','early-return'],['terminateSimulation','terminate-simulation']]){
  assert.match(stepOutcomeError(0,.02,{...ok,[flag]:true}),new RegExp(label+' true'));
 }
 for(const reached of [undefined,NaN,Infinity,0,-.02,.01,.03])assert.match(stepOutcomeError(0,.02,{...ok,lastSuccessfulTime:reached}),/not strictly advancing/);
 const v=new DataView(new ArrayBuffer(8));v.setFloat64(0,.02);const bits=v.getBigUint64(0);
 v.setBigUint64(0,bits+4n);assert.equal(stepOutcomeError(0,.02,{...ok,lastSuccessfulTime:v.getFloat64(0)}),null);
 v.setBigUint64(0,bits+5n);assert.match(stepOutcomeError(0,.02,{...ok,lastSuccessfulTime:v.getFloat64(0)}),/4 ULP/);
});
