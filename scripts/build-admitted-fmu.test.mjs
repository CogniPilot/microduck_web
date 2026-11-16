import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {checkProducerInputs,checkSmokeRecord} from './build-admitted-fmu.mjs';
import {pageBuildInputs} from './fmu-page-inputs.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const site=new URL('../site/',import.meta.url).pathname;
const page=await pageBuildInputs(site);
const bodies={};
const sources=JSON.parse(await readFile(new URL('../site/msl-sources.json',import.meta.url),'utf8'));
Object.assign(bodies,sources);
const names=JSON.parse(await readFile(new URL('../site/sources/manifest.json',import.meta.url),'utf8'));
for(const name of names)bodies[name]=await readFile(new URL('../site/sources/'+name,import.meta.url),'utf8');
const main=await readFile(new URL('../site/fmu-sources/MicroduckWholeSystem.mo',import.meta.url));
const {modelOptions}=await import('../site/simulation-options.js');
const {wholeModelOptions}=await import('../site/fmu-page-contract.js');
const options=Buffer.from(JSON.stringify(wholeModelOptions(modelOptions('MicroduckJawLocked'))));
const input=()=>({main,workspace:Buffer.from(JSON.stringify(bodies)),options});

test('actual 273 page source bodies and 68 options join without a model/engine',()=>{
 const joined=checkProducerInputs(page,input());assert.equal(joined.sourceCount,273);assert.equal(joined.optionsSha256,page.pageBinding.optionsSha256);
});
test('another body, source set or options cannot borrow the page identity',()=>{
 const changed={...bodies,'Microduck.mo':bodies['Microduck.mo']+'\n// changed'};
 assert.throws(()=>checkProducerInputs(page,{...input(),workspace:Buffer.from(JSON.stringify(changed))}),/source bytes differ/);
 const missing={...bodies};delete missing['Microduck.mo'];assert.throws(()=>checkProducerInputs(page,{...input(),workspace:Buffer.from(JSON.stringify(missing))}),/source sets differ/);
 assert.throws(()=>checkProducerInputs(page,{...input(),options:Buffer.from(JSON.stringify({...JSON.parse(options),dt:0.003}))}),/options differ/);
});
test('native core smoke must name the exact binding bytes and absolute path',()=>{
 const bytes=Buffer.from('{"synthetic":true}'),p='/test/HOST-BOUND.json';
 checkSmokeRecord(Buffer.from('CORE_SMOKE_PASS\n'+hash(bytes)+'  '+p+'\n'),bytes,p);
 assert.throws(()=>checkSmokeRecord(Buffer.from('CORE_SMOKE_PASS\n'+'0'.repeat(64)+'  '+p+'\n'),bytes,p),/another artifact/);
 assert.throws(()=>checkSmokeRecord(Buffer.from('CORE_SMOKE_PASS\n'+hash(bytes)+'  /other/HOST-BOUND.json\n'),bytes,p),/another artifact/);
 assert.throws(()=>checkSmokeRecord(Buffer.from('CORE_SMOKE_FAILED\n'+hash(bytes)+'  '+p+'\n'),bytes,p),/did not pass/);
});

test('transpiler index binds native admission to this artifact, component and options (mock transpiler only)',async()=>{
 const {buildFmu,readZip,embeddedCoreModules}=await import('./build-fmu.mjs');
 const {standInFmu,standInDescription}=await import('./fmu-test-support.mjs');
 const fmu=await standInFmu({description:standInDescription().replace('modelName="StandIn"','modelName="MicroduckWholeSystem"')});
 const entries=readZip(fmu),component=entries.get('binaries/wasm32-wasip2/StandIn.wasm');
 const cores=embeddedCoreModules(component),transpiler={version:'0.23.0',componentWit:async()=>
 'world test {\nexport fmi:fmi3/common@3.0.0;\nexport fmi:fmi3/co-simulation@3.0.0;\n}',
 transpileBytes:async()=>({imports:[],files:{'fmu.js':Buffer.from('export async function instantiate() {}'),...Object.fromEntries(cores.map((b,i)=>['fmu.core'+i+'.wasm',b]))}})};
 const nativeAdmission={schema:1,archiveSha256:hash(fmu),componentSha256:hash(component),modelDescriptionSha256:hash(entries.get('modelDescription.xml')),sourceCount:273,optionsSha256:page.pageBinding.optionsSha256,
 bindingSha256:'1'.repeat(64),smokeSha256:'2'.repeat(64),publicIoSha256:'3'.repeat(64),exportSha256:'4'.repeat(64),sourceSetSha256:'5'.repeat(64)};
 const built=await buildFmu(fmu,{...page,transpiler,nativeAdmission});assert.deepEqual(built.index.nativeAdmission,nativeAdmission);
 for(const key of ['archiveSha256','componentSha256','modelDescriptionSha256','optionsSha256'])await assert.rejects(buildFmu(fmu,{...page,transpiler,nativeAdmission:{...nativeAdmission,[key]:'0'.repeat(64)}}),/native admission does not match/);
});
