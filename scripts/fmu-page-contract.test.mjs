// Unexecuted source controls: contract metadata and recording fakes, not a robot FMU.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PAGE_INPUT_GROUPS,PAGE_OUTPUT_GROUPS,PAGE_OPTIONAL_OUTPUTS,scalarNames,currentPageSources,pageBinding,
 canonicalJson,wholeModelOptions,WHOLE_MODEL,LEGACY_MODEL,STANDARD_PIN_FILE} from '../site/fmu-page-contract.js';
import {checkPageInterface,offeredFmu} from '../site/fmu-session.js';
import {pageBuildInputs} from './fmu-page-inputs.mjs';
import {modelOptions} from '../site/simulation-options.js';
import {fileURLToPath} from 'node:url';
const site=new URL('../site/',import.meta.url);
const text=async file=>readFile(new URL(file,site),'utf8');
const sha=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
const pageSources=async()=>Object.fromEntries(await Promise.all(JSON.parse(await text('sources/manifest.json'))
 .map(async name=>[name,await text('sources/'+name)])));
function variables(){
 let vr=1;
 return [...[['input',PAGE_INPUT_GROUPS],['output',PAGE_OUTPUT_GROUPS]].flatMap(([causality,groups])=>
  groups.map(([name,type,dimensions])=>({name,type,dimensions,causality,vr:vr++}))),
  {name:'cameraRows',type:'Int64',causality:'parameter',start:['24'],vr:vr++},
  {name:'cameraColumns',type:'Int64',causality:'parameter',start:['32'],vr:vr++}];
}

test('actual wrapper demands both selectors, full typed sensors/pose and Integer dimensions',()=>{
 assert.equal(checkPageInterface(variables()),undefined);
 for(const name of ['usePolicyController','usePolicyPosition','lidarValid','policyObservation','bodyRotation','cameraRows','stateOfCharge'])
  assert.match(checkPageInterface(variables().filter(v=>v.name!==name)),/needs/);
 assert.match(checkPageInterface(variables().map(v=>v.name==='lidarValid'?{...v,type:'Float64'}:v)),/Boolean/);
 assert.match(checkPageInterface(variables().map(v=>v.name==='cameraRGB'?{...v,dimensions:[32,24,3]}:v)),/cameraRGB/);
 assert.match(checkPageInterface(variables().map(v=>v.name==='cameraColumns'?{...v,start:['31']}:v)),/cameraColumns/);
 const count=groups=>groups.reduce((n,[name,,shape])=>n+scalarNames(name,shape).length,0);
 assert.equal(count(PAGE_INPUT_GROUPS),2516);assert.equal(count(PAGE_OUTPUT_GROUPS),438);
});

test('the battery outputs of the electrical model are optional, but exact when present',()=>{
 const withoutBattery=variables().filter(v=>!PAGE_OPTIONAL_OUTPUTS.has(v.name));
 assert.equal(withoutBattery.length,variables().length-2);
 assert.equal(checkPageInterface(withoutBattery),undefined);
 for(const name of PAGE_OPTIONAL_OUTPUTS){
  assert.match(checkPageInterface(variables().map(v=>v.name===name?{...v,type:'Boolean'}:v)),new RegExp(name));
  assert.match(checkPageInterface(variables().map(v=>v.name===name?{...v,dimensions:[2]}:v)),new RegExp(name));
  assert.match(checkPageInterface(variables().map(v=>v.name===name?{...v,causality:'input'}:v)),new RegExp(name));
 }
});

test('whole-page interface accepts exact aggregates or scalarized members and refuses supersets',()=>{
 const scalarized=variables().flatMap(variable=>scalarNames(variable.name,variable.dimensions)
  .map(name=>({...variable,name,dimensions:[]})));
 assert.equal(checkPageInterface(variables()),undefined);
 assert.equal(checkPageInterface(scalarized),undefined);
 for(const [name,dimensions]of [['cameraRGB',[25,32,3]],['bodyPosition',[16,3]]]){
  const oversized=variables().map(variable=>variable.name===name?{...variable,dimensions}:variable);
  assert.match(checkPageInterface(oversized),new RegExp(name));
 }
 for(const name of ['cameraRGB[25,1,1]','bodyPosition[16,1]']){
  assert.match(checkPageInterface([...scalarized,{name,type:'Float64',causality:name.startsWith('camera')?'input':'output',vr:99999}]),/exact/);
 }
 assert.match(checkPageInterface([...variables(),{name:'cameraRGB[1,1,1]',type:'Float64',causality:'input',vr:99999}]),/cameraRGB/);
 assert.match(checkPageInterface([...scalarized,scalarized.find(variable=>variable.name==='bodyPosition[1,1]')]),/bodyPosition/);
 assert.match(checkPageInterface(scalarized.map(variable=>variable.name==='bodyPosition[1,1]'?{...variable,type:'Boolean'}:variable)),/bodyPosition/);
 assert.match(checkPageInterface(scalarized.map(variable=>variable.name==='cameraRGB[1,1,1]'?{...variable,dimensions:[1]}:variable)),/cameraRGB/);
 assert.match(checkPageInterface(variables().map(variable=>variable.name==='cameraRows'?{...variable,dimensions:[1]}:variable)),/cameraRows/);
});

