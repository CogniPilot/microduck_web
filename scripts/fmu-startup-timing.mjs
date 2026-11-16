import {checkFmuPageFrame} from './fmu-browser-receipts.mjs';
// Qualification metadata only. No body reads, engine, route interception or model imports.
export function summarizeFmuStartup(trace, resources, index, offer, siteUrl) {
 const output = [];
 const starts = trace?.events?.filter(e => e.direction === 'command' && e.data?.type === 'prepare') ?? [];
 for (const start of starts) {
  const fail = reason => ({worker:start.worker, command:start.data.id, observed:false,
   reason, targetMs:1000, withinTarget:null});
  const replies = trace.events.filter(e => e.worker === start.worker && e.direction === 'reply' && e.data?.id === start.data.id);
  if (trace.overflow || replies.length !== 1) { output.push(fail('missing/duplicate/overflowed prepare evidence')); continue; }
  const reply = replies[0], frame = reply.data?.result;
  try {
   if (reply.data?.error) throw Error('prepare error');
   checkFmuPageFrame(frame, index, {prepare:true});
   if (frame.time !== 0) throw Error('prepare time is not zero');
  } catch { output.push(fail('prepare did not pass complete zero-time FMU frame validation')); continue; }
  if (!Number.isFinite(start.epochMs) || !Number.isFinite(reply.epochMs) || reply.epochMs < start.epochMs) {
   output.push(fail('missing/nonmonotonic page clock')); continue;
  }
  let required;
  try {
   const indexUrl = new URL('prebuilt/' + offer.fmu.index, siteUrl), base = new URL('./', indexUrl);
   if (!index.glue?.file || !index.coreModules || !Object.keys(index.coreModules).length) throw Error();
   required = [...new Set([indexUrl.href, new URL(index.glue.file, base).href,
    ...Object.values(index.coreModules).map(entry => { if (!entry.file) throw Error(); return new URL(entry.file, base).href; })])];
  } catch { output.push(fail('incomplete artifact file identity')); continue; }
  const downloads = [], missing = [];
  for (const url of required) {
   const rows = resources.filter(row => row.url === url && Number.isFinite(row.startTime) &&
    row.startTime > 0 && Number.isFinite(row.responseEnd) && row.responseEnd >= 0 &&
    row.startTime + row.responseEnd <= reply.epochMs);
   if (!rows.length) { missing.push(url); continue; }
   const row = rows.reduce((a,b) => a.startTime + a.responseEnd >= b.startTime + b.responseEnd ? a : b);
   downloads.push({url,startEpochMs:row.startTime,endEpochMs:row.startTime + row.responseEnd});
  }
  if (missing.length) { output.push({...fail('required download timing unobserved'),missing}); continue; }
  const lastRequiredByteEpochMs = Math.max(...downloads.map(row => row.endEpochMs));
  // Already cached/downloaded bytes do not start a new user's prepare clock in the past.
  const postDownloadStartEpochMs = Math.max(start.epochMs, lastRequiredByteEpochMs);
  const postDownloadMs = reply.epochMs - postDownloadStartEpochMs;
  output.push({worker:start.worker,command:start.data.id,observed:true,
   prepareStartEpochMs:start.epochMs,readyEpochMs:reply.epochMs,
   prepareElapsedMs:reply.epochMs-start.epochMs,lastRequiredByteEpochMs,
   postDownloadStartEpochMs,postDownloadMs,downloads,
   targetMs:1000,withinTarget:postDownloadMs < 1000,
   scope:'URL-observed last-required-byte baseline to a validated zero-time FMU prepare-frame receipt; baseline is later of prepare request or last observed required index/glue/core response end. Not paint, overall readiness, cold causal download proof, cache/SW source, all-instance or fidelity proof.'});
 }
 return output.length ? output : [{observed:false,reason:'no prepare evidence',targetMs:1000,withinTarget:null}];
}
