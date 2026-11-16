within;
model MicroduckWholeSystem "Complete page plant and Modelica policy interface; neural inference remains external"
  // Physical equations, initialization and events remain in the unchanged plant.
  parameter Real upperLegLength=0.042190056700720374;
  parameter Real lowerLegLength=0.04939635614091388;
  parameter Real hipWidth=0.035;
  parameter Real footLength=0.07;
  parameter Real footWidth=0.04;
  parameter Real jawMass=0.005;
  parameter Real jawLength=0.03;
  parameter Real cameraPeriod=0.10;
  parameter Integer cameraRows=24;
  parameter Integer cameraColumns=32;
  parameter Real torqueConstant=0.8;
  parameter Real windingResistance=2;
  parameter Real thermalCapacity=5;
  parameter Real cooling=0.2;
  parameter Real batteryEnergy=20000;
  parameter Real goal[3]={0.60,0,0.12};
  // Original manual and rendered-sensor inputs retain their names and types.
  input Real action[15]={0,0,0,0,0,0,0,0,0,-1,0,0,0,0,0};
  input Boolean usePolicyPosition=false;
  input Real policyPosition[15]=zeros(15) "Native proposed radians; each servo enforces its physical limits";
  input Real cameraRGB[cameraRows,cameraColumns,3]=zeros(cameraRows,cameraColumns,3) "Rendered RGB supplied by Three.js";
  input Real cameraTimestamp=0;
  input Real lidarRange[8,8]=fill(4,8,8) "Rendered ToF slant ranges from Three.js";
  input Boolean lidarValid[8,8]=fill(false,8,8);
  input Real lidarTimestamp=0;
  input Boolean usePolicyController=false "Select controller position commands; also enable usePolicyPosition for policy walking";
  // The page worker owns these held histories. They remain explicit inputs.
  input Real forwardVelocity=0 "m/s, robot forward";
  input Real lateralVelocity=0 "m/s, robot left";
  input Real steeringRate=0 "rad/s, positive turns left";
  input Real policyAction[14]=zeros(14) "Raw network offsets, radians";
  input Real previousPolicyAction[14]=zeros(14);
  input Real previousCommand[3]=zeros(3) "Held Modelica output from the previous policy tick";
  input Real previousPositionCommand[15]=zeros(15);
  input Boolean hasPreviousPositionCommand=false;
  parameter Real commandAlpha=0.2 "Native robotd Walk command EMA";
  parameter Real actionScale=0.9 "Native robotd Walk radians per raw action";
  parameter Real headLowpass=0.5;
  parameter Real legsLowpass=0.7;
  output Real imageCentroid[2];
  output Boolean imageTargetVisible;
  output Real nearestObstacle;
  output Real jointPosition[15];
  output Real jointVelocity[15];
  output Real policyJointHome[14] "Servo homes in pretrained policy order";
  output Real policyJointHalfRange[14] "Servo half-ranges in pretrained policy order";
  output Real commandedPosition[15];
  output Real motorTorque[15];
  output Real estimatedCurrent[15];
  output Real estimatedTemperature[15];
  output Real stateOfCharge;
  output Real terminalVoltage;
  output Real batteryCurrent;
  output Real trunkGyro[3];
  output Real trunkAcceleration[3];
  output Real headGyro[3];
  output Real headAcceleration[3];
  output Real bodyPosition[15,3] "Viewer only, not policy input";
  output Real bodyRotation[15,3,3] "Viewer only, not policy input";
  output Real cameraOrigin[3];
  output Real cameraToWorld[3,3];
  output Real lidarOrigin[3];
  output Real lidarToWorld[3,3];
  output Real score "Privileged reward only";
  output Boolean fallen;
  output Real policyObservation[61];
  output Real filteredCommand[3];
  output Real positionCommand[15] "Native proposed joint positions, before physical joint limits";
  output Real normalizedPolicyAction[15];
  output Real clippedPolicyActions;
  MicroduckJawLocked plant(
    upperLegLength=upperLegLength,
    lowerLegLength=lowerLegLength,
    hipWidth=hipWidth,
    footLength=footLength,
    footWidth=footWidth,
    jawMass=jawMass,
    jawLength=jawLength,
    cameraPeriod=cameraPeriod,
    cameraRows=cameraRows,
    cameraColumns=cameraColumns,
    torqueConstant=torqueConstant,
    windingResistance=windingResistance,
    thermalCapacity=thermalCapacity,
    cooling=cooling,
    batteryEnergy=batteryEnergy,
    goal=goal,
    // Exact page modelOptions physical overrides, retained in the instance.
    leftSoleContact(k=510, d=10.7, mu=1, v_eps=0.09),
    rightSoleContact(k=510, d=10.7, mu=1, v_eps=0.09),
    trunkContact(k=510, d=10.7, mu=1, v_eps=0.09),
    leftHipYawLinkContact(k=510, d=10.7, mu=1, v_eps=0.09),
    leftHipRollLinkContact(k=510, d=10.7, mu=1, v_eps=0.09),
    leftUpperLegContact(k=510, d=10.7, mu=1, v_eps=0.09),
    leftLowerLegContact(k=510, d=10.7, mu=1, v_eps=0.09),
    leftFootContact(k=510, d=10.7, mu=1, v_eps=0.09),
    neckLinkContact(k=510, d=10.7, mu=1, v_eps=0.09),
    headPitchLinkContact(k=510, d=10.7, mu=1, v_eps=0.09),
    headYawLinkContact(k=510, d=10.7, mu=1, v_eps=0.09),
    headContact(k=510, d=10.7, mu=1, v_eps=0.09),
    rightHipYawLinkContact(k=510, d=10.7, mu=1, v_eps=0.09),
    rightHipRollLinkContact(k=510, d=10.7, mu=1, v_eps=0.09),
    rightUpperLegContact(k=510, d=10.7, mu=1, v_eps=0.09),
    rightLowerLegContact(k=510, d=10.7, mu=1, v_eps=0.09),
    rightFootContact(k=510, d=10.7, mu=1, v_eps=0.09),
    action=action,
    usePolicyPosition=usePolicyPosition,
    cameraRGB=cameraRGB,
    cameraTimestamp=cameraTimestamp,
    lidarRange=lidarRange,
    lidarValid=lidarValid,
    lidarTimestamp=lidarTimestamp,
    policyPosition=if usePolicyController then controller.positionCommand else policyPosition);
  MicroduckPolicyInterface controller(
    forwardVelocity=forwardVelocity, lateralVelocity=lateralVelocity, steeringRate=steeringRate,
    trunkGyro=plant.trunkGyro, gravityRow=plant.bodyRotation[1,3,:],
    jointPosition=plant.jointPosition, jointVelocity=plant.jointVelocity,
    policyHome=plant.policyJointHome, policyHalfRange=plant.policyJointHalfRange,
    policyAction=policyAction, previousPolicyAction=previousPolicyAction,
    previousCommand=previousCommand, previousPositionCommand=previousPositionCommand,
    hasPreviousPositionCommand=hasPreviousPositionCommand,
    commandAlpha=commandAlpha, actionScale=actionScale,
    headLowpass=headLowpass, legsLowpass=legsLowpass);
