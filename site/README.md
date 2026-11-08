# Microduck Lab

Keyboard and touch driving, gait in progress. Serve this directory with the repository's static server. The prerecorded walk-and-turn button replays an actual four-second native Rumoca/Modelica trajectory; it is not live physics.

For live control, choose Prepare simulation, then Run pretrained. Hold W/S or up/down for forward/reverse (target ±0.3 m/s), A/D or left/right to steer (±0.5 rad/s), or use the large on-screen buttons. Release clears that command. Space or Zero clears all commands. Editor focus, window blur and hiding the page also clear commands. Pause stops stepping; Stop closes the session.

Live preparation and stepping are currently very slow. A desktop Node/WASM measurement took about138 seconds to prepare and7.8 seconds to advance20 ms; phone performance is unqualified. The replay is the quick way to inspect motion. The corrected-gain native trial did not fall in four seconds, but this is not a qualified stable gait or velocity-tracking result.

Modelica/Rumoca owns the physical robot, joints, actuators, contact, sensors, computer-vision equations, policy observations and joint-action mapping. The physics root is Microduck, using its original PD gains, not the stronger hand-tuned MicroduckStand configuration. Both the physical session and MicroduckPolicyInterface use Rumoca interactive configuration.

JavaScript handles the UI, Three.js rendering, rendered RGB/ToF input, transport and the external pretrained ONNX WASM inference call. There is no JavaScript physics integrator or Python application. The RL network and training are not yet Modelica-native; browser training is not implemented.

## Licences and provenance

Pollen's robot code/MJCF is Apache-2.0. Its43 STL meshes are CC BY-NC-SA4.0, with noncommercial and share-alike conditions; they are not Apache-2.0. See third_party/microduck_rl/LICENSE-MODELS.md and LICENSE. All43 are unchanged from upstream bae39f5900b318f7e87fc485c30a31213cfa14eb: no local decimation. Three.js, Monaco and ONNX Runtime retain their MIT licences. MSL and MultiBodyLie retain the included licence/notice files. SLAM-WEB-LICENSE covers the adapted editor integration.

The pretrained velstand.onnx comes from pollen-robotics/microduck-policies at283771bcb3690a0a94a288c108365d9b630d21e4 (Apache-2.0). policies/DOWNLOADS.json retains URLs and hashes; only velstand.onnx is bundled, while the unmodified upstream manifest describes additional policies not included here.

The current Rumoca WASM source/asset hashes are in vendor/rumoca-4f0a575d/BUILD-PIN.json. Its embedded dirty identity is explicitly distinguished from the exact committed source tree. The Modelica source/dependency pins are retained alongside the source manifest.

This demo uses the pre-merge Rumoca build from PR #627, revision4f0a575d38d3df824c76792cb59526f002588a4f. That PR still awaits its566-model census; this demo is a phone-test preview, not a claim that those merge gates are closed.
