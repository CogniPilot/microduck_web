// Modelica owns physics; the pretrained policy supplies actuator commands.
import {modelOptions} from './simulation-options.js';
import * as ort from './vendor/onnxruntime-1.31.1/ort.js';
import {poseFrame} from './policy-contract.js';
import {checkControllerInputs} from './model-inputs.js';
import {createWalkRunner} from './walk-runner.js';
import {residual as residualAction} from './ars.js';
import {runEpisode,TASKS,appliedAction} from './rollout.js';
import {offeredFmu,openFmuSession,checkPageInterface,preloadFmu} from './fmu-session.js';
import {currentPageSources,pageBinding,wholeModelOptions,LEGACY_MODEL,WHOLE_MODEL,PAGE_FIXED_VALUES} from './fmu-page-contract.js';
import {createReadout,plantReadoutName,telemetryPattern,observationNames,commandNames} from './session-readout.js';
ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths={mjs:new URL('./vendor/onnxruntime-1.31.1/ort-wasm-simd-threaded.js',import.meta.url).href,wasm:new URL('./vendor/onnxruntime-1.31.1/ort-wasm-simd-threaded.wasm',import.meta.url).href};
let session, controller, initialized, policy, lastValues, whole=false, sdk;
// The compiler and SDK sessions load only when the FMU is not used (edited sources or no
// offered FMU), so an FMU visit never fetches or initializes them.
const loadSdk=()=>sdk??=Promise.all([import('./model-runtime.js'),import('./prebuilt-session.js')])
 .then(([runtime,prebuilt])=>({init:runtime.default,compiler:runtime,...prebuilt}));
let plantReadout,observationReadout,commandReadout;
let previous=new Float32Array(14),previousCommand=new Float64Array(3),previousPosition;
// The last tick's policy observation and learned residual, read by training rollouts.
let lastObservation,lastResidual;
function checkedResidual(policy){
 if(!Array.isArray(policy?.weights)||policy.weights.length!==14*61||!Array.isArray(policy.mean)||policy.mean.length!==61||!Array.isArray(policy.std)||policy.std.length!==61||
  ![...policy.weights,...policy.mean,...policy.std].every(Number.isFinite)||!policy.std.every(value=>value>0))throw Error('Invalid trained residual policy.');
 return policy;
}

