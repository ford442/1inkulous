cmake_minimum_required(VERSION 3.20)
project(1inkulous_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Build the WebAssembly module with:
#   npm run build:wasm          release: -O3 -flto, sized memory
#   npm run build:wasm:debug    -O0 -g -sASSERTIONS=2, opt-in
# which wrap:
#   emcmake cmake -S cpp -B cpp/build-wasm -DCMAKE_BUILD_TYPE=Release
#   cmake --build cpp/build-wasm
#
# The release outputs land in src/wasm/ (core.js glue + core.wasm) so Vite
# bundles the .wasm as an asset and hashes it like any other import. The debug
# build has its own build directory *and* its own output directory
# (CORE_OUTPUT_DIR): were it to write src/wasm/, make would see those files as
# newer than the release inputs and quietly keep the debug binary on the next
# release build.
#
# Without Emscripten this configures as a plain static library, which is what
# native unit tests and tooling will link against.

set(CORE_SOURCES
  src/core.cpp
  src/core_abi.cpp
  src/followers.cpp
  src/huts.cpp
  src/nav.cpp
  src/shaman.cpp
  src/terrain.cpp
)

# Nothing in cpp/ uses RTTI or exceptions, so say so: a stray `dynamic_cast` or
# `throw` fails the build instead of pulling the runtime support in. MSVC has
# its own spelling and is not a target here.
function(core_language_options target)
  if(NOT MSVC)
    target_compile_options(${target} PRIVATE -fno-rtti -fno-exceptions)
  endif()
endfunction()

if(EMSCRIPTEN)
  # Plain defaults, overridable with -D. Not CACHE entries: a cached default
  # would outlive an edit to this file in every existing build directory.
  if(NOT DEFINED CORE_OUTPUT_DIR)
    set(CORE_OUTPUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../src/wasm")
  endif()

  # Linear memory, sized from measurement (scripts/test-memory.ts): a full tribe
  # (kMaxFollowers) all sent across the world, with huts, peaks at about
  #   planet resolution 24 (the default)   3 MB
  #                     48                 8 MB   (room for all kMaxHuts)
  #                     96                29 MB
  #                    160                80 MB
  # INITIAL_MEMORY holds the default planet with a wide margin, so a match never
  # grows the heap, and the test fails if that stops being true. Growth stays
  # enabled for a bigger planet, but MAXIMUM_MEMORY caps it: a leak, or a planet
  # raised past what this was sized for, aborts the module at a stack trace
  # instead of swelling the tab. Raise both on purpose when the planet grows.
  # Untouched pages cost nothing until the core writes to them.
  if(NOT DEFINED CORE_INITIAL_MEMORY)
    set(CORE_INITIAL_MEMORY 33554432)
  endif()
  if(NOT DEFINED CORE_MAXIMUM_MEMORY)
    set(CORE_MAXIMUM_MEMORY 134217728)
  endif()

  add_executable(core ${CORE_SOURCES})
  target_include_directories(core PRIVATE include)
  core_language_options(core)

  set_target_properties(core PROPERTIES
    OUTPUT_NAME "core"
    SUFFIX ".js"
    RUNTIME_OUTPUT_DIRECTORY "${CORE_OUTPUT_DIR}"
  )

  if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    # Slow and large on purpose: stack overflow and heap checks, names and
    # DWARF for the browser's debugger. Never what `npm run dev` builds.
    target_compile_options(core PRIVATE -O0 -g)
    target_link_options(core PRIVATE -O0 -g -sASSERTIONS=2)
  else()
    # LTO has to be on for compile and link alike.
    #
    # -msimd128 was tried and is left off: the compiler vectorised a few hundred
    # instructions and the wasm grew 4%, but route and step times on the 3600-
    # node graph (test:core's cost block) did not move outside run-to-run noise.
    # Search and steering are branchy scalar work. Revisit if a bulk pass such as
    # a compute-style terrain relax moves into the core.
    target_compile_options(core PRIVATE -O3 -flto)
    target_link_options(core PRIVATE -O3 -flto)
  endif()

  target_link_options(core PRIVATE
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
    -sINITIAL_MEMORY=${CORE_INITIAL_MEMORY}
    -sMAXIMUM_MEMORY=${CORE_MAXIMUM_MEMORY}
    # A bigger planet needs more than the initial heap; let it, up to the cap.
    -sALLOW_MEMORY_GROWTH=1
    # STRICT drops every incoming Module option from the glue unless it is
    # listed. These are the ones CoreModuleOptions in src/wasm/core.d.ts offers
    # and simulation.ts passes: without them `printErr` is silently ignored in
    # release, and ASSERTIONS=2 aborts at startup over it.
    -sINCOMING_MODULE_JS_API=locateFile,print,printErr
    # Fail the build on an unresolved symbol rather than at runtime.
    -sSTRICT=1
    # No filesystem shims: the core never touches files.
    -sFILESYSTEM=0
  )
else()
  add_library(1inkulous_core STATIC ${CORE_SOURCES})
  target_include_directories(1inkulous_core PUBLIC include)
  core_language_options(1inkulous_core)
endif()
