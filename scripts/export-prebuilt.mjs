import fs from 'node:fs';import path from 'node:path';import {gzipSync} from 'node:zlib';import crypto from 'node:crypto';
import init,* as compiler from '../site/model-runtime.js';
import {modelSourceSet} from '../site/prebuilt-session.js';
import {modelOptions} from '../site/simulation-options.js';
const site=new URL('../site/',import.meta.url),output=new URL('prebuilt/',site);
await init({module_or_path:fs.readFileSync(compiler.WASM_URL)});
const sources=JSON.parse(fs.readFileSync(new URL('msl-sources.json',site)));
for(const name of JSON.parse(fs.readFileSync(new URL('sources/manifest.json',site))))sources[name]=fs.readFileSync(new URL('sources/'+name,site),'utf8');
const manifest={version:1,models:{}};fs.mkdirSync(output,{recursive:true});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
for(const model of ['MicroduckJawLocked','MicroduckPolicyInterface']){
 const start=performance.now(),set=modelSourceSet(sources,model);
 const key=compiler.prebuilt_artifact_key(set.source,model,set.workspace);
 const artifact=compiler.export_prebuilt_artifact(set.source,model,set.workspace);
 const bytes=Buffer.from(artifact),compressed=gzipSync(bytes,{level:9});
 const name=model+'.json.gz';fs.writeFileSync(new URL(name,output),compressed);
 const record={format:'prebuilt-dae',key,artifact:name,bytes:compressed.length,uncompressed_bytes:bytes.length,sha256:sha(compressed),uncompressed_sha256:sha(bytes)};
 if(model==='MicroduckJawLocked'){
  const options=JSON.stringify(modelOptions(model));
  const runtimeKey=compiler.precompiled_runtime_key(set.source,model,set.workspace,options);
  const runtimeBytes=compiler.export_precompiled_runtime_artifact(set.source,model,set.workspace,options);
  const runtimeCompressed=gzipSync(runtimeBytes,{level:9}),runtimeName=model+'.runtime.bin.gz';
  fs.writeFileSync(new URL(runtimeName,output),runtimeCompressed);
  record.format='precompiled-runtime';
  record.runtime={key:runtimeKey,artifact:runtimeName,bytes:runtimeCompressed.length,uncompressed_bytes:runtimeBytes.length,sha256:sha(runtimeCompressed),uncompressed_sha256:sha(runtimeBytes)};
 }
 manifest.models[model]=record;
 console.log(JSON.stringify({model,export_ms:performance.now()-start,bytes:bytes.length,gzip_bytes:compressed.length}));
}
fs.writeFileSync(new URL('manifest.json',output),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({compiler:compiler.get_git_commit(),models:Object.keys(manifest.models),output:path.resolve(output.pathname)}));
