# Circuit Forge

Spec: [docs/LLD.md](docs/LLD.md).

## Layout (so far)

| Path | What |
| --- | --- |
| `crates/circuit-core` | IR, op protocol, `apply()`, ERC, SPICE compiler. Pure Rust, the single source of truth. |
| `crates/circuit-core-wasm` | wasm-bindgen facade → npm package `@tutor/core` |
| `crates/circuit-core-py` | PyO3 facade → Python package `circuit_core` |
| `contract/schema` | JSON Schemas exported from the Rust types (generated, committed) |
| `apps/web/src/gen`, `apps/api/tutor_api/models` | TS types / Pydantic models generated from the schemas (do not edit) |
| `registry` | Parts (YAML), schematic symbols (SVG), SPICE models, block templates (YAML), bundle manifest |
| `third_party/ngspice` | The pinned ngspice: native and WASM build scripts, patches, licence notes |
| `apps/web` | Vite + React editor: store mirroring the WASM core, edit tools, ELK layout worker, SVG schematic with canvas overlays, scope, ngspice WASM sim worker |
| `workers/sim_runner` | Simulation worker (arq): circuit-core netlists on the pinned native ngspice under rlimits, results cached in Redis; the native ngspice driver; its image |
| `tools/sim` | Simulation tests for every part, every block template and the demo circuit; native vs WASM parity |
| `tools/parity` | Cross-runtime parity gate: native vs WASM vs Python |
| `tools/codegen` | Schema → TS / Pydantic generation |

## Setup

Needs Rust (with `wasm32-unknown-unknown`), `wasm-pack`, Node 24, `uv`, and Docker for the
ngspice WASM build (it runs in the pinned emsdk image; no local Emscripten needed).

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-pack
uv venv --python 3.12 .venv && uv pip install --python .venv maturin pytest "pydantic>=2.9,<3" -e "workers/sim_runner[test]"
uv pip install --python .venv py7zr                   # Windows only: unpacks the official ngspice build
export PYO3_PYTHON="$PWD/.venv/Scripts/python.exe"   # Windows; .venv/bin/python elsewhere
third_party/ngspice/build-native.sh                  # native ngspice (tests, sim_runner)
third_party/ngspice/build-wasm.sh                    # ngspice.wasm (browser)
node crates/circuit-core-wasm/build.mjs            # @tutor/core for the browser (Vite resolves it from pkg/)
(cd apps/web && npm ci)
```

## Everyday commands

```sh
cargo test --workspace                     # core tests (apply/undo properties, ERC, golden netlists)
tools/parity/run.sh                        # builds both bindings, then checks 1000 random op logs
tools/codegen/run.sh                       # schemas -> TS + Pydantic (add --check in CI)
node crates/circuit-core-wasm/build.mjs    # browser package in crates/circuit-core-wasm/pkg
cargo run -p circuit-core --example bundle_registry   # registry bundle (JSON, symbols.svg, model files) in target/registry
.venv/Scripts/python -m pytest -q tools/sim           # every part + every template at 5 points + demo + native vs WASM parity
.venv/Scripts/python -m pytest -q workers/sim_runner/tests   # the worker on Redis 7 (Docker) and native ngspice
docker compose up -d --build                         # Redis + sim_runner (worker on an internal network)
(cd apps/web && npx vitest run && npx tsc --noEmit)   # store, layout, schematic, sim worker; end to end on ngspice.wasm
(cd apps/web && npm run dev)                          # editor on the demo circuit at http://localhost:5173
(cd apps/web && npm run build)                        # static bundle in apps/web/dist (app + ngspice + registry)
(cd apps/web && npm run e2e)                          # browser tests on that bundle (system Edge; PW_CHANNEL=chrome for Chrome)
```

The editor needs the browser build of the core, the registry bundle and `ngspice.wasm` (above). The dev
server serves the last two from `target/registry` and `third_party/ngspice/dist/wasm`; `npm run build` copies
them into `dist/`. For a CDN, set `VITE_REGISTRY_URL` and/or `VITE_NGSPICE_URL` at build time and that part is
left out of `dist/`. `/#new` opens an empty circuit. In development the open editor is on `window.circuitForge`.

The simulation tests use the bindings and registry bundle that `tools/parity/run.sh` builds. They skip
when ngspice is not built; CI sets `REQUIRE_NGSPICE=1` so they cannot skip there. The worker tests also skip
without Docker (CI sets `REQUIRE_DOCKER=1`).

After changing a wire type: `tools/codegen/run.sh`, then commit the regenerated files.
After a deliberate netlist change: `cargo insta review` (or `INSTA_UPDATE=always cargo test`) and review the diff.
After a change that alters the Sallen-Key bench netlist: `SIM_UPDATE_SELFTEST=1 pytest workers/sim_runner/tests -k selftest`
(the image's selftest fixture).
After changing the demo circuit: `UPDATE_FIXTURES=1 cargo test -p circuit-core` (refreshes the IR snapshot the simulation tests load).
After changing a model in `registry/models`: run `tools/sim`; every part's behaviour is checked there.
After changing a template in `registry/templates` or a solver: rebuild the bundle, then `pytest tools/sim`; when every
template meets its spec it writes `target/registry/registry-<version>.verified.json`, which the CI web build requires
(`REQUIRE_VERIFIED=1`).
After changing a symbol in `registry/symbols`: `cargo insta review` (the sprite sheet is snapshotted) and look at it in the editor.
