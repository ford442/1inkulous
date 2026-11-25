/**
 * Types for the Emscripten glue that `npm run build:wasm` emits next to this
 * file as `core.js`. The glue itself is generated and gitignored.
 *
 * The exported C functions — every `_core_*` member — are not written here: they
 * are generated from cpp/include/1inkulous/core_abi.h into ./core-abi.d.ts
 * (`npm run gen:abi`), so the header is the only place the ABI is declared. What
 * this file adds is the Emscripten runtime half of the module.
 */

import type { CoreExports } from './core-abi.d.ts'

export type { CoreExports, Ptr } from './core-abi.d.ts'

export type CoreModule = CoreExports & {
  /** Decodes a NUL-terminated string at a pointer into linear memory. */
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

export default function createCoreModule(options?: CoreModuleOptions): Promise<CoreModule>
