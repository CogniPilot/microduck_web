import test from 'node:test';
import assert from 'node:assert/strict';
import {Raycaster,Vector3} from '../site/vendor/three.module.js';
import {makeInfiniteGrid} from '../site/pollen/arena.js';

test('Flat floor preserves the source grid surface and shader with two triangles',()=>{
  const original=makeInfiniteGrid(),flat=makeInfiniteGrid({segments:1});
  assert.equal(original.geometry.index.count/3,131072);assert.equal(flat.geometry.index.count/3,2);
  assert.equal(flat.material.vertexShader,original.material.vertexShader);assert.equal(flat.material.fragmentShader,original.material.fragmentShader);
  assert.equal(flat.material.uniforms.uTopoScale.value,0);assert.deepEqual(flat.material.uniforms,original.material.uniforms);
  original.updateMatrixWorld(true);flat.updateMatrixWorld(true);
  for(const x of [-14,-.27,12])for(const z of [-13,.39,14]){
    const ray=new Raycaster(new Vector3(x,2,z),new Vector3(0,-1,0));
    const a=ray.intersectObject(original)[0],b=ray.intersectObject(flat)[0];
    assert(a&&b);assert(a.point.distanceTo(b.point)<1e-10);assert(Math.abs(a.distance-b.distance)<1e-10);
  }
  for(const mesh of [original,flat]){mesh.geometry.dispose();mesh.material.dispose();}
});