function routed(values,output,input,count){
 return Array.from({length:count},(_,i)=>[input+'['+(i+1)+']',values[output+'['+(i+1)+']']]);
}
function snapshot(initial){
 lastValues=initial?initial.values:plantReadout();
 const frame=poseFrame(lastValues,initial?initial.time:session.time(),telemetryPattern);
 return frame;
}
// Absolute time (ms since the epoch), comparable with the page's clock.
const epoch=()=>performance.timeOrigin+performance.now();
async function execute(message){
 if(message.type==='prepare'){
  const requestedModel=message.model??LEGACY_MODEL,marks={prepare_received:epoch()};
  let fmu;
  try { fmu=await offeredFmu({model:requestedModel, sources:message.sources,
   base:new URL('./prebuilt/',import.meta.url),
   sourceProvider:()=>currentPageSources(message.sources),
   expectedPageBinding:()=>pageBinding(modelOptions(LEGACY_MODEL)), interfaceCheck:checkPageInterface}); }
  catch(error){fmu={fallback:String(error?.message??error)};}
  marks.fmu_offered=epoch();
  if(fmu?.index){try{return await prepareFmu(fmu,requestedModel,{downloadFirst:message.requireFmu===true,marks});}catch(error){fmu={fallback:String(error?.message??error)};}}
  // FMU qualification: an absent, unusable or failed FMU refuses here, before any SDK code
  // initializes, so a later SDK session can never be credited as the FMU.
  if(message.requireFmu===true)throw Error('FMU required: '+(fmu?.fallback||'no FMU is offered for these sources'));
  const {init,compiler,createModelSession,readCompressedArtifact,readCompressedRuntimeArtifact}=await loadSdk();
  initialized??=init();await initialized;
  const standard=await(await fetch('./msl-sources.json')).json();
  const sources={...standard,...message.sources},model=message.model??'MicroduckJawLocked',source=sources[model+'.mo'];
  if(!source)throw Error('Missing model source: '+model);
  releaseSessions();previous=new Float32Array(14);previousCommand=new Float64Array(3);previousPosition=undefined;
  const started=performance.now(),response=await fetch('./prebuilt/manifest.json');
  if(!response.ok)throw Error('Precompiled model manifest is unavailable.');
  const manifest=await response.json();
  const make=name=>createModelSession({compiler,sources,model:name,options:modelOptions(name),manifest,readArtifact:name=>readCompressedArtifact(new URL('./prebuilt/'+name,import.meta.url)),readRuntimeArtifact:name=>readCompressedRuntimeArtifact(new URL('./prebuilt/'+name,import.meta.url))});
  const controlStart=performance.now(),control=await make('MicroduckPolicyInterface');controller=control.session;
  const plantStart=performance.now(),plant=await make(model);session=plant.session;
  const preparation={controller:control.mode,plant:plant.mode,controller_ms:plantStart-controlStart,plant_ms:performance.now()-plantStart,total_ms:performance.now()-started};if(fmu?.fallback)preparation.fmu_fallback=fmu.fallback;
  try{checkControllerInputs(JSON.parse(controller.input_names()));const initial=JSON.parse(session.state_json());plantReadout=createReadout(session,Object.keys(initial.values).filter(plantReadoutName));observationReadout=createReadout(controller,observationNames);commandReadout=createReadout(controller,commandNames);const frame=snapshot(initial);frame.preparation=preparation;frame.execution=JSON.parse(session.execution_receipt_json());return frame;}catch(error){releaseSessions();throw error;}
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
   ...(whole?[]:[
   ...routed(lastValues,'trunkGyro','trunkGyro',3),
   ...[1,2,3].map(i=>['gravityRow['+i+']',lastValues['bodyRotation[1,3,'+i+']']]),
   ...routed(lastValues,'jointPosition','jointPosition',15),
   ...routed(lastValues,'jointVelocity','jointVelocity',15),
   ...routed(lastValues,'policyJointHome','policyHome',14),
   ...routed(lastValues,'policyJointHalfRange','policyHalfRange',14)
   ])
  ]));
  const values=observationReadout();
  const obs=Float32Array.from({length:61},(_,i)=>values['policyObservation['+(i+1)+']']);
  if(!Array.from(obs).every(Number.isFinite))throw Error('Modelica policy observations are unavailable.');
  timing.observation_ms=mark()-phase;phase=mark();
  const result=await policy.run({obs:new ort.Tensor('float32',obs,[1,61])}),raw=result.actions.data;
  if(raw.length!==14||!Array.from(raw).every(Number.isFinite))throw Error('Invalid pretrained policy output.');
  // Training: a learned residual on the normalized observation is added to the pretrained action,
  // and the action actually applied is also the policy's next previous-action input.
  const extra=message.residual?residualAction(checkedResidual(message.residual).weights,message.residual,obs,14):null;
  const applied=appliedAction(raw,extra);
  if(!Array.from(applied).every(Number.isFinite))throw Error('Invalid trained policy output.');
  lastObservation=obs;lastResidual=extra;
  timing.policy_ms=mark()-phase;phase=mark();
  controller.set_inputs(JSON.stringify(Array.from(applied,(value,i)=>['policyAction['+(i+1)+']',value])));
  const mapped=commandReadout();
  session.set_inputs(JSON.stringify([...(message.inputs??[]),...(whole?[["usePolicyController",1],["usePolicyPosition",1]]:[['usePolicyPosition',1],...routed(mapped,'positionCommand','policyPosition',15)])]));
  timing.mapping_ms=mark()-phase;phase=mark();
  session.advance_to(message.time);timing.physics_ms=mark()-phase;phase=mark();previous=new Float32Array(applied);
  previousCommand=Float64Array.from({length:3},(_,i)=>mapped['filteredCommand['+(i+1)+']']);
  previousPosition=Float64Array.from({length:15},(_,i)=>mapped['positionCommand['+(i+1)+']']);
  control={policy:extra?'Pollen velstand + learned residual':'Pollen velstand',twist,clipped:mapped.clippedPolicyActions};
 }else if(message.type==='rollout'){
  // One training episode from reset, unpaced, on this worker's own plant.
  const task=TASKS[message.task];if(!task)throw Error('Unknown training task.');
  return runEpisode({task,residualPolicy:message.residual?checkedResidual(message.residual):null,
   reset:()=>execute({type:'reset'}),
   step:async({time,twist,residual})=>({frame:await execute({type:'policy_step',time,twist,residual}),observation:lastObservation,residual:lastResidual})});
 }else if(message.type==='step'){
  if(message.inputs)session.set_inputs(JSON.stringify(message.inputs));session.advance_to(message.time);
 }else if(message.type==='reset'){session.reset();if(controller!==session)controller.reset();previous=new Float32Array(14);previousCommand=new Float64Array(3);previousPosition=undefined;}
 else throw Error('Unknown simulation command.');
 const frame=snapshot();if(whole)frame.execution=JSON.parse(session.execution_receipt_json());timing.snapshot_ms=mark()-phase;if(control){frame.control=control;frame.timing_ms=timing;}return frame;
}
// One lifecycle owner even when plant/controller are aliases of the same FMU.
function releaseSessions(){
 const old=[...new Set([session,controller].filter(Boolean))];
 session=controller=undefined;whole=false;lastValues=undefined;
 plantReadout=observationReadout=commandReadout=undefined;
 let failure;
 for(const owned of old){try{owned.free();}catch(error){failure??=error;}}
 if(failure)throw failure;
}
async function prepareFmu({index,base},selectedModel,{downloadFirst=false,marks={}}={}){
 const started=performance.now();
 marks.session_start=epoch();
 const next=await openFmuSession({index,base,downloadFirst,onProgress:progress=>self.postMessage({type:'load_progress',...progress}),parameters:wholeModelOptions(modelOptions(selectedModel)).parameters,fixedValues:PAGE_FIXED_VALUES});
 let nextPlantReadout,nextObservationReadout,nextCommandReadout,initial,frame;
 try{
  const names=JSON.parse(next.variable_names()).filter(plantReadoutName);
  nextPlantReadout=createReadout(next,names);
  nextObservationReadout=createReadout(next,observationNames);
  nextCommandReadout=createReadout(next,commandNames);
  initial={time:next.time(),values:nextPlantReadout()};
  frame=poseFrame(initial.values,initial.time,telemetryPattern);
  frame.execution=JSON.parse(next.execution_receipt_json());
  frame.execution.worker_epoch_ms={...marks,frame_ready:epoch()};
  releaseSessions();
 }catch(error){next.free();throw error;}
 session=controller=next;whole=true;lastValues=initial.values;
 plantReadout=nextPlantReadout;observationReadout=nextObservationReadout;commandReadout=nextCommandReadout;
 previous=new Float32Array(14);previousCommand=new Float64Array(3);previousPosition=undefined;
 frame.preparation={controller:'fmu',plant:'fmu',selected_model:selectedModel,model:WHOLE_MODEL,
  standard_library_validation:'current-build source-pin comparison; producer owns actual library bytes',
  total_ms:performance.now()-started};
 return frame;
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
 // Outside the command queue: the offered FMU's files download and compile while the page
 // opens, and the prepare that follows reuses them. A failure is reported and prepare loads them.
 if(data.type==='preload'){preloadFmu({model:data.model??LEGACY_MODEL,base:new URL('./prebuilt/',import.meta.url)}).catch(error=>console.warn('FMU preload failed; preparation loads the FMU itself:',String(error?.message??error)));return;}
 if(data.type==='walk_stop'){walking.stop(data).then(reply,refuse);return;}
 enqueue(async()=>{
  if(data.type==='walk_start')return walking.start(data);
  if(walking.isRunning())throw Error('Pause walking before issuing another simulation command.');
  return execute(data);
 }).then(reply,refuse);
};
