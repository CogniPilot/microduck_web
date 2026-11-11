import test from 'node:test';
import assert from 'node:assert/strict';
import {createWalkRunner} from '../site/walk-runner.js';

function fixture(override) {
  let now=0,wall=0;
  const tasks=[],messages=[],commands=[],starts=[],delays=[];
  const runner=createWalkRunner({time:()=>now,clock:()=>wall,send:m=>messages.push(m),schedule:(t,delay=0)=>{const due=wall+delay;delays.push(delay);tasks.push(()=>{wall=Math.max(wall,due);return t();});},
    step:async command=>{
      commands.push(command);starts.push(wall);
      const frame=override?await override(command,commands.length):{time:command.time,outputs:{fallen:false}};
      now=frame.time;return frame;
    }});
  return {runner,tasks,messages,commands,starts,delays,wall:()=>wall,advanceWall:ms=>{wall+=ms;},tick:async()=>{assert(tasks.length);await tasks.shift()();}};
}
const start=(f,generation=1)=>f.runner.start({generation,twist:[0,0,0]});

test('physics advances without display acknowledgements and keeps only the latest unsent frame',async()=>{
  const f=fixture();start(f);
  for(let i=0;i<20;i++)await f.tick();
  assert.equal(f.commands.length,20);
  assert.equal(f.messages.length,1);
  assert.equal(f.messages[0].sequence,1);
  assert.equal(f.runner.acknowledge({generation:1,sequence:1}),true);
  assert.equal(f.messages.length,2);
  assert.equal(f.messages[1].sequence,20);
  assert.equal(f.runner.acknowledge({generation:1,sequence:1}),false);
  const stopped=await f.runner.stop({generation:1});
  assert.equal(stopped.frame.time,f.commands.at(-1).time);
  assert.equal(f.messages.at(-1).type,'walk_done');
  await f.tick();assert.equal(f.commands.length,20);
});

test('pause during an asynchronous step waits for that step and schedules no successor',async()=>{
  let release;
  const f=fixture(command=>new Promise(resolve=>{release=()=>resolve({time:command.time,outputs:{fallen:false}});}));
  start(f);const tick=f.tick();
  let settled=false;const pause=f.runner.stop({generation:1}).then(x=>{settled=true;return x;});
  assert.equal(settled,false);assert.equal(f.runner.isRunning(),true);
  assert.throws(()=>start(f,2),/already running/);
  release();await tick;const stopped=await pause;
  assert.equal(stopped.time,.02);assert.equal(f.commands.length,1);
  assert.equal(f.tasks.length,0);assert.equal(f.runner.isRunning(),false);
});

test('pause before dispatch and stale callbacks cannot advance a resumed generation',async()=>{
  const f=fixture();start(f);await f.runner.stop({generation:1});start(f,2);
  await f.tick();assert.equal(f.commands.length,0);
  await f.tick();assert.equal(f.commands.length,1);
  assert.equal(f.messages.at(-1).generation,2);
  assert.equal(f.runner.update({generation:1,sequence:100,twist:[1,0,0]}),false);
  assert.equal(f.runner.acknowledge({generation:1,sequence:1}),false);
  await assert.rejects(f.runner.stop({generation:1}),/Stale/);
  await f.runner.stop({generation:2});
});

test('inputs are copied, updated monotonically, and timestamped at the current physics time',async()=>{
  const f=fixture(),twist=[.3,0,0],inputs=[['cameraTimestamp',999],['lidarTimestamp',999],['lidarRange[1,1]',2]];
  f.runner.start({generation:1,twist,inputs});twist[0]=9;inputs[2][1]=9;
  await f.tick();assert.deepEqual(f.commands[0].twist,[.3,0,0]);
  assert.deepEqual(f.commands[0].inputs,[['cameraTimestamp',0],['lidarTimestamp',0],['lidarRange[1,1]',2]]);
  assert.equal(f.runner.update({generation:1,sequence:2,twist:[0,0,.5],inputs}),true);
  inputs[2][1]=10;
  assert.equal(f.runner.update({generation:1,sequence:1,twist:[1,0,0],inputs:null}),false);
  await f.tick();assert.deepEqual(f.commands[1].twist,[0,0,.5]);
  assert.equal(f.commands[1].inputs[0][1],.02);assert.equal(f.commands[1].inputs[2][1],9);
  f.runner.update({generation:1,sequence:3,twist:[0,0,0],inputs:null});
  await f.tick();assert.equal('inputs' in f.commands[2],false);
  await f.runner.stop({generation:1});
});

