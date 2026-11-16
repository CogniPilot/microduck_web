// Real-browser check: an FMU loads again and again in one browser context, and resets in one session.
//
//   node scripts/fmu-repeat-browser.mjs <site> <playwright-core index.mjs> <chromium> [sessions] [resets] [timeout-s]
//
// Each session reloads the page, so the physics worker and its FMU instance are created anew; a
// browser that leaks wasm memories or instances across sessions fails a later load. After the last
// load the simulation is reset `resets` times, each through the page's own Reset control, and must
// report a live FMU frame again. <site> must already offer the FMU (scripts/build-fmu.mjs).
import {serve} from './serve.mjs';

const [site, playwrightEntry, executable, sessionsArg = '10', resetsArg = '5', timeoutArg = '600'] =
  process.argv.slice(2);
if (!site || !playwrightEntry || !executable) {
  console.error('usage: fmu-repeat-browser.mjs <site> <playwright-core index.mjs> <chromium> [sessions] [resets] [timeout-s]');
  process.exit(2);
}
const READY = /^(Simulation ready · whole-system FMU loaded|Pretrained Pollen velstand · whole-system FMU|Whole-system FMU)/;
const STATUS = () => document.getElementById('simulation-status')?.textContent ?? '';

const {chromium} = await import(playwrightEntry);
const {server, url} = await serve(site);
const close = () => new Promise(resolve => server.close(resolve));
const browser = await chromium.launch({executablePath: executable, args: ['--no-sandbox']});
const sessions = [], resets = [], errors = [];
let failure;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const timeout = Number(timeoutArg) * 1000;
  for (let session = 0; session < Number(sessionsArg) && !failure; session++) {
    const started = performance.now();
    await page.goto(new URL('index.html?fmu=require', url).href);
    await page.waitForFunction(() => !document.getElementById('enter-scene').disabled, null, {timeout: 60000});
    await page.click('#enter-scene');
    await page.waitForFunction(() => /whole-system FMU|unavailable|stopped|failed/i.test(
      document.getElementById('simulation-status')?.textContent ?? ''), null, {timeout});
    const status = await page.evaluate(STATUS);
    const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const load = await page.evaluate(() => globalThis.microduckExecutionReceipt?.load ?? null);
    sessions.push({session, seconds: (performance.now() - started) / 1000, status, page_js_heap: heap, load});
    if (!READY.test(status)) failure = `session ${session} did not start: ${status}`;
  }
  for (let reset = 0; reset < Number(resetsArg) && !failure; reset++) {
    const started = performance.now();
    await page.waitForFunction(() => !document.getElementById('reset-simulation').disabled, null, {timeout});
    await page.click('#reset-simulation');
    await page.waitForFunction(() => !document.getElementById('reset-simulation').disabled, null, {timeout});
    const status = await page.evaluate(STATUS);
    resets.push({reset, seconds: (performance.now() - started) / 1000, status});
    if (/unavailable|stopped|failed|error/i.test(status)) failure = `reset ${reset} failed: ${status}`;
  }
} catch (error) {
  failure = String(error);
} finally {
  console.log(JSON.stringify({sessions, resets, errors, failure: failure ?? null}, null, 1));
  await browser.close();
  await close();
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log('FMU_REPEAT_PASS');
