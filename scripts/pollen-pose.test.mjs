import test from 'node:test';
import assert from 'node:assert/strict';
import {Group,Vector3} from '../site/vendor/three.module.js';
import {BODY_NAMES,createModelicaPoseView} from '../site/pollen/pose-view.js';

function setup(){
  const scene=new Group(),modelSpace=new Group(),hierarchy=new Group(),visualBodies=new Map();
  modelSpace.rotation.x=-Math.PI/2;scene.add(modelSpace);modelSpace.add(hierarchy);
  for(const name of BODY_NAMES){const parent=new Group(),visuals=new Group();hierarchy.add(parent);parent.add(visuals);visualBodies.set(name,{parent,visuals});}
  let locked=false,changes=0,worldPosition,restores=0;
  const view=createModelicaPoseView({modelSpace,visualBodies,lockControls:x=>{locked=x;},invalidate:()=>changes++,onPose:point=>{worldPosition=point;},onRestore:()=>restores++});
  const state={time:1,bodies:BODY_NAMES.map(()=>({position:[1,2,3],rotation:[1,0,0,0,1,0,0,0,1]}))};
  return {scene,modelSpace,visualBodies,view,state,status:()=>({locked,changes}),follow:()=>({worldPosition,restores})};
}
const near=(actual,expected)=>actual.forEach((x,i)=>assert(Math.abs(x-expected[i])<1e-12,`${actual} != ${expected}`));

test('Modelica world positions and oriented axes use one Z-up to Y-up conversion',()=>{
  const x=setup();x.state.bodies[0].rotation=[0,-1,0,1,0,0,0,0,1];x.view.apply(x.state);x.scene.updateMatrixWorld(true);
  const object=x.visualBodies.get(BODY_NAMES[0]).visuals;
  near(object.getWorldPosition(new Vector3()).toArray(),[1,3,-2]);
  near(object.localToWorld(new Vector3(1,0,0)).toArray(),[1,3,-3]);
  near(x.visualBodies.get(BODY_NAMES[14]).visuals.getWorldPosition(new Vector3()).toArray(),[1,3,-2]);
  near(x.follow().worldPosition.toArray(),[1,3,-2]);
  assert.deepEqual(x.status(),{locked:true,changes:1});
});

test('An invalid final pose refuses before reparenting or publishing any body',()=>{
  const x=setup();x.state.bodies.at(-1).position[2]=NaN;
  assert.throws(()=>x.view.apply(x.state),/Incomplete/);
  for(const {parent,visuals} of x.visualBodies.values()){assert.equal(visuals.parent,parent);assert.deepEqual(visuals.position.toArray(),[0,0,0]);}
  assert.deepEqual(x.status(),{locked:false,changes:0});
  assert.equal(x.follow().worldPosition,undefined);
});

test('Stop restores the joint hierarchy and its local transforms',()=>{
  const x=setup();x.view.apply(x.state);x.view.restore();
  for(const {parent,visuals} of x.visualBodies.values()){assert.equal(visuals.parent,parent);assert.deepEqual(visuals.position.toArray(),[0,0,0]);assert.deepEqual(visuals.quaternion.toArray(),[0,0,0,1]);}
  assert.deepEqual(x.status(),{locked:false,changes:2});
  assert.equal(x.follow().restores,1);
});
