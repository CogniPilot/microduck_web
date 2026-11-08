# Microduck Lab

Keyboard and touch driving. Serve this directory with the repository's static server. The prerecorded walk-and-turn button replays an actual four-second native Rumoca/Modelica trajectory; it is not live physics.

For live control, choose Prepare simulation, then Run pretrained. Hold W/S or up/down for forward/reverse (target ±0.3 m/s), A/D or left/right to steer (±0.5 rad/s), or use the large on-screen buttons. Release clears that command. Space or Zero clears all commands. Editor focus, window blur and hiding the page also clear commands. Pause stops stepping; Stop closes the session.

The release WASM build and joint-armature reduction improve live stepping. A four-second keyboard-controlled browser trial completed200 policy ticks without falling; with rendered sensors enabled it took about97 seconds after40 seconds of preparation on a headless software renderer. This is a short functionality trial, not stable-gait or speed-tracking qualification. Phone performance is unqualified. Camera/ToF rendering is optional and off initially; enable Render camera / ToF to inspect those inputs. Their target rates are30/15Hz, but a software-renderer sensor-only test reached about5.86Hz each.

Modelica/Rumoca owns the physical robot, joints, actuators, contact, sensors, computer-vision equations, policy observations and joint-action mapping. The physics root is Microduck, using its original PD gains, not the stronger hand-tuned MicroduckStand configuration. Both the physical session and MicroduckPolicyInterface use Rumoca interactive configuration.

JavaScript handles the UI, Three.js rendering, rendered RGB/ToF input, transport and the external pretrained ONNX WASM inference call. There is no JavaScript physics integrator or Python application. The RL network and training are not yet Modelica-native; browser training is not implemented.

## Licences and provenance

Pollen's robot code/MJCF is Apache-2.0. Its43 STL meshes are CC BY-NC-SA4.0, with noncommercial and share-alike conditions; they are not Apache-2.0. See third_party/microduck_rl/LICENSE-MODELS.md and LICENSE. All43 are unchanged from upstream bae39f5900b318f7e87fc485c30a31213cfa14eb: no local decimation. Three.js, Monaco and ONNX Runtime retain their MIT licences. MSL and MultiBodyLie retain the included licence/notice files. SLAM-WEB-LICENSE covers the adapted editor integration.

The pretrained velstand.onnx comes from pollen-robotics/microduck-policies at283771bcb3690a0a94a288c108365d9b630d21e4 (Apache-2.0). policies/DOWNLOADS.json retains URLs and hashes; only velstand.onnx is bundled, while the unmodified upstream manifest describes additional policies not included here.

Physics uses the exact release build pinned in vendor/rumoca-b2cb0f02-release/BUILD-PIN.json. The editor retains its separately pinned older runtime. The Modelica source/dependency pins are retained alongside the source manifest.

The stateless Modelica policy adapter matches native robotd Walk defaults: command EMA0.2, raw action scale0.9, head/leg target low-pass0.5/0.7,61 observations and14 raw actions at50Hz. JavaScript holds the previous Modelica outputs between ticks. Absolute proposed targets go directly to the Modelica servos, which retain physical joint limits. The separate mouth stays closed. Optional native skills, alternate policies and hardware safety/servo calibration are outside this walking demo.
