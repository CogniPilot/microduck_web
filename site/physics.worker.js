// Modelica owns physics; the pretrained policy supplies actuator commands.
import init, * as compiler from './model-runtime.js';
import {createModelSession,readCompressedArtifact,readCompressedRuntimeArtifact} from './prebuilt-session.js';
import {modelOptions} from './simulation-options.js';
import * as ort from './vendor/onnxruntime-1.31.1/ort.js';
import {poseFrame} from './policy-contract.js';
import {checkControllerInputs} from './model-inputs.js';
import {createWalkRunner} from './walk-runner.js';
import {createReadout,plantReadoutName,telemetryPattern,observationNames,commandNames} from './session-readout.js';
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={mjs:new URL('./vendor/onnxruntime-1.31.1/ort-wasm-simd-threaded.js',import.meta.url).href,wasm:new URL('./vendor/onnxruntime-1.31.1/ort-wasm-simd-threaded.wasm',import.meta.url).href};
let session, controller, initialized, policy, lastValues;
let plantReadout,observationReadout,commandReadout;
let previous=new Float32Array(14),previousCommand=new Float64Array(3),previousPosition;

function routed(values,output,input,count){
 return Array.from({length:count},(_,i)=>[input+'['+(i+1)+']',values[output+'['+(i+1)+']']]);
}
function snapshot(initial){
 lastValues=initial?initial.values:plantReadout();
 const frame=poseFrame(lastValues,initial?initial.time:session.time(),telemetryPattern);
 return frame;
}
async function execute(message){
 if(message.type==='prepare'){
  initialized??=init();await initialized;
  const standard=await(await fetch('./msl-sources.json')).json();
  const sources={...standard,...message.sources},model=message.model??'MicroduckJawLocked',source=sources[model+'.mo'];
  if(!source)throw Error('Missing model source: '+model);
  session?.free();controller?.free();session=undefined;controller=undefined;lastValues=undefined;plantReadout=undefined;observationReadout=undefined;commandReadout=undefined;previous=new Float32Array(14);previousCommand=new Float64Array(3);previousPosition=undefined;
  const started=performance.now(),response=await fetch('./prebuilt/manifest.json');
  if(!response.ok)throw Error('Precompiled model manifest is unavailable.');
  const manifest=await response.json();
  const make=name=>createModelSession({compiler,sources,model:name,options:modelOptions(name),manifest,readArtifact:name=>readCompressedArtifact(new URL('./prebuilt/'+name,import.meta.url)),readRuntimeArtifact:name=>readCompressedRuntimeArtifact(new URL('./prebuilt/'+name,import.meta.url))});
  const controlStart=performance.now(),control=await make('MicroduckPolicyInterface');controller=control.session;
  const plantStart=performance.now(),plant=await make(model);session=plant.session;
  const preparation={controller:control.mode,plant:plant.mode,controller_ms:plantStart-controlStart,plant_ms:performance.now()-plantStart,total_ms:performance.now()-started};
  try{checkControllerInputs(JSON.parse(controller.input_names()));const initial=JSON.parse(session.state_json());plantReadout=createReadout(session,Object.keys(initial.values).filter(plantReadoutName));observationReadout=createReadout(controller,observationNames);commandReadout=createReadout(controller,commandNames);const frame=snapshot(initial);frame.preparation=preparation;frame.execution=JSON.parse(session.execution_receipt_json());return frame;}catch(error){session.free();controller.free();session=undefined;controller=undefined;plantReadout=undefined;observationReadout=undefined;commandReadout=undefined;throw error;}
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
  const values=observationReadout();
  const obs=Float32Array.from({length:61},(_,i)=>values['policyObservation['+(i+1)+']']);
  if(!Array.from(obs).every(Number.isFinite))throw Error('Modelica policy observations are unavailable.');
  timing.observation_ms=mark()-phase;phase=mark();
  const result=await policy.run({obs:new ort.Tensor('float32',obs,[1,61])}),raw=result.actions.data;
  if(raw.length!==14||!Array.from(raw).every(Number.isFinite))throw Error('Invalid pretrained policy output.');
  timing.policy_ms=mark()-phase;phase=mark();
  controller.set_inputs(JSON.stringify(Array.from(raw,(value,i)=>['policyAction['+(i+1)+']',value])));
  const mapped=commandReadout();
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
const tasks=[],taskChannel=new MessageChannel();
taskChannel.port1.onmessage=()=>tasks.shift()?.();
const enqueue=task=>{const result=queue.then(task);queue=result.catch(()=>{});return result;};
const walking=createWalkRunner({
 step:command=>enqueue(()=>execute(command)),time:()=>session?.time()??NaN,
 send:message=>self.postMessage(message),
 schedule:(task,delay)=>{const dispatch=()=>{tasks.push(task);taskChannel.port2.postMessage(null);};if(delay>0)setTimeout(dispatch,delay);else dispatch();}
});
self.onmessage=({data})=>{
 const reply=result=>self.postMessage({id:data.id,result});
 const refuse=error=>self.postMessage({id:data.id,error:String(error)});
 if(data.type==='walk_input'){
  try{walking.update(data);}catch(error){walking.stop(data).catch(()=>{});self.postMessage({type:'walk_error',generation:data.generation,error:String(error)});}return;
 }
 if(data.type==='walk_ack'){walking.acknowledge(data);return;}
 if(data.type==='walk_stop'){walking.stop(data).then(reply,refuse);return;}
 enqueue(async()=>{
  if(data.type==='walk_start')return walking.start(data);
  if(walking.isRunning())throw Error('Pause walking before issuing another simulation command.');
  return execute(data);
 }).then(reply,refuse);
};
