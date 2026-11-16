import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchWithRetry, pause, RETRY_DELAYS_MS} from '../site/fetch-retry.js';

// A scripted transport: each entry is a status to answer with, or an Error to throw.
function transport(script) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init});
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return {status: next, ok: next >= 200 && next < 300};
  };
  return {calls, fetch};
}
const recordWaits = () => { const waits = []; return {waits, wait: async ms => { waits.push(ms); }}; };

test('a transient 503 is retried and the later success is returned', async () => {
  const {calls, fetch} = transport([503, 200]), {waits, wait} = recordWaits();
  const response = await fetchWithRetry('./sources/a.mo', {fetch, wait});
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [RETRY_DELAYS_MS[0]]);
});

test('a dropped connection is retried and the later success is returned', async () => {
  const {calls, fetch} = transport([new TypeError('Failed to fetch'), 200]), {wait} = recordWaits();
  assert.equal((await fetchWithRetry('./sources/a.mo', {fetch, wait})).status, 200);
  assert.equal(calls.length, 2);
});

test('an exhausted budget returns the last 5xx, so the caller fails as before', async () => {
  const {calls, fetch} = transport([503]), {waits, wait} = recordWaits();
  const response = await fetchWithRetry('./sources/a.mo', {fetch, wait});
  assert.equal(response.status, 503);
  assert.equal(response.ok, false);
  assert.equal(calls.length, RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(waits, [...RETRY_DELAYS_MS]);
});

test('an exhausted budget of network errors throws the last error', async () => {
  const {calls, fetch} = transport([new TypeError('Failed to fetch')]), {wait} = recordWaits();
  await assert.rejects(fetchWithRetry('./sources/a.mo', {fetch, wait}), /Failed to fetch/);
  assert.equal(calls.length, RETRY_DELAYS_MS.length + 1);
});

test('a 404 is not retried', async () => {
  const {calls, fetch} = transport([404, 200]), {waits, wait} = recordWaits();
  assert.equal((await fetchWithRetry('./sources/missing.mo', {fetch, wait})).status, 404);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('an abort during the pause stops retrying and rejects with the abort reason', async () => {
  const controller = new AbortController();
  const {calls, fetch} = transport([503, 200]);
  const pending = fetchWithRetry('./sources/a.mo', {fetch, signal: controller.signal, delays: [60000]});
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(new Error('stopped by the page'));
  await assert.rejects(pending, /stopped by the page/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal, controller.signal);
});

test('an aborted request is not retried', async () => {
  const controller = new AbortController();
  controller.abort();
  const abort = Object.assign(new Error('aborted'), {name: 'AbortError'});
  const {calls, fetch} = transport([abort, 200]), {waits, wait} = recordWaits();
  await assert.rejects(fetchWithRetry('./sources/a.mo', {fetch, wait, signal: controller.signal}), /aborted/);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('pause resolves after its delay and rejects at once on an already aborted signal', async () => {
  await pause(1);
  const controller = new AbortController();
  controller.abort(new Error('gone'));
  await assert.rejects(pause(60000, controller.signal), /gone/);
});
