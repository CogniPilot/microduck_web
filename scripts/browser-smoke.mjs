import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {serve} from './serve.mjs';

const root = path.resolve(process.argv[2] ?? 'site');
const output = path.resolve(process.argv[3] ?? 'test-results');
await mkdir(output, {recursive: true});
const {server, url} = await serve(root);
let browser;
const result = {url, started_utc: new Date().toISOString(), page_errors: [], failed_responses: [], console: []};
try {
  browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE,
    args:['--no-sandbox', '--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror', error => result.page_errors.push(String(error)));
  page.on('console', event => result.console.push({type:event.type(),text:event.text()}));
  page.on('response', response => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico'))
      result.failed_responses.push({status:response.status(),url:response.url()});
  });
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
  await page.waitForFunction(() => !document.querySelector('#step-simulation').disabled ||
    /unavailable|failed|exceeded/i.test(document.querySelector('#simulation-status').textContent), null, {timeout:360000});
  result.simulation_status = await page.locator('#simulation-status').innerText();
  assert.equal(await page.locator('#step-simulation').isEnabled(), true, result.simulation_status);
  await page.locator('#step-simulation').click();
  await page.waitForFunction(() => document.querySelector('#view-mode').textContent.includes('0.020'), null, {timeout:60000});
  result.step = await page.locator('#view-mode').innerText();
  assert.match(await page.locator('#demo-configuration').innerText(), /softened contacts and relaxed RK tolerances/);
  await page.locator('#walk-mode').click();
  await page.waitForFunction(() => /Live speed: [0-9]+\.[0-9]+× real time/.test(document.querySelector('#simulation-speed').textContent), null, {timeout:60000});
  result.live_speed = await page.locator('#simulation-speed').innerText();
  result.overlay_visibility = await page.evaluate(() => Object.fromEntries(['simulation-speed','demo-configuration'].map(id=>{const element=document.getElementById(id),r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.left+Math.min(10,r.width/2),r.top+r.height/2);return [id,{inside:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,uncovered:hit===element||element.contains(hit)}];})));
  for(const value of Object.values(result.overlay_visibility)){assert.equal(value.inside,true);assert.equal(value.uncovered,true);}
  assert.ok(Number(result.live_speed.match(/Live speed: ([0-9.]+)/)[1]) > 0);
  await page.locator('#walk-mode').click();
  await page.waitForFunction(() => !document.querySelector('#step-simulation').disabled, null, {timeout:60000});
  await page.screenshot({path:path.join(output,'pages.png'),fullPage:true});
  await page.locator('#stop-simulation').click();
  assert.deepEqual(result.page_errors, []);
  assert.deepEqual(result.failed_responses, []);
  result.passed = true;
} catch (error) {result.passed=false;result.error=String(error);throw error;}
finally {
  result.ended_utc=new Date().toISOString();
  await writeFile(path.join(output,'browser.json'),JSON.stringify(result,null,2)+'\n');
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify(result));
