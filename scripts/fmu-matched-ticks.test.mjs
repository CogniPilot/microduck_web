// Deterministic session stand-ins only. These are not physics/timing measurements.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runTicks,TickRefusal} from './fmu-matched-ticks.mjs';
import * as W from './matched-tick-workload.mjs';
function fake({failAt=Infinity,stall=false,badFinal=false,start=0}={}){
 const names=[...Array.from({length:15},(_,i)=>`jointPosition[${i+1}]`),'score','fallen'];
 const home=Array.from({length:15},(_,i)=>i/10),frames=[];let time=start,step=0;const values=Object.fromEntries(names.map((n,i)=>[n,i<15?home[i]:0]));
 return{frames,home,time:()=>time,variable_names:()=>JSON.stringify(names),set_inputs(json){const rows=JSON.parse(json);frames.push(rows);for(const[n,v]of rows){const m=n.match(/^policyPosition\[(\d+)\]$/);if(m)values[`jointPosition[${m[1]}]`]=v;}},
 advance_to(t){step++;if(step===failAt)throw Error('intentional tick failure');if(!stall)time=t;},
 read_values(json){return Float64Array.from(JSON.parse(json),n=>badFinal&&step>0&&n==='score'?NaN:values[n]);},
 bind_outputs(json){return json;},read_bound(json){return this.read_values(json);}};
}
const opts=(extra={})=>{let t=0;return{ticks:3,warmup:1,clock:()=>t++,...extra};};
test('all15 targets and cadence use the accepted law; full wrapper selector is explicit',()=>{
 const s=fake(),r=runTicks(s,opts());assert.deepEqual([...r.simTimes],[.02,.04,.06]);assert.equal(r.failures.length,0);assert.deepEqual([...r.timing.total],[3,3,3]);
 s.frames.forEach((rows,k)=>{assert.deepEqual(rows.slice(0,2),[['usePolicyController',0],['usePolicyPosition',1]]);assert.equal(rows.length,17);for(let i=0;i<15;i++)assert.equal(rows[i+2][1],s.home[i]+W.delta(.02*(k+1),i));});
});
test('pre/live preparation and named/values/bound/none preserve requests and progress',()=>{
 let expected;
 for(const inputs of ['live','pre'])for(const readout of ['named','values','bound','none']){const s=fake(),r=runTicks(s,opts({inputs,readout}));assert.equal(r.failures.length,0);expected??=s.frames;assert.deepEqual(s.frames,expected);assert.equal(W.checkProgress(r.simTimes,3).completedTicks,3);}
});
test('failure retains only completed measured prefix; wrong start/home never begins a tick',()=>{
 assert.throws(()=>runTicks(fake({failAt:2}),opts()),e=>e instanceof TickRefusal&&e.completed===1&&e.simTimes.length===1&&Object.values(e.timing).every(v=>v.length===1));
 const s=fake({start:.1});assert.throws(()=>runTicks(s,opts()),/zero-time/);assert.equal(s.frames.length,0);
 const bad=fake();bad.read_values=()=>new Float64Array(14);assert.throws(()=>runTicks(bad,opts()),/15-joint/);assert.equal(bad.frames.length,0);
});
test('stalled progress and nonfinite final public values cannot qualify',()=>{
 const stopped=runTicks(fake({stall:true}),opts());assert.equal(W.checkProgress(stopped.simTimes,3).completedTicks,0);
 const invalid=runTicks(fake({badFinal:true}),opts());assert.match(invalid.failures.join(' '),/not finite/);
});

test('a failed final read preserves all completed timing rows; invalid clocks refuse qualification',()=>{
 const s=fake(),original=s.read_values.bind(s);let lastStepReads=0;s.read_values=json=>{if(s.frames.length===3&&JSON.parse(json).includes('score')&&++lastStepReads===2)throw Error('intentional final read failure');return original(json);};
 assert.throws(()=>runTicks(s,opts()),e=>e instanceof TickRefusal&&e.completed===3&&e.simTimes.length===3);
 const r=runTicks(fake(),opts({clock:()=>NaN}));assert.match(r.failures.join(' '),/invalid elapsed series/);
});
