/**
 * Hand-written types for the Emscripten glue that `npm run build:wasm` emits
 * next to this file as `core.js`. The glue itself is generated and gitignored;
 * this declaration is the checked-in contract, so a change to the C ABI in
 * cpp/include/1inkulous/core_abi.h has to be mirrored here.
 *
 * The underscore-prefixed members are the exported C functions. Use the wrapper
 * in src/sim/simulation.ts rather than reaching for these directly.
 */

export type CoreModule = {
  _core_version: () => number
  /** Pointer into linear memory; decode with UTF8ToString. */
  _core_version_text: () => number
  _core_init: (stepMs: number) => void
  _core_tick: (deltaMs: number) => number
  _core_step_ms: () => number
  _core_step_count: () => number
  _core_elapsed_ms: () => number
  _core_pending_ms: () => number
  _core_reset: () => void

  UTF8ToString: (pointer: number) => string

  /** Module linear memory, for reading bulk state without per-call copies. */
  readonly HEAPU8: Uint8Array
  readonly HEAPF32: Float32Array
  readonly HEAPF64: Float64Array
  readonly HEAP32: Int32Array
}

export type CoreModuleOptions = {
  /** Override where the .wasm is fetched from. Vite resolves it by default. */
  locateFile?: (path: string, prefix: string) => string
  print?: (message: string) => void
  printErr?: (message: string) => void
}

export default function createCoreModule(
  options?: CoreModuleOptions,
): Promise<CoreModule>
