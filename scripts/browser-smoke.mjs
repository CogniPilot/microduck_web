import {summarizeFmuStartup} from './fmu-startup-timing.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {installFmuReceiptCapture,auditFmuWorkerTrace} from './fmu-browser-receipts.mjs';
import {auditFmuPageRecoveryTrace} from './fmu-page-recovery-receipts.mjs';
import {canonicalJson,WHOLE_MODEL,LEGACY_MODEL} from '../site/fmu-page-contract.js';
import {launchSmokeBrowser} from './fmu-browser-launch.mjs';
import {serve} from './serve.mjs';

const root = path.resolve(process.argv[2] ?? 'site');
const output = path.resolve(process.argv[3] ?? 'test-results');
// Optional fourth argument: an actual native-admitted OFFER already installed in this staging site.
const offerPath=process.argv[4]&&path.resolve(process.argv[4]);
// Optional fifth argument: the operator-pinned provider/browser launch configuration.
const launchConfig=process.argv[5]&&path.resolve(process.argv[5]);
const recoveryMode=process.argv[6];
assert(recoveryMode===undefined||recoveryMode==='page-error-reprepare','unknown qualification mode');
if(recoveryMode)assert(offerPath&&launchConfig,'page-error qualification needs an actual offer and explicit launch config');
let expectedFmu;
if(offerPath){
 assert(!existsSync(output),'FMU qualification output must be fresh');
 const offer=JSON.parse(await readFile(offerPath));
 assert.equal(offer.model,WHOLE_MODEL);assert.equal(offer.selectedModel,LEGACY_MODEL);assert.equal(offer.nativeAdmission?.schema,1);
 const manifest=JSON.parse(await readFile(path.join(root,'prebuilt/manifest.json')));
 assert.equal(canonicalJson(manifest.models?.[LEGACY_MODEL]?.fmu),canonicalJson(offer.fmu),'staging page does not install the admitted offer');
 const indexPath=path.resolve(root,'prebuilt',offer.fmu.index);assert(indexPath.startsWith(path.join(root,'prebuilt')+path.sep),'index outside prebuilt');
 const bytes=await readFile(indexPath);assert.equal(createHash('sha256').update(bytes).digest('hex'),offer.fmu.sha256,'index hash differs');
 expectedFmu=JSON.parse(bytes);assert.equal(expectedFmu.modelName,WHOLE_MODEL);
 assert.equal(canonicalJson(expectedFmu.nativeAdmission),canonicalJson(offer.nativeAdmission),'index native admission differs');
 assert(typeof expectedFmu.instantiationToken==='string'&&expectedFmu.instantiationToken.length>0);
}
await mkdir(output, {recursive: true});
const {server, url} = await serve(root);
let browser,page;
const result = {url, started_utc: new Date().toISOString(), page_errors: [], failed_responses: [], console: [], resourceTimings: [], resourceTimingOverflow:false};
try {
  browser = await launchSmokeBrowser(launchConfig);
  page = await browser.newPage({viewport:{width:1440,height:1000}});
  // Passive metadata only; no routes, body reads or additional resource requests.
  page.context().on('requestfinished', request => {
    if(result.resourceTimings.length>=4096){result.resourceTimingOverflow=true;return;}
    try {const t=request.timing();result.resourceTimings.push({url:request.url(),startTime:t.startTime,responseEnd:t.responseEnd});}
    catch(error){result.resourceTimings.push({url:request.url(),timingError:String(error)});}
  });
  page.on('pageerror', error => result.page_errors.push(String(error)));
  page.on('console', event => result.console.push({type:event.type(),text:event.text()}));
  page.on('response', response => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico'))
      result.failed_responses.push({status:response.status(),url:response.url()});
  });
  if(expectedFmu)await page.addInitScript(installFmuReceiptCapture,{allowCommandRefusal:!!recoveryMode});
  await page.goto(url, {waitUntil:'networkidle',timeout:60000});
  await page.waitForFunction(() => document.querySelector('#joints')?.children.length >= 14, null, {timeout:60000});
  await page.evaluate(() => globalThis.microduckSourcesReady);
  result.isolation = await page.evaluate(() => ({crossOriginIsolated, sharedArrayBuffer:typeof SharedArrayBuffer}));
  assert.equal(result.isolation.crossOriginIsolated, false);
  assert.equal(result.isolation.sharedArrayBuffer, 'undefined');
  result.source_count = await page.locator('#source-file option').count();
  assert.ok(result.source_count > 200);
  result.inference = await page.evaluate(async () => {
    const ort = await import('./vendor/onnxruntime-1.31.1/ort.js');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = {
      mjs:new URL('./vendor/onnxruntime-1.31.1/ort-wasm-simd-threaded.js', location.href).href,
      wasm:new URL('./vendor/onnxruntime-1.31.1/ort-wasm-simd-threaded.wasm', location.href).href
    };
    const session = await ort.InferenceSession.create('./policies/velstand.onnx', {executionProviders:['wasm']});
    try {
      const output = await session.run({obs:new ort.Tensor('float32',new Float32Array(61),[1,61])});
      const actions = Array.from(output.actions.data);
      if (actions.length !== 14 || !actions.every(Number.isFinite)) throw Error('Invalid policy output');
      return {count:actions.length, finite:true, numThreads:ort.env.wasm.numThreads};
    } finally {await session.release();}
  });
  await page.locator('#enter-scene').click();
  if (!expectedFmu) {
    // Waddle in starts the accepted FMU walker automatically on the current page.
    await page.waitForFunction(() => {
      const r = globalThis.microduckExecutionReceipt;
      const t = Number(document.querySelector('#view-mode').textContent.match(/t = ([0-9.]+) s/)?.[1]);
      return (r?.engine === 'fmi3-ls-wasm' && r.refusal === null && t > 0 &&
        document.querySelector('#walk-mode').textContent === 'Pause walking' &&
        /Live speed: [0-9]+\.[0-9]+× real time/.test(document.querySelector('#simulation-speed').textContent)) ||
        /unavailable|failed|exceeded/i.test(document.querySelector('#simulation-status').textContent);
    }, null, {timeout:360000});
    result.simulation_status = await page.locator('#simulation-status').innerText();
    result.automaticWalking = await page.evaluate(() => ({
      receipt: globalThis.microduckExecutionReceipt,
      view: document.querySelector('#view-mode').textContent,
      walking: document.querySelector('#walk-mode').textContent,
      stepDisabled: document.querySelector('#step-simulation').disabled,
      speed: document.querySelector('#simulation-speed').textContent
    }));
    assert.equal(result.automaticWalking.receipt?.engine, 'fmi3-ls-wasm', result.simulation_status);
    assert.equal(result.automaticWalking.receipt.refusal, null);
    assert.equal(result.automaticWalking.receipt.model, WHOLE_MODEL);
    assert.ok(result.automaticWalking.receipt.instantiation_token?.length > 0);
    assert.equal(result.automaticWalking.walking, 'Pause walking');
    assert.equal(result.automaticWalking.stepDisabled, true);
    assert.ok(Number(result.automaticWalking.view.match(/t = ([0-9.]+) s/)?.[1]) > 0);
    assert.ok(Number(result.automaticWalking.speed.match(/Live speed: ([0-9.]+)/)?.[1]) > 0);
    await page.locator('#walk-mode').click();
    await page.waitForFunction(() => !document.querySelector('#step-simulation').disabled, null, {timeout:60000});
    const pausedTime = Number((await page.locator('#view-mode').innerText()).match(/t = ([0-9.]+) s/)?.[1]);
    assert.ok(Number.isFinite(pausedTime) && pausedTime > 0, 'automatic walk did not pause at an advancing time');
    const targetText = (pausedTime + 0.02).toFixed(3);
    await page.locator('#step-simulation').click();
    await page.waitForFunction(target => !document.querySelector('#step-simulation').disabled &&
      document.querySelector('#view-mode').textContent.includes('t = ' + target + ' s'), targetText, {timeout:60000});
  } else {
    // Keep the historical explicit-OFFER qualification contract unchanged. That
    // manual-before-walk flow is not qualified for automatic entry by this CI fix.
    await page.waitForFunction(() => !document.querySelector('#step-simulation').disabled ||
      /unavailable|failed|exceeded/i.test(document.querySelector('#simulation-status').textContent), null, {timeout:360000});
    result.simulation_status = await page.locator('#simulation-status').innerText();
    assert.equal(await page.locator('#step-simulation').isEnabled(), true, result.simulation_status);
    await page.locator('#step-simulation').click();
    await page.waitForFunction(() => document.querySelector('#view-mode').textContent.includes('0.020'), null, {timeout:60000});
  }
  result.step = await page.locator('#view-mode').innerText();
  assert.match(await page.locator('#demo-configuration').innerText(), /softened contacts, fixed-step Heun at 1 ms/);
  await page.locator('#walk-mode').click();
  await page.waitForFunction(() => /Live speed: [0-9]+\.[0-9]+× real time/.test(document.querySelector('#simulation-speed').textContent), null, {timeout:60000});
  result.live_speed = await page.locator('#simulation-speed').innerText();
  result.overlay_visibility = await page.evaluate(() => Object.fromEntries(['simulation-speed','demo-configuration'].map(id=>{const element=document.getElementById(id),r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+Math.min(10,r.width/2),r.top+r.height/2);return [id,{inside:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,uncovered:hit===element||element.contains(hit)}];})));
  for(const value of Object.values(result.overlay_visibility)){assert.equal(value.inside,true);assert.equal(value.uncovered,true);}
  assert.ok(Number(result.live_speed.match(/Live speed: ([0-9.]+)/)[1]) > 0);
  await page.locator('#walk-mode').click();
  await page.waitForFunction(() => !document.querySelector('#step-simulation').disabled, null, {timeout:60000});
  if(expectedFmu){
    await page.locator('#reset-simulation').click();
    await page.waitForFunction(() => !document.querySelector('#step-simulation').disabled&&document.querySelector('#view-mode').textContent.includes('0.000'),null,{timeout:60000});
    await page.locator('#step-simulation').click();
    await page.waitForFunction(() => !document.querySelector('#step-simulation').disabled&&document.querySelector('#view-mode').textContent.includes('0.020'),null,{timeout:60000});
    if(recoveryMode){
      // Validate the complete actual nominal prefix without inventing a stop event.
      const prefix=await page.evaluate(()=>globalThis.__fmuQualificationTrace);
      result.fmuNominalPrefix=auditFmuWorkerTrace(prefix,expectedFmu,{requireReset:true,requireTermination:false});
      await page.evaluate(()=>globalThis.__fmuArmCommandRefusal(1,.04));
      await page.locator('#step-simulation').click();
      await page.waitForFunction(()=>/Simulation stopped:.*FMU cannot advance backwards/.test(document.querySelector('#simulation-status').textContent),null,{timeout:60000});
      result.pageRefusal={status:await page.locator('#simulation-status').innerText(),prepareEnabled:await page.locator('#prepare-simulation').isEnabled(),stepDisabled:await page.locator('#step-simulation').isDisabled(),resetDisabled:await page.locator('#reset-simulation').isDisabled()};
      assert.equal(result.pageRefusal.prepareEnabled,true);assert.equal(result.pageRefusal.stepDisabled,true);assert.equal(result.pageRefusal.resetDisabled,true);
      await page.locator('#prepare-simulation').click();
      await page.waitForFunction(()=>!document.querySelector('#step-simulation').disabled&&document.querySelector('#view-mode').textContent.includes('0.000'),null,{timeout:360000});
      await page.locator('#step-simulation').click();
      await page.waitForFunction(()=>!document.querySelector('#step-simulation').disabled&&document.querySelector('#view-mode').textContent.includes('0.020'),null,{timeout:60000});
    }
  }
  await page.screenshot({path:path.join(output,'pages.png'),fullPage:true});
  await page.locator('#stop-simulation').click();
  if(expectedFmu){
    result.fmuTrace=await page.evaluate(()=>globalThis.__fmuQualificationTrace);
    result.fmuQualification=recoveryMode?auditFmuPageRecoveryTrace(result.fmuTrace,expectedFmu):auditFmuWorkerTrace(result.fmuTrace,expectedFmu,{requireReset:true});
    result.fmuOfferPath=offerPath;
  }
  assert.deepEqual(result.page_errors, []);
  assert.deepEqual(result.failed_responses, []);
  result.passed = true;
} catch (error) {result.passed=false;result.error=String(error);throw error;}
finally {
  if(expectedFmu&&!result.fmuTrace&&page)result.fmuTrace=await page.evaluate(()=>globalThis.__fmuQualificationTrace).catch(()=>null);
  if(expectedFmu)result.fmuStartupTiming=result.resourceTimingOverflow
    ? [{observed:false,reason:'resource timing overflow',targetMs:1000,withinTarget:null}]
    : summarizeFmuStartup(result.fmuTrace,result.resourceTimings,expectedFmu,JSON.parse(await readFile(offerPath)),url);
  result.ended_utc=new Date().toISOString();
  await writeFile(path.join(output,'browser.json'),JSON.stringify(result,null,2)+'\n');
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify(result));
