#!/usr/bin/env bash
#
# Compiles cpp/ to WebAssembly. Fails loudly when Emscripten is not on PATH
# rather than leaving the app to break at runtime.
#
#   scripts/build-wasm.sh            release: into src/wasm/, what the app loads
#   scripts/build-wasm.sh debug      -O0 -g -sASSERTIONS=2: into
#                                    cpp/build-wasm-debug/out/, its own build and
#                                    output directories so it can neither be
#                                    mistaken for nor overwrite the release one.
#                                    Use it with CORE_WASM_DIR (see README).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="${1:-release}"
case "${MODE}" in
  release)
    BUILD_TYPE=Release
    BUILD_DIR="${ROOT}/cpp/build-wasm"
    OUT_DIR="${ROOT}/src/wasm"
    ;;
  debug)
    BUILD_TYPE=Debug
    BUILD_DIR="${ROOT}/cpp/build-wasm-debug"
    OUT_DIR="${BUILD_DIR}/out"
    ;;
  *)
    echo "usage: build-wasm.sh [release|debug]" >&2
    exit 2
    ;;
esac

if ! command -v emcmake >/dev/null 2>&1; then
  cat >&2 <<'MESSAGE'
error: Emscripten not found on PATH (emcmake is missing).

The simulation core is C++ compiled to WebAssembly, so the app cannot run
without it. Install the SDK once:

  git clone https://github.com/emscripten-core/emsdk.git
  cd emsdk && ./emsdk install latest && ./emsdk activate latest

Then activate it in each shell (add to your profile to make it permanent):

  source /path/to/emsdk/emsdk_env.sh

Verify with `emcc -v`, then re-run `npm run build:wasm`.
MESSAGE
  exit 1
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "error: cmake not found on PATH; it is required to build cpp/." >&2
  exit 1
fi

echo "building simulation core (${BUILD_TYPE}) with $(emcc --version | head -n 1)"

emcmake cmake -S "${ROOT}/cpp" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE="${BUILD_TYPE}" \
  -DCORE_OUTPUT_DIR="${OUT_DIR}"
cmake --build "${BUILD_DIR}"

for artifact in core.js core.wasm; do
  if [[ ! -f "${OUT_DIR}/${artifact}" ]]; then
    echo "error: expected ${OUT_DIR}/${artifact} to exist after the build." >&2
    exit 1
  fi
done

# The memory the module will really ask for, read from the binary rather than
# repeating what CMake was told: this is what the browser instantiates.
memory="$(node "${ROOT}/scripts/wasm-memory.mjs" "${OUT_DIR}/core.wasm")"

echo "wasm core (${BUILD_TYPE}) written to ${OUT_DIR#"${ROOT}/"}/ " \
     "($(du -h "${OUT_DIR}/core.wasm" | cut -f1) core.wasm, ${memory})"

if [[ "${MODE}" == debug ]]; then
  echo "debug build only: it does not replace src/wasm/. Load it with" \
       "CORE_WASM_DIR=${OUT_DIR#"${ROOT}/"} (npm run dev:debug)."
fi
