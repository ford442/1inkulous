import type { Vec3 } from '../engine/math'
import createCoreModule, { type CoreModule } from '../wasm/core.js'
import type { BuildingSite } from './buildingSite'
import type { HutSite } from './hutSite'
import type { LandBridge } from './landBridge'

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

export { BuildingSite } from './buildingSite'
export { HutSite } from './hutSite'
export { LandBridge } from './landBridge'

/** What a successful Land Bridge cast asks the terrain to do. */
export type LandBridgePlan = {
  /** Stamp centres along the bridge, as unit directions, in order. */
  readonly stamps: readonly Vec3[]
  /** Angular radius of each stamp, in radians. */
  readonly stampRadius: number
  /** Height above sea level the centre line is raised to. */
  readonly height: number
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

  /** Whether a hut could stand centred on a direction, and if not, why. */
  hutSite: (direction: Vec3) => HutSite
  /** Builds a hut there, door along `heading`. Returns its id, or -1 if refused. */
  placeHut: (direction: Vec3, heading: Vec3) => number
  readonly hutCount: number
  /** Followers inside every hut together. */
  readonly housedCount: number
  hutOccupants: (id: number) => number
  /** Sends selected followers into a hut, as many as fit. Returns how many went. */
  orderEnterHut: (id: number) => number
  /** Live view of the hut instance buffer, `hutInstanceFloats` per hut. Re-read per frame. */
  hutInstances: () => Float32Array
  readonly hutInstanceFloats: number
  /** Hut footprint radius in world units, as the core places them. */
  readonly hutRadius: number
  readonly hutCapacity: number

  /** Whether a building could claim the nav node nearest a direction, and if not, why. */
  buildingSite: (direction: Vec3) => BuildingSite
  /**
   * Claims that node for `tribe` and `kind` (0 is a hut). Returns its id, or
   * -1 if the site is water, too steep, already taken, or otherwise refused.
   * Does not sculpt.
   */
  placeBuilding: (direction: Vec3, tribe: number, kind: number) => number
  readonly buildingCount: number
  /**
   * Live view of the building instance buffer — position, tribe, kind,
   * occupants, flags. Re-read it every frame.
   */
  buildingInstances: () => Float32Array
  readonly buildingInstanceFloats: number
  /** Placeholder radius in world units, for the mesh and the build cursor. */
  readonly buildingRadius: number

  /** Spawns a tribe's shaman. Returns her follower id, or -1 if refused. */
  spawnShaman: (direction: Vec3, tribe: number) => number
  /** A tribe's shaman's follower id, or -1. Ids shift; look it up each time. */
  shamanId: (tribe: number) => number
  mana: (tribe: number) => number
  /** Mana a tribe is gaining per second right now. */
  manaIncome: (tribe: number) => number
  setMana: (tribe: number, mana: number) => void
  readonly manaMax: number
  readonly landBridgeCost: number
  /** Furthest either end of a bridge may be from the shaman, in world units. */
  readonly landBridgeRange: number
  /** Angular radius of each bridge stamp, in radians: half the strip's width. */
  readonly landBridgeStampRadius: number
  /** Whether a tribe's shaman could bridge `from` to `to`, and if not, why. */
  checkLandBridge: (tribe: number, from: Vec3, to: Vec3) => LandBridge
  /**
   * Casts it: on success the mana is spent and the plan comes back for the
   * terrain to carry out; otherwise the reason, and nothing has changed.
   */
  castLandBridge: (
    tribe: number,
    from: Vec3,
    to: Vec3,
  ) => { result: LandBridge; plan: LandBridgePlan | null }

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
  const hutInstanceFloats = module._core_hut_instance_floats()
  const buildingInstanceFloats = module._core_building_instance_floats()
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
      // `TypedArray.set` bounds-checks against the whole heap view, not against
      // the region the core allocated, so an oversized array here would scribble
      // over unrelated core memory without raising anything.
      if (
        graph.directions.length !== graph.nodeCount * 3 ||
        graph.neighborOffsets.length !== graph.nodeCount + 1 ||
        graph.neighbors.length !== graph.linkCount
      ) {
        throw new Error(
          `Navigation graph arrays do not match ${graph.nodeCount} nodes and ` +
            `${graph.linkCount} links.`,
        )
      }

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
      // The core validates the CSR topology on commit and simply stays unready
      // if it does not hold. Fail here rather than leaving a world whose units
      // silently refuse every order.
      if (module._core_nav_ready() !== 1) {
        throw new Error(
          'Simulation core rejected the navigation graph topology on commit.',
        )
      }
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

    hutSite(direction: Vec3) {
      return module._core_hut_site(direction[0], direction[1], direction[2]) as HutSite
    },

    placeHut(direction: Vec3, heading: Vec3) {
      return module._core_hut_place(
        direction[0],
        direction[1],
        direction[2],
        heading[0],
        heading[1],
        heading[2],
      )
    },

    get hutCount() {
      return module._core_hut_count()
    },

    get housedCount() {
      return module._core_huts_housed()
    },

    hutOccupants(id: number) {
      return module._core_hut_occupants(id)
    },

    orderEnterHut(id: number) {
      return module._core_hut_order_enter(id)
    },

    hutInstances() {
      const count = module._core_hut_count()
      if (count === 0) {
        return new Float32Array(0)
      }
      const start = module._core_hut_instances() >> 2
      return module.HEAPF32.subarray(start, start + count * hutInstanceFloats)
    },

    hutInstanceFloats,
    hutRadius: module._core_hut_radius(),
    hutCapacity: module._core_hut_capacity(),

    buildingSite(direction: Vec3) {
      return module._core_building_site(direction[0], direction[1], direction[2]) as BuildingSite
    },

    placeBuilding(direction: Vec3, tribe: number, kind: number) {
      return module._core_building_place(direction[0], direction[1], direction[2], tribe, kind)
    },

    get buildingCount() {
      return module._core_building_count()
    },

    buildingInstances() {
      const count = module._core_building_count()
      if (count === 0) {
        return new Float32Array(0)
      }
      const start = module._core_building_instances() >> 2
      return module.HEAPF32.subarray(start, start + count * buildingInstanceFloats)
    },

    buildingInstanceFloats,
    buildingRadius: module._core_building_radius(),

    spawnShaman(direction: Vec3, tribe: number) {
      return module._core_shaman_spawn(direction[0], direction[1], direction[2], tribe)
    },

    shamanId(tribe: number) {
      return module._core_shaman(tribe)
    },

    mana(tribe: number) {
      return module._core_mana(tribe)
    },

    manaIncome(tribe: number) {
      return module._core_mana_income(tribe)
    },

    setMana(tribe: number, mana: number) {
      module._core_mana_set(tribe, mana)
    },

    manaMax: module._core_mana_max(),
    landBridgeCost: module._core_land_bridge_cost(),
    landBridgeRange: module._core_land_bridge_range(),
    // Read live: it depends on the planet radius the nav graph commits.
    get landBridgeStampRadius() {
      return module._core_land_bridge_stamp_radius()
    },

    checkLandBridge(tribe: number, from: Vec3, to: Vec3) {
      return module._core_land_bridge_check(
        tribe,
        from[0],
        from[1],
        from[2],
        to[0],
        to[1],
        to[2],
      ) as LandBridge
    },

    castLandBridge(tribe: number, from: Vec3, to: Vec3) {
      const result = module._core_land_bridge_cast(
        tribe,
        from[0],
        from[1],
        from[2],
        to[0],
        to[1],
        to[2],
      ) as LandBridge
      if (result !== 0) {
        return { result, plan: null }
      }
      // Copied out at once: the buffer is the core's and the next cast reuses it.
      const count = module._core_land_bridge_stamp_count()
      const start = module._core_land_bridge_stamps() >> 2
      const stamps: Vec3[] = []
      for (let i = 0; i < count; i += 1) {
        const base = start + i * 3
        stamps.push([module.HEAPF32[base], module.HEAPF32[base + 1], module.HEAPF32[base + 2]])
      }
      return {
        result,
        plan: {
          stamps,
          stampRadius: module._core_land_bridge_stamp_radius(),
          height: module._core_land_bridge_height(),
        },
      }
    },
  }
}
