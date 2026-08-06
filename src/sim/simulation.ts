import type { Vec3 } from '../engine/math'
import createCoreModule, { type CoreModule } from '../wasm/core.js'

/**
 * The JS side of the WASM boundary.
 *
 * Rendering stays in TypeScript; simulation lives in C++ behind `tick`. Only
 * scalars cross per frame — as state grows, it should be read out of
 * `module.HEAPF32` and friends rather than marshalled through calls.
 */

/** The navigation graph the core paths over, as TypeScript hands it in. */
export type NavGraphUpload = {
  readonly nodeCount: number
  readonly linkCount: number
  readonly directions: Float32Array
  readonly neighborOffsets: Int32Array
  readonly neighbors: Int32Array
}

export type NavCommitOptions = {
  planetRadius: number
  /** Steepest walkable ground as height over run. Omit for the core's default. */
  maxSlope?: number
}

export type Simulation = {
  /** Core version reported by the module, e.g. "0.2.0". */
  readonly version: string
  /** Fixed step length in milliseconds. */
  readonly stepMs: number
  /** Fixed steps run since load. */
  readonly stepCount: number
  /** Simulated time in milliseconds — whole steps only. */
  readonly elapsedMs: number
  /**
   * Feeds a frame's elapsed time to the core and returns how many fixed steps
   * ran. 0 is normal on a frame shorter than one step.
   */
  tick: (deltaMs: number) => number
  reset: () => void

  /**
   * Uploads the walkable graph. Copies the topology into the core once; call
   * `writeNavHeights` afterwards and whenever the terrain moves.
   */
  uploadNavGraph: (graph: NavGraphUpload, options: NavCommitOptions) => void
  /**
   * Overwrites the core's height per node, in place. Cheap enough to call on
   * every frame a sculpt stroke touched the terrain.
   */
  writeNavHeights: (heights: Float32Array) => void
  readonly navReady: boolean

  spawnFollower: (direction: Vec3, tribe: number) => number
  readonly followerCount: number
  readonly selectedFollowerCount: number
  setFollowerSelected: (id: number, selected: boolean) => void
  clearFollowerSelection: () => void
  /** Sends every selected follower to a terrain direction. Returns how many routed. */
  orderFollowerMove: (direction: Vec3) => number
  /**
   * Live view of the packed instance buffer — `followerInstanceFloats` floats
   * per follower, in id order. Re-read it every frame: the pointer moves as the
   * population grows and the view is invalidated when linear memory grows.
   */
  followerInstances: () => Float32Array
  readonly followerInstanceFloats: number

  /** Escape hatch for future bulk reads straight out of linear memory. */
  readonly module: CoreModule
}

export type SimulationOptions = {
  /** Fixed step length in ms. Omit for the core's default (50ms = 20Hz). */
  stepMs?: number
}

export async function createSimulation(
  options: SimulationOptions = {},
): Promise<Simulation> {
  let module: CoreModule
  try {
    module = await createCoreModule({
      printErr: (message) => console.error(`[core] ${message}`),
    })
  } catch (cause) {
    throw new Error(
      'Failed to instantiate the WebAssembly simulation core. Run `npm run build:wasm` ' +
        '(requires Emscripten) and reload.',
      { cause },
    )
  }

  const version = module.UTF8ToString(module._core_version_text())
  const encoded = module._core_version()
  // Catches a stale src/wasm/ build against a newer checked-in ABI.
  const expected =
    Number(version.split('.')[0]) * 10000 +
    Number(version.split('.')[1]) * 100 +
    Number(version.split('.')[2])
  if (encoded !== expected) {
    throw new Error(
      `Simulation core reported inconsistent versions (${encoded} vs "${version}").`,
    )
  }

  module._core_init(options.stepMs ?? 0)

  const instanceFloats = module._core_follower_instance_floats()
  // Cached only to spot a stale build; the pointer itself is re-read per call.
  let navNodeCount = 0

  return {
    version,
    module,
    get stepMs() {
      return module._core_step_ms()
    },
    get stepCount() {
      return module._core_step_count()
    },
    get elapsedMs() {
      return module._core_elapsed_ms()
    },
    tick(deltaMs: number) {
      return module._core_tick(deltaMs)
    },
    reset() {
      module._core_reset()
    },

    uploadNavGraph(graph: NavGraphUpload, commit: NavCommitOptions) {
      if (module._core_nav_alloc(graph.nodeCount, graph.linkCount) !== 1) {
        throw new Error(
          `Simulation core rejected a navigation graph of ${graph.nodeCount} nodes ` +
            `and ${graph.linkCount} links.`,
        )
      }

      // Byte offsets into linear memory; the typed-array views are indexed in
      // elements, hence the shifts. HEAP views are re-read here because an
      // allocation above may have grown — and so replaced — them.
      module.HEAPF32.set(graph.directions, module._core_nav_directions() >> 2)
      module.HEAP32.set(graph.neighborOffsets, module._core_nav_neighbor_offsets() >> 2)
      module.HEAP32.set(graph.neighbors, module._core_nav_neighbors() >> 2)

      module._core_nav_commit(commit.planetRadius, commit.maxSlope ?? 0)
      navNodeCount = graph.nodeCount
    },

    writeNavHeights(heights: Float32Array) {
      if (heights.length !== navNodeCount) {
        throw new Error(
          `Height buffer of ${heights.length} does not match the core's ` +
            `${navNodeCount} navigation nodes.`,
        )
      }
      module.HEAPF32.set(heights, module._core_nav_heights() >> 2)
    },

    get navReady() {
      return module._core_nav_ready() === 1
    },

    spawnFollower(direction: Vec3, tribe: number) {
      return module._core_follower_spawn(direction[0], direction[1], direction[2], tribe)
    },

    get followerCount() {
      return module._core_follower_count()
    },

    get selectedFollowerCount() {
      return module._core_follower_selected_count()
    },

    setFollowerSelected(id: number, selected: boolean) {
      module._core_follower_set_selected(id, selected ? 1 : 0)
    },

    clearFollowerSelection() {
      module._core_follower_clear_selection()
    },

    orderFollowerMove(direction: Vec3) {
      return module._core_follower_order_move(direction[0], direction[1], direction[2])
    },

    followerInstances() {
      const count = module._core_follower_count()
      if (count === 0) {
        return new Float32Array(0)
      }
      const start = module._core_follower_instances() >> 2
      return module.HEAPF32.subarray(start, start + count * instanceFloats)
    },

    followerInstanceFloats: instanceFloats,
  }
}
