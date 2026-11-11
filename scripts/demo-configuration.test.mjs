import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import init,* as compiler from '../site/model-runtime.js';
import {modelSourceSet} from '../site/prebuilt-session.js';
import {modelOptions} from '../site/simulation-options.js';
const site=new URL('../site/',import.meta.url);
test('demo overrides only the physical session and retains the interactive runner',()=>{
 const worker=fs.readFileSync(new URL('physics.worker.js',site),'utf8');
 const makeLine=worker.split('\n').find(line=>line.startsWith('  const make=name=>'));
 const configuration={dt:.002,rtol:1e-6,atol:1e-8,parameters:{},execution_policy:'auto'};
 const make=new Function('configuration','modelOptions','createModelSession','compiler','sources','manifest','readCompressedArtifact','URL',makeLine.replaceAll('import.meta.url',JSON.stringify('https://example.invalid/physics.worker.js'))+';return make;')(configuration,modelOptions,args=>args,{}, {}, {},()=>{},URL);
 assert.deepEqual(make('MicroduckPolicyInterface').options,modelOptions('MicroduckPolicyInterface'));
 const options=make('MicroduckJawLocked').options;
 assert.equal(options.rtol,1e-3);assert.equal(options.atol,1e-5);assert.equal(options.dt,.002);
 assert.equal(Object.keys(options.parameters).length,68);
 const expected={k:510,d:10.7,mu:1,v_eps:.09};
 for(const [name,value]of Object.entries(options.parameters))assert.equal(value,expected[name.split('.').at(-1)],name);
 assert(!worker.includes('diagnosticFrames'));assert(!worker.includes('diagnostic_trace'));
 assert.match(fs.readFileSync(new URL('app.js',site),'utf8'),/model: 'MicroduckJawLocked'/);
});
test('published prebuilt keys bind the exact selected model, companions and compiler',async()=>{
 await init({module_or_path:fs.readFileSync(compiler.WASM_URL)});
 const sources=JSON.parse(fs.readFileSync(new URL('msl-sources.json',site)));
 for(const name of JSON.parse(fs.readFileSync(new URL('sources/manifest.json',site))))sources[name]=fs.readFileSync(new URL('sources/'+name,site),'utf8');
 const manifest=JSON.parse(fs.readFileSync(new URL('prebuilt/manifest.json',site)));
 assert.deepEqual(Object.keys(manifest.models).sort(),['MicroduckJawLocked','MicroduckPolicyInterface']);
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 for(const [name,record]of Object.entries(manifest.models)){
  const set=modelSourceSet(sources,name);
  assert.equal(compiler.prebuilt_artifact_key(set.source,name,set.workspace),record.key,name);
  const compressed=fs.readFileSync(new URL('prebuilt/'+record.artifact,site)),bytes=gunzipSync(compressed);
  assert.equal(sha(compressed),record.sha256);assert.equal(sha(bytes),record.uncompressed_sha256);
  assert.equal(compressed.length,record.bytes);assert.equal(bytes.length,record.uncompressed_bytes);
  if(name==='MicroduckJawLocked'){
   assert.equal(record.format,'precompiled-runtime');
   assert.equal(compiler.precompiled_runtime_key(set.source,name,set.workspace,JSON.stringify(modelOptions(name))),record.runtime.key);
   const binary=fs.readFileSync(new URL('prebuilt/'+record.runtime.artifact,site)),raw=gunzipSync(binary);
   assert.equal(sha(binary),record.runtime.sha256);assert.equal(sha(raw),record.runtime.uncompressed_sha256);
   assert.equal(binary.length,record.runtime.bytes);assert.equal(raw.length,record.runtime.uncompressed_bytes);
  }else assert.equal(record.format,'prebuilt-dae');
 }
});
