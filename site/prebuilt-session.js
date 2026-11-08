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
export async function createModelSession({compiler,sources,model,options,manifest,readArtifact}){
 if(manifest?.version!==1)throw Error('Unsupported precompiled model manifest.');
 const entry=manifest.models?.[model];
 if(typeof entry?.key!=='string'||typeof entry?.artifact!=='string')throw Error('Missing precompiled model: '+model);
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
 // A damaged/missing published artifact never falls back to source compilation.
 const artifact=unchanged?await readArtifact(entry.artifact):compiler.export_prebuilt_artifact(set.source,model,set.workspace);
 if(typeof artifact!=='string')throw Error('Invalid precompiled model transport.');
 const session=compiler.WasmSimulationSession.fromPrebuiltArtifact(artifact,set.source,model,set.workspace,JSON.stringify(options));
 return {session,mode:unchanged?'prebuilt':'source'};
}
export async function readCompressedArtifact(url){
 const response=await fetch(url);if(!response.ok)throw Error('Precompiled model download failed: '+response.status);
 if(typeof DecompressionStream!=='function')throw Error('This browser cannot decompress the precompiled model.');
 // Never JSON-parse/reserialize the envelope: its payload string carries u64 IDs.
 return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
}
