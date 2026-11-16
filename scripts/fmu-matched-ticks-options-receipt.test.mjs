// Pure configuration/receipt and session stand-ins only; no FMU or engine is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedSessionOptions,checkedExecutionReceipt,createBoundReadout} from './fmu-matched-ticks.mjs';
import {canonicalJson,WHOLE_MODEL} from '../site/fmu-page-contract.js';
import {sha256} from './matched-tick-workload.mjs';

const optionsSha256='9e3343c901e45dd0c84351c1d12f5ffb0f84323ab9f7907df43212f51503cfc0';
const index=()=>({instantiationToken:'stand-in-admitted-token',pageBinding:{optionsSha256},nativeAdmission:{optionsSha256}});

test('actual canonical page configuration passes before loading; retuned or mismatched admission refuses',()=>{
 const {options,optionsSha256:actual}=checkedSessionOptions(index());
 assert.equal(actual,optionsSha256);
 assert.equal(options.dt,0.002);
 assert.deepEqual(options.fixed_step,{step:0.001,order:2});
 assert.equal(Object.hasOwn(options.fixed_step,'scheme'),false);
 assert.equal(Object.keys(options.parameters).length,68);
 const sdkOptions={...options,fixed_step:{step:0.002,order:1,scheme:'semi-implicit'}};
 const retuned=sha256(canonicalJson(sdkOptions));
 assert.throws(()=>checkedSessionOptions({...index(),pageBinding:{optionsSha256:retuned}}),/admitted page options/);
 assert.throws(()=>checkedSessionOptions({...index(),nativeAdmission:{optionsSha256:retuned}}),/native admission/);
});

test('bound readout performs SDK named-object conversion, deduplication and exact typed extent checks',()=>{
 let binds=0,reads=0,values=Float64Array.of(1,-0,NaN);
 const session={bind_outputs(json){binds++;assert.deepEqual(JSON.parse(json),['a','b','c']);return 17;},
  read_bound(handle){reads++;assert.equal(handle,17);return values;}};
 const read=createBoundReadout(session,['a','b','a','c']);
 const result=read();
 assert.equal(binds,1);assert.equal(reads,1);
 assert.deepEqual(result,{a:1,b:-0,c:null});
 assert.equal(ArrayBuffer.isView(result),false);
 values=Float64Array.of(1,2);
 assert.throws(read,/Invalid typed session readout/);
 values=[1,2,3];
 assert.throws(read,/Invalid typed session readout/);
});

test('actual receipt must identify exact FMU engine, whole model, token and null refusal',()=>{
 const receipt={engine:'fmi3-ls-wasm',refusal:null,model:WHOLE_MODEL,instantiation_token:index().instantiationToken};
 const session=value=>({execution_receipt_json:()=>JSON.stringify(value)});
 assert.deepEqual(checkedExecutionReceipt(session(receipt),index()),receipt);
 for(const changed of [{engine:'wasm_program'},{engine:'rumoca-fmi3-ls-wasm'},
  {model:'MicroduckJawLocked'},{instantiation_token:'another-token'},{refusal:'unavailable'},{refusal:undefined}])
  assert.throws(()=>checkedExecutionReceipt(session({...receipt,...changed}),index()));
 assert.throws(()=>checkedExecutionReceipt(session(receipt),{...index(),instantiationToken:''}),/missing admitted token/);
 assert.throws(()=>checkedExecutionReceipt({execution_receipt_json:()=>'{bad'},index()),SyntaxError);
});
