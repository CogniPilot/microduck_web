// Qualification-only evidence collection. Does not change worker URLs, messages or runtime code.
import assert from 'node:assert/strict';
import {WHOLE_MODEL,LEGACY_MODEL} from '../site/fmu-page-contract.js';

// Passed directly to Playwright addInitScript; deliberately has no module dependencies.
export function installFmuReceiptCapture({allowCommandRefusal=false}={}){
 const NativeWorker=globalThis.Worker,trace={schema:'fmu-browser-worker-trace/1',events:[],overflow:false};
 globalThis.__fmuQualificationTrace=trace;
 let next=0,armed,used=false;
 const ids=new WeakMap(),live=new Map();
 const record=event=>{if(trace.events.length>=2048){trace.overflow=true;return;}trace.events.push({epochMs:performance.timeOrigin+performance.now(),...event});};
 if(allowCommandRefusal)globalThis.__fmuArmCommandRefusal=(worker,expectedTime)=>{
  if(used||armed)throw Error('qualification refusal already armed');
  if(worker!==1||!live.has(worker))throw Error('first qualification worker is not live');
  if(!Number.isFinite(expectedTime)||expectedTime<=0)throw Error('invalid qualification target');
  armed={worker:live.get(worker),expectedTime};used=true;
  record({worker,direction:'fault_arm',data:{expectedTime,time:-1}});
 };
 globalThis.Worker=class extends NativeWorker{
  constructor(url,...args){
   super(url,...args);
   if(new URL(String(url),location.href).pathname.endsWith('/physics.worker.js')){
    const id=++next;ids.set(this,id);live.set(id,this);
    this.addEventListener('message',({data})=>record({worker:id,direction:'reply',data:structuredClone(data)}));
   }
  }
  postMessage(...args){
   const worker=ids.get(this);
   if(worker!==undefined){
    let m=args[0];
    if(armed?.worker===this){
     if(m?.type!=='step'||m.time!==armed.expectedTime||!Number.isSafeInteger(m.id))throw Error('qualification expected the next manual step');
     record({worker,direction:'fault_injection',data:{id:m.id,type:m.type,originalTime:m.time,time:-1}});
     m={...m,time:-1};args=[m,...args.slice(1)];armed=undefined;
    }
    const data={id:m?.id,type:m?.type,generation:m?.generation,sequence:m?.sequence};
    // Lifecycle replay needs the actual step target and inputs; never copy source bodies.
    for(const key of ['time','inputs'])if(Object.hasOwn(m??{},key))data[key]=structuredClone(m[key]);
    record({worker,direction:'command',data});
   }
   return super.postMessage(...args);
  }
  terminate(){const worker=ids.get(this);if(worker!==undefined){record({worker,direction:'terminate'});live.delete(worker);}return super.terminate();}
 };
}

export function checkFmuPageFrame(frame,index,{prepare=false}={}){
 assert(frame&&typeof frame==='object','missing actual worker frame');
 assert(Number.isFinite(frame.time)&&frame.time>=0,'invalid actual frame time');
 const e=frame.execution;
 assert.equal(e?.engine,'fmi3-ls-wasm','worker frame is not FMU execution');
 assert.equal(e.refusal,null,'worker FMU execution carries a refusal');
 assert.equal(e.model,WHOLE_MODEL,'worker is not running the whole model');
 assert(typeof index.instantiationToken==='string'&&index.instantiationToken.length>0,'missing verified index token');
 assert.equal(e.instantiation_token,index.instantiationToken,'worker token differs from verified index');
 if(prepare){
  const p=frame.preparation;
  assert.equal(p?.controller,'fmu','controller preparation fell back');
  assert.equal(p.plant,'fmu','plant preparation fell back');
  assert.equal(p.selected_model,LEGACY_MODEL,'wrong selected page entry');
  assert.equal(p.model,WHOLE_MODEL,'preparation reduced the model');
  assert(p.fmu_fallback===undefined||p.fmu_fallback==='','FMU fallback was reported');
 }
 return frame;
}

