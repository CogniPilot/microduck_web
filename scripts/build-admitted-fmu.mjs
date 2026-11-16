// Publish build files only from the SAME native-smoked full-robot FMU and current page sources/options.
// No new runtime, fallback, compiler, fetch, optimization or ABI path.
// node scripts/build-admitted-fmu.mjs HOST-BOUND.json CORE-SMOKE-PASS.txt PAGE_SITE NEW_OUT JCO_ENTRY
import {readFile, writeFile, mkdir, lstat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {buildFmu,writeBuildFiles} from './build-fmu.mjs';
import {pageBuildInputs} from './fmu-page-inputs.mjs';
import {canonicalJson,WHOLE_MODEL,LEGACY_MODEL} from '../site/fmu-page-contract.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const check=(condition,message)=>{if(!condition)throw Error('build-admitted-fmu: '+message);};

export function checkSmokeRecord(bytes,bindingBytes,bindingPath){
 const lines=Buffer.from(bytes).toString('utf8').trimEnd().split('\n');
 check(lines.length===2&&lines[0]==='CORE_SMOKE_PASS','native core smoke did not pass');
 const row=lines[1].match(/^([a-f0-9]{64})  (\/[^\r\n]+)$/);
 check(row&&row[1]===hash(bindingBytes)&&row[2]===path.resolve(bindingPath),'smoke record is bound to another artifact admission');
}

// This equality links the actual compiler workspace + main document to the existing page contract.
// It does not infer source provenance from XML names or component sizes.
export function checkProducerInputs(page,{main,workspace,options}){
 check(page.sourceModel===WHOLE_MODEL&&page.pageBinding?.model===WHOLE_MODEL,'page does not select the whole robot');
 const bodies=JSON.parse(Buffer.from(workspace).toString('utf8'));
 check(bodies&&typeof bodies==='object'&&!Array.isArray(bodies),'invalid compiler workspace');
 check(!Object.hasOwn(bodies,WHOLE_MODEL+'.mo'),'main document is duplicated in the workspace');
 const sources=Object.fromEntries(Object.entries(bodies).map(([name,body])=>{
  check(typeof body==='string','workspace body is not text: '+name);return[name,hash(Buffer.from(body))];
 }));
 sources[WHOLE_MODEL+'.mo']=hash(main);
 const actualKeys=Object.keys(sources).sort(),pageKeys=Object.keys(page.sources).sort();
 check(actualKeys.length===273&&JSON.stringify(actualKeys)===JSON.stringify(pageKeys),'page/compiler source sets differ');
 for(const name of actualKeys)check(sources[name]===page.sources[name],'page/compiler source bytes differ: '+name);
 const canonicalOptions=canonicalJson(JSON.parse(Buffer.from(options).toString('utf8')));
 check(hash(Buffer.from(canonicalOptions))===page.pageBinding.optionsSha256,'page/compiler options differ');
 return{sourceCount:actualKeys.length,optionsSha256:page.pageBinding.optionsSha256,sourceSetSha256:hash(Buffer.from(canonicalJson(sources)))};
}

async function regular(file){
 check(path.isAbsolute(file),'native evidence path is not absolute');
 const state=await lstat(file);check(state.isFile()&&!state.isSymbolicLink(),'native evidence is not a regular file: '+file);
 return readFile(file);
}
async function boundFile(record){
 check(typeof record?.path==='string'&&/^[a-f0-9]{64}$/.test(record.sha256??''),'invalid native file binding');
 const bytes=await regular(record.path);check(hash(bytes)===record.sha256,'native evidence bytes changed: '+record.path);return bytes;
}

export async function readNativeAdmission(bindingPath,smokePath,page){
 const bindingBytes=await regular(path.resolve(bindingPath)),binding=JSON.parse(bindingBytes);
 const smokeBytes=await regular(path.resolve(smokePath));checkSmokeRecord(smokeBytes,bindingBytes,bindingPath);
 check(binding.kind==='actual-full-robot-host-binding/1'&&binding.model===WHOLE_MODEL,'wrong native admission kind/model');
 check(typeof binding.instantiationToken==='string'&&binding.instantiationToken.length>0,'missing native token');
 const archive=await boundFile(binding.archive);
 const exportBytes=await boundFile(binding.exportRecord),exported=JSON.parse(exportBytes);
 check(exported.model===WHOLE_MODEL,'export model differs');
 for(const field of ['modelDescription.xml','component.wasm','public-io.tsv','JOIN.json'])check(binding.files?.[field],'incomplete native typed-I/O association');
 for(const entry of Object.values(binding.files))await boundFile(entry);
 await boundFile(binding.publicVariables);
 const main=await boundFile(binding.inputs.main),workspace=await boundFile(binding.inputs.workspace),options=await boundFile(binding.inputs.options);
 for(const [name,bytes]of Object.entries({source:main,workspace,options}))check(exported.inputs?.[name]?.sha256===hash(bytes),'export/native '+name+' differs');
 check(exported.options_sha256===hash(options),'export option document differs');
 const joined=checkProducerInputs(page,{main,workspace,options});
 const nativeAdmission={schema:1,scope:'Same artifact native core smoke and actual source/options joins; not browser runtime qualification',
  bindingSha256:hash(bindingBytes),smokeSha256:hash(smokeBytes),archiveSha256:binding.archive.sha256,
  componentSha256:binding.files['component.wasm'].sha256,modelDescriptionSha256:binding.files['modelDescription.xml'].sha256,
  publicIoSha256:binding.files['public-io.tsv'].sha256,exportSha256:hash(exportBytes),compiler:exported.compiler,...joined};
 return{archive,binding,nativeAdmission};
}

export async function buildAdmittedFmu({bindingPath,smokePath,site,out,jco}){
 check(typeof jco==='string'&&path.isAbsolute(jco),'exact build-time jco entry is required');
 const page=await pageBuildInputs(site);
 const {archive,binding,nativeAdmission}=await readNativeAdmission(bindingPath,smokePath,page);
 const built=await buildFmu(new Uint8Array(archive),{...page,jco,nativeAdmission});
 check(built.index.modelName===WHOLE_MODEL&&built.index.instantiationToken===binding.instantiationToken,'transpiled index disagrees with native model/token');
 check(built.index.component.sha256===nativeAdmission.componentSha256,'transpiled component differs from native-smoked component');
 const notes=await readFile(new URL('../site/fmu/TRANSPILE-LICENSE',import.meta.url)).catch(()=>undefined);
 // Exact license source is handled separately below; no successful offer is written without it.
 check(notes,'missing generated-glue license text (site/fmu/TRANSPILE-LICENSE)');
 built.files.set('TRANSPILE-LICENSE',notes);
 await mkdir(out); // fresh directory, no overwriting another build or active page
 await writeBuildFiles(out,built.files);
 const offer={schema:1,scope:'Prepared offer; actual browser load/init/tick/reset/error qualification still required',
  selectedModel:LEGACY_MODEL,model:WHOLE_MODEL,
  fmu:{index:path.basename(out)+'/'+built.indexFile,sha256:built.indexSha256},nativeAdmission,
  files:[...built.files].map(([file,bytes])=>({file,bytes:bytes.length,sha256:hash(bytes)}))};
 // An incomplete build can leave files, but it never yields an installable offer.
 await writeFile(path.join(out,'OFFER.json'),JSON.stringify(offer,null,2)+'\n',{flag:'wx'});
 return offer;
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const [bindingPath,smokePath,site,out,jco]=process.argv.slice(2);
 check(process.argv.length===7,'usage: build-admitted-fmu.mjs HOST-BOUND.json CORE-SMOKE-PASS.txt PAGE_SITE NEW_OUT JCO_ENTRY');
 console.log(JSON.stringify(await buildAdmittedFmu({bindingPath,smokePath,site,out,jco}),null,2));
}
