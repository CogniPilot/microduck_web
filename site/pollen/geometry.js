// Adapted from Pollen Robotics microduck-simulator efedf47f, Apache-2.0.
// Modified to share its light GLB geometry with the Modelica body-pose viewer.
import {GLTFLoader} from '../vendor/three-addons/loaders/GLTFLoader.js';
import {toCreasedNormals} from '../vendor/three-addons/utils/BufferGeometryUtils.js';

let geometryPromise;
export function loadPollenGeometries() {
  geometryPromise??=new GLTFLoader().loadAsync(new URL('./microduck.glb',import.meta.url).href).then(gltf=>{
    const geometries=new Map();
    gltf.scene.traverse(object=>{
      if(!object.isMesh||!object.geometry)return;
      const name=object.userData.meshFile||object.name||object.geometry.name;
      if(!name||geometries.has(name))return;
      const welded=object.geometry;
      welded.deleteAttribute('normal');
      // Pollen's creased-normal grid uses millimetres for metre-scale CAD.
      const scaled=welded.clone();scaled.scale(1000,1000,1000);
      const display=toCreasedNormals(scaled,Math.PI/5);display.scale(.001,.001,.001);
      if(display!==scaled)scaled.dispose();
      geometries.set(name,display);
      if(object.name&&object.name!==name)geometries.set(object.name,display);
    });
    if(!geometries.size)throw Error('The robot GLB contains no named geometry.');
    return geometries;
  });
  return geometryPromise;
}
