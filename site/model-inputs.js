// Routing contract only. All observation/filter/actuator math stays in Modelica.
const vector = (name, count) => Array.from({length: count}, (_, i) => `${name}[${i + 1}]`);
const controllerInputs = [
  'forwardVelocity', 'lateralVelocity', 'steeringRate', 'hasPreviousPositionCommand',
  ...vector('previousPolicyAction', 14), ...vector('previousCommand', 3),
  ...vector('previousPositionCommand', 15), ...vector('trunkGyro', 3),
  ...vector('gravityRow', 3), ...vector('jointPosition', 15),
  ...vector('jointVelocity', 15), ...vector('policyHome', 14),
  ...vector('policyHalfRange', 14), ...vector('policyAction', 14),
];

export function checkControllerInputs(names) {
  const available = new Set(names);
  const missing = controllerInputs.filter(name => !available.has(name));
  if (missing.length) {
    throw Error('The saved MicroduckPolicyInterface.mo is incompatible with walking. '
      + 'Download your edits, then use Restore file for that model. Missing input: ' + missing[0]);
  }
}
