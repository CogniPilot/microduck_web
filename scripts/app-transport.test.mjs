import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source=fs.readFileSync(process.env.MD_TRANSPORT_SOURCE??new URL('../site/app.js',import.meta.url),'utf8');
const prefix=source.split('async function playRecording(')[0].replace(/^import .*\n/gm,'')
 .replaceAll('import.meta.url',JSON.stringify('https://example.invalid/app.js'));
const walkingSource=fs.readFileSync(new URL('../site/walking-controls.js',import.meta.url),'utf8').replace('export function createWalkingControls','function createWalkingControls');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(ready=Promise.resolve(),{sensors=false,editorFile='Microduck.mo',editor='model Microduck end Microduck;'}={}){
 const workers=[],elements=new Map(),applied=[],invalidations=[];
 let sensorLoop;
 const element=id=>{if(!elements.has(id))elements.set(id,{value:id==='editor'?editor:'model Microduck end Microduck;'});return elements.get(id);};
 const sandbox={URL,sourceFiles:['Microduck.mo'],selectedFile:'Microduck.mo',editorFile,savedDraft:()=>null,
  originals:new Map([['Microduck.mo','model Microduck end Microduck;']]),microduckSourcesReady:ready,
  document:{getElementById:element,querySelectorAll:()=>[],addEventListener(){}},
  setTimeout:()=>1,clearTimeout(){},showSensors(){},sensorInputs:frame=>[['cameraTimestamp',frame.stamp??999]],
  renderer:{setAnimationLoop:callback=>{sensorLoop=callback;},render(){}},
  controls:{update(){},target:{}},arena:{focus(){}},scene:{},camera:{},
  Worker:class{
   constructor(){this.terminated=false;this.commands=[];workers.push(this);}
   postMessage(message){this.commands.push(message);}
   terminate(){this.terminated=true;}
   reply(label,type='prepare',time=0){const command=this.commands.findLast(x=>x.type===type);assert(command);this.onmessage({data:{id:command.id,result:{label,time,outputs:{},preparation:{plant:'prebuilt',controller:'prebuilt'}}}});}
   fail(type,error){const command=this.commands.findLast(x=>x.type===type);assert(command);this.onmessage({data:{id:command.id,error}});}
  }};
 sandbox.createWalkingControls=new Function('document','window',walkingSource+';return createWalkingControls;')(sandbox.document,{addEventListener(){}});
 // Keep the observer in this exact page realm, outside the source under test.
 const sensorCode=sensors?'let viewDirty=false;'+source.slice(source.indexOf('  let sensorPreview, sensorReadPending'),source.indexOf('  const {sensors, joints, robot} = await loadRobot')):'';
 const sensorApi=sensors?',setPreview:preview=>{sensorPreview=preview;},sensorFrame:()=>renderedFrame':'';
 const withApplied=new Function('applied','invalidations',...Object.keys(sandbox),'globalThis',prefix+'\nrobotView={restore(){},apply(state){applied.push(state.label);}};invalidateSensorFrames=()=>{invalidations.push(true);renderedFrame=undefined;};'+sensorCode+'return {enterSimulation,stopPhysics,startWalking,pauseWalking,updateWalking,resetSimulation,ready:()=>physicsReady,time:()=>physicsTime,setSensorFrame:frame=>{renderedFrame=frame;}'+sensorApi+'};');
 const api=withApplied(applied,invalidations,...Object.values(sandbox),sandbox);
 return {workers,applied,invalidations,element,api,sensorTick:now=>sensorLoop(now),prepare:()=>element('prepare-simulation').onclick(),step:()=>element('step-simulation').onclick(),reset:()=>element('reset-simulation').onclick(),setReady:p=>{sandbox.microduckSourcesReady=p;}};
}

test('rejected old prepare cannot stop a replacement worker',async()=>{
 const f=fixture(),old=f.prepare();await drain();assert.equal(f.workers.length,1);
 f.api.stopPhysics();const next=f.prepare();await drain();assert.equal(f.workers.length,2);
 assert.equal(f.workers[1].terminated,false);f.workers[1].reply('B');await Promise.all([old,next]);
 assert.equal(f.api.ready(),true);assert.deepEqual(f.applied,['B']);
 f.workers[0].onerror({message:'late old error'});assert.equal(f.workers[1].terminated,false);
});

