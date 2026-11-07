import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const checker = fileURLToPath(new URL('./check-site.mjs', import.meta.url));
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'microduck-package-'));
  try {
    const site = path.join(root, 'site');
    const required = ['index.html','app.js','physics.worker.js','policy-contract.js',
      'walking-controls.js','sources/manifest.json','policies/velstand.onnx'];
    for (const file of required) {
      await mkdir(path.dirname(path.join(site,file)), {recursive:true});
      await writeFile(path.join(site,file), 'fixture');
    }
    const check = () => spawnSync(process.execPath, [checker, site], {cwd:root,encoding:'utf8'});
    const mesh = 'synthetic mesh fixture';
    const hash = createHash('sha256').update(mesh).digest('hex');
    const addMesh = async (name='assets/part.stl') => {
      await mkdir(path.dirname(path.join(site,name)), {recursive:true});
      await writeFile(path.join(site,name),mesh);
    };
    const approve = async record => writeFile(path.join(root,'mesh-clearance.json'),
      JSON.stringify(record ?? {schema_version:1,decision:'synthetic test-only approval',files:{'assets/part.stl':hash}}));
    await run({root,site,check,addMesh,approve,hash});
  } finally {await rm(root,{recursive:true,force:true});}
}
test('mesh-free package needs no clearance', () => fixture(async ({check}) => {
  assert.equal(check().status,0);
}));
test('STLs without a clearance fail, including uppercase extensions', () => fixture(async ({check,addMesh}) => {
  await addMesh('assets/part.STL');
  const result=check(); assert.notEqual(result.status,0); assert.match(result.stderr,/owner-approved/);
}));
test('exact synthetic clearance admits exactly those bytes', () => fixture(async ({check,addMesh,approve}) => {
  await addMesh(); await approve(); assert.equal(check().status,0);
}));
test('a changed mesh invalidates its clearance', () => fixture(async ({site,check,addMesh,approve}) => {
  await addMesh(); await approve(); await writeFile(path.join(site,'assets/part.stl'),'changed');
  const result=check(); assert.notEqual(result.status,0); assert.match(result.stderr,/hash mismatch/);
}));
test('an additional mesh is not covered by old approval', () => fixture(async ({check,addMesh,approve}) => {
  await addMesh(); await approve(); await addMesh('assets/extra.stl');
  const result=check(); assert.notEqual(result.status,0); assert.match(result.stderr,/exactly/);
}));
test('clearance for another path is refused', () => fixture(async ({check,addMesh,approve,hash}) => {
  await addMesh(); await approve({schema_version:1,decision:'synthetic',files:{'../part.stl':hash}});
  const result=check(); assert.notEqual(result.status,0); assert.match(result.stderr,/exactly/);
}));
test('blank approval reference is refused', () => fixture(async ({check,addMesh,approve,hash}) => {
  await addMesh(); await approve({schema_version:1,decision:' ',files:{'assets/part.stl':hash}});
  const result=check(); assert.notEqual(result.status,0); assert.match(result.stderr,/Invalid/);
}));
test('malformed clearance is refused', () => fixture(async ({root,check,addMesh}) => {
  await addMesh(); await writeFile(path.join(root,'mesh-clearance.json'),'{');
  const result=check(); assert.notEqual(result.status,0); assert.match(result.stderr,/valid owner-approved/);
}));
