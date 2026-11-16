// The worker's manifest-gated FMU branch, with the compiler, policy runtime, model sessions
// and FMU loader replaced by recording fakes. Needs node --experimental-test-module-mocks.
import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {PAGE_INPUT_GROUPS,PAGE_OUTPUT_GROUPS,scalarNames,wholeModelOptions} from '../site/fmu-page-contract.js';
const SIMULATION_INPUTS=PAGE_INPUT_GROUPS.flatMap(([name,,shape])=>scalarNames(name,shape));
const SIMULATION_OUTPUTS=PAGE_OUTPUT_GROUPS.flatMap(([name,,shape])=>scalarNames(name,shape));
import {modelOptions} from '../site/simulation-options.js';
import {registerHooks} from 'node:module';
// Every module the worker itself imports, to show an FMU visit never loads the compiler.
const resolved = [];
registerHooks({resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (context.parentURL?.endsWith('/site/physics.worker.js')) resolved.push(result.url);
  return result;
}});
const loadsSdk = () => resolved.filter(url => /\/site\/(model-runtime|prebuilt-session)\.js(\?|$)/.test(url));

const site = name => new URL('../site/' + name, import.meta.url).href;
const vector = (name, count) => Array.from({length: count}, (_, i) => `${name}[${i + 1}]`);
const pose = [...Array.from({length: 45}, (_, i) => `bodyPosition[${Math.floor(i / 3) + 1},${i % 3 + 1}]`),
  ...Array.from({length: 135}, (_, i) => `bodyRotation[${Math.floor(i / 9) + 1},${Math.floor(i / 3) % 3 + 1},${i % 3 + 1}]`)];
const plantOutputs = [...pose, ...vector('jointPosition', 15), ...vector('jointVelocity', 15), ...vector('trunkGyro', 3),
  ...vector('policyJointHome', 14), ...vector('policyJointHalfRange', 14), 'fallen'];
const controllerNames = ['forwardVelocity', 'lateralVelocity', 'steeringRate', 'hasPreviousPositionCommand',
  ...vector('previousPolicyAction', 14), ...vector('previousCommand', 3), ...vector('previousPositionCommand', 15), ...vector('trunkGyro', 3),
  ...vector('gravityRow', 3), ...vector('jointPosition', 15), ...vector('jointVelocity', 15), ...vector('policyHome', 14),
  ...vector('policyHalfRange', 14), ...vector('policyAction', 14)];
const controllerOutputs = [...vector('policyObservation', 61), ...vector('positionCommand', 15), ...vector('filteredCommand', 3), 'clippedPolicyActions'];
const sensor = [['cameraTimestamp', 0], ['lidarValid[1,1]', 1]];

const log = [];
// A session that refuses writes to anything but its inputs, as the SDK and the FMU do.
function fakeSession(label, outputs, inputs, behaviour = {}) {
  let time = 0, live = true, fault;
  const check=()=>{if(fault)throw Error(fault);};
  const value = name => name.startsWith('bodyRotation') ? 1 : 0.25;
  return {label, writes: [], resets: 0, frees: 0,
    time: () => time,
    advance_to(t) { check();try{behaviour.advance?.();}catch(error){fault=String(error);throw error;}time = t; log.push([label, 'advance', t]); },
    variable_names: () => JSON.stringify([...new Set([...outputs,...inputs])]),
    set_inputs(json) { check();const rows=JSON.parse(json); for(const [name] of rows)if(!inputs.includes(name))throw Error(`${label} has no input ${name}`); this.writes.push(Object.fromEntries(rows)); log.push([label,'write',Object.fromEntries(rows)]); },
    read_values(json) { check();behaviour.read?.(); const names=JSON.parse(json); for(const name of names)if(!outputs.includes(name)&&!inputs.includes(name))throw Error(`${label} has no ${name}`); log.push([label,'read',names]); return Float64Array.from(names,value); },
    state_json: () => JSON.stringify({time, values: Object.fromEntries(outputs.map(n => [n, value(n)]))}),
    input_names: () => JSON.stringify(inputs),
    execution_receipt_json: () => JSON.stringify({engine: label==='fmu'?'fmi3-ls-wasm':label}),
    reset() { if(fault)throw Error(fault+' Prepare the simulation again.');this.resets++; time = 0; },
    free() { this.frees++;log.push([label,'free',live]); live=false; },
  };
}

