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
| `registry` | Parts (YAML), schematic symbols (SVG), SPICE models, bundle manifest |
| `third_party/ngspice` | The pinned ngspice: native and WASM build scripts, patches, licence notes |
| `apps/web/src/workers` | Simulation worker (Comlink) on ngspice WASM, with the main-thread watchdog |
| `tools/sim` | Native ngspice driver; simulation tests for every part and the demo circuit; native vs WASM parity |
| `tools/parity` | Cross-runtime parity gate: native vs WASM vs Python |
| `tools/codegen` | Schema → TS / Pydantic generation |

## Setup

Needs Rust (with `wasm32-unknown-unknown`), `wasm-pack`, Node 24, `uv`, and Docker for the
ngspice WASM build (it runs in the pinned emsdk image; no local Emscripten needed).

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-pack
uv venv --python 3.12 .venv && uv pip install --python .venv maturin pytest "pydantic>=2.9,<3"
uv pip install --python .venv py7zr                   # Windows only: unpacks the official ngspice build
export PYO3_PYTHON="$PWD/.venv/Scripts/python.exe"   # Windows; .venv/bin/python elsewhere
third_party/ngspice/build-native.sh                  # native ngspice (tests, sim_runner)
third_party/ngspice/build-wasm.sh                    # ngspice.wasm (browser)
(cd apps/web && npm ci)
```

## Everyday commands

```sh
cargo test --workspace                     # core tests (apply/undo properties, ERC, golden netlists)
tools/parity/run.sh                        # builds both bindings, then checks 1000 random op logs
tools/codegen/run.sh                       # schemas -> TS + Pydantic (add --check in CI)
node crates/circuit-core-wasm/build.mjs    # browser package in crates/circuit-core-wasm/pkg
cargo run -p circuit-core --example bundle_registry   # registry bundle (JSON, symbols.svg, model files) in target/registry
.venv/Scripts/python -m pytest -q tools/sim           # every part simulated + demo circuit + native vs WASM parity
(cd apps/web && npx vitest run && npx tsc --noEmit)   # sim worker: engine, watchdog, end to end on ngspice.wasm
```

The simulation tests use the bindings and registry bundle that `tools/parity/run.sh` builds. They skip
when ngspice is not built; CI sets `REQUIRE_NGSPICE=1` so they cannot skip there.

After changing a wire type: `tools/codegen/run.sh`, then commit the regenerated files.
After a deliberate netlist change: `cargo insta review` (or `INSTA_UPDATE=always cargo test`) and review the diff.
After changing the demo circuit: `UPDATE_FIXTURES=1 cargo test -p circuit-core` (refreshes the IR snapshot the simulation tests load).
After changing a model in `registry/models`: run `tools/sim`; every part's behaviour is checked there.
After changing a symbol in `registry/symbols`: `cargo insta review` (the sprite sheet is snapshotted) and look at it in the editor.
