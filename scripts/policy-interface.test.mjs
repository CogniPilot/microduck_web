import fs from 'node:fs';import assert from 'node:assert/strict';
import init,* as compiler from '../site/vendor/rumoca-b2cb0f02-release/rumoca_bind_wasm.js';
import test from 'node:test';
test('native Walk observation and target fixtures match the Modelica interface',async()=>{
const site=new URL('../site',import.meta.url).pathname;

await init({module_or_path:fs.readFileSync(site+'/vendor/rumoca-b2cb0f02-release/rumoca_bind_wasm_bg.wasm')});
const source=fs.readFileSync(site+'/sources/MicroduckPolicyInterface.mo','utf8');
const session=compiler.WasmSimulationSession.withInteractiveConfiguration(source,'MicroduckPolicyInterface',JSON.stringify({dt:.002,solver:'rk-like',atol:1e-8,rtol:1e-6,execution_policy:'auto',initial_inputs:[],parameters:{}}));
const route=(name,a)=>a.map((x,i)=>[name+'['+(i+1)+']',x]);const joints=[0,1,2,3,4,5,6,7,8,10,11,12,13,14];const f32bits=x=>{const f=new Float32Array([x]);return new Uint32Array(f.buffer)[0]};
let previousTargets=null,previousCommand=[0,0,0],maxTargetDifference=0,assertions=0;
for(const line of fs.readFileSync(new URL('./fixtures/native-policy-reference.jsonl',import.meta.url),'utf8').trim().split('\n')){
const x=JSON.parse(line);
session.set_inputs(JSON.stringify([
...['forwardVelocity','lateralVelocity','steeringRate'].map((name,i)=>[name,x.requested[i]]),
...route('previousCommand',previousCommand),...route('previousPolicyAction',x.previous_raw.map(Math.fround)),
...route('jointPosition',x.positions),...route('jointVelocity',x.velocities),...route('policyHome',joints.map(j=>x.home[j])),
...route('trunkGyro',[.3,-.2,.1]),...route('gravityRow',[.2,-.3,.9327379053088815]),
...route('policyAction',x.raw.map(Math.fround)),['hasPreviousPositionCommand',previousTargets?1:0],...route('previousPositionCommand',previousTargets??Array(15).fill(0))]));
const v=JSON.parse(session.state_json()).values;
for(let i=0;i<61;i++){assert.equal(f32bits(v['policyObservation['+(i+1)+']']),x.observation_bits[i],`obs ${x.tick}/${i}`);assertions++;}
const targets=Array.from({length:15},(_,i)=>v['positionCommand['+(i+1)+']']);
for(let i=0;i<15;i++){let d=Math.abs(targets[i]-x.targets[i]);maxTargetDifference=Math.max(maxTargetDifference,d);assert(d<2e-15,`target ${x.tick}/${i}: ${d}`);assertions++;}
previousTargets=targets;previousCommand=Array.from({length:3},(_,i)=>v['filteredCommand['+(i+1)+']']);
}
session.free();const result={frames:32,assertions,observation_f32_bits:'all equal',maxTargetDifference,compiler:compiler.get_git_commit(),scope:'Actual Modelica adapter against actual native obs.rs and verbatim postprocessor loop in minimal wrapper. Includes large/asymmetric raw offsets, first and filtered ticks, command reversal, mouth skip and raw previous-action feedback.'};assert.equal(result.assertions,2432);

});