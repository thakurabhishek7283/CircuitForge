#!/usr/bin/env bash
# ngspice of the pinned version as a WebAssembly shared library (LLD §8)
#   -> dist/wasm/ngspice.mjs + ngspice.wasm   (ES module factory: `createNgspice()`) + COPYING
#
# Shared-library API (ngSpice_Init / ngSpice_Circ / ngSpice_Command / ngGet_Vec_Info, plus the
# plot/vector listings the worker needs). No pthreads (LLD §8: no SharedArrayBuffer, no
# COOP/COEP): built without -pthread, so configure finds Emscripten's pthread stubs (mutexes are
# no-ops, pthread_create fails). No thread is ever needed: `low_latency` sends ngspice output
# straight to the callbacks instead of through a printing thread, the worker calls the
# synchronous `run` (never `bg_run`), and decks never carry .control sections (the only other
# thread). Same feature set as build-native.sh.
#
# Without emcc on PATH the script re-runs itself in the pinned emsdk container (EMSDK_IMAGE in
# pin.env), so the only host requirement is Docker. CI and deploy builds use the same image.
set -euo pipefail
shopt -s nullglob
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pin.env
. "$here/pin.env"
dist="$here/dist/wasm"
key="$NGSPICE_VERSION-$EMSDK_IMAGE-$(cat "$0" "$here"/patches/*.patch | sha256sum | cut -c1-16)"

if [ -f "$dist/.key" ] && [ "$(cat "$dist/.key")" = "$key" ]; then
  echo "$dist"
  exit 0
fi

if ! command -v emcc >/dev/null; then
  bash "$here/fetch.sh" src >/dev/null
  mount="$here"
  user=()
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) mount="$(cygpath -w "$here")" ;;
    *) user=(-u "$(id -u):$(id -g)") ;;
  esac
  echo "emcc not found: building in $EMSDK_IMAGE" >&2
  MSYS_NO_PATHCONV=1 docker run --rm "${user[@]}" -e HOME=/tmp -e EM_CACHE=/tmp/emcache -v "$mount:/ngspice" \
    "$EMSDK_IMAGE" bash /ngspice/build-wasm.sh
  exit $?
fi

tarball="$(bash "$here/fetch.sh" src)"
work="${NGSPICE_WASM_WORK:-/tmp/ngspice-wasm}"
rm -rf "$work" && mkdir -p "$work"
tar -xzf "$tarball" -C "$work"
cd "$work/ngspice-$NGSPICE_VERSION"
for p in "$here"/patches/*.patch; do patch -p1 -s < "$p"; done

log="$work/build.log"
{
  emconfigure ./configure --with-ngshared --disable-xspice --disable-osdi --disable-openmp --disable-klu \
    --with-readline=no --with-fftw3=no --without-x --disable-dependency-tracking \
    --enable-static --disable-shared --without-pic CFLAGS="-O2 -Dlow_latency" CXXFLAGS="-O2" &&
    # --with-ngshared hard-codes -shared (configure's STATIC and src/Makefile.am's libngspice
    # flags); emptying them makes libtool build a static libngspice.a (convenience libraries
    # included), which is linked into the module below.
    emmake make -j"$(nproc)" STATIC= libngspice_la_CFLAGS= libngspice_la_LDFLAGS=
} > "$log" 2>&1 || { grep -E 'error|Error' "$log" | head -30; echo "see $log" >&2; exit 1; }

lib=src/.libs/libngspice.a
[ -f "$lib" ] || { echo "$lib not found:" >&2; find src -name 'libngspice*' >&2; exit 1; }

exports='_ngSpice_Init,_ngSpice_Circ,_ngSpice_Command,_ngGet_Vec_Info,_ngSpice_CurPlot,_ngSpice_AllPlots,_ngSpice_AllVecs,_malloc,_free'
runtime='FS,addFunction,removeFunction,UTF8ToString,stringToUTF8,lengthBytesUTF8,getValue,setValue,HEAPU8,HEAPF64'
mkdir -p "$dist.tmp"
# em++: the C++ runtime for the HICUM/L2 model.
em++ -O2 "$lib" -o "$dist.tmp/ngspice.mjs" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createNgspice \
  -sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sSTACK_SIZE=1048576 -sALLOW_TABLE_GROWTH=1 \
  -sEXPORTED_FUNCTIONS="$exports" -sEXPORTED_RUNTIME_METHODS="$runtime" \
  >> "$log" 2>&1 || { tail -30 "$log"; exit 1; }
# ngspice is mostly BSD, numparam is LGPL: its licence ships next to the binary (README.md).
cp COPYING "$dist.tmp/COPYING"

rm -rf "$dist" && mv "$dist.tmp" "$dist"
echo "$key" > "$dist/.key"
ls -l "$dist"
echo "$dist"
