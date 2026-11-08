// Modelica owns physics; the pretrained policy supplies actuator commands.
import init, * as compiler from './vendor/rumoca-b2cb0f02-release/rumoca_bind_wasm.js';
import * as ort from './vendor/onnxruntime-1.31.1/ort.js';
import {poseFrame} from './policy-contract.js';
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={mjs:new URL('./vendor/onnxruntime-1.31.1/ort-wasm-simd-threaded.js',import.meta.url).href,wasm:new URL('./vendor/onnxruntime-1.31.1/ort-wasm-simd-threaded.wasm',import.meta.url).href};
let session, controller, initialized, policy, lastValues;
let previous=new Float32Array(14),previousCommand=new Float64Array(3),previousPosition;
const configuration={dt:0.002,solver:'rk-like',atol:1e-8,rtol:1e-6,
 initial_inputs:[],execution_policy:'auto',parameters:{}};
function routed(values,output,input,count){
 return Array.from({length:count},(_,i)=>[input+'['+(i+1)+']',values[output+'['+(i+1)+']']]);
}
function snapshot(){
 const state=JSON.parse(session.state_json());lastValues=state.values;
 const frame=poseFrame(state.values,state.time,/^(cameraTimestamp$|lidarRange\[|lidarValid\[|lidarTimestamp$|imageCentroid\[|imageTargetVisible$|nearestObstacle$|trunkGyro\[|trunkAcceleration\[|headGyro\[|headAcceleration\[|jointPosition\[|jointVelocity\[|commandedPosition\[|motorTorque\[|estimatedCurrent\[|estimatedTemperature\[|stateOfCharge$|score$|fallen$)/);
 return frame;
}
async function execute(message){
 if(message.type==='prepare'){
  initialized??=init();await initialized;
  const standard=await(await fetch('./msl-sources.json')).json();
  const sources={...standard,...message.sources},model=message.model??'Microduck',source=sources[model+'.mo'];
  if(!source)throw Error('Missing model source: '+model);delete sources[model+'.mo'];
  const controllerSource=sources['MicroduckPolicyInterface.mo'];delete sources['MicroduckPolicyInterface.mo'];
  const loaded=JSON.parse(compiler.sync_workspace_sources(JSON.stringify(sources)));
  if(loaded.error_count)throw Error('Could not load Modelica sources: '+loaded.skipped_files.join(', '));
  session?.free();controller?.free();session=undefined;controller=undefined;lastValues=undefined;previous=new Float32Array(14);previousCommand=new Float64Array(3);previousPosition=undefined;
  // Same configuration surface as slam_web: Rumoca owns solver and live inputs.
  controller=compiler.WasmSimulationSession.withInteractiveConfiguration(
   controllerSource,'MicroduckPolicyInterface',JSON.stringify(configuration));
  session=compiler.WasmSimulationSession.withInteractiveConfiguration(source,model,JSON.stringify(configuration));
  try{const frame=snapshot();frame.execution=JSON.parse(session.execution_receipt_json());return frame;}catch(error){session.free();session=undefined;throw error;}
 }
 if(!session)throw Error('Prepare the Modelica simulation first.');
 let control;
 const timing={},mark=()=>performance.now();let phase=mark();
 if(message.type==='policy_step'){
  policy??=await ort.InferenceSession.create('./policies/velstand.onnx',{executionProviders:['wasm']});
  if(JSON.stringify(policy.inputMetadata[0].shape)!=='[1,61]'||JSON.stringify(policy.outputMetadata[0].shape)!=='[1,14]')throw Error('Policy dimensions do not match.');
  const twist=message.twist??[0,0,0];
  if(twist.length!==3||!twist.every(Number.isFinite))throw Error('Invalid velocity/steering command.');
  controller.set_inputs(JSON.stringify([
   ...['forwardVelocity','lateralVelocity','steeringRate'].map((name,i)=>[name,twist[i]]),
   ...Array.from(previous,(value,i)=>['previousPolicyAction['+(i+1)+']',value]),
   ...Array.from(previousCommand,(value,i)=>['previousCommand['+(i+1)+']',value]),
   ['hasPreviousPositionCommand',previousPosition?1:0],
   ...Array.from(previousPosition??new Float64Array(15),(value,i)=>['previousPositionCommand['+(i+1)+']',value]),
   ...routed(lastValues,'trunkGyro','trunkGyro',3),
   ...[1,2,3].map(i=>['gravityRow['+i+']',lastValues['bodyRotation[1,3,'+i+']']]),
   ...routed(lastValues,'jointPosition','jointPosition',15),
   ...routed(lastValues,'jointVelocity','jointVelocity',15),
   ...routed(lastValues,'policyJointHome','policyHome',14),
   ...routed(lastValues,'policyJointHalfRange','policyHalfRange',14)
  ]));
  const values=JSON.parse(controller.state_json()).values;
  const obs=Float32Array.from({length:61},(_,i)=>values['policyObservation['+(i+1)+']']);
  if(!Array.from(obs).every(Number.isFinite))throw Error('Modelica policy observations are unavailable.');
  timing.observation_ms=mark()-phase;phase=mark();
  const result=await policy.run({obs:new ort.Tensor('float32',obs,[1,61])}),raw=result.actions.data;
  if(raw.length!==14||!Array.from(raw).every(Number.isFinite))throw Error('Invalid pretrained policy output.');
  timing.policy_ms=mark()-phase;phase=mark();
  controller.set_inputs(JSON.stringify(Array.from(raw,(value,i)=>['policyAction['+(i+1)+']',value])));
  const mapped=JSON.parse(controller.state_json()).values;
  session.set_inputs(JSON.stringify([...(message.inputs??[]),['usePolicyPosition',1],...routed(mapped,'positionCommand','policyPosition',15)]));
  timing.mapping_ms=mark()-phase;phase=mark();
  session.advance_to(message.time);timing.physics_ms=mark()-phase;phase=mark();previous=new Float32Array(raw);
  previousCommand=Float64Array.from({length:3},(_,i)=>mapped['filteredCommand['+(i+1)+']']);
  previousPosition=Float64Array.from({length:15},(_,i)=>mapped['positionCommand['+(i+1)+']']);
  control={policy:'Pollen velstand',twist,clipped:mapped.clippedPolicyActions};
 }else if(message.type==='step'){
  if(message.inputs)session.set_inputs(JSON.stringify(message.inputs));session.advance_to(message.time);
 }else if(message.type==='reset'){session.reset();controller.reset();previous=new Float32Array(14);previousCommand=new Float64Array(3);previousPosition=undefined;}
 else throw Error('Unknown simulation command.');
 const frame=snapshot();timing.snapshot_ms=mark()-phase;if(control){frame.control=control;frame.timing_ms=timing;}return frame;
}
let queue=Promise.resolve();
self.onmessage=({data})=>{queue=queue.then(async()=>{try{self.postMessage({id:data.id,result:await execute(data)});}catch(error){self.postMessage({id:data.id,error:String(error)});}});};