test('Stop before sources-ready prevents the old continuation from spawning',async()=>{
 const ready=deferred(),f=fixture(ready.promise),old=f.prepare();f.api.stopPhysics();const next=f.prepare();
 ready.resolve();await drain();assert.equal(f.workers.length,1);assert.equal(f.workers[0].terminated,false);
 f.workers[0].reply('B');await Promise.all([old,next]);assert.deepEqual(f.applied,['B']);
});

test('late source failure from a canceled prepare leaves the replacement ready',async()=>{
 const ready=deferred(),f=fixture(ready.promise),old=f.prepare();f.api.stopPhysics();f.setReady(Promise.resolve());
 const next=f.prepare();await drain();f.workers[0].reply('B');await next;ready.reject(Error('old source failure'));await old;
 assert.equal(f.workers[0].terminated,false);assert.equal(f.api.ready(),true);assert.deepEqual(f.applied,['B']);
});

test('already-resolved old prepare success is discarded across Stop and replacement',async()=>{
 const f=fixture(),old=f.prepare();await drain();f.workers[0].reply('A');f.api.stopPhysics();
 const next=f.prepare();await drain();assert.deepEqual(f.applied,[]);f.workers[1].reply('B');await Promise.all([old,next]);
 assert.deepEqual(f.applied,['B']);assert.equal(f.api.ready(),true);
});

test('old manual-step success cannot apply or enable controls during new preparation',async()=>{
 const f=fixture(),first=f.prepare();await drain();f.workers[0].reply('A');await first;
 const step=f.step();f.workers[0].reply('old step','step',.02);f.api.stopPhysics();const next=f.prepare();await drain();await step;
 assert.deepEqual(f.applied,['A']);assert.equal(f.element('step-simulation').disabled,true);
 f.workers[1].reply('B');await next;assert.deepEqual(f.applied,['A','B']);
});

test('live walking displays the worker clock factor rather than page delivery latency',async()=>{const f=fixture();const preparing=f.prepare();await drain();f.workers[0].reply('ready');await preparing;const started=f.api.startWalking([0,0,0]);f.workers[0].reply('started','walk_start');await started;const generation=f.workers[0].commands.find(x=>x.type==='walk_start').generation;f.workers[0].onmessage({data:{type:'walk_frame',generation,sequence:1,result:{label:'live',time:.02,outputs:{}},speed:{factor:.5,simulatedSeconds:.02,wallSeconds:.04}}});assert.match(f.element('simulation-speed').textContent,/0.50× real time/);f.api.stopPhysics();assert.equal(f.element('simulation-speed').textContent,'Live speed: —');});

