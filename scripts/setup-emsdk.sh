#!/usr/bin/env bash
#
# Installs and activates the Emscripten SDK when it is not already on PATH.
# Used by the Cursor cloud environment install step and can be run manually.

set -euo pipefail

EMSDK_ROOT="${EMSDK:-/opt/emsdk}"
# The one Emscripten release the repo is built and tested with, shared with CI.
EMSDK_VERSION="$(tr -d '[:space:]' < "$(dirname "${BASH_SOURCE[0]}")/../.emsdk-version")"

if command -v emcmake >/dev/null 2>&1; then
  echo "Emscripten already on PATH: $(emcc --version | head -n 1)"
  exit 0
fi

if [[ ! -d "${EMSDK_ROOT}" ]]; then
  echo "cloning Emscripten SDK into ${EMSDK_ROOT}"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "${EMSDK_ROOT}"
fi

cd "${EMSDK_ROOT}"
./emsdk install "${EMSDK_VERSION}"
./emsdk activate "${EMSDK_VERSION}"

echo "Emscripten ready: $(./upstream/emscripten/emcc --version | head -n 1)"
