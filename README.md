# Microduck demo

Repository scaffold for the browser Modelica demo at
`https://cognipilot.github.io/microduck-demo/`.

The separately reviewed static application belongs in `site/`. It is deliberately
not included in the scaffold commit. Import the approved site packet with its
vendor files, source manifests, license notices and model/policy provenance
before publishing. This is a static deployment: there is no service or API key.

## Run locally

Use Node.js 22, then run:

```
npm ci
npm test
npx playwright install --with-deps chromium
npm run check
npm run test:browser
npm run serve
```

Open `http://127.0.0.1:8080/microduck-demo/`. The Chromium check serves that project
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
No clearance record or real-mesh approval is supplied by the scaffold. The tests
use only a synthetic mesh and a clearly labelled synthetic test approval.

The scaffold fails its checks if the site packet is missing. It must be composed
with the reviewed application and rerun before the first push. Hosted Actions and
the real Pages URL still need verification after publication.

## Licenses

Scaffold code: Apache-2.0, see LICENSE. Site dependencies retain their individual
licenses; the application is not licensed as one undifferentiated asset bundle.
Pollen Robotics' Microduck XML is Apache-2.0; its STL meshes at upstream revision
`bae39f5900b318f7e87fc485c30a31213cfa14eb` are **CC BY-NC-SA 4.0**.
Before distributing meshes, include upstream
[LICENSE-MODELS.md](third_party/microduck_rl/LICENSE-MODELS.md), credit Pollen
Robotics, link the upstream repository and license, and disclose modifications
including any decimation. Mesh inclusion awaits the repository owner's decision.
Pretrained-policy and other vendor licenses/provenance belong to the site packet.

The verbatim upstream Microduck license texts are labelled under
[third_party/microduck_rl](third_party/microduck_rl/README.md); they apply to that
upstream material, rather than to every dependency in this repository.

GitHub Pages workflow reference:
https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
