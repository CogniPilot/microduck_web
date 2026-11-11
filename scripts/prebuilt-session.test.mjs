import test from 'node:test';import assert from 'node:assert/strict';import {gzipSync} from 'node:zlib';
import {modelSourceSet,createModelSession,readCompressedArtifact,readCompressedRuntimeArtifact} from '../site/prebuilt-session.js';
const key={version:1,compiler_version:'0.10.4',compiler_identity:'8583646acddb',model_name:'Root',source_sha256:'a'.repeat(64),sources_sha256:'b'.repeat(64)};
function fixture(change={}){
 const calls=[],expected={...key,...change},opaque=JSON.stringify({payload_json:'{"id":18446744073709551615}',text:'🦆'});
 const compiler={prebuilt_artifact_key:(...args)=>{calls.push(['key',...args]);return JSON.stringify(expected);},export_prebuilt_artifact:(...args)=>{calls.push(['compile',...args]);return opaque;},WasmSimulationSession:{fromPrebuiltArtifact:(...args)=>{calls.push(['factory',...args]);return {ready:true};}}};
 const args={compiler,sources:{'Root.mo':'model Root end Root;','Modelica/package.mo':'package Modelica end Modelica;','Other.mo':'model Other end Other;'},model:'Root',options:{dt:.002},manifest:{version:1,models:{Root:{format:'prebuilt-dae',key:JSON.stringify(key),artifact:'Root.json.gz'}}},readArtifact:async name=>{calls.push(['read',name]);return opaque;}};
 return{calls,args,opaque};
}
test('source set preserves all explicit companions and excludes only the primary',()=>{const{args}=fixture(),before=JSON.stringify(args.sources),set=modelSourceSet(args.sources,'Root');assert.equal(set.source,args.sources['Root.mo']);assert.deepEqual(JSON.parse(set.workspace),{'Modelica/package.mo':args.sources['Modelica/package.mo'],'Other.mo':args.sources['Other.mo']});assert.equal(JSON.stringify(args.sources),before);assert.throws(()=>modelSourceSet({},'Missing'),/Missing Modelica source/);});
test('unchanged source loads the opaque artifact without compiling',async()=>{const{calls,args,opaque}=fixture();const result=await createModelSession(args);assert.equal(result.mode,'prebuilt');assert.deepEqual(calls.map(x=>x[0]),['key','read','factory']);assert.equal(calls[2][1],opaque);assert.equal(calls[2][2],args.sources['Root.mo']);assert.equal(calls[2][5],JSON.stringify(args.options));});
for(const name of ['source_sha256','sources_sha256'])test('changed '+name+' explicitly compiles then loads',async()=>{const{calls,args,opaque}=fixture({[name]:'c'.repeat(64)});const result=await createModelSession(args);assert.equal(result.mode,'source');assert.deepEqual(calls.map(x=>x[0]),['key','compile','factory']);assert.equal(calls[2][1],opaque);});
for(const name of ['compiler_identity','compiler_version','model_name','version'])test('mismatched '+name+' refuses without source compilation',async()=>{const{calls,args}=fixture({[name]:name==='version'?2:'different'});await assert.rejects(createModelSession(args),/model\/compiler mismatch/);assert.deepEqual(calls.map(x=>x[0]),['key']);});
test('invalid metadata refuses instead of compiling the unchanged default',async()=>{for(const entry of [{key:'bad',artifact:'Root.json.gz'},{key:JSON.stringify({...key,source_sha256:'bad'}),artifact:'Root.json.gz'},{key:JSON.stringify({...key,extra:true}),artifact:'Root.json.gz'}]){const{calls,args}=fixture();args.manifest.models.Root={format:'prebuilt-dae',...entry};await assert.rejects(createModelSession(args),/Invalid precompiled/);assert.deepEqual(calls.map(x=>x[0]),['key']);}});
test('missing artifact and rejected payload never trigger compilation fallback',async()=>{for(const kind of ['download','payload']){const{calls,args}=fixture();if(kind==='download')args.readArtifact=async()=>{throw Error('download refused');};else args.compiler.WasmSimulationSession.fromPrebuiltArtifact=()=>{throw Error('payload refused');};await assert.rejects(createModelSession(args),/refused/);assert(!calls.some(x=>x[0]==='compile'));}});
test('gzip transport retains opaque text including u64 digits exactly',async()=>{const text=JSON.stringify({payload_json:'{"id":18446744073709551615}',text:'🦆'});const url='data:application/gzip;base64,'+gzipSync(text).toString('base64');assert.equal(await readCompressedArtifact(url),text);});

