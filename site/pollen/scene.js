// Adapted from Pollen Robotics GameCanvas.jsx and game.js (efedf47f), Apache-2.0.
// Modified for the existing viewer and flat-ground Modelica physics.
import * as THREE from 'three';
import {RoomEnvironment} from '../vendor/three-addons/environments/RoomEnvironment.js';
import {makeInfiniteGrid,makeArenaWalls} from './arena.js';

export function createPollenScene(scene,renderer) {
  scene.background=new THREE.Color(0x08080c);
  renderer.setClearColor(0x08080c,1);
  renderer.shadowMap.enabled=false;
  const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment(renderer);
  const environment=pmrem.fromScene(room);
  scene.environment=environment.texture;
  scene.environmentIntensity=.45;
  room.dispose();pmrem.dispose();
  scene.add(new THREE.AmbientLight(0xffffff,.6));
  for(const [color,intensity,position] of [[0xffffff,1.6,[2,4,2]],[0xffffff,.4,[-2,2,1.5]],[0xffb366,.7,[0,3,-2]]]){
    const light=new THREE.DirectionalLight(color,intensity);light.position.fromArray(position);scene.add(light);
  }
  // Flat ground needs no vertices for relief displacement. The grid shader is unchanged.
  const grid=makeInfiniteGrid({segments:1}),{wallMats,wallMeshes}=makeArenaWalls();
  scene.add(grid,...wallMeshes);
  const materials=[grid.material,...wallMats];
  for(const material of materials)material.uniforms.uReveal.value=1;
  // The Modelica contact model is flat. The arena walls are visual borders.
  grid.material.uniforms.uTopoScale.value=0;
  return {
    focus(position){
      grid.position.x=position.x;grid.position.z=position.z;
      for(const material of materials)material.uniforms.uFocus.value.copy(position);
    },
    border(visible){for(const wall of wallMeshes)wall.visible=visible;},
    dispose(){environment.dispose();grid.geometry.dispose();for(const material of materials)material.dispose();for(const wall of wallMeshes)wall.geometry.dispose();}
  };
}
