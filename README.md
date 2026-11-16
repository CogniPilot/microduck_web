# Microduck demo

Browser Modelica demo intended for
[https://cognipilot.github.io/microduck_web](https://cognipilot.github.io/microduck_web)

The static application is in `site/`, with vendor files, source manifests, licence notices and model/policy provenance. This is a static deployment: there is no service or API key.

## Run locally

Use Node.js 22, then run:

```
npm ci
npm run build:prebuilt
npm test
npx playwright install --with-deps chromium
npm run check
npm run test:browser
npm run serve
```

Open `http://127.0.0.1:8080/microduck_web/`. The Chromium check serves that project
prefix without COOP/COEP, confirms SharedArrayBuffer is unavailable, runs actual
single-thread WASM policy inference, prepares the robot and advances physics by
20 ms. This is a hosting compatibility check, not walking qualification.

## Publish

Enable **Settings → Pages → Source → GitHub Actions** in the public repository.
The Pages workflow tests pull requests without deploying them. A successful main
push or manual main run uploads the tested `site/` directory and deploys through
the `github-pages` environment. All Actions are pinned to commits. There are no
custom isolation headers and no service-worker workaround.

An in-flight deployment is allowed to finish before a later deployment starts.
STL assets are refused unless a committed `mesh-clearance.json` at the repository
root records `schema_version: 1`, a nonempty `decision` reference to the explicit
owner approval, and `files`, an object mapping every site-relative STL path to
its SHA-256. The set and hashes must match exactly. The publisher must verify the
decision's authority during review; this file check cannot authenticate an owner.
The current viewer loads one compact GLB from site/pollen/microduck.glb. Raw STL assets are not published. robot.xml remains the body, joint and sensor description; its mesh filenames are lookup keys into the GLB. The historical mesh-clearance.json remains as provenance for the earlier STL publication. The tests use only a synthetic mesh and a clearly labelled synthetic test approval.

The checks fail if the site is missing. Hosted Actions and the real Pages URL still need verification after publication.

## Licenses

Scaffold code: Apache-2.0, see LICENSE. Site dependencies retain their individual
licenses; the application is not licensed as one undifferentiated asset bundle.
Pollen Robotics' Microduck XML is Apache-2.0; its STL meshes at upstream revision
`bae39f5900b318f7e87fc485c30a31213cfa14eb` are **CC BY-NC-SA 4.0**.
Before distributing meshes, include upstream
[LICENSE-MODELS.md](third_party/microduck_rl/LICENSE-MODELS.md), credit Pollen
Robotics, link the upstream repository and license, and disclose modifications
including any decimation. The historical mesh-clearance.json records the earlier STL publish decision and all 43 exact hashes. The current GLB has separate provenance and inherited mesh terms in site/pollen/MESH-LICENSE.txt and site/pollen/SOURCE.json. Its bytes are unchanged; creased normals are recomputed for rendering at load time.
Pretrained-policy and other vendor licenses/provenance belong to the site packet.

The verbatim upstream Microduck license texts are labelled under
[third_party/microduck_rl](third_party/microduck_rl/README.md); they apply to that
upstream material, rather than to every dependency in this repository.

GitHub Pages workflow reference:
https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages

## Current application

The current application is in site/. See site/README.md for controls, physics architecture, current performance and licences. It supports keyboard and hold-to-drive touch buttons; the gait remains in progress. The external pretrained policy is ONNX; Modelica-native training is future work.

Saved Modelica drafts use a versioned walking-input contract. Drafts from the earlier site are retained separately and can be downloaded with the editor notice; they no longer override the updated default model. A custom interface missing required inputs is refused during preparation with a Restore file instruction, before walking begins.

### Prepare the native-smoked whole-robot FMU for this page

After the full-robot native chain has completed its core smoke, use its exact
`HOST-BOUND.json` and `CORE-SMOKE-PASS.txt`:

```sh
node scripts/build-admitted-fmu.mjs \
  /absolute/native/out/host-join/HOST-BOUND.json \
  /absolute/native/out/CORE-SMOKE-PASS.txt \
  /absolute/this-checkout/site \
  /absolute/new-browser-output \
  /tmp/task-specific-jco/node_modules/@bytecodealliance/jco-transpile/dist/index.js
```

The producer verifies the actual archive, native typed-I/O binding, all 273
compiler/page source bodies and the complete options identity, then calls the
existing pinned, unoptimized multi-memory transpiler. The content-hashed browser
index includes the native admission identity. `OFFER.json` is written last; a
partial directory supplies no offer. This command does not edit the live page or
its prebuilt manifest. Before publication, qualify actual browser
load/init/tick/reset/error behavior on this artifact, then apply the offer to
`models.MicroduckJawLocked.fmu` in the page's prebuilt manifest. The selected page
model remains that UI entry; the offered component must be
`MicroduckWholeSystem`, with plant and controller together.

`npm run test:fmu` includes source/identity controls and the existing lifecycle
mocks. These tests do not supply a production FMU or replace actual browser
qualification. A native host smoke does not prove browser performance or physics
agreement with MuJoCo.

Keep source, worktrees and open results in the persistent workspace. Put fetched
build tools, dependency caches and regenerable build outputs in fresh,
task-specific `/tmp` directories; verify exact inputs again if scratch was wiped.

### Compare FMU tick cost with the existing SDK/MuJoCo workload

After a real native-admitted offer has been built, the FMU timing driver uses the
same 500 ticks, 20 ms targets, 10-tick warmup and `home + 0.05*sin(2*pi*t+i)` law as
the existing SDK/MuJoCo harness:

```sh
node scripts/fmu-matched-ticks.mjs \
  --offer /absolute/generated-fmu/OFFER.json \
  --site /absolute/this-checkout/site \
  --out /absolute/new-run/r01-named-rumoca.json \
  --raw /absolute/new-run/r01-named-rumoca.ticks.f64 \
  --ticks 500 --warmup 10 --readout named --inputs live
```

Run it only inside the reviewed resource/deadline controller. It loads the
content-hashed, native-admitted full `MicroduckWholeSystem` component through the
existing FMU session; no SDK fallback or compatibility shim is installed. It
passes the complete page parameter set and checks the canonical options against
both page and native admission. It keeps the admitted fixed step of 1 ms, order 2
and dt of 2 ms; it does not retune the FMU to the SDK integrator. The actual
session receipt must identify the full FMU engine, model and token with no refusal
before timing and acceptance. The explicit `usePolicyController=0`
selector chooses the externally commanded plant route while retaining the whole
model. No input or output is removed from the packaged model. The additional
selector write is recorded; the controller and sensor equations remain present.

Timing separates input writes, advancement and named readout. It retains all raw
ticks and verifies actual simulation progress, the 15 finite home joints and
finite final selected public/joint values. These checks do not establish finite
values throughout the trajectory.
A thrown step/final read writes a refused completed prefix, never a successful
zero-filled series. `matched-tick-workload.mjs` is a byte-identical copy of the
accepted November13 common harness; it changes no numerical construction.

This is Node/V8 tick cost, without page rendering or neural policy inference.
Rumoca's 15-servo/contact/integrator/readout configuration still differs from the
14-actuator MuJoCo model; shared-servo offsets and the simulated horizon are
matched, not a physical-parity certificate. Run a fresh MuJoCo companion in the
same window. Old SDK ratios and the default-input FMU diagnostic are not new FMU
results. Real browser walking and full fidelity/speed parity remain separate
qualification work.

### Require actual FMU receipts in the page smoke

For a fresh staging site with the admitted offer installed in its prebuilt
manifest, pass the actual OFFER.json as a fourth argument:

```sh
node scripts/browser-smoke.mjs /absolute/staging-site /absolute/new-results /absolute/OFFER.json
```

This optional qualification mode keeps the normal page/worker/runtime. It records
actual physics-worker replies and requires both preparations to be FMU, the full
model and exact token with no refusal on every observed frame, a manual tick,
walking, pause, dynamics reset, replay and worker termination. SDK fallback or UI movement cannot pass.
Walk evidence must join the actual start command and acknowledgement generation,
strictly increasing delivered sequences and page acknowledgements; a pause needs
its matching completed frame and time. A stale frame or empty pause cannot count.
The recorder wraps the page Worker constructor; it preserves worker URLs, message
and transfer objects and does not install network routes. Its trace is capped;
overflow refuses qualification. This is a diagnostic smoke, not a timing run.
The FMU mode clicks Reset simulation after pause and requires an actual time-zero
receipt, complete initial-frame restoration and identical-input manual replay.
Fault recovery, internal model-event behavior and native/browser trace agreement
still need separate actual qualification. Source controls are not a runtime pass.

The electrical-model source candidate incorporates upstream microduck_web PR15
(commit fde00fa408896f08b8d513ca790292ba0621f11d) and forwards terminalVoltage
and batteryCurrent at the whole-model interface. The page/compiler source join
must use the corresponding new model packet; old SDK benchmark results describe
the pre-contribution model. No electrical-model speed or fidelity is established
by these source changes.

For an operator-pinned retained browser, the qualification script also accepts a fifth
argument after the site, fresh output directory and native-admitted offer:

```
node scripts/browser-smoke.mjs SITE NEW_OUTPUT OFFER.json LAUNCH_CONFIG.json
```

The launch configuration selects an exact Playwright entry/hash, browser version and
executable, private scratch, library directories and font directory. Its environment
is passed only to the browser child. The default local Playwright launch is retained
when this argument is absent. This configuration does not authorize execution or
establish full-browser resource coverage; those belong to the runtime operator.

### Reset, fault and event qualification scope

`scripts/fmu-lifecycle-receipts.mjs` adds separate auditors for a direct worker
protocol segment captured by the existing receipt recorder. Reset requires
prepare, one manual step, reset to the complete initial frame, an identical-input
replay with the same complete frame, then termination. Fault qualification requires
the expected step error, blocked subsequent work and reset, then fresh prepare and
a successful step. Command/reply IDs, full FMU model/token and null refusal on
successful frames remain mandatory. These are retained JavaScript frame comparisons,
not a binary64 trajectory or physics-parity certificate.

The page has a separate Reset simulation button. It finishes the current command,
pauses walking, invalidates old sensor/input generations, asks the existing worker
to reset, and applies only the current time-zero reply. Stop or replacement
discards a late reset completion. The Reset button in the pose controls still
changes preview geometry only. The FMU browser smoke exercises dynamics reset and
replay after pause; actual runtime qualification still requires an admitted FMU.
The page's error path terminates the worker; recovery creates a fresh one.
Direct-worker fault controls do not qualify that complete UI transition.

The fixed native profile does not advertise host event mode. The browser session
instantiates with event-mode use disabled and refuses a
do-step that asks for event handling, early return or termination, keeping the last
accepted time and a sticky fault. The extracted pure outcome check preserves that
rule. Source controls prove refusal and mocked-worker error propagation, not event
handling. The guest processes internal model events inside DoStep; actual event
behavior on this full artifact remains unqualified. Optional host-managed event
mode is outside the advertised profile and is not required for this website slice.
No actual reset/fault/internal-event runtime qualification is claimed here.

An optional qualification-only mode checks the page's error/terminate/reprepare
path after the complete nominal reset/replay segment:

```
node scripts/browser-smoke.mjs SITE NEW_OUTPUT OFFER.json LAUNCH_CONFIG.json page-error-reprepare
```

The recorder declares one copied manual command with a backward target. The real
FMU adapter refuses it before DoStep; the page must terminate that worker and
prepare a new worker through its existing controls. The complete trace must show
the real error, termination, distinct observer-owned worker identity, exact
full-model/token preparation and matching complete manual replay. Default capture
forwards the original messages unchanged and exposes no fault-arm hook. This mode
changes no product UI, physics or solver behavior. It tests page command-refusal
recovery, not a guest trap, solver or sticky session fault, or internal events.
Actual artifact execution requires a separately admitted bounded operator.
