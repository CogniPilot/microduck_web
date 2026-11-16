// Write the first frame of a recording as its own small file, so the page can draw the
// preview before the full recording arrives. Nothing is computed: frame 0 is copied as is.
// usage: node scripts/slice-recording-preview.mjs pretrained-walk
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';

const name = process.argv[2];
if (!/^[a-z-]+$/.test(name ?? '')) throw Error('usage: slice-recording-preview.mjs <recording-name>');
const source = new URL(`../site/recordings/${name}.json`, import.meta.url);
const bytes = await readFile(source);
const recording = JSON.parse(bytes);
if (!recording.frames?.length) throw Error(`${name}.json has no frames`);
const first = {
  label: recording.label,
  kind: recording.kind,
  first_frame_of: {file: `${name}.json`, sha256: createHash('sha256').update(bytes).digest('hex'), frame: 0},
  frames: [recording.frames[0]]
};
await writeFile(new URL(`../site/recordings/${name}.first.json`, import.meta.url), JSON.stringify(first) + '\n');
