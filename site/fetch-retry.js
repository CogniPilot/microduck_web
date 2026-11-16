// GitHub Pages occasionally answers a static file with a 5xx or drops the connection, and a
// single such response among the page's few hundred source requests used to end the
// simulation. A transient failure (5xx status or network error) is retried after each of
// these pauses; a 4xx, an abort or an exhausted budget fails as before. Retrying changes
// only transport: the bytes a response carries are still checked by their consumers.
export const RETRY_DELAYS_MS = Object.freeze([250, 1000, 3000]);

// Resolves after `ms`, or rejects with the signal's reason as soon as it aborts.
export function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, {once: true});
  });
}

// Returns the final Response, as fetch does; callers keep their own `response.ok` checks.
export async function fetchWithRetry(url, {fetch: fetchFile = globalThis.fetch, signal, delays = RETRY_DELAYS_MS, wait = pause} = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetchFile(url, signal ? {signal} : undefined);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || attempt >= delays.length) throw error;
      await wait(delays[attempt], signal);
      continue;
    }
    if (response.status < 500 || attempt >= delays.length) return response;
    await wait(delays[attempt], signal);
  }
}