const readyFixture=async()=>{const f=fixture(),prepared=f.prepare();await drain();f.workers[0].reply('initial');await prepared;return f;};
test('page dynamics reset keeps the worker, invalidates sensors and applies actual time zero',async()=>{
 const f=await readyFixture(),worker=f.workers[0],before=f.invalidations.length;
 f.api.setSensorFrame({old:true});const reset=f.reset();await drain();
 assert.equal(f.api.ready(),false);assert.equal(f.element('reset-simulation').disabled,true);
 assert.equal(f.element('step-simulation').disabled,true);
 assert.equal(worker.commands.at(-1).type,'reset');assert.equal(worker.terminated,false);
 assert.equal((await f.reset()),undefined,'duplicate reset does not issue another command');
 worker.reply('reset','reset',0);await reset;
 assert.equal(f.api.time(),0);assert.equal(f.api.ready(),true);assert.equal(f.workers.length,1);
 assert.equal(f.invalidations.length,before+2);assert.deepEqual(f.applied,['initial','reset']);
 assert.equal(f.element('reset-simulation').disabled,false);
 const tick=f.step();assert.equal(worker.commands.at(-1).time,.02);
 assert.equal(worker.commands.at(-1).inputs,undefined,'old sensor frame is not sent');
 worker.reply('after reset','step',.02);await tick;
});
test('reset waits for the current manual command but never applies its stale frame',async()=>{
 const f=await readyFixture(),worker=f.workers[0],tick=f.step(),reset=f.reset();
 assert.equal(worker.commands.at(-1).type,'step');worker.reply('old step','step',.02);
 await tick;await drain();assert.deepEqual(f.applied,['initial']);
 assert.equal(worker.commands.at(-1).type,'reset');assert.equal(f.element('step-simulation').disabled,true);
 worker.reply('reset','reset',0);await reset;assert.deepEqual(f.applied,['initial','reset']);
});
test('reset pauses an active generation, acknowledges but does not apply its stale frame',async()=>{
 const f=await readyFixture(),worker=f.workers[0],started=f.api.startWalking([0,0,0]);
 worker.reply('started','walk_start');await started;
 const generation=worker.commands.at(-1).generation,reset=f.reset();await drain();
 assert.equal(worker.commands.at(-1).type,'walk_stop');
 worker.onmessage({data:{type:'walk_frame',generation,sequence:1,result:{label:'stale walk',time:.04,outputs:{}}}});
 assert.deepEqual(f.applied,['initial']);assert.equal(worker.commands.at(-1).type,'walk_ack');
 worker.reply('paused','walk_stop',.04);await drain();assert.equal(worker.commands.at(-1).type,'reset');
 worker.reply('reset','reset',0);await reset;
 worker.onmessage({data:{type:'walk_frame',generation,sequence:2,result:{label:'late walk',time:.06,outputs:{}}}});
 assert.deepEqual(f.applied,['initial','reset']);assert.equal(f.api.time(),0);
});
test('Stop and replacement discard a late reset success or failure without enabling controls',async()=>{
 for(const error of [false,true]){
  const f=await readyFixture(),old=f.workers[0],reset=f.reset();await drain();
  f.api.stopPhysics();const next=f.prepare();await drain();
  if(error)old.fail('reset','late reset failure');else old.reply('late reset','reset',0);
  await reset;assert.equal(f.workers[1].terminated,false);assert.equal(f.element('reset-simulation').disabled,true);
  f.workers[1].reply('replacement');await next;
  assert.deepEqual(f.applied,['initial','replacement']);assert.equal(f.api.ready(),true);
 }
});
test('already-resolved reset completion cannot apply after Stop and a replacement prepare',async()=>{
 const f=await readyFixture(),old=f.workers[0],reset=f.reset();await drain();
 old.reply('obsolete zero','reset',0);f.api.stopPhysics();const next=f.prepare();await drain();await reset;
 assert.deepEqual(f.applied,['initial']);assert.equal(f.element('step-simulation').disabled,true);
 f.workers[1].reply('new initial');await next;assert.deepEqual(f.applied,['initial','new initial']);
});
test('reset failure or nonzero returned time closes the worker and requires prepare',async()=>{
 for(const invalidTime of [false,true]){
  const f=await readyFixture(),worker=f.workers[0],reset=f.reset();await drain();
  if(invalidTime)worker.reply('wrong time','reset',.02);else worker.fail('reset','Prepare the simulation again.');
  await reset;assert.equal(worker.terminated,true);assert.equal(f.api.ready(),false);
  assert.equal(f.element('reset-simulation').disabled,true);assert.equal(f.element('prepare-simulation').disabled,false);
  assert.deepEqual(f.applied,['initial']);assert.match(f.element('simulation-status').textContent,/reset failed/);
 }
});
test('reset waits for walk-start ownership, blocks input updates and resumes with a fresh generation',async()=>{
 const f=await readyFixture(),worker=f.workers[0],started=f.api.startWalking([.3,0,0]);
 const oldGeneration=worker.commands.at(-1).generation,reset=f.reset();
 f.api.updateWalking([.3,0,.5]);assert.equal(worker.commands.at(-1).type,'walk_start');
 worker.reply('started','walk_start');await started;await drain();assert.equal(worker.commands.at(-1).type,'walk_stop');
 worker.reply('paused','walk_stop');await drain();worker.reply('reset','reset',0);await reset;
 const resumed=f.api.startWalking([0,0,0]),command=worker.commands.at(-1);
 assert(command.generation>oldGeneration);assert.equal(command.inputs,null);
 worker.reply('resumed','walk_start');await resumed;f.api.stopPhysics();
});
test('an old pause completion cannot apply its frame to a replacement worker',async()=>{
 const f=await readyFixture(),old=f.workers[0],started=f.api.startWalking([0,0,0]);
 old.reply('started','walk_start');await started;const paused=f.api.pauseWalking(),id=old.commands.at(-1).id;
 old.onmessage({data:{id,result:{frame:{label:'obsolete pause',time:.04,outputs:{}}}}});
 f.api.stopPhysics();const replacement=f.prepare();await drain();await paused;
 assert.deepEqual(f.applied,['initial']);assert.equal(f.element('step-simulation').disabled,true);
 f.workers[1].reply('replacement');await replacement;assert.deepEqual(f.applied,['initial','replacement']);
});
test('actual sensor callback drops old success/failure across reset and blocks new captures until ready',async()=>{
 for(const oldFails of [false,true]){
  const f=fixture(Promise.resolve(),{sensors:true}),prepared=f.prepare();await drain();f.workers[0].reply('initial');await prepared;
  const old=deferred(),next=deferred();let captures=0,resets=0;
  f.api.setPreview({capture:()=>++captures===1?old.promise:next.promise,reset(){resets++;},stats:{cameraFps:30,tofHz:15,renderer:'fake'}});
  f.element('sensor-rendering').checked=true;f.sensorTick(0);assert.equal(captures,1);
  const reset=f.reset();await drain();
  if(oldFails)old.reject(Error('obsolete capture'));else old.resolve({stamp:888});
  await drain();assert.equal(f.api.sensorFrame(),undefined);
  f.sensorTick(20);assert.equal(captures,1,'no sensor capture while reset owns the page');
  f.workers[0].reply('reset','reset',0);await reset;assert.equal(resets,2);
  f.sensorTick(40);assert.equal(captures,2,'old failure did not remove the current preview');
  const fresh={stamp:123,ranges:[],valid:[]};next.resolve(fresh);await drain();assert.equal(f.api.sensorFrame(),fresh);
  const step=f.step();assert.deepEqual(f.workers[0].commands.at(-1).inputs,[['cameraTimestamp',123]]);
  f.workers[0].reply('fresh step','step',.02);await step;
 }
});


