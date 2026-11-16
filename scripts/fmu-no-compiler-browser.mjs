// Real-browser check: an FMU visit through Waddle In loads no compiler or SDK session code.
//
//   node scripts/fmu-no-compiler-browser.mjs <site> <playwright-core index.mjs> <chromium> [timeout-s] [advance-s] [sensors]
//
// <site> must already offer the FMU in prebuilt/manifest.json (scripts/build-fmu.mjs).
// The page is opened with ?fmu=require, so an unusable FMU fails instead of falling back.
// Every request of the page and its workers is recorded; the check fails if any request
// is compiler or SDK-session code, or if the simulation never reports a live FMU frame.
import {serve} from './serve.mjs';

// Page and worker marks as ms after navigation, in time order.
const timeline = (pageEpoch, workerEpoch = {}) => Object.fromEntries(Object.entries({...pageEpoch, ...workerEpoch})
  .filter(([name]) => name !== 'navigation').sort(([, a], [, b]) => a - b)
  .map(([name, at]) => [name, Math.round(at - pageEpoch.navigation)]));

const [site, playwrightEntry, executable, timeoutArg = '180', advanceArg = '0', sensorsArg] = process.argv.slice(2);
if (!site || !playwrightEntry || !executable) {
  console.error('usage: fmu-no-compiler-browser.mjs <site> <playwright-core index.mjs> <chromium> [timeout-s]');
  process.exit(2);
}
// Modules and artifacts that only the SDK path needs.
export const COMPILER_CODE = /\/(model-runtime\.js|prebuilt-session\.js|rumoca_bind_wasm[^/]*|[^/]*\.runtime\.bin(\.gz)?|MicroduckJawLocked\.json\.gz|MicroduckPolicyInterface\.json\.gz)(\?|$)/;

const {chromium} = await import(playwrightEntry);
const {server, url} = await serve(site);
const close = () => new Promise(resolve => server.close(resolve));
const browser = await chromium.launch({executablePath: executable, args: ['--no-sandbox']});
const requests = [], errors = [], failed = [];
try {
  const context = await browser.newContext();
  context.on('request', request => requests.push(request.url()));
  context.on('response', response => { if (response.status() >= 400) failed.push(response.status() + ' ' + response.url()); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const started = performance.now();
  await page.goto(new URL('index.html?fmu=require', url).href);
  // Page-side marks on the same absolute clock as the worker's (ms since the epoch).
  const pageEpoch = {navigation: await page.evaluate(() => performance.timeOrigin), loaded: await page.evaluate(() => performance.timeOrigin + performance.now())};
  await page.waitForFunction(() => !document.getElementById('enter-scene').disabled, null, {timeout: 60000});
  pageEpoch.enter_enabled = await page.evaluate(() => performance.timeOrigin + performance.now());
  await page.click('#enter-scene');
  pageEpoch.clicked = await page.evaluate(() => performance.timeOrigin + performance.now());
  // The worker's first FMU frame is reported as a whole-system FMU status.
  await page.waitForFunction(() => /whole-system FMU|unavailable|stopped|failed/i.test(document.getElementById('simulation-status')?.textContent ?? ''),
    null, {timeout: Number(timeoutArg) * 1000});
  const status = await page.evaluate(() => document.getElementById('simulation-status')?.textContent ?? '');
  pageEpoch.status_seen = await page.evaluate(() => performance.timeOrigin + performance.now());
  // Only the worker's success frames say ready or name the policy; refusals start otherwise.
  const entered = /^(Simulation ready · whole-system FMU loaded|Pretrained Pollen velstand · whole-system FMU|Whole-system FMU)/.test(status);
  const compiler = requests.filter(request => COMPILER_CODE.test(new URL(request).pathname));
  const fmuFiles = requests.filter(request => /\/prebuilt\/fmu\//.test(request));
  // Advance evidence after readiness: the page's own live-speed report (simulated
  // and wall seconds), its sensor frame counters, and whether the rendered view changes.
  let advance;
  // Camera and ToF frames are rendered only while the page's sensor rendering is on (off by default).
  // Its checkbox sits in a panel the scene view hides, so set it as its own change handler expects.
  if (entered && sensorsArg === 'sensors') await page.evaluate(() => {
    const toggle = document.getElementById('sensor-rendering');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', {bubbles: true}));
  });
  if (entered && Number(advanceArg) > 0) {
    const sample = () => page.evaluate(() => ({
      speed: document.getElementById('simulation-speed')?.textContent ?? null,
      sensors: globalThis.microduckSensorStats ? JSON.parse(JSON.stringify(globalThis.microduckSensorStats)) : null}));
    const shot = async () => (await import('node:crypto')).createHash('sha256').update(await page.screenshot()).digest('hex');
    const before = {...await sample(), view: await shot()};
    await page.waitForTimeout(Number(advanceArg) * 1000);
    const after = {...await sample(), view: await shot()};
    advance = {seconds: Number(advanceArg), before, after, view_changed: before.view !== after.view};
  }
  const receipt = entered ? await page.evaluate(() => globalThis.microduckExecutionReceipt ?? null) : null;
  const pageMarks = await page.evaluate(() => globalThis.microduckLoadMarks ?? {});
  console.log(JSON.stringify({entered, status, seconds: (performance.now() - started) / 1000,
    requests: requests.length, fmu_requests: fmuFiles.length, compiler_requests: compiler, failed, errors,
    load: receipt?.load ?? null, startup: receipt?.startup ?? null, timeline_ms: timeline({...pageEpoch, ...pageMarks}, receipt?.worker_epoch_ms), advance}, null, 1));
  if (!entered) throw Error('the FMU simulation did not start: ' + status);
  if (!fmuFiles.length) throw Error('no FMU file was requested');
  if (compiler.length) throw Error('the FMU visit requested compiler or SDK code: ' + compiler.join(', '));
  console.log('FMU_NO_COMPILER_PASS');
} finally {
  await browser.close();
  await close();
}
