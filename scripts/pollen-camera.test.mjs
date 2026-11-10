import test from 'node:test';
import assert from 'node:assert/strict';
import {PerspectiveCamera,Vector3} from '../site/vendor/three.module.js';
import {createCameraFollower} from '../site/pollen/camera-follow.js';
const near=(actual,expected)=>actual.forEach((x,i)=>assert(Math.abs(x-expected[i])<1e-12,`${actual} != ${expected}`));

test('Following preserves camera framing and manual orbit/pan through walking and Stop',()=>{
  const camera=new PerspectiveCamera();camera.position.set(3,2,1);const controls={target:new Vector3(0,.13,0)},follow=createCameraFollower(camera,controls);
  follow.update(new Vector3(2,.2,-1));near(camera.position.toArray(),[5,2,0]);near(controls.target.toArray(),[2,.13,-1]);
  camera.position.add(new Vector3(.3,.4,.5));controls.target.add(new Vector3(.3,.4,.5));
  follow.update(new Vector3(3,.4,4));near(camera.position.toArray(),[6.3,2.4,5.5]);near(controls.target.toArray(),[3.3,.53,4.5]);
  follow.restore();near(camera.position.toArray(),[3.3,2.4,1.5]);near(controls.target.toArray(),[.3,.53,.5]);
});

test('Arena view stays fixed; Robot reframes at the current body and re-enables following',()=>{
  const camera=new PerspectiveCamera();camera.position.set(3,2,1);const controls={target:new Vector3(0,.13,0)},follow=createCameraFollower(camera,controls);
  follow.hold();follow.update(new Vector3(7,.5,8));near(camera.position.toArray(),[3,2,1]);near(controls.target.toArray(),[0,.13,0]);
  follow.home();near(camera.position.toArray(),[10,2,9]);near(controls.target.toArray(),[7,.13,8]);
  follow.update(new Vector3(8,.5,9));near(camera.position.toArray(),[11,2,10]);follow.restore();near(camera.position.toArray(),[3,2,1]);
});

test('Nonfinite follow data holds the last camera and the last finite origin',()=>{
  const camera=new PerspectiveCamera();camera.position.set(3,2,1);const controls={target:new Vector3(0,.13,0)},follow=createCameraFollower(camera,controls);
  follow.update(new Vector3(2,.2,-1));
  for(const point of [undefined,new Vector3(NaN,0,0),new Vector3(0,Infinity,0),new Vector3(0,0,NaN)]){
    assert.equal(follow.update(point),false);near(camera.position.toArray(),[5,2,0]);near(controls.target.toArray(),[2,.13,-1]);
  }
  follow.restore();near(camera.position.toArray(),[3,2,1]);
});
