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

  /** Navigation graph. Sizes it, then hands back pointers for TS to fill. */
  _core_nav_alloc: (nodeCount: number, linkCount: number) => number
  /** Pointers into linear memory — byte offsets, valid until the next alloc. */
  _core_nav_directions: () => number
  _core_nav_heights: () => number
  _core_nav_neighbor_offsets: () => number
  _core_nav_neighbors: () => number
  _core_nav_commit: (planetRadius: number, maxSlope: number) => void
  _core_nav_node_count: () => number
  _core_nav_ready: () => number
  _core_nav_nearest_walkable: (x: number, y: number, z: number) => number

  _core_follower_spawn: (x: number, y: number, z: number, tribe: number) => number
  _core_follower_count: () => number
  _core_followers_clear: () => void
  /** Pointer to the packed instance buffer; moves as the population grows. */
  _core_follower_instances: () => number
  _core_follower_instance_floats: () => number
  _core_follower_set_selected: (id: number, selected: number) => void
  _core_follower_clear_selection: () => void
  _core_follower_selected_count: () => number
  _core_follower_order_move: (x: number, y: number, z: number) => number
  _core_follower_speed: () => number
  _core_follower_set_speed: (speed: number) => void

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
