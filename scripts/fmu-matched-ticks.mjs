// Same input law/cadence/timing shell as the accepted SDK/MuJoCo comparison.
// Executes the FULL wrapper with manual policy-position inputs, controller selector false.
// No model reduction, no fallback and no interpreter/JSPI shim. Requires an admitted real FMU offer.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import * as W from './matched-tick-workload.mjs';
import {loadFmuIndex,openFmuSession,checkPageInterface} from '../site/fmu-session.js';
import {pageBuildInputs} from './fmu-page-inputs.mjs';
import {canonicalJson,WHOLE_MODEL,LEGACY_MODEL,wholeModelOptions,PAGE_FIXED_VALUES} from '../site/fmu-page-contract.js';
import {modelOptions} from '../site/simulation-options.js';
import {createReadout,plantReadoutName} from '../site/session-readout.js';

export class TickRefusal extends Error {
 constructor(cause,completed,timing,simTimes){super(String(cause?.message??cause));this.completed=completed;
  this.timing=Object.fromEntries(Object.entries(timing).map(([k,v])=>[k,v.slice(0,completed)]));this.simTimes=simTimes.slice(0,completed);}
}

// Keep the original page/native integrator; only the external tick law is shared with SDK.
export function checkedSessionOptions(index){
 const options=wholeModelOptions(modelOptions(LEGACY_MODEL)),optionsSha256=W.sha256(canonicalJson(options));
 assert.equal(optionsSha256,index.pageBinding?.optionsSha256,'runtime options differ from admitted page options');
 assert.equal(optionsSha256,index.nativeAdmission?.optionsSha256,'runtime options differ from native admission');
 return{options,optionsSha256};
}

export function checkedExecutionReceipt(session,index){
 const execution=JSON.parse(session.execution_receipt_json());
 assert(execution&&typeof execution==='object'&&!Array.isArray(execution),'invalid FMU execution receipt');
 assert.equal(execution.engine,'fmi3-ls-wasm','session execution is not the FMU engine');
 assert.equal(execution.refusal,null,'FMU execution receipt carries a refusal');
 assert.equal(execution.model,WHOLE_MODEL,'session execution is not the full model');
 assert(typeof index.instantiationToken==='string'&&index.instantiationToken.length>0,'missing admitted token');
 assert.equal(execution.instantiation_token,index.instantiationToken,'session token differs from admitted artifact');
 return execution;
}

// Exact accepted SDK bound-readout work: validate extent and build the named object.
export function createBoundReadout(session,names){
 if(typeof session.bind_outputs!=='function'||typeof session.read_bound!=='function')throw Error('Bound session readout is unavailable.');
 const ordered=[...new Set(names)],binding=session.bind_outputs(JSON.stringify(ordered));
 return ()=>{
  const values=session.read_bound(binding);
  if(!(values instanceof Float64Array)||values.length!==ordered.length)throw Error('Invalid typed session readout.');
  return Object.fromEntries(ordered.map((name,i)=>[name,Number.isFinite(values[i])?values[i]:null]));
 };
}

