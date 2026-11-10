import {Vector3} from '../vendor/three.module.js';

// Follow horizontal motion while preserving the user's orbit and pan offset.
export function createCameraFollower(camera,controls) {
  const homePosition=camera.position.clone(),homeTarget=controls.target.clone();
  const last=new Vector3(),next=new Vector3(),delta=new Vector3();
  let following=true;
  return {
    update(position){
      if(!position||!Number.isFinite(position.x)||!Number.isFinite(position.y)||!Number.isFinite(position.z))return false;
      next.set(position.x,0,position.z);delta.copy(next).sub(last);
      if(following){camera.position.add(delta);controls.target.add(delta);}
      last.copy(next);return true;
    },
    home(){following=true;camera.position.copy(homePosition).add(last);controls.target.copy(homeTarget).add(last);},
    hold(){following=false;},
    restore(){if(following){camera.position.sub(last);controls.target.sub(last);}last.set(0,0,0);}
  };
}
