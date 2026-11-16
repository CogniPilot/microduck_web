import assert from 'node:assert/strict';
import {summarizeFmuStartup as reduce} from './fmu-startup-timing.mjs';
const index={modelName:'MicroduckWholeSystem',instantiationToken:'test-only',glue:{file:'g.js'},coreModules:{a:{file:'a.wasm'}}};
const offer={fmu:{index:'offer/i.json'}},base='http://127.0.0.1:9999/';
const trace={overflow:false,events:[
 {worker:1,direction:'command',epochMs:1000,data:{id:1,type:'prepare'}},
 {worker:1,direction:'reply',epochMs:2500,data:{id:1,result:{time:0,execution:{engine:'fmi3-ls-wasm',refusal:null,model:index.modelName,instantiation_token:index.instantiationToken},preparation:{controller:'fmu',plant:'fmu',model:'MicroduckWholeSystem',selected_model:'MicroduckJawLocked'}}}}
]};
const resources=['i.json','g.js','a.wasm'].map(file=>({url:base+'prebuilt/offer/'+file,startTime:1000,responseEnd:1000}));
const get=(t=trace,r=resources)=>reduce(t,r,index,offer,base)[0];
assert.equal(get().postDownloadMs,500);assert.equal(get().prepareElapsedMs,1500);assert.equal(get().withinTarget,true);
assert.equal(get(trace,resources.slice(1)).observed,false);
assert.equal(get(trace,resources.map(r=>({...r,responseEnd:-1}))).withinTarget,null);
const backwards=structuredClone(trace);backwards.events[1].epochMs=999;assert.equal(get(backwards).observed,false);
const slow=structuredClone(trace);slow.events[1].epochMs=3101;assert.equal(get(slow).withinTarget,false);
const cached=resources.map(r=>({...r,startTime:500,responseEnd:10}));assert.equal(get(trace,cached).postDownloadMs,1500);
const fallback=structuredClone(trace);fallback.events[1].data.result.preparation.plant='sdk';assert.equal(get(fallback).observed,false);
const namedFallback=structuredClone(trace);namedFallback.events[1].data.result.preparation.fmu_fallback='load failed';assert.equal(get(namedFallback).withinTarget,null);
const badTime=structuredClone(trace);badTime.events[1].data.result.time=.02;assert.equal(get(badTime).withinTarget,null);
const wrongSelected=structuredClone(trace);wrongSelected.events[1].data.result.preparation.selected_model='other';assert.equal(get(wrongSelected).observed,false);
const missingTime=structuredClone(trace);delete missingTime.events[1].data.result.time;assert.equal(get(missingTime).observed,false);
const missingModel=structuredClone(trace);delete missingModel.events[1].data.result.preparation.model;assert.equal(get(missingModel).observed,false);
const boundary=structuredClone(trace);boundary.events[1].epochMs=3000;assert.equal(get(boundary).observed,true);assert.equal(get(boundary).postDownloadMs,1000);assert.equal(get(boundary).withinTarget,false);
console.log('13 pure startup-timing controls PASS; no model/provider/browser/engine');