export function runTicks(session,{ticks,warmup,readout='named',inputs='live',clock=()=>performance.now()}={}){
 assert(Number.isInteger(ticks)&&ticks>0&&ticks<=W.TICKS_MAX&&Number.isInteger(warmup)&&warmup>=0&&warmup<ticks,'invalid tick/warmup shape');
 assert(['named','values','bound','none'].includes(readout)&&['live','pre'].includes(inputs),'invalid readout/input mode');
 assert.equal(session.time(),0,'matched workload requires a zero-time fresh session');
 const names=JSON.parse(session.variable_names()).filter(plantReadoutName).sort();
 assert(names.length>0,'no plant readout');
 const jointNames=Array.from({length:15},(_,i)=>`jointPosition[${i+1}]`);
 const home=Array.from(session.read_values(JSON.stringify(jointNames)));
 assert(home.length===15&&home.every(Number.isFinite),'invalid 15-joint home pose');
 // Full wrapper keeps its controller, sensors and equations. This selector chooses the SAME externally commanded plant route as SDK.
 const frame=t=>JSON.stringify([['usePolicyController',0],['usePolicyPosition',1],...home.map((h,i)=>[`policyPosition[${i+1}]`,h+W.delta(t,i)])]);
 const request=JSON.stringify(names);let get;
 if(readout==='named')get=createReadout(session,names);
 else if(readout==='values')get=()=>session.read_values(request);
 else if(readout==='bound')get=createBoundReadout(session,names);
 else get=()=>undefined;
 const pre=inputs==='pre'?Array.from({length:ticks},(_,i)=>frame(W.TICK_SECONDS*(i+1))):null;
 const timing=Object.fromEntries(['total','inputs','advance','readout'].map(k=>[k,new Float64Array(ticks)])),simTimes=new Float64Array(ticks);
 let sink,completed=0;
 try{
  for(let k=0;k<ticks;k++){
   const t=W.TICK_SECONDS*(k+1),t0=clock();session.set_inputs(pre?pre[k]:frame(t));const t1=clock();
   session.advance_to(t);const t2=clock();sink=get();const t3=clock();
   timing.inputs[k]=t1-t0;timing.advance[k]=t2-t1;timing.readout[k]=t3-t2;timing.total[k]=t3-t0;
   simTimes[k]=session.time();completed=k+1;
  }
 }catch(error){throw new TickRefusal(error,completed,timing,simTimes);}
 let finalValues,finalJoints;
 try{finalValues=session.read_values(request);finalJoints=session.read_values(JSON.stringify(jointNames));}
 catch(error){throw new TickRefusal(error,completed,timing,simTimes);}
 const failures=[];
 for(const [name,values]of Object.entries(timing))if(!Array.from(values).every(v=>Number.isFinite(v)&&v>=0))failures.push('invalid elapsed series: '+name);
 if(!(finalValues instanceof Float64Array)||finalValues.length!==names.length||!W.allFinite(finalValues))failures.push('final selected public values are not finite/full length');
 if(!(finalJoints instanceof Float64Array)||finalJoints.length!==15||!W.allFinite(finalJoints))failures.push('final joints are not 15 finite values');
 const fallenAt=names.indexOf('fallen');
 return{timing,simTimes,failures,home,names,simTime:session.time(),finalChecksum:finalValues instanceof Float64Array?W.sha256(Buffer.from(finalValues.buffer,finalValues.byteOffset,finalValues.byteLength)):null,
  finalJoints:finalJoints instanceof Float64Array?Array.from(finalJoints):null,fallen:fallenAt<0||!(finalValues instanceof Float64Array)?null:finalValues[fallenAt],readoutSinkType:typeof sink};
}

