#!/usr/bin/env bash
#
# Compiles cpp/ to WebAssembly into src/wasm/. Fails loudly when Emscripten is
# not on PATH rather than leaving the app to break at runtime.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT}/cpp/build-wasm"
OUT_DIR="${ROOT}/src/wasm"

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

echo "building simulation core with $(emcc --version | head -n 1)"

emcmake cmake -S "${ROOT}/cpp" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release
cmake --build "${BUILD_DIR}"

for artifact in core.js core.wasm; do
  if [[ ! -f "${OUT_DIR}/${artifact}" ]]; then
    echo "error: expected ${OUT_DIR}/${artifact} to exist after the build." >&2
    exit 1
  fi
done

echo "wasm core written to src/wasm/ ($(du -h "${OUT_DIR}/core.wasm" | cut -f1) core.wasm)"
