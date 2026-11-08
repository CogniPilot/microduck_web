within;
model MicroduckPolicyInterface "Modelica signal interface for the external Pollen model_api=1 network"
  input Real forwardVelocity=0 "m/s, robot forward";
  input Real lateralVelocity=0 "m/s, robot left";
  input Real steeringRate=0 "rad/s, positive turns left";
  input Real trunkGyro[3]=zeros(3);
  input Real gravityRow[3]={0,0,1} "Third row of world-from-body rotation";
  input Real jointPosition[15]=zeros(15);
  input Real jointVelocity[15]=zeros(15);
  input Real policyHome[14]=zeros(14) "Issued by the robot's Modelica servo components";
  input Real policyHalfRange[14]=ones(14) "Issued by the robot's Modelica servo components";
  input Real policyAction[14]=zeros(14) "Raw network offsets, radians";
  input Real previousPolicyAction[14]=zeros(14);
  output Real policyObservation[61];
  output Real action[15];
  output Real clippedPolicyActions;
protected
  final parameter Integer policyJoint[14]={1,2,3,4,5,6,7,8,9,11,12,13,14,15};
equation
  for i in 1:3 loop
    policyObservation[i]=trunkGyro[i];
    policyObservation[i+3]=-gravityRow[i];
  end for;
  for i in 1:14 loop
    policyObservation[i+6]=jointPosition[policyJoint[i]]-policyHome[i];
    policyObservation[i+20]=jointVelocity[policyJoint[i]];
    policyObservation[i+34]=previousPolicyAction[i];
    action[policyJoint[i]]=max(-1,min(1,policyAction[i]/policyHalfRange[i]));
  end for;
  action[10]=-1 "Close the separate jaw; it is absent from the pretrained network";
  policyObservation[49]=forwardVelocity;
  policyObservation[50]=lateralVelocity;
  policyObservation[51]=steeringRate;
  for i in 52:61 loop
    policyObservation[i]=0;
  end for;
  clippedPolicyActions=sum({if abs(policyAction[i])>policyHalfRange[i] then 1 else 0 for i in 1:14});
end MicroduckPolicyInterface;