equation
  imageCentroid=plant.imageCentroid;
  imageTargetVisible=plant.imageTargetVisible;
  nearestObstacle=plant.nearestObstacle;
  jointPosition=plant.jointPosition;
  jointVelocity=plant.jointVelocity;
  policyJointHome=plant.policyJointHome;
  policyJointHalfRange=plant.policyJointHalfRange;
  commandedPosition=plant.commandedPosition;
  motorTorque=plant.motorTorque;
  estimatedCurrent=plant.estimatedCurrent;
  estimatedTemperature=plant.estimatedTemperature;
  stateOfCharge=plant.stateOfCharge;
  terminalVoltage=plant.terminalVoltage;
  batteryCurrent=plant.batteryCurrent;
  trunkGyro=plant.trunkGyro;
  trunkAcceleration=plant.trunkAcceleration;
  headGyro=plant.headGyro;
  headAcceleration=plant.headAcceleration;
  bodyPosition=plant.bodyPosition;
  bodyRotation=plant.bodyRotation;
  cameraOrigin=plant.cameraOrigin;
  cameraToWorld=plant.cameraToWorld;
  lidarOrigin=plant.lidarOrigin;
  lidarToWorld=plant.lidarToWorld;
  score=plant.score;
  fallen=plant.fallen;
  policyObservation=controller.policyObservation;
  filteredCommand=controller.filteredCommand;
  positionCommand=controller.positionCommand;
  normalizedPolicyAction=controller.action;
  clippedPolicyActions=controller.clippedPolicyActions;
  annotation(experiment(StopTime=2,Interval=0.02,Tolerance=1e-5));
end MicroduckWholeSystem;