export function auditFmuWorkerTrace(trace,index,{requireReset=false,requireTermination=true}={}){
 assert.equal(trace?.schema,'fmu-browser-worker-trace/1');assert.equal(trace.overflow,false,'worker evidence overflow');
 assert(Array.isArray(trace.events),'missing worker events');
 const workers=new Set(trace.events.map(e=>e.worker));assert.equal(workers.size,1,'smoke must use one physics worker');
 const commands=new Map(),replied=new Set();let prepare=0,manual=0,walk=0,start=0,stop=0,terminated=0,reset=0,replay=0;
 let initialFrame,manualFrame,manualCommand;
 let generation=null,phase='idle',sequence=0,pending=null,lastTime=0,done=null;
 for(const event of trace.events){
  const m=event.data;
  assert.equal(terminated,0,'evidence after worker termination');
  if(event.direction==='command'){
   assert(m&&typeof m==='object');
   if(m.id!==undefined){assert(Number.isSafeInteger(m.id)&&!commands.has(m.id),'invalid/duplicate command id');commands.set(m.id,m);}
   if(m.type==='walk_start'){
    assert.equal(phase,'idle','multiple walk starts');assert.equal(manual,1,'walk before manual step');
    assert(Number.isSafeInteger(m.generation)&&m.generation>0,'invalid walk generation');generation=m.generation;phase='starting';
   }else if(m.type==='walk_ack'){
    assert(phase==='running'||phase==='stopping','ack outside active walk');assert.equal(m.generation,generation,'stale walk acknowledgement');
    assert(pending&&m.sequence===pending.sequence,'ack does not identify the delivered frame');
    sequence=pending.sequence;lastTime=pending.time;pending=null;walk++;
   }else if(m.type==='walk_stop'){
    assert.equal(phase,'running','pause outside active walk');assert.equal(m.generation,generation,'stale pause command');phase='stopping';
   }else if(m.type==='reset'){
    assert(requireReset,'unexpected reset in ordinary smoke');assert.equal(phase,'closed','reset before completed pause');assert.equal(reset,0,'duplicate reset');
   }
   continue;
  }
  if(event.direction==='terminate'){assert.equal(phase,'closed','worker stopped before pause receipt');terminated++;continue;}
  assert.equal(event.direction,'reply');assert(m&&typeof m==='object');assert(!m.error,'worker reported '+m.error);assert.notEqual(m.type,'walk_error','worker walk failed');
  const command=m.id===undefined?null:commands.get(m.id);
  if(m.id!==undefined){assert(command&&!replied.has(m.id),'unmatched/duplicate command reply');replied.add(m.id);}
  if(command?.type==='prepare'){checkFmuPageFrame(m.result,index,{prepare:true});assert.equal(m.result.time,0);initialFrame=m.result;lastTime=0;prepare++;}
  else if(command?.type==='step'){
   checkFmuPageFrame(m.result,index);assert.equal(m.result.time,0.02);
   if(phase==='closed'){
    assert(requireReset&&reset===1,'replay before reset');assert.equal(replay,0,'duplicate replay');
    assert.equal(command.time,manualCommand.time,'reset replay target differs');assert.deepEqual(command.inputs,manualCommand.inputs,'reset replay inputs differ');
    assert.deepEqual(m.result,manualFrame,'reset replay frame differs');replay++;
   }else{assert.equal(phase,'idle','manual step during walk');manualFrame=m.result;manualCommand=command;manual++;}
   lastTime=m.result.time;
  }else if(command?.type==='reset'){
   assert(requireReset&&phase==='closed','reset outside reset qualification');assert.equal(reset,0,'duplicate reset reply');
   checkFmuPageFrame(m.result,index);assert.equal(m.result.time,0,'reset time is not zero');
   const {preparation,...initial}=initialFrame;assert.deepEqual(m.result,initial,'reset did not restore complete initial frame');lastTime=0;reset++;
  }
  else if(command?.type==='walk_start'){
   assert.equal(phase,'starting','start reply outside starting walk');const r=m.result;
   assert.equal(r?.generation,generation,'start reply generation differs');assert.equal(r.mode,'realtime','unexpected walk pacing');
   assert(Number.isFinite(r.time)&&Math.abs(r.time-lastTime)<1e-10,'start reply time differs');phase='running';start++;
  }else if(m.type==='walk_frame'){
   assert(phase==='running'||phase==='stopping','frame outside active walk');assert(!done,'frame after walk done');
   assert.equal(m.generation,generation,'stale walk frame');assert(Number.isSafeInteger(m.sequence)&&m.sequence>sequence,'non-increasing walk sequence');assert.equal(pending,null,'frame before prior acknowledgement');
   checkFmuPageFrame(m.result,index);assert(m.result.time>lastTime,'walk time did not advance');pending={sequence:m.sequence,time:m.result.time};
  }else if(m.type==='walk_done'){
   assert.equal(phase,'stopping','walk ended before requested pause');assert.equal(m.generation,generation,'stale walk done');assert(!done,'duplicate walk done');
   checkFmuPageFrame(m.frame,index);assert(Number.isFinite(m.time)&&m.time>=lastTime&&Math.abs(m.time-m.frame.time)<1e-10,'done time differs');assert.equal(m.reason,'paused','walk did not pause normally');done={generation:m.generation,time:m.time,frame:m.frame,reason:m.reason};
  }else if(command?.type==='walk_stop'){
   assert.equal(phase,'stopping','pause reply outside stopping walk');assert(done,'missing actual walk-done receipt');assert.equal(pending,null,'unacknowledged frame at pause');
   const r=m.result;assert.deepEqual({generation:r?.generation,time:r?.time,frame:r?.frame,reason:r?.reason},done,'pause does not match actual walk done');assert.equal(r?.generation,generation,'pause generation differs');checkFmuPageFrame(r.frame,index);
   assert(Number.isFinite(r.time)&&r.time>=lastTime&&Math.abs(r.time-r.frame.time)<1e-10,'pause time differs');assert.equal(r.reason,'paused','pause reason differs');phase='closed';stop++;
  }else if(m.result?.execution||m.result?.preparation||Number.isFinite(m.result?.time))checkFmuPageFrame(m.result,index);
 }
 assert.equal(prepare,1,'one actual FMU prepare required');assert.equal(manual,1,'one actual manual tick required');assert.equal(start,1,'one actual walk-start reply required');
 assert(walk>0,'no page-acknowledged FMU walk frame');assert.equal(stop,1,'one valid pause reply required');assert.equal(phase,'closed','walk did not close');assert.equal(terminated,requireTermination?1:0,requireTermination?'worker stop was not observed':'worker terminated before qualification continuation');
 if(requireReset){assert.equal(reset,1,'one reset receipt required');assert.equal(replay,1,'one reset replay required');}
 return{scope:!requireTermination?'paused nominal qualification prefix only; worker termination still required':requireReset?'actual prepare/manual/walk-generation/ack/pause/reset/replay/stop receipts; not fault/internal-event or physics-parity qualification':'actual prepare/manual/walk-generation/ack/pause/stop receipts; not reset/fault/event or physics-parity qualification',prepare,manual,start,walk,stop,terminated,reset,replay,generation,lastAcceptedSequence:sequence,time:lastTime,engine:'fmi3-ls-wasm',model:WHOLE_MODEL,instantiationToken:index.instantiationToken};
}