test('Waddle In starts only after accepted prepare without a second click',async()=>{const f=fixture(),enter=f.api.enterSimulation();await drain();const w=f.workers[0];assert.deepEqual(w.commands.map(x=>x.type),['preload','prepare']);w.reply('ready');await drain();assert.equal(w.commands.at(-1).type,'walk_start');w.reply('walking','walk_start');await enter;assert.equal(f.api.ready(),true);});
test('the first preparation adopts the worker that preloads at page open; a later one starts a fresh worker',async()=>{const f=fixture();assert.equal(f.workers.length,1);assert.deepEqual(f.workers[0].commands.map(x=>x.type),['preload']);const first=f.prepare();await drain();assert.equal(f.workers.length,1);assert.equal(f.workers[0].commands.at(-1).type,'prepare');f.workers[0].reply('first');await first;f.api.stopPhysics();const second=f.prepare();await drain();assert.equal(f.workers.length,2);assert.deepEqual(f.workers[1].commands.map(x=>x.type),['prepare']);f.workers[1].reply('second');await second;});
test('preparation before the editor holds the selected file sends its original source',async()=>{const f=fixture(Promise.resolve(),{editorFile:null,editor:''});const prepare=f.prepare();await drain();assert.deepEqual(f.workers[0].commands.at(-1).sources,{'Microduck.mo':'model Microduck end Microduck;'});f.workers[0].reply('ready');await prepare;});
test('preparation sends the editor text once the editor holds the selected file',async()=>{const f=fixture(Promise.resolve(),{editor:'model Microduck Real x; end Microduck;'});const prepare=f.prepare();await drain();assert.equal(f.workers[0].commands.at(-1).sources['Microduck.mo'],'model Microduck Real x; end Microduck;');f.workers[0].reply('ready');await prepare;});
test('with editing disabled, preparation requires the FMU',async()=>{const f=fixture();const prepare=f.prepare();await drain();assert.equal(f.workers[0].commands.at(-1).requireFmu,true);f.workers[0].reply('ready');await prepare;});
test('a refused FMU shows a visible warning with its reason; a later ready simulation hides it',async()=>{const f=fixture();const first=f.prepare();await drain();f.workers[0].fail('prepare','Error: FMU required: the FMU index does not match its build');await first;const warning=f.element('simulation-warning');assert.equal(warning.hidden,false);assert.match(warning.textContent,/^Live simulation unavailable: FMU required: the FMU index does not match its build\./);assert.match(warning.textContent,/No in-browser compiler was started/);const second=f.prepare();await drain();f.workers.at(-1).reply('ready');await second;assert.equal(warning.hidden,true);});
test('Waddle In during existing prepare starts that worker after acceptance',async()=>{const f=fixture(),prepare=f.prepare();await drain();await f.api.enterSimulation();const w=f.workers[0];assert.equal(f.workers.length,1);w.reply('ready');await drain();assert.equal(w.commands.at(-1).type,'walk_start');w.reply('walking','walk_start');await prepare;});
test('failed Waddle In prepare never starts walking',async()=>{const f=fixture(),enter=f.api.enterSimulation();await drain();const rejected=assert.rejects(enter,/refused/);f.workers[0].fail('prepare','refused');await rejected;assert.equal(f.workers[0].commands.some(x=>x.type==='walk_start'),false);assert.equal(f.api.ready(),false);});
test('Stop cancels Waddle In before ready and manual replacement stays paused',async()=>{const f=fixture(),enter=f.api.enterSimulation();await drain();const old=f.workers[0];old.reply('old');f.api.stopPhysics();const replacement=f.prepare();await drain();const current=f.workers[1];current.reply('new');await Promise.all([enter,replacement]);assert.equal(old.commands.some(x=>x.type==='walk_start'),false);assert.equal(current.commands.some(x=>x.type==='walk_start'),false);assert.deepEqual(f.applied,['new']);});
test('Waddle In starts an already prepared session',async()=>{const f=await readyFixture(),enter=f.api.enterSimulation();await drain();const w=f.workers[0];assert.equal(w.commands.at(-1).type,'walk_start');w.reply('walking','walk_start');await enter;assert.equal(f.workers.length,1);});
test('Waddle In startup failure stops the owned worker honestly',async()=>{const f=fixture(),enter=f.api.enterSimulation();await drain();const w=f.workers[0];w.reply('ready');await drain();w.fail('walk_start','walk refused');await enter;assert.equal(w.terminated,true);assert.equal(f.api.ready(),false);assert.match(f.element('simulation-status').textContent,/walk refused/);});


