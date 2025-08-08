# ngspice (pinned)

One ngspice release, used for both the browser engine (WASM) and the server engine (native, for
`sim_runner` and the simulation tests). LLD §2: the version is pinned once.

| File | What |
| --- | --- |
| `pin.env` | ngspice version, source tarball URL + sha256, official Windows build + sha256, emsdk image |
| `fetch.sh` | Downloads a pinned artifact into `.cache/` and verifies its hash |
| `build-native.sh` | `dist/native/bin/ngspice`: built from the tarball on Linux/macOS; on Windows, the official build of the same release (needs `py7zr` in `.venv`, local development only) |
| `build-wasm.sh` | `dist/wasm/ngspice.{mjs,wasm}` and ngspice's `COPYING`: shared-library API as an ES module (`createNgspice()`), no pthreads. Runs in the pinned `emscripten/emsdk` image when `emcc` is not installed, so it needs only Docker |
| `patches/` | Applied to the tarball before either build |

`dist/`, `build/` and `.cache/` are not committed. CI builds both engines (cached on the pin, the
scripts and the patches) and the web deploy should take `dist/wasm` from the same build.

## Build configuration

Both engines use the same feature set, so they run the same code:
`--disable-xspice --disable-osdi --disable-openmp --disable-klu`, no readline, FFTW or X11. XSPICE
code models and OSDI need `dlopen`, which the WASM build cannot do. KLU is LGPL and unused: every
simulation uses the default SPARSE solver.

WASM specifics: `--with-ngshared` with `-Dlow_latency` (output goes straight to the callbacks,
not through a printing thread); configured without `-pthread`, so Emscripten's pthread stubs
satisfy the threading code and no thread is ever started (the worker calls the synchronous `run`
and decks never contain `.control`); libtool's forced `-shared` is emptied so a static
`libngspice.a` is linked into the module.

`0001-optdefs-xspice-enum.patch`: ngspice 47 does not compile with `--disable-xspice`
(`cktsopt.c` uses an option id that `optdefs.h` declares only under `XSPICE`).

## Licences

ngspice is "Modified BSD" except for listed parts (its `COPYING`). Two of those end up in our
builds:

- `src/maths/sparse`: MIT-style, BSD compatible.
- `src/frontend/numparam`: **LGPLv2 or newer**, part of the core (parameter handling), cannot be
  configured out.

`ngspice.wasm` is shipped as its own file, loaded at runtime by the worker, and is rebuilt
reproducibly from the pinned upstream tarball plus `patches/` with `build-wasm.sh`. Keep it that
way (never bundle it into application code), ship ngspice's `COPYING` next to it, and point to
this directory as the corresponding source. Confirm the LGPL position before the public beta.
