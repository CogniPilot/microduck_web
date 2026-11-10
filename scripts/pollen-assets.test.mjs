import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

test('Pinned GLB retains complete geometry for every existing visual mesh reference',()=>{
  const site=new URL('../site/',import.meta.url),bytes=fs.readFileSync(new URL('pollen/microduck.glb',site));
  const source=JSON.parse(fs.readFileSync(new URL('pollen/SOURCE.json',site)));
  const pin=source.files.find(x=>x.path==='pollen/microduck.glb');
  assert.equal(bytes.length,pin.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),pin.sha256);
  assert.equal(bytes.subarray(0,4).toString(),'glTF');assert.equal(bytes.readUInt32LE(4),2);assert.equal(bytes.readUInt32LE(8),bytes.length);
  assert.equal(bytes.readUInt32LE(16),0x4e4f534a);
  const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  const names=new Set(gltf.nodes.map(x=>x.extras?.meshFile||x.name));
  const xml=fs.readFileSync(new URL('robot.xml',site),'utf8');
  const attributes=text=>Object.fromEntries([...text.matchAll(/([\w_]+)="([^"]*)"/g)].map(x=>[x[1],x[2]]));
  const assets=new Map([...xml.matchAll(/<mesh\s+([^>]+)>/g)].map(m=>{const a=attributes(m[1]);return [a.name||a.file.split('/').pop().replace(/\.[^.]+$/,''),a.file];}));
  const visuals=[...xml.matchAll(/<geom\s+([^>]+)>/g)].map(m=>attributes(m[1])).filter(x=>x.class==='visual'&&x.mesh);
  assert(visuals.length>0);
  for(const visual of visuals){assert(assets.has(visual.mesh),'Undefined visual mesh '+visual.mesh);assert(names.has(assets.get(visual.mesh).split('/').pop()),'Missing visual mesh '+visual.mesh);}
  for(const mesh of gltf.meshes)for(const primitive of mesh.primitives){assert.equal(primitive.mode??4,4);assert(gltf.accessors[primitive.attributes.POSITION].count>0);assert.equal(gltf.accessors[primitive.indices].count%3,0);}
});