test('Waddle In preserves an in-flight dynamics reset and leaves it paused',async()=>{const f=await readyFixture(),w=f.workers[0],reset=f.reset();await drain();await f.api.enterSimulation();assert.equal(f.workers.length,1);assert.equal(w.terminated,false);assert.equal(w.commands.at(-1).type,'reset');w.reply('reset','reset',0);await reset;assert.equal(w.commands.some(x=>x.type==='walk_start'),false);});
test('Waddle In waits for an accepted manual step without conflicting commands',async()=>{const f=await readyFixture(),w=f.workers[0],step=f.step(),enter=f.api.enterSimulation();await drain();assert.equal(w.commands.at(-1).type,'step');w.reply('stepped','step',.02);await step;await drain();assert.equal(w.commands.at(-1).type,'walk_start');w.reply('walking','walk_start',.02);await enter;assert.equal(w.terminated,false);});
test('Stop during Waddle In waiting on a manual step cannot start the replacement',async()=>{const f=await readyFixture(),w=f.workers[0],step=f.step(),enter=f.api.enterSimulation();w.reply('old step','step',.02);f.api.stopPhysics();const prepare=f.prepare();await drain();f.workers[1].reply('replacement');await Promise.all([step,enter,prepare]);assert.equal(f.workers[1].commands.some(x=>x.type==='walk_start'),false);assert.equal(w.commands.some(x=>x.type==='walk_start'),false);});
