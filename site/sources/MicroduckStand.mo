within;
model MicroduckStand "Author stance control using the physical servo model"
  extends Microduck(
    leftHipYaw(kp=5,damping=0.18),
    leftHipRoll(kp=5,damping=0.18),
    leftHipPitch(kp=5,damping=0.18),
    leftKnee(kp=5,damping=0.18),
    leftAnkle(kp=5,damping=0.18),
    rightHipYaw(kp=5,damping=0.18),
    rightHipRoll(kp=5,damping=0.18),
    rightHipPitch(kp=5,damping=0.18),
    rightKnee(kp=5,damping=0.18),
    rightAnkle(kp=5,damping=0.18));
end MicroduckStand;
