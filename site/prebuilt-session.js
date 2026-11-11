// Keys and opaque artifact validation belong to Rust. This module only routes.
export function modelSourceSet(sources,model){
 const file=model+'.mo',source=sources[file];
 if(typeof source!=='string')throw Error('Missing Modelica source: '+file);
 return {source,model,workspace:JSON.stringify(Object.fromEntries(Object.entries(sources).filter(([name])=>name!==file)))};
}
function metadata(key){
 let value;try{value=JSON.parse(key);}catch{throw Error('Invalid precompiled model key.');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid precompiled model key.');
 return value;
}
export async function createModelSession({compiler,sources,model,options,manifest,readArtifact,readRuntimeArtifact}){
 if(manifest?.version!==1)throw Error('Unsupported precompiled model manifest.');
 const entry=manifest.models?.[model];
 if(typeof entry?.key!=='string'||typeof entry?.artifact!=='string')throw Error('Missing precompiled model: '+model);
 if(!['prebuilt-dae','precompiled-runtime'].includes(entry.format))throw Error('Invalid precompiled model format: '+model);
 const set=modelSourceSet(sources,model);
 const expectedKey=compiler.prebuilt_artifact_key(set.source,model,set.workspace);
 const expected=metadata(expectedKey),stored=metadata(entry.key);
 const names=Object.keys(expected).sort();
 if(JSON.stringify(Object.keys(stored).sort())!==JSON.stringify(names))throw Error('Invalid precompiled model key fields.');
 for(const name of names.filter(n=>n!=='source_sha256'&&n!=='sources_sha256'))
  if(stored[name]!==expected[name])throw Error('Precompiled model/compiler mismatch: '+model);
 for(const name of ['source_sha256','sources_sha256'])
  if(typeof stored[name]!=='string'||!/^[0-9a-f]{64}$/.test(stored[name]))throw Error('Invalid precompiled source hash.');
 const unchanged=stored.source_sha256===expected.source_sha256&&stored.sources_sha256===expected.sources_sha256;
 const optionsJson=JSON.stringify(options);
 if(unchanged&&entry.format==='precompiled-runtime'){
  const runtime=entry.runtime;
  if(typeof runtime?.key!=='string'||typeof runtime?.artifact!=='string')throw Error('Missing precompiled runtime: '+model);
  const key=compiler.precompiled_runtime_key(set.source,model,set.workspace,optionsJson);
  if(runtime.key!==key)throw Error('Precompiled runtime source/compiler/options mismatch: '+model);
  const bytes=await readRuntimeArtifact(runtime.artifact);
  if(!(bytes instanceof Uint8Array)||!bytes.length)throw Error('Invalid precompiled runtime transport.');
  const session=compiler.WasmSimulationSession.fromPrecompiledRuntimeArtifact(bytes,set.source,model,set.workspace,optionsJson);
  return {session,mode:'precompiled-runtime'};
 }
 // A damaged/missing published artifact never falls back to source compilation.
 const artifact=unchanged?await readArtifact(entry.artifact):compiler.export_prebuilt_artifact(set.source,model,set.workspace);
 if(typeof artifact!=='string')throw Error('Invalid precompiled model transport.');
 const session=compiler.WasmSimulationSession.fromPrebuiltArtifact(artifact,set.source,model,set.workspace,optionsJson);
 return {session,mode:unchanged?'prebuilt':'source'};
}
async function compressedArtifactResponse(url){
 const response=await fetch(url);if(!response.ok)throw Error('Precompiled model download failed: '+response.status);
 if(typeof DecompressionStream!=='function')throw Error('This browser cannot decompress the precompiled model.');
 return new Response(response.body.pipeThrough(new DecompressionStream('gzip')));
}
export async function readCompressedArtifact(url){
 // Never JSON-parse/reserialize the envelope: its payload string carries u64 IDs.
 return (await compressedArtifactResponse(url)).text();
}
export async function readCompressedRuntimeArtifact(url){
 return new Uint8Array(await(await compressedArtifactResponse(url)).arrayBuffer());
}
