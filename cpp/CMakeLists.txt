cmake_minimum_required(VERSION 3.20)
project(1inkulous_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Build the WebAssembly module with:
#   npm run build:wasm
# which wraps:
#   emcmake cmake -S cpp -B cpp/build-wasm -DCMAKE_BUILD_TYPE=Release
#   cmake --build cpp/build-wasm
#
# Outputs land in src/wasm/ (core.js glue + core.wasm) so Vite bundles the .wasm
# as an asset and hashes it like any other import.
#
# Without Emscripten this configures as a plain static library, which is what
# native unit tests and tooling will link against.

set(CORE_SOURCES
  src/core.cpp
  src/core_abi.cpp
)

if(EMSCRIPTEN)
  set(WASM_OUTPUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../src/wasm")

  add_executable(core ${CORE_SOURCES})
  target_include_directories(core PRIVATE include)

  set_target_properties(core PROPERTIES
    OUTPUT_NAME "core"
    SUFFIX ".js"
    RUNTIME_OUTPUT_DIRECTORY "${WASM_OUTPUT_DIR}"
  )

  target_compile_options(core PRIVATE -O3)

  target_link_options(core PRIVATE
    -O3
    # A library, not a program: there is no main().
    --no-entry
    # An ES module exporting a factory, so Vite can bundle it and the .wasm
    # resolves relative to the glue through import.meta.url.
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createCoreModule
    # `node` is included so the module can be exercised headlessly in CI.
    -sENVIRONMENT=web,worker,node
    # UTF8ToString reads the version string back; the HEAP views are the
    # zero-copy path for bulk state, so they must be exported explicitly —
    # current Emscripten omits them otherwise. Everything else is called
    # directly as Module._core_*.
    -sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPU8,HEAP32,HEAPF32,HEAPF64
    # Simulation state will grow as units and terrain move in; let it.
    -sALLOW_MEMORY_GROWTH=1
    # Fail the build on an unresolved symbol rather than at runtime.
    -sSTRICT=1
    # No filesystem shims: the core never touches files.
    -sFILESYSTEM=0
  )
else()
  add_library(1inkulous_core STATIC ${CORE_SOURCES})
  target_include_directories(1inkulous_core PUBLIC include)
endif()
