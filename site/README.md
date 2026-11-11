# Microduck Lab

Keyboard and touch driving. Serve this directory with the repository's static server. The prerecorded walk-and-turn button replays an actual four-second native Rumoca/Modelica trajectory; it is not live physics.

For live control, choose Prepare simulation, then Run pretrained. Hold W/S or up/down for forward/reverse (target ±0.3 m/s), A/D or left/right to steer (±0.5 rad/s), or use the large on-screen buttons. Release clears that command. Space or Zero clears all commands. Editor focus, window blur and hiding the page also clear commands. Pause stops stepping; Stop closes the session.

The default is a demo configuration: the rigid-jaw model, softened contacts on all 17 contact units (k=510 N/m, d=10.7 s/m, mu=1, v_eps=0.09 m/s), and explicit Heun integration with a fixed 1 ms step. The policy interface keeps its original solver. The plant has no adaptive step-size error control; its softened-contact configuration differs from the benchmark contact model. The on-page real-time factor measures simulation seconds advanced per elapsed wall second during the current live walk, including pacing and waiting; preparation and paused time are excluded. Phone performance is unqualified. Camera/ToF rendering is optional and off initially; enable Render camera / ToF to inspect those inputs. Their target rates are30/15Hz, but a software-renderer sensor-only test reached about5.86Hz each.

Modelica/Rumoca owns the physical robot, joints, actuators, contact, sensors, computer-vision equations, policy observations and joint-action mapping. The physics root is MicroduckJawLocked (the jaw is rigidly attached), using the original PD gains, not the stronger hand-tuned MicroduckStand configuration. Both the physical session and MicroduckPolicyInterface use Rumoca interactive configuration.

JavaScript handles the UI, Three.js rendering, rendered RGB/ToF input, transport and the external pretrained ONNX WASM inference call. There is no JavaScript physics integrator or Python application. The RL network and training are not yet Modelica-native; browser training is not implemented.

## Licences and provenance

Pollen's scene/loader code and robot MJCF are Apache-2.0. The viewer loads pollen/microduck.glb under the inherited CC BY-NC-SA 4.0 mesh terms, with noncommercial and share-alike conditions; the geometry is not Apache-2.0. See pollen/MESH-LICENSE.txt, pollen/NOTICE and pollen/SOURCE.json for the exact sources, credit and conversion basis. The GLB bytes are unchanged; creased normals are recomputed at load time. Raw STL files and the unused older simulation runtime are not published. robot.xml remains the body/joint/sensor description and names geometry keys within the GLB. Three.js, Monaco and ONNX Runtime retain their MIT licences. MSL and MultiBodyLie retain the included licence/notice files. SLAM-WEB-LICENSE covers the adapted editor integration.

The pretrained velstand.onnx comes from pollen-robotics/microduck-policies at283771bcb3690a0a94a288c108365d9b630d21e4 (Apache-2.0). policies/DOWNLOADS.json retains URLs and hashes; only velstand.onnx is bundled, while the unmodified upstream manifest describes additional policies not included here.

Physics uses the build pinned in vendor/rumoca-ec9bc1dd-locals-release/BUILD-PIN.json, an unmerged compiler revision with fixed-shape Wasm locals enabled. The editor retains its separately pinned 6fd79278 build for this demo. The Modelica source/dependency pins are retained alongside the source manifest.

The stateless Modelica policy adapter matches native robotd Walk defaults: command EMA0.2, raw action scale0.9, head/leg target low-pass0.5/0.7,61 observations and14 raw actions at50Hz. JavaScript holds the previous Modelica outputs between ticks. Absolute proposed targets go directly to the Modelica servos, which retain physical joint limits. The separate mouth stays closed. Optional native skills, alternate policies and hardware safety/servo calibration are outside this walking demo.

## Precompiled default models

The fixed plant and policy interface are exported at site build time by `npm run build:prebuilt`, using the same pinned compiler WASM module as the browser. Opaque gzip artifacts retain the Rust-owned complete-source/model/compiler key. The unchanged default loads these artifacts; editing Modelica source or a companion changes that key and explicitly compiles the edited source. A mismatched compiler/model or damaged published artifact refuses instead of silently compiling the default. No JavaScript IR decoding or physics math is introduced.

The unchanged plant loads a full precompiled-runtime binary artifact, including the lowered model and generated Wasm kernels. Its Rust-owned key also covers the exact parsed solver and contact options, shared by the export script and worker in simulation-options.js. Runtime download, decode, instantiation and initialization still happen in the browser. The small controller retains its precompiled DAE path. A missing or mismatched runtime artifact refuses; it never silently recompiles the default. Edited sources explicitly use source compilation. Preparation remains separate from the live speed readout. Artifacts and SDK must be regenerated together from one compiler revision.

Each tick reads the same pose, policy, telemetry and sensor/status values through the session’s ordered Float64Array readout. The initial snapshot establishes key order; later ticks avoid serializing and parsing the full state. The underlying session observation and numerical computation are unchanged.
