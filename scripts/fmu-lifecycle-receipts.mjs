// Qualification-only auditors for a direct worker protocol segment, not UI controls.
import assert from 'node:assert/strict';
import {checkFmuPageFrame} from './fmu-browser-receipts.mjs';

function exchanges(trace) {
 assert.equal(trace?.schema,'fmu-browser-worker-trace/1');
 assert.equal(trace.overflow,false,'worker evidence overflow');
 assert(Array.isArray(trace.events)&&trace.events.length>0,'missing lifecycle evidence');
 assert(trace.events.every(e=>Number.isSafeInteger(e.worker)&&e.worker>0),'invalid worker identity');
 assert.equal(new Set(trace.events.map(e=>e.worker)).size,1,'one worker per lifecycle segment');
 const rows=[],seen=new Set();let pending=null,terminated=false;
 for(const event of trace.events){
  assert(!terminated,'evidence after worker termination');
  if(event.direction==='terminate'){
   assert.equal(pending,null,'termination before command reply');terminated=true;continue;
  }
  const m=event.data;assert(m&&typeof m==='object');
  if(event.direction==='command'){
   assert.equal(pending,null,'concurrent lifecycle command');
   assert(Number.isSafeInteger(m.id)&&!seen.has(m.id),'invalid/duplicate lifecycle id');
   seen.add(m.id);pending=m;
  }else{
   assert.equal(event.direction,'reply');
   assert(pending&&m.id===pending.id,'unmatched lifecycle reply');
   assert.notEqual(Object.hasOwn(m,'error'),Object.hasOwn(m,'result'),'reply must have result or error');
   rows.push({command:pending,reply:m});pending=null;
  }
 }
 assert.equal(pending,null,'missing lifecycle reply');assert(terminated,'missing worker termination');
 return rows;
}
function success(row,type,index,{prepare=false}={}){
 assert.equal(row.command.type,type);assert(!Object.hasOwn(row.reply,'error'),'unexpected lifecycle error');
 return checkFmuPageFrame(row.reply.result,index,{prepare});
}
function failure(row,type,pattern){
 assert.equal(row.command.type,type);assert.equal(typeof row.reply.error,'string');
 assert.match(row.reply.error,pattern);return row.reply.error;
}
const comparable=frame=>{const {preparation,...state}=frame;return state;};

export function auditFmuResetTrace(trace,index){
 const rows=exchanges(trace);assert.equal(rows.length,4,'prepare/step/reset/replay required');
 const initial=success(rows[0],'prepare',index,{prepare:true});assert.equal(initial.time,0);
 const before=success(rows[1],'step',index);assert.equal(rows[1].command.time,.02);assert.equal(before.time,.02);
 const reset=success(rows[2],'reset',index);assert.equal(reset.time,0);
 assert.deepEqual(comparable(reset),comparable(initial),'reset did not restore complete initial frame');
 assert.deepEqual(rows[3].command.inputs,rows[1].command.inputs,'replay inputs differ');
 assert.equal(rows[3].command.time,rows[1].command.time,'replay target differs');
 const replay=success(rows[3],'step',index);
 assert.deepEqual(replay,before,'reset replay frame differs');
 return{scope:'direct worker reset and one complete-frame replay; not UI reset, events or physical parity',reset:1,replay:1};
}

export function auditFmuFaultTrace(trace,index,{expectedError}={}){
 assert(expectedError instanceof RegExp,'explicit expected fault required');
 assert(!expectedError.global&&!expectedError.sticky,'fault matcher must be stateless');
 const rows=exchanges(trace);assert.equal(rows.length,6,'prepare/fault/blocked-step/blocked-reset/reprepare/recovery required');
 assert.equal(success(rows[0],'prepare',index,{prepare:true}).time,0);
 const error=failure(rows[1],'step',expectedError);
 const blocked=failure(rows[2],'step',expectedError);assert.equal(blocked,error,'fault changed on repeated work');
 failure(rows[3],'reset',expectedError);failure(rows[3],'reset',/Prepare the simulation again/);
 assert.equal(success(rows[4],'prepare',index,{prepare:true}).time,0);
 const recovered=success(rows[5],'step',index);assert.equal(recovered.time,.02);assert.equal(rows[5].command.time,.02);
 return{scope:'direct worker fault propagation/refusal and fresh-prepare recovery; not event-mode handling or UI recovery',fault:1,recovery:1};
}
