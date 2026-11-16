// Producer-only full source read. The browser never imports this Node module.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {modelOptions} from '../site/simulation-options.js';
import {LEGACY_MODEL, WHOLE_MODEL, WRAPPER_FILE, STANDARD_PIN_FILE, STANDARD_PIN_SHA256,
  STANDARD_SOURCE_COUNT, PAGE_SOURCE_COUNT, pageBinding} from '../site/fmu-page-contract.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = name => typeof name === 'string' && name.endsWith('.mo') && !name.startsWith('/') &&
 !name.includes('\\') && !name.includes('\0') && !name.split('/').some(x => !x || x === '.' || x === '..');

export async function pageBuildInputs(directory) {
 const pinBytes = await readFile(path.join(directory, STANDARD_PIN_FILE));
 if (hash(pinBytes) !== STANDARD_PIN_SHA256) throw Error('The current page library pin differs.');
 const pin = JSON.parse(pinBytes), standard = JSON.parse(await readFile(path.join(directory, 'msl-sources.json'), 'utf8'));
 const names = JSON.parse(await readFile(path.join(directory, 'sources/manifest.json'), 'utf8'));
 if (!Array.isArray(names) || names.length !== PAGE_SOURCE_COUNT || new Set(names).size !== names.length || !names.every(safe))
  throw Error('The current page needs exactly 243 distinct safe Modelica source keys.');
 if (Object.keys(pin.files).length !== STANDARD_SOURCE_COUNT ||
     Object.keys(standard).length !== STANDARD_SOURCE_COUNT ||
     Object.keys(standard).some(name => !Object.hasOwn(pin.files, name)))
  throw Error('The full 29-source standard library does not match its pin.');
 const sources = {};
 for (const [name, digest] of Object.entries(pin.files)) {
  if (typeof standard[name] !== 'string' || hash(Buffer.from(standard[name])) !== digest)
   throw Error('The actual standard-library source differs: ' + name);
  sources[name] = digest;
 }
 for (const name of names) {
  if (Object.hasOwn(sources, name)) throw Error('Overlapping Modelica source key: ' + name);
  sources[name] = hash(await readFile(path.join(directory, 'sources', name)));
 }
 if (!Object.hasOwn(sources, LEGACY_MODEL + '.mo') || !Object.hasOwn(sources, 'MicroduckPolicyInterface.mo') ||
     Object.hasOwn(sources, WHOLE_MODEL + '.mo')) throw Error('Incorrect editable page model/source set.');
 const wrapper = await readFile(path.join(directory, WRAPPER_FILE));
 if (!wrapper.length) throw Error('The whole-system wrapper is empty.');
 sources[WHOLE_MODEL + '.mo'] = hash(wrapper);
 // Avoid executing an arbitrary selected directory's configuration module. The
 // build tool owns the current configuration; the selected site's bytes must match.
 if (hash(await readFile(path.join(directory, 'simulation-options.js'))) !==
     hash(await readFile(new URL('../site/simulation-options.js', import.meta.url))))
  throw Error('The selected page simulation options differ from this producer.');
 return {sources, sourceModel: WHOLE_MODEL, pageBinding: await pageBinding(modelOptions(LEGACY_MODEL))};
}
