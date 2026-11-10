import {Matrix4,Vector3} from '../vendor/three.module.js';

// Wire order of the existing Modelica body-pose output, independent of mesh order.
export const BODY_NAMES=['trunk_base','yaw2roll','hip_l','upper_leg_left','leg','ankle_left',
  'neck','neck_pitch','yaw_roll_motion','jaw_soft','bearing_roll','hip_l_2','upper_leg_right','leg_2','ankle_right'];

export function createModelicaPoseView({modelSpace,visualBodies,invalidate,lockControls,onPose=()=>{},onRestore=()=>{}}) {
  const matrix=new Matrix4(),rootPosition=new Vector3();
  return {
    focus:rootPosition,
    apply(state){
      if(!Number.isFinite(state.time)||state.bodies?.length!==BODY_NAMES.length)
        throw Error('Invalid Modelica body-pose frame.');
      // Refuse the complete frame before publishing any visible change.
      state.bodies.forEach((pose,i)=>{
        if(!visualBodies.has(BODY_NAMES[i])||pose.position?.length!==3||pose.rotation?.length!==9||
          ![...pose.position,...pose.rotation].every(Number.isFinite))throw Error('Incomplete Modelica body pose.');
      });
      state.bodies.forEach((pose,i)=>{
        const object=visualBodies.get(BODY_NAMES[i]).visuals;
        modelSpace.add(object);object.position.fromArray(pose.position);
        const r=pose.rotation;
        matrix.set(r[0],r[1],r[2],0,r[3],r[4],r[5],0,r[6],r[7],r[8],0,0,0,0,1);
        object.quaternion.setFromRotationMatrix(matrix);
      });
      modelSpace.updateMatrixWorld(true);
      onPose(visualBodies.get(BODY_NAMES[0]).visuals.getWorldPosition(rootPosition));
      lockControls(true);invalidate();
    },
    restore(){
      for(const {visuals,parent} of visualBodies.values()){
        parent.add(visuals);visuals.position.set(0,0,0);visuals.quaternion.identity();
      }
      modelSpace.updateMatrixWorld(true);
      visualBodies.get(BODY_NAMES[0]).visuals.getWorldPosition(rootPosition);
      onRestore();lockControls(false);invalidate();
    }
  };
}
