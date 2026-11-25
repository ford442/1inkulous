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
#
# What those two builds are lives in cpp/CMakePresets.json (wasm-release and
# wasm-debug); this script only runs the preset and checks what came out, so the
# flags are written down in one place, shared with anyone running cmake by hand.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="${1:-release}"
case "${MODE}" in
  release)
    PRESET=wasm-release
    BUILD_DIR="${ROOT}/cpp/build-wasm"
    ;;
  debug)
    PRESET=wasm-debug
    BUILD_DIR="${ROOT}/cpp/build-wasm-debug"
    ;;
  *)
    echo "usage: build-wasm.sh [release|debug]" >&2
    exit 2
    ;;
esac

# The Emscripten release the core is built and tested with (also what CI installs).
EMSDK_VERSION="$(tr -d '[:space:]' < "${ROOT}/.emsdk-version")"

if ! command -v emcmake >/dev/null 2>&1; then
  cat >&2 <<MESSAGE
error: Emscripten not found on PATH (emcmake is missing).

The simulation core is C++ compiled to WebAssembly, so the app cannot run
without it. Install the SDK once:

  git clone https://github.com/emscripten-core/emsdk.git
  cd emsdk && ./emsdk install ${EMSDK_VERSION} && ./emsdk activate ${EMSDK_VERSION}

Then activate it in each shell (add to your profile to make it permanent):

  source /path/to/emsdk/emsdk_env.sh

Verify with \`emcc -v\`, then re-run \`npm run build:wasm\`.
MESSAGE
  exit 1
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "error: cmake not found on PATH; it is required to build cpp/." >&2
  exit 1
fi

emcc_banner="$(emcc --version | head -n 1)"
echo "building simulation core (${PRESET}) with ${emcc_banner}"
if [[ "${emcc_banner}" != *" ${EMSDK_VERSION} "* ]]; then
  echo "warning: the core is built and tested with Emscripten ${EMSDK_VERSION} (.emsdk-version); this is a different release." >&2
fi

# Presets are read from the source directory, hence the cd.
(
  cd "${ROOT}/cpp"
  emcmake cmake --preset "${PRESET}"
  cmake --build --preset "${PRESET}"
)

# Where the preset put the output: read back from the configured build rather
# than repeated here, so the preset is the only place it is written.
OUT_DIR="$(sed -n 's/^CORE_OUTPUT_DIR:[A-Z]*=//p' "${BUILD_DIR}/CMakeCache.txt")"
if [[ -z "${OUT_DIR}" ]]; then
  echo "error: ${BUILD_DIR}/CMakeCache.txt has no CORE_OUTPUT_DIR; is the ${PRESET} preset intact?" >&2
  exit 1
fi
OUT_DIR="$(cd "${OUT_DIR}" && pwd)"

for artifact in core.js core.wasm; do
  if [[ ! -f "${OUT_DIR}/${artifact}" ]]; then
    echo "error: expected ${OUT_DIR}/${artifact} to exist after the build." >&2
    exit 1
  fi
done

# The memory the module will really ask for, read from the binary rather than
# repeating what CMake was told: this is what the browser instantiates.
memory="$(node "${ROOT}/scripts/wasm-memory.mjs" "${OUT_DIR}/core.wasm")"

echo "wasm core (${PRESET}) written to ${OUT_DIR#"${ROOT}/"}/ " \
     "($(du -h "${OUT_DIR}/core.wasm" | cut -f1) core.wasm, ${memory})"

if [[ "${MODE}" == debug ]]; then
  echo "debug build only: it does not replace src/wasm/. Load it with" \
       "CORE_WASM_DIR=${OUT_DIR#"${ROOT}/"} (npm run dev:debug)."
fi