test('invalid input refuses without consuming a generation or replacing valid controls',async()=>{
  const f=fixture();
  for(const twist of [[NaN,0,0],[Infinity,0,0],[0,0],null])assert.throws(()=>f.runner.start({generation:1,twist}),/Invalid/);
  assert.equal(f.tasks.length,0);start(f);
  assert.throws(()=>f.runner.update({generation:1,sequence:1,twist:[1,0,0],inputs:[['x',Infinity]]}),/Invalid/);
  await f.tick();assert.deepEqual(f.commands[0].twist,[0,0,0]);
  await f.runner.stop({generation:1});assert.throws(()=>start(f),/Stale/);
});

test('a fall publishes its final state even when the page has not acknowledged an older frame',async()=>{
  const f=fixture((command,count)=>({time:command.time,outputs:{fallen:count===3}}));start(f);
  for(let i=0;i<3;i++)await f.tick();
  assert.equal(f.messages.filter(x=>x.type==='walk_frame').length,1);
  const done=f.messages.at(-1);assert.equal(done.type,'walk_done');
  assert.equal(done.reason,'fallen');assert.equal(done.frame.outputs.fallen,true);
  assert.equal(f.tasks.length,0);assert.equal(f.runner.isRunning(),false);
});

test('step failures stop the loop and reject a pending pause',async()=>{
  let rejectStep;
  const f=fixture(()=>new Promise((resolve,reject)=>{rejectStep=reject;}));start(f);
  const tick=f.tick(),pause=assert.rejects(f.runner.stop({generation:1}),/solver fault/);
  rejectStep(new Error('solver fault'));await tick;await pause;
  assert.equal(f.messages.at(-1).type,'walk_error');assert.equal(f.tasks.length,0);
  assert.equal(f.runner.isRunning(),false);
});

test('unexpected solver time fails closed before a frame is published',async()=>{
  const f=fixture(()=>({time:NaN,outputs:{fallen:false}}));start(f);await f.tick();
  assert.equal(f.messages.length,1);assert.equal(f.messages[0].type,'walk_error');
  assert.equal(f.runner.isRunning(),false);
});

test('realtime waits for the first20ms and never exceeds50policy steps per wall second',async()=>{
  const f=fixture();start(f);
  for(let i=0;i<50;i++)await f.tick();
  assert.equal(f.starts[0],20);assert.equal(f.starts[49],1000);
  await f.runner.stop({generation:1});
});

test('a stalled callback resets the cadence instead of issuing a catch-up burst',async()=>{
  const f=fixture();start(f);await f.tick();f.advanceWall(1000);await f.tick();await f.tick();
  assert.deepEqual(f.starts,[20,1020,1040]);
  await f.runner.stop({generation:1});
});

test('slow physics yields immediately to its next task without an extra20ms penalty',async()=>{
  const f=fixture(command=>{f.advanceWall(100);return {time:command.time,outputs:{fallen:false}};});start(f);
  for(let i=0;i<3;i++)await f.tick();
  assert.deepEqual(f.starts,[20,120,220]);assert.deepEqual(f.delays.slice(1),[0,0,0]);
  await f.runner.stop({generation:1});
});

test('explicit unpaced mode advances without a pacing delay and invalid modes refuse',async()=>{
  const f=fixture();assert.throws(()=>f.runner.start({generation:1,twist:[0,0,0],mode:'typo'}),/pacing mode/);
  assert.equal(f.runner.start({generation:1,twist:[0,0,0],mode:'unpaced'}).mode,'unpaced');
  for(let i=0;i<20;i++)await f.tick();
  assert(f.starts.every(x=>x===0));assert(f.delays.every(x=>x===0));
  await f.runner.stop({generation:1});
});

test('worker speed uses simulation progress over worker wall time independently of page ack',async()=>{const f=fixture();start(f);await f.tick();assert.equal(f.messages[0].speed.factor,1);f.advanceWall(60);await f.tick();assert.equal(f.commands.length,2);f.runner.acknowledge({generation:1,sequence:1});const speed=f.messages.at(-1).speed;assert.equal(speed.simulatedSeconds,.04);assert.equal(speed.wallSeconds,.08);assert.equal(speed.factor,.5);const stopped=await f.runner.stop({generation:1});assert.deepEqual(stopped.speed,speed);});