const state = {offered: undefined, openFails: false, faultNext: false, opened: [], made: [], inits: 0};
mock.module(site('model-runtime.js'), {defaultExport: async () => { state.inits++; }, namedExports: {}});
mock.module(site('prebuilt-session.js'), {namedExports: {
  createModelSession: async ({model}) => {
    state.made.push(model);
    const session = model === 'MicroduckPolicyInterface' ? fakeSession('controller', controllerOutputs, controllerNames)
      : fakeSession('plant', plantOutputs, ['usePolicyPosition', ...vector('policyPosition', 15), ...sensor.map(([n]) => n)]);
    return {session, mode: 'prebuilt'};
  },
  readCompressedArtifact: async () => '', readCompressedRuntimeArtifact: async () => new Uint8Array(1),
}});
mock.module(site('vendor/onnxruntime-1.31.1/ort.js'), {namedExports: {
  env: {wasm: {}},
  Tensor: class { constructor(type, data, dims) { Object.assign(this, {type, data, dims}); } },
  InferenceSession: {create: async () => ({inputMetadata: [{shape: [1, 61]}], outputMetadata: [{shape: [1, 14]}],
    run: async () => ({actions: {data: new Float32Array(14).fill(0.5)}}), release: async () => {}})},
}});
mock.module(site('fmu-session.js'), {namedExports: {
  offeredFmu: async args => { state.offeredArgs = args; return typeof state.offered === 'function' ? state.offered() : state.offered; },
  checkPageInterface: () => undefined,
  preloadFmu: async args => { (state.preloads ??= []).push(args); return true; },
  openFmuSession: async options => {
    if (state.openFails) throw Error('core module download failed: 404');
    const session = fakeSession('fmu', [...new Set([...SIMULATION_OUTPUTS,...plantOutputs])], [...new Set([...SIMULATION_INPUTS,...sensor.map(([n])=>n)])],
      {read:()=>{if(state.readFails)throw Error('first frame getter refused');},advance: () => {
        if(state.eventNext){state.eventNext=false;throw Error('FMU stopped at t=0.04 (terminate-simulation false, early-return false, event-handling-needed true)');}
        if (state.faultNext) { state.faultNext = false; throw Error('FMU do-step failed at t=0: RuntimeError: unreachable'); }
      }});
    state.opened.push({options, session});
    return session;
  },
}});

// The worker's task channel would keep the test process alive; let it go when the tests end.
globalThis.MessageChannel = class extends MessageChannel {
  constructor() {
    super();
    const port = this.port1;
    Object.defineProperty(port, 'onmessage', {set(handler) { port.addEventListener('message', handler); port.start(); port.unref(); }});
  }
};
const replies = new Map();
const notifications=[];let notification;
let nextId = 1;
globalThis.self = {postMessage: message => { replies.get(message.id)?.(message);if(message.id===undefined){notifications.push(message);notification?.(message);} }};
globalThis.fetch = async url => new Response(String(url).endsWith('msl-sources.json') ? '{}' : JSON.stringify({version: 1, models: {}}));
await import(site('physics.worker.js'));
const send = message => new Promise(resolve => { const id = nextId++; replies.set(id, resolve); self.onmessage({data: {...message, id}}); });
const sources = {'MicroduckJawLocked.mo': 'model MicroduckJawLocked end MicroduckJawLocked;', 'MicroduckPolicyInterface.mo': 'model MicroduckPolicyInterface end MicroduckPolicyInterface;'};
const policyStep = time => send({type: 'policy_step', time, twist: [0.1, 0, 0], inputs: sensor});

test('an FMU visit resolves neither the compiler nor the SDK session modules', async () => {
  state.offered = {index: {modelName: 'MicroduckWholeSystem'}, base: new URL('http://page.test/prebuilt/fmu/i.json')};
  const {result, error} = await send({type: 'prepare', sources});
  assert.equal(error, undefined);
  assert.deepEqual([result.preparation.controller, result.preparation.plant], ['fmu', 'fmu']);
  assert.deepEqual(state.opened.at(-1).options.fixedValues,{cameraRows:24,cameraColumns:32});
 assert.deepEqual(loadsSdk(), []);
  assert.equal(state.inits, 0);
  state.offered = undefined;
  state.opened.length = 0;
});

test('no FMU offered: the two SDK sessions exactly as before', async () => {
  const {result, error} = await send({type: 'prepare', sources});
  assert.equal(error, undefined);
  assert.deepEqual(state.made, ['MicroduckPolicyInterface', 'MicroduckJawLocked']);
  assert.equal(state.inits, 1);
  assert.equal(state.opened.length, 0);
  assert.equal(loadsSdk().length, 2, 'the SDK loads on the first visit that needs it');
  assert.deepEqual([result.preparation.controller, result.preparation.plant], ['prebuilt', 'prebuilt']);
  assert.equal(result.preparation.fmu_fallback, undefined);
  assert.equal(state.offeredArgs.model, 'MicroduckJawLocked');
  const step = await policyStep(0.02);
  assert.equal(step.error, undefined);
});

