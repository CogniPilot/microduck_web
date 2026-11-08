import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {modelDrafts, draftPrefix} from '../site/model-drafts.js';
import {checkControllerInputs} from '../site/model-inputs.js';
import init, * as compiler from '../site/vendor/rumoca-b2cb0f02-release/rumoca_bind_wasm.js';

const name = 'MicroduckPolicyInterface.mo';
const oldKey = 'microduck-lab-draft-v2-named:' + name;
function storage(entries = []) {
  const data = new Map(entries);
  return {data, getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key)};
}

test('an older model cannot override the current worker contract and remains recoverable', () => {
  const store = storage([[oldKey, 'older edited Modelica'], ['unrelated', 'untouched']]);
  const drafts = modelDrafts(store);
  assert.equal(drafts.get(name), null);
  assert.deepEqual(drafts.previous([name]), {[name]: 'older edited Modelica'});
  assert.equal(store.data.get(oldKey), 'older edited Modelica');
  assert.equal(store.data.get('unrelated'), 'untouched');
});

test('new edits and Restore affect only the current version', () => {
  const store = storage([[oldKey, 'older source']]);
  const drafts = modelDrafts(store);
  drafts.set(name, 'current edited source');
  assert.equal(drafts.get(name), 'current edited source');
  assert.equal(store.data.get(draftPrefix + name), 'current edited source');
  drafts.remove(name);
  assert.equal(drafts.get(name), null);
  assert.equal(store.data.get(oldKey), 'older source');
});

test('blocked storage uses defaults and reports a failed save to the existing caller', () => {
  const refused = () => { throw Error('storage unavailable'); };
  const drafts = modelDrafts({getItem: refused, setItem: refused, removeItem: refused});
  assert.equal(drafts.get(name), null);
  assert.deepEqual(drafts.previous([name]), {});
  assert.throws(() => drafts.set(name, 'source'), /storage unavailable/);
});

test('the actual current Modelica input catalog satisfies routing before walking', async () => {
  const site = new URL('../site/', import.meta.url);
  await init({module_or_path: fs.readFileSync(new URL('vendor/rumoca-b2cb0f02-release/rumoca_bind_wasm_bg.wasm', site))});
  const source = fs.readFileSync(new URL('sources/' + name, site), 'utf8');
  const session = compiler.WasmSimulationSession.withInteractiveConfiguration(source,
    'MicroduckPolicyInterface', JSON.stringify({dt: .002, solver: 'rk-like', atol: 1e-8,
      rtol: 1e-6, execution_policy: 'auto', initial_inputs: [], parameters: {}}));
  try {
    const names = JSON.parse(session.input_names());
    assert.doesNotThrow(() => checkControllerInputs(names));
    assert.throws(() => checkControllerInputs(names.filter(x => x !== 'previousCommand[1]')),
      /Restore file.*previousCommand\[1\]/);
  } finally { session.free(); }
});
