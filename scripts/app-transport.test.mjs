import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source=fs.readFileSync(process.env.MD_TRANSPORT_SOURCE??new URL('../site/app.js',import.meta.url),'utf8');
const prefix=source.split('async function playRecording(')[0].replace(/^import .*\n/gm,'')
 .replaceAll('import.meta.url',JSON.stringify('https://example.invalid/app.js'));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(ready=Promise.resolve()){
 const workers=[],elements=new Map(),applied=[];
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'model Microduck end Microduck;'});return elements.get(id);};
 const sandbox={URL,sourceFiles:['Microduck.mo'],selectedFile:'Microduck.mo',savedDraft:()=>null,
  originals:new Map([['Microduck.mo','model Microduck end Microduck;']]),microduckSourcesReady:ready,
  document:{getElementById:element},createWalkingControls:()=>({finish(){},command:()=>[0,0,0]}),
  setTimeout:()=>1,clearTimeout(){},showSensors(){},
  Worker:class{
   constructor(){this.terminated=false;this.commands=[];workers.push(this);}
   postMessage(message){this.commands.push(message);}
   terminate(){this.terminated=true;}
   reply(label,type='prepare',time=0){const command=this.commands.findLast(x=>x.type===type);assert(command);this.onmessage({data:{id:command.id,result:{label,time,outputs:{},preparation:{plant:'prebuilt',controller:'prebuilt'}}}});}
  }};
 // Keep the observer in this exact page realm, outside the source under test.
 const withApplied=new Function('applied',...Object.keys(sandbox),'globalThis',prefix+'\nrobotView={restore(){},apply(state){applied.push(state.label);}};return {stopPhysics,startWalking,ready:()=>physicsReady};');
 const api=withApplied(applied,...Object.values(sandbox),sandbox);
 return {workers,applied,element,api,prepare:()=>element('prepare-simulation').onclick(),step:()=>element('step-simulation').onclick(),setReady:p=>{sandbox.microduckSourcesReady=p;}};
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