function runtimeFixture(change={}){
 const f=fixture(change),bytes=Uint8Array.from([0,255,128,42]);
 const runtimeKey=(source,model,workspace,options)=>JSON.stringify({source,model,workspace,options:JSON.parse(options)});
 f.args.manifest.models.Root.format='precompiled-runtime';
 const set=modelSourceSet(f.args.sources,'Root');
 f.args.manifest.models.Root.runtime={key:runtimeKey(set.source,'Root',set.workspace,JSON.stringify(f.args.options)),artifact:'Root.runtime.bin.gz'};
 f.args.compiler.precompiled_runtime_key=(...a)=>{f.calls.push(['runtime-key',...a]);return runtimeKey(...a);};
 f.args.compiler.WasmSimulationSession.fromPrecompiledRuntimeArtifact=(...a)=>{f.calls.push(['runtime-factory',...a]);return {ready:true};};
 f.args.readRuntimeArtifact=async name=>{f.calls.push(['runtime-read',name]);return bytes;};
 return {...f,bytes};
}
test('runtime default loads binary bytes with exact source and options and no DAE factory',async()=>{
 const {args,calls,bytes}=runtimeFixture();const result=await createModelSession(args);
 assert.equal(result.mode,'precompiled-runtime');assert.deepEqual(calls.map(c=>c[0]),['key','runtime-key','runtime-read','runtime-factory']);
 const factory=calls.at(-1);assert.equal(factory[1],bytes);assert.equal(factory[5],JSON.stringify(args.options));
});
test('changed runtime options refuse before download with no slower compilation fallback',async()=>{
 const {args,calls}=runtimeFixture();args.options.dt=.001;
 await assert.rejects(createModelSession(args),/source\/compiler\/options mismatch/);
 assert.deepEqual(calls.map(c=>c[0]),['key','runtime-key']);
});
test('missing or damaged runtime never falls back to the DAE path',async()=>{
 for(const fault of ['missing','download','payload','text']){
  const {args,calls}=runtimeFixture();
  if(fault==='missing')delete args.manifest.models.Root.runtime;
  if(fault==='download')args.readRuntimeArtifact=async()=>{throw Error('runtime download refused');};
  if(fault==='payload')args.compiler.WasmSimulationSession.fromPrecompiledRuntimeArtifact=()=>{throw Error('runtime payload refused');};
  if(fault==='text')args.readRuntimeArtifact=async()=> 'not binary';
  await assert.rejects(createModelSession(args),/Missing precompiled runtime|refused|Invalid precompiled runtime transport/);
  assert(!calls.some(c=>['compile','read','factory'].includes(c[0])));
 }
});
test('edited sources explicitly compile without reading the published runtime',async()=>{
 const {args,calls}=runtimeFixture({source_sha256:'c'.repeat(64)});
 const result=await createModelSession(args);assert.equal(result.mode,'source');
 assert.deepEqual(calls.map(c=>c[0]),['key','compile','factory']);
});
test('missing or unknown published format refuses instead of downgrading preparation',async()=>{
 for(const format of [undefined,'other']){const {args}=fixture();args.manifest.models.Root.format=format;await assert.rejects(createModelSession(args),/Invalid precompiled model format/);}
});
test('binary gzip transport preserves all bytes without text decoding',async()=>{
 const bytes=Uint8Array.from([0,128,255,195,40,0,17]),url='data:application/gzip;base64,'+gzipSync(bytes).toString('base64');
 assert.deepEqual(await readCompressedRuntimeArtifact(url),bytes);
});
