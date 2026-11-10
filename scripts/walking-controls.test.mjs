import test from 'node:test';
import assert from 'node:assert/strict';
import {createWalkingControls} from '../site/walking-controls.js';

function fixture(t,options={}) {
 const saved={window:globalThis.window,document:globalThis.document};
 const listeners=new Map(),documentListeners=new Map();
 globalThis.window={addEventListener:(name,callback)=>listeners.set(name,callback)};
 globalThis.document={querySelectorAll:()=>[],addEventListener:(name,callback)=>documentListeners.set(name,callback)};
 t.after(()=>{for(const [name,value]of Object.entries(saved)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}});
 const button={disabled:false,textContent:''},status={textContent:''},started=[],updates=[],running=[],errors=[];
 const controls=createWalkingControls({button,status,canRun:()=>true,start:async twist=>started.push(twist),pause:async()=>{},update:twist=>updates.push(twist),setRunning:x=>running.push(x),onError:e=>errors.push(e),...options});
 const key=(code,type='keydown',target)=>listeners.get(type)({code,target,preventDefault(){}});
 return {button,status,controls,started,updates,running,errors,key,listeners};
}

test('keyboard input updates an active worker walk without requesting page-driven steps',async t=>{
 const f=fixture(t);f.key('KeyW');assert.equal(f.updates.length,0);
 await f.button.onclick();assert.equal(f.controls.isRunning(),true);assert.deepEqual(f.started,[[0,0,0]]);
 f.key('KeyW');f.key('KeyA');assert.deepEqual(f.updates.at(-1),[.3,0,.5]);
 f.key('KeyW','keyup');assert.deepEqual(f.updates.at(-1),[0,0,.5]);
 f.listeners.get('blur')();assert.deepEqual(f.updates.at(-1),[0,0,0]);
});

test('pause keeps the controls disabled until the worker acknowledges the final state',async t=>{
 let release;
 const f=fixture(t,{pause:()=>new Promise(resolve=>{release=resolve;})});await f.button.onclick();
 const paused=f.button.onclick();assert.equal(f.button.disabled,true);assert.equal(f.controls.isRunning(),false);
 assert.equal(f.running.at(-1),true);release();await paused;
 assert.equal(f.button.disabled,false);assert.equal(f.running.at(-1),false);
});

test('preparation completes before starting and failure does not leave walking active',async t=>{
 let ready=false;
 const f=fixture(t,{canRun:()=>ready,ensureReady:async()=>{ready=true;}});await f.button.onclick();
 assert.equal(f.started.length,1);f.controls.finish('fallen');assert.match(f.status.textContent,/Robot fell/);
});

test('editing keys do not drive, and a startup failure restores controls',async t=>{
 const f=fixture(t,{start:async()=>{throw Error('prepare failed');}});await f.button.onclick();
 assert.equal(f.controls.isRunning(),false);assert.equal(f.button.disabled,false);assert.equal(f.errors.length,1);
 f.key('KeyW','keydown',{closest:()=>true});assert.deepEqual(f.controls.command(),[0,0,0]);
});

test('canceled auto-prepare success cannot start a replacement action',async t=>{
 let release,first=true;
 const f=fixture(t,{ensureReady:()=>first?(first=false,new Promise(resolve=>{release=resolve;})):Promise.resolve()});
 const old=f.button.onclick();f.controls.finish();await f.button.onclick();release();await old;
 assert.equal(f.started.length,1);assert.equal(f.controls.isRunning(),true);assert.equal(f.errors.length,0);
});

test('canceled auto-prepare failure cannot stop a replacement action',async t=>{
 let reject,first=true;
 const f=fixture(t,{ensureReady:()=>first?(first=false,new Promise((resolve,no)=>{reject=no;})):Promise.resolve()});
 const old=f.button.onclick();f.controls.finish();await f.button.onclick();reject(Error('old failure'));await old;
 assert.equal(f.started.length,1);assert.equal(f.controls.isRunning(),true);assert.equal(f.errors.length,0);
});

test('late pause rejection cannot finish a replacement walking action',async t=>{
 let reject;
 const f=fixture(t,{pause:()=>new Promise((resolve,no)=>{reject=no;})});await f.button.onclick();
 const old=f.button.onclick();f.controls.finish();await f.button.onclick();reject(Error('old pause'));await old;
 assert.equal(f.controls.isRunning(),true);assert.equal(f.started.length,2);assert.equal(f.errors.length,0);
});