test('FMU offered: one FMU session, no compiler, controller signals stay inside', async () => {
  const sdkCount = state.made.length, inits = state.inits;
  state.offered = {index: {modelName: 'MicroduckJawLocked'}, base: new URL('http://page.test/prebuilt/fmu/i.json')};
  const {result, error} = await send({type: 'prepare', sources});
  assert.equal(error, undefined);
  assert.equal(state.made.length, sdkCount, 'no SDK session was made');
  assert.equal(state.inits, inits, 'the compiler was not initialised');
  assert.deepEqual([result.preparation.controller, result.preparation.plant], ['fmu', 'fmu']);
  assert.ok(log.some(([label, what]) => label === 'controller' && what === 'free') && log.some(([label, what]) => label === 'plant' && what === 'free'));
  const [{options, session}] = state.opened;
  assert.deepEqual(options.parameters, wholeModelOptions(modelOptions('MicroduckJawLocked')).parameters);
  const step = await policyStep(0.02);
  assert.equal(step.error, undefined);
  assert.equal(step.result.time, 0.02);
  const written = Object.assign({}, ...session.writes);
  for (const name of ['forwardVelocity', 'previousPolicyAction[1]', 'policyAction[14]', 'cameraTimestamp']) assert.ok(name in written, name);
  for (const name of ['trunkGyro[1]', 'gravityRow[1]', 'policyHome[1]', 'policyPosition[1]']) assert.ok(!(name in written), name);
  assert.equal(written['forwardVelocity'], 0.1);
  assert.equal(written.usePolicyController,1);assert.equal(written.usePolicyPosition,1);
  const phase=log.filter(([label])=>label==='fmu');
  const advance=phase.findIndex(([,what])=>what==='advance');
  const observation=phase.findIndex(([,what,names])=>what==='read'&&names.includes('policyObservation[1]'));
  const action=phase.findIndex(([,what,values])=>what==='write'&&'policyAction[1]' in values);
  const mapping=phase.findIndex(([,what,names])=>what==='read'&&names.includes('positionCommand[1]'));
  const snapshot=phase.findIndex(([,what,names],i)=>i>advance&&what==='read'&&names.includes('bodyPosition[1,1]'));
  assert(observation>=0&&observation<action&&action<mapping&&mapping<advance&&advance<snapshot);
  assert(!phase.slice(advance+1).some(([,what])=>what==='write'),'history is not published after advance/before snapshot');
  await send({type: 'reset'});
  assert.equal(session.resets, 1, 'one reset for the one session');
  state.previousFmu=session;
});

test('a fault in the FMU is reported, and prepare starts a new session', async () => {
  state.faultNext = true;
  const failed = await policyStep(0.04);
  assert.match(failed.error, /RuntimeError: unreachable/);
  const old=state.opened.at(-1).session,advances=log.filter(([label,what])=>label==='fmu'&&what==='advance').length;
  assert.match((await policyStep(0.06)).error,/RuntimeError: unreachable/);
  assert.match((await send({type:'reset'})).error,/Prepare the simulation again/);
  assert.equal(log.filter(([label,what])=>label==='fmu'&&what==='advance').length,advances);
  assert.equal(old.resets,1,'the refused reset never enters the faulted instance');
  const again = await send({type: 'prepare', sources});
  assert.equal(again.error, undefined);
  assert.equal(state.opened.length, 2);
  assert.equal(old.frees,1,'aliased old FMU freed once');
  assert.equal((await policyStep(0.02)).error, undefined);
});

test('worker reset returns a frame at zero, resets an aliased FMU once and clears policy history',async()=>{
 const session=state.opened.at(-1).session,count=session.resets;
 assert.equal((await send({type:'reset'})).result.time,0);
 assert.equal(session.resets,count+1,'plant/controller aliases reset once');
 const before=session.writes.length;
 assert.equal((await policyStep(.02)).error,undefined);
 const history=session.writes.slice(before).find(row=>'hasPreviousPositionCommand' in row);
 assert.equal(history.hasPreviousPositionCommand,0);
 for(const name of [...vector('previousPolicyAction',14),...vector('previousCommand',3),...vector('previousPositionCommand',15)])assert.equal(history[name],0,name);
});