test('browser contract reads only tiny pin plus wrapper; producer verifies actual 29 library bodies',async()=>{
 const calls=[];
 const fetch=async url=>{const file=String(url).split('/').pop();calls.push(file);
  return new Response(await text(file===STANDARD_PIN_FILE?file:'fmu-sources/MicroduckWholeSystem.mo'));};
 const current=await currentPageSources(await pageSources(),{fetch,base:site});
 assert.deepEqual(calls,[STANDARD_PIN_FILE,'MicroduckWholeSystem.mo']);
 assert.equal(Object.keys(current.sources).length,244);assert.equal(Object.keys(current.sourcePins).length,29);
 const producer=await pageBuildInputs(fileURLToPath(site));
 assert.equal(Object.keys(producer.sources).length,273);assert.equal(producer.sourceModel,WHOLE_MODEL);
 for(const [name,body]of Object.entries(current.sources))assert.equal(producer.sources[name],await sha(body));
 for(const [name,digest]of Object.entries(current.sourcePins))assert.equal(producer.sources[name],digest);
 assert.deepEqual(producer.pageBinding,await pageBinding(modelOptions(LEGACY_MODEL)));
 const options=wholeModelOptions(modelOptions(LEGACY_MODEL));
 assert.equal(Object.keys(options.parameters).length,68);
 assert.equal(options.parameters['plant.leftSoleContact.k'],510);
 assert.deepEqual(options.fixed_step,{step:.001,order:2});
 assert.equal(canonicalJson({b:1,a:2}),canonicalJson({a:2,b:1}));
});

test('whole-page offer binds selected model, all273 keys, wrapper, library pin and exact options',async t=>{
 const current=await currentPageSources(await pageSources(),{fetch:async url=>new Response(await text(String(url).endsWith(STANDARD_PIN_FILE)?STANDARD_PIN_FILE:'fmu-sources/MicroduckWholeSystem.mo')),base:site});
 const producer=await pageBuildInputs(fileURLToPath(site));
 const base=new URL('http://fmu.test/prebuilt/');
 let index={schema:1,format:'fmi3-ls-wasm-transpiled',modelName:WHOLE_MODEL,instantiationToken:'fixture-not-a-product',
  glue:{file:'g.js'},coreModules:{},imports:[],variables:variables(),...producer};
 const fetch=async url=>new Response(String(url).endsWith('manifest.json')?
  JSON.stringify({version:1,models:{[LEGACY_MODEL]:{fmu:{index:'index.json',sha256:await sha(JSON.stringify(index))}}}}):JSON.stringify(index));
 const offer=()=>offeredFmu({model:LEGACY_MODEL,sources:{},sourceProvider:async()=>current,
  expectedPageBinding:()=>pageBinding(modelOptions(LEGACY_MODEL)),interfaceCheck:checkPageInterface,base,fetch});
 // This metadata-only case requires the same multi-memory capability as the loader;
 // no glue/module/fmu is instantiated by offeredFmu.
 const first=await offer();
 if(first.fallback?.includes('multi-memory')){t.skip('this engine lacks the metadata-loader capability; no assertions executed');return;}
 assert(first.index);
 index={...index,pageBinding:{...index.pageBinding,optionsSha256:'0'.repeat(64)}};
 assert.match((await offer()).fallback,/options differ/);
 index={...index,pageBinding:producer.pageBinding,sources:{...producer.sources,[WHOLE_MODEL+'.mo']:'0'.repeat(64)}};
 assert.match((await offer()).fallback,/edited page source/);
 const missing={...producer.sources};delete missing[Object.keys(current.sourcePins)[0]];
 index={...index,sources:missing};assert.match((await offer()).fallback,/not in the FMU/);
 index={...index,sources:producer.sources,modelName:LEGACY_MODEL};
 assert.match((await offer()).fallback,/whole-model/);
});


test('no offered FMU never asks for wrapper/library source-provider work',async()=>{
 let provided=0;
 const result=await offeredFmu({model:LEGACY_MODEL,base:new URL('http://page.test/prebuilt/'),
  fetch:async()=>new Response(JSON.stringify({version:1,models:{[LEGACY_MODEL]:{}}})),
  sourceProvider:async()=>{provided++;throw Error('must not load');}});
 assert.equal(result,undefined);assert.equal(provided,0);
});

test('changed thin library pin is refused rather than silently fetching library bodies',async()=>{
 let calls=0;
 const sources=await pageSources();
 await assert.rejects(()=>currentPageSources(sources,{fetch:async()=>{calls++;return new Response('{}');},base:site}),/changed/);
 assert.equal(calls,1);
});


test('fixed calculated camera metadata is legal; runtime values remain mandatory',()=>{
 const calculated=variables().map(v=>v.name==='cameraRows'||v.name==='cameraColumns'?
  {name:v.name,type:v.type,vr:v.vr,causality:'calculatedParameter',variability:'fixed',initial:'calculated'}:v);
 assert.equal(checkPageInterface(calculated),undefined);
 for(const change of [{causality:'structuralParameter'},{causality:'local'},{type:'UInt64'},
   {variability:'tunable'},{initial:'exact'},{initial:'approx'},{start:['24']},{dimensions:[1]}])
  assert.match(checkPageInterface(calculated.map(v=>v.name==='cameraRows'?{...v,...change}:v)),/cameraRows/);
 assert.match(checkPageInterface([...calculated,calculated.find(v=>v.name==='cameraRows')]),/cameraRows/);
});