export async function runFmuDriver(argv){
 const a=W.parseArgs(argv,{ticks:String(W.TICKS),warmup:String(W.WARMUP),readout:'named',inputs:'live'},['offer','site','out','raw','ticks','warmup','readout','inputs','manifest']);
 for(const k of ['offer','site','out','raw'])assert(a[k],`--${k} is required`);
 for(const p of [a.out,a.raw])assert(!fs.existsSync(p),'output already exists: '+p);
 const {ticks,warmup}=W.runShape(a),manifest=a.manifest?W.loadManifest(a.manifest):null;
 const observed={};const bytes=p=>{const b=fs.readFileSync(p);observed[path.resolve(p)]=W.sha256(b);if(manifest)W.verifyInputs(manifest,observed);return b;};
 const started=performance.now(),offerPath=path.resolve(a.offer),offer=JSON.parse(bytes(offerPath)),root=path.dirname(offerPath);
 assert(offer.schema===1&&offer.model===WHOLE_MODEL&&offer.nativeAdmission?.schema===1,'not a native-admitted full-robot offer');
 const entryName=path.basename(offer.fmu?.index??'');assert(entryName&&offer.fmu.index===path.basename(root)+'/'+entryName,'offer index does not name this output directory');
 const indexPath=path.join(root,entryName);
 const fetchFile=async url=>{
  const u=new URL(url);assert.equal(u.protocol,'file:','benchmark never fetches network inputs');
  const p=fileURLToPath(u);assert.equal(path.dirname(p),root,'artifact request is outside the offered directory');
  assert(fs.lstatSync(p).isFile()&&!fs.lstatSync(p).isSymbolicLink(),'artifact is not regular');
  return new Response(bytes(p),{headers:{'content-type':p.endsWith('.wasm')?'application/wasm':'text/javascript'}});
 };
 const index=await loadFmuIndex(pathToFileURL(indexPath),offer.fmu.sha256,{fetch:fetchFile});
 assert.equal(canonicalJson(index.nativeAdmission),canonicalJson(offer.nativeAdmission),'index/offer native admission differs');
 assert.equal(index.modelName,WHOLE_MODEL);assert.equal(checkPageInterface(index.variables),undefined,'FMU does not carry the complete page interface');
 const page=await pageBuildInputs(path.resolve(a.site));
 assert.equal(canonicalJson(index.pageBinding),canonicalJson(page.pageBinding),'page options/source contract differs');
 assert.equal(canonicalJson(index.sources),canonicalJson(page.sources),'actual page source bytes differ');
 const loadMs=performance.now()-started;
 bytes(fileURLToPath(import.meta.url));bytes(fileURLToPath(new URL('./matched-tick-workload.mjs',import.meta.url)));
 const openStarted=performance.now();let session;
 try{
  const {options,optionsSha256}=checkedSessionOptions(index);
  session=await openFmuSession({index,base:pathToFileURL(root+'/'),fetch:fetchFile,parameters:options.parameters,fixedValues:PAGE_FIXED_VALUES});
  let execution=checkedExecutionReceipt(session,index);
  const openMs=performance.now()-openStarted;
  const result=runTicks(session,{ticks,warmup,readout:a.readout,inputs:a.inputs});
  try{execution=checkedExecutionReceipt(session,index);}
  catch(error){throw new TickRefusal(error,ticks,result.timing,result.simTimes);}
  return W.finish({engine:'rumoca-fmi3-ls-wasm',scope:'Full compiled FMU draft, externally commanded plant workload; separate model/contact/step configuration from MuJoCo, no physical parity certificate',
   versions:{execution,nativeAdmission:index.nativeAdmission},
   sessionOptionsSha256:optionsSha256,sessionOptionsHashFormat:'sha256 of canonical JSON',
   stateValidation:'15 finite home joints and final selected public/joint values only; no trajectory-finiteness claim',
   inputFiles:Object.fromEntries(Object.entries(observed).map(([p,sha256])=>[p,{path:p,sha256}])),
   manifestVerified:manifest!==null,loadMs,openMs,
   workload:{tickSeconds:W.TICK_SECONDS,dt:options.dt,integratorStep:options.fixed_step.step,substepsPerTick:W.TICK_SECONDS/options.fixed_step.step,substepCountBasis:'configured ratio, not a measured solver counter',integrator:`${options.solver}, order ${options.fixed_step.order}; scheme ${options.fixed_step.scheme??'not specified in admitted options'}`,fixedStepOrder:options.fixed_step.order,fixedStepScheme:options.fixed_step.scheme??null,inputsMode:a.inputs,readout:a.readout,readoutValueCount:a.readout==='none'?0:result.names.length,servoInputs:15,additionalSelector:'usePolicyController=0; whole model retained'},
   inputsChecksum:{offsetsAll15:W.targetsChecksum(null,[...Array(15).keys()],ticks),offsetsSharedServos:W.targetsChecksum(null,W.B_FROM_A,ticks),appliedTargetsAll15:W.targetsChecksum(result.home,[...Array(15).keys()],ticks),appliedTargetsSharedServos:W.targetsChecksum(W.B_FROM_A.map(i=>result.home[i]),W.B_FROM_A,ticks)},
   home:result.home,simTime:result.simTime,finalChecksum:{what:'sha256 of selected public little-endian doubles',sha256:result.finalChecksum},finalJointPositions:result.finalJoints,fallen:result.fallen,readoutSinkType:result.readoutSinkType,
  },result.timing,result.simTimes,result.failures,ticks,warmup,a.raw,a.out);
 }catch(error){
  // A thrown tick never produces a zero-filled successful series or an inferred speed.
  if(error instanceof TickRefusal){
   const n=error.completed,raw=Buffer.alloc(n*5*8);let at=0;
   for(const block of [...Object.values(error.timing),error.simTimes])for(const v of block){raw.writeDoubleLE(v,at);at+=8;}
   fs.writeFileSync(a.raw,raw,{flag:'wx'});fs.writeFileSync(a.out,JSON.stringify({schema:'matched-tick-refusal/1',engine:'rumoca-fmi3-ls-wasm',accepted:false,reason:error.message,completedTicks:n,requestedTicks:ticks,rawLayout:'five blocks for completed prefix only',inputFiles:observed},null,2)+'\n',{flag:'wx'});
  }
  throw error;
 }finally{session?.free();}
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 try{process.exitCode=await runFmuDriver(process.argv.slice(2))?0:4;}catch(error){console.error('REFUSED: '+error.message);process.exitCode=1;}
}