test('event-needed refusal becomes walk_error without a success frame; recovery needs prepare', {timeout:3000},async t=>{
 // This is a scripted session error, not an actual guest event. The pure outcome test
 // checks the real session's flag rule; this checks its propagation through the worker.
 state.eventNext=true;
 let timer;
 const start=notifications.length,failed=new Promise((resolve,reject)=>{
  // The fixture unrefs its task channel; keep this awaited task alive with a bounded timer.
  timer=setTimeout(()=>reject(Error('missing walk_error')),2000);
  notification=m=>{if(m.type==='walk_error'){clearTimeout(timer);resolve(m);}};
 });
 t.after(()=>{clearTimeout(timer);notification=undefined;});
 const started=await send({type:'walk_start',generation:1,twist:[0,0,0],mode:'unpaced'});
 assert.equal(started.result.generation,1);
 const error=await failed;notification=undefined;
 assert.equal(error.generation,1);assert.match(error.error,/event-handling-needed true/);
 assert.deepEqual(notifications.slice(start).map(m=>m.type),['walk_error']);
 assert.match((await send({type:'walk_stop',generation:1})).error,/event-handling-needed true/);
 assert.match((await send({type:'reset'})).error,/Prepare the simulation again/);
 assert.equal((await send({type:'prepare',sources})).error,undefined);
 assert.equal((await policyStep(.02)).error,undefined);
});

test('FMU offered but unusable: SDK sessions with the reason recorded', async () => {
  state.offered = {fallback: 'edited page source MicroduckJawLocked.mo'};
  let {result} = await send({type: 'prepare', sources});
  assert.deepEqual([result.preparation.plant, result.preparation.fmu_fallback], ['prebuilt', 'edited page source MicroduckJawLocked.mo']);
  state.offered = {index: {modelName: 'MicroduckJawLocked'}, base: new URL('http://page.test/prebuilt/fmu/i.json')};
  state.openFails = true;
  ({result} = await send({type: 'prepare', sources}));
  assert.deepEqual([result.preparation.plant, result.preparation.fmu_fallback], ['prebuilt', 'core module download failed: 404']);
  assert.equal((await policyStep(0.02)).error, undefined);
});


test('a staged first-frame failure frees the new session once and falls back without alias double-free',async()=>{
 state.openFails=false;state.readFails=false;
 state.offered={index:{modelName:'MicroduckWholeSystem'},base:new URL('http://page.test/prebuilt/fmu/i.json')};
 assert.equal((await send({type:'prepare',sources})).error,undefined);
 const old=state.opened.at(-1).session;
 state.readFails=true;
 const fallback=await send({type:'prepare',sources});
 state.readFails=false;
 const failedNext=state.opened.at(-1).session;
 assert.equal(failedNext.frees,1);assert.equal(old.frees,1);
 assert.equal(fallback.error,undefined);assert.equal(fallback.result.preparation.plant,'prebuilt');
 assert.match(fallback.result.preparation.fmu_fallback,/first frame getter refused/);
});

test('requireFmu: an absent, unusable or failed FMU refuses before any SDK work',async()=>{
 state.openFails=false;state.readFails=false;
 const sdk=()=>[state.made.length,state.inits];
 const cases=[
  [undefined,/FMU required: no FMU is offered/],
  [{fallback:'edited page source MicroduckJawLocked.mo'},/FMU required: edited page source MicroduckJawLocked\.mo/],
  [{index:{modelName:'MicroduckWholeSystem'},base:new URL('http://page.test/prebuilt/fmu/i.json')},/FMU required: core module download failed: 404/,true],
 ];
 for(const [offered,refusal,openFails] of cases){
  state.offered=offered;state.openFails=!!openFails;
  const before=sdk();
  const {result,error}=await send({type:'prepare',sources,requireFmu:true});
  assert.equal(result,undefined);assert.match(error,refusal);
  assert.deepEqual(sdk(),before,'no SDK session or compiler init');
 }
 state.openFails=false;
 state.offered={index:{modelName:'MicroduckWholeSystem'},base:new URL('http://page.test/prebuilt/fmu/i.json')};
 const {result,error}=await send({type:'prepare',sources,requireFmu:true});
 assert.equal(error,undefined);
 assert.deepEqual([result.preparation.controller,result.preparation.plant],['fmu','fmu']);
 assert.equal(state.opened.at(-1).options.downloadFirst,true,'qualification receives every body before compiling');
 assert.equal((await send({type:'prepare',sources})).error,undefined);
 assert.equal(state.opened.at(-1).options.downloadFirst,false,'ordinary visits keep streaming compilation');
});
