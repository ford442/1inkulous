import type { Vec3 } from '../engine/math'
import createCoreModule, { type CoreModule } from '../wasm/core.js'
import { HutKind, type HutSite } from './hutSite'
import type { Spell, SpellResult } from './spell'
import type { Role } from './role'
import type { AiAction, AiWeights } from './ai'

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
  /** Highest the terrain may be raised, above sea level. Omit for no ceiling. */
  maxHeight?: number
}

/** An inclusive run of nav node ids. */
export type NodeRange = { readonly first: number; readonly last: number }

export { HutKind, HutSite } from './hutSite'
export { Spell, SpellResult, SPELLS, SPELL_NEVER } from './spell'
export { Role } from './role'
export { AiAction } from './ai'

/**
 * What the core's world generator takes (inkulous::WorldGenParams in
 * cpp/include/1inkulous/worldgen.hpp, which says what each one does). Every
 * field but the seed may be left out for the core's default.
 */
export type WorldGenParams = {
  readonly seed: number
  readonly land?: number
  readonly continents?: number
  readonly continentSize?: number
  readonly continentWeight?: number
  readonly frequency?: number
  readonly octaves?: number
  readonly persistence?: number
  readonly lacunarity?: number
  readonly warp?: number
  readonly ridges?: number
  readonly relief?: number
  readonly peak?: number
  readonly smoothing?: number
}

/** The core's defaults, field for field. */
export const DEFAULT_WORLDGEN: Required<Omit<WorldGenParams, 'seed'>> = {
  land: 0.4,
  continents: 3,
  continentSize: 0.8,
  continentWeight: 0.55,
  frequency: 1.8,
  octaves: 5,
  persistence: 0.5,
  lacunarity: 2,
  warp: 0.25,
  ridges: 0.3,
  relief: 1.5,
  peak: 0.9,
  smoothing: 1,
}

/** A hut site as the core judged it. */
export type HutSiteReport = {
  readonly site: HutSite
  /** The anchor node's unit direction, where the hut would stand; null with no node. */
  readonly centre: Vec3 | null
  /** Angle in radians from the centre to the furthest footprint node. */
  readonly footprint: number
}

/**
 * What the last Land Bridge to land laid. The core has already raised the
 * land; this is for drawing and for tests.
 */
export type LandBridgePlan = {
  /** Stamp centres along the bridge, as unit directions, in order. */
  readonly stamps: readonly Vec3[]
  /** Angular radius of each stamp, in radians. */
  readonly stampRadius: number
  /** Height above sea level the centre line is raised to. */
  readonly height: number
}

/** A spell's fixed rules, as the core holds them. */
export type SpellRules = {
  /** Mana, spent when the cast lands. */
  readonly cost: number
  /** Furthest its target may be from the shaman, in world units along the ground. */
  readonly range: number
  readonly castSeconds: number
  /** Seconds after it lands before the tribe may cast it again. */
  readonly cooldownSeconds: number
}

/** A cast under way. */
export type SpellCast = {
  readonly spell: Spell
  /** 0..1 through the cast time. */
  readonly progress: number
  /** Where it lands: the disc's centre, a bridge's far end. */
  readonly target: Vec3
  /** The disc's angular radius, in radians. */
  readonly radius: number
}

/** How a tribe's most recent cast ended. */
export type SpellEnd = {
  /** Goes up by one each time a cast ends; 0 before the first. */
  readonly count: number
  readonly spell: Spell
  /** `SpellResult.ok` when it landed; otherwise why not. */
  readonly result: SpellResult
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
  /**
   * How far the clock is from the last step towards the next, in [0, 1). Each
   * follower is drawn that far from its previous pose to its current one, so
   * motion is smooth whatever the display rate.
   */
  readonly stepAlpha: number
  /** Clears the clock and its checkpoints. */
  reset: () => void
  /**
   * Runs exactly `count` fixed steps, leaving the frame-time accumulator
   * alone: how a replay (src/sim/replay.ts) or a lockstep peer drives the
   * core. Returns how many ran.
   */
  runSteps: (count: number) => number

  /**
   * Seeds the match's random generator, the core's only source of chance.
   * Call it as the match starts, before anything draws from it (the forest).
   */
  seedMatch: (seed: number) => void
  /** What the match was last seeded with; a fresh core holds the default. */
  readonly matchSeed: number
  /**
   * The core's hash of everything that decides the next step, as a uint32.
   * Two cores fed the same seed and commands on the same steps agree on it.
   */
  stateHash: () => number
  /** The hash every `checkpointEvery` steps since the clock was cleared, oldest first. */
  checkpoints: () => { readonly step: number; readonly hash: number }[]
  readonly checkpointEvery: number

  /**
   * Uploads the walkable graph and seeds the terrain with `heights`, one per
   * node — the generated field. Done once: from then on the core owns the
   * heights, and only the terrain calls below change them.
   */
  uploadNavGraph: (
    graph: NavGraphUpload,
    heights: Float32Array,
    options: NavCommitOptions,
  ) => void
  readonly navReady: boolean

  /**
   * Live, read-only view of the core's height per node. Re-read it rather than
   * keeping it: the view is invalidated when linear memory grows.
   */
  navHeights: () => Float32Array
  /** Terrain height under a direction, on the triangle a walker there stands on. */
  terrainHeightAt: (direction: Vec3) => number
  /**
   * Raises (positive delta) or lowers the terrain inside an angular radius,
   * with a smooth falloff to the edge. Returns true if anything moved.
   */
  sculptTerrain: (centre: Vec3, angularRadius: number, delta: number) => boolean
  /**
   * Pulls the terrain inside an angular radius towards `targetHeight`, by at
   * most `rate` at the centre. Returns true if anything moved.
   */
  flattenTerrain: (
    centre: Vec3,
    angularRadius: number,
    targetHeight: number,
    rate: number,
  ) => boolean
  /**
   * The nodes any edit has moved since the last call, and clears them; null
   * when nothing has. What the mesh has to copy back.
   */
  takeTerrainDirty: () => NodeRange | null
  /**
   * Replaces the whole ground with a generated world: a seed and parameters,
   * run in the core. Marks every node dirty. Returns how many nodes are land.
   */
  generateTerrain: (params: WorldGenParams) => number
  /**
   * Replaces the whole ground with these heights, one per node: a scenario's
   * own height field, or the editor putting its ground back. Marks every node
   * dirty.
   */
  setTerrainHeights: (heights: Float32Array) => void
  /**
   * The walkable node nearest a direction, or -1. What a placement snaps to:
   * every follower and tree stands on one.
   */
  nearestWalkableNode: (direction: Vec3) => number
  /**
   * Takes everything off the world but the ground and the clock: followers,
   * huts, trees, mana, casts, unlocks, wood and the AI. The editor rebuilds a
   * world on this.
   */
  clearWorld: () => void

  spawnFollower: (direction: Vec3, tribe: number) => number
  readonly followerCount: number
  readonly selectedFollowerCount: number
  setFollowerSelected: (id: number, selected: boolean) => void
  clearFollowerSelection: () => void
  /** Sends every selected follower to a terrain direction. Returns how many routed. */
  orderFollowerMove: (direction: Vec3) => number
  /** 0 brave, 1 warrior; -1 for a bad id. */
  followerRole: (id: number) => Role | -1
  /** For tests and scenarios: false for a bad id or the shaman. */
  setFollowerRole: (id: number, role: Role) => boolean
  followerHealth: (id: number) => number
  /** For tests and scenarios; a follower set to 0 is gone after the next step. */
  setFollowerHealth: (id: number, health: number) => void
  readonly followerMaxHealth: number
  /** The tree a follower is on its way to chop, or -1. */
  followerTree: (id: number) => number
  /**
   * Live view of the packed instance buffer — `followerInstanceFloats` floats
   * per follower, in id order. Re-read it every frame: the pointer moves as the
   * population grows and the view is invalidated when linear memory grows.
   */
  followerInstances: () => Float32Array
  readonly followerInstanceFloats: number

  /**
   * Whether `tribe` could build a hut of `kind` on the nav node nearest a
   * direction, and if not, why — with that node's direction, where the hut
   * would be centred, and the angle to the edge of the footprint it would
   * block. Null centre when there is no node. Without a tribe (or with a
   * negative one) only the ground is judged; the kind defaults to a dwelling.
   */
  hutSite: (direction: Vec3, kind?: HutKind, tribe?: number) => HutSiteReport
  /**
   * Builds a hut of `kind` (a dwelling by default) there, door along
   * `heading`, owned by `tribe` (negative: unclaimed, and free, until someone
   * goes in), and charges the tribe its wood. Blocks the footprint to walking.
   * Returns its id, or -1 if refused. Does not sculpt.
   */
  placeHut: (direction: Vec3, heading: Vec3, tribe: number, kind?: HutKind) => number
  /** Wood `tribe`'s next hut of `kind` costs: 0 for its first dwelling. */
  hutCost: (kind: HutKind, tribe: number) => number
  /** -1 while unclaimed, or for a bad id. */
  hutTribe: (id: number) => number
  /** -1 for a bad id. */
  hutKind: (id: number) => HutKind | -1
  readonly hutCount: number
  /** Followers inside every hut together. */
  readonly housedCount: number
  hutOccupants: (id: number) => number
  /** Sends selected braves into a hut, as many as fit. Returns how many went. */
  orderEnterHut: (id: number) => number
  /** Sends everyone inside a hut back out of the door as braves. Returns how many. */
  ejectHut: (id: number) => number
  /** Live view of the hut instance buffer, `hutInstanceFloats` per hut. Re-read per frame. */
  hutInstances: () => Float32Array
  readonly hutInstanceFloats: number
  /** Hut footprint radius in world units, as the core places them. */
  readonly hutRadius: number
  /** People per dwelling, and per training hut. */
  readonly hutCapacity: number
  readonly trainingCapacity: number
  /** Wood one warrior's training costs, and how long it takes. */
  readonly warriorCost: number
  readonly trainSeconds: number

  /** Wood a tribe holds. */
  wood: (tribe: number) => number
  setWood: (tribe: number, wood: number) => void
  /**
   * Scatters up to `count` trees, replacing any, drawn from the match's
   * generator: seed the match first. Returns how many stand.
   */
  spawnTrees: (count: number) => number
  readonly treeCount: number
  /** Live view of the tree instance buffer, `treeInstanceFloats` per tree. Re-read per frame. */
  treeInstances: () => Float32Array
  readonly treeInstanceFloats: number
  /** Sends selected braves to chop a tree. Returns how many went. */
  orderChop: (id: number) => number
  /** 0..1 through chopping; -1 for a bad id. */
  treeProgress: (id: number) => number
  /**
   * Plants one tree on the walkable node nearest a direction: `size` a
   * multiple of the placeholder (default 1), `turn` its lean in radians round
   * the node (default 0). Its id, or -1. For tests, scenarios and the editor.
   */
  plantTree: (direction: Vec3, size?: number, turn?: number) => number
  /** A tree's size and lean, as `plantTree` takes them; 0 for a bad id. */
  treeSize: (id: number) => number
  treeTurn: (id: number) => number
  /** Wood a felled tree gives, and the brave-seconds it takes. */
  readonly woodPerTree: number
  readonly chopSeconds: number

  /** Spawns a tribe's shaman. Returns her follower id, or -1 if refused. */
  spawnShaman: (direction: Vec3, tribe: number) => number
  /** A tribe's shaman's follower id, or -1. Ids shift; look it up each time. */
  shamanId: (tribe: number) => number
  mana: (tribe: number) => number
  /** Mana a tribe is gaining per second right now. */
  manaIncome: (tribe: number) => number
  /** Everyone of a tribe, walking or inside a hut, as of the last step. */
  population: (tribe: number) => number
  setMana: (tribe: number, mana: number) => void
  readonly manaMax: number
  /** Each spell's rules, indexed by `Spell`. */
  readonly spellRules: readonly SpellRules[]
  /** Angular radius in radians of the disc a spell writes; for a bridge, of each stamp. */
  spellRadius: (spell: Spell) => number
  /**
   * Whether a tribe's shaman could cast `spell` at `target`, and if not, why.
   * `origin` is a Land Bridge's near end; omit it for wherever she stands.
   * Changes nothing.
   */
  checkSpell: (spell: Spell, tribe: number, target: Vec3, origin?: Vec3 | null) => SpellResult
  /**
   * The same check; on `ok` she stops and starts casting. Nothing is spent
   * until it lands, a cast time later — see `spellCasting` and `lastSpellEnd`.
   */
  castSpell: (spell: Spell, tribe: number, target: Vec3, origin?: Vec3 | null) => SpellResult
  /** Ends a tribe's cast in progress, with nothing spent. */
  cancelSpell: (tribe: number) => void
  /** The cast a tribe has under way, or null. */
  spellCasting: (tribe: number) => SpellCast | null
  /** Seconds before a tribe may cast `spell` again; 0 when it may. */
  spellCooldown: (tribe: number, spell: Spell) => number
  lastSpellEnd: (tribe: number) => SpellEnd
  /** The stamps of the last Land Bridge to land, or null if none has. */
  landBridgePlan: () => LandBridgePlan | null
  /**
   * Holds a spell back from a tribe: `at` 0 unlocks it now, SPELL_NEVER (-1)
   * locks it for the match, a positive number locks it until the tribe's
   * population first reaches that. A locked spell is refused as
   * `SpellResult.locked`, for the AI as for the player.
   */
  setSpellUnlock: (tribe: number, spell: Spell, at: number) => void
  /** 0 unlocked, SPELL_NEVER, or the population still to reach. */
  spellUnlockAt: (tribe: number, spell: Spell) => number

  /** True once the tribe's shaman has been killed: its people take no more orders. */
  shamanFallen: (tribe: number) => boolean
  /** True once a shaman has fallen and at most one still stands. */
  readonly matchOver: boolean
  /** The tribe whose shaman is left standing once the match is over; -1 until then. */
  readonly matchWinner: number

  /**
   * Hands a tribe to the core's AI, which thinks every `aiThinkSeconds` and
   * gives the same orders and casts the player's clicks do. False for a tribe
   * with neither a hut nor a shaman.
   */
  enableAi: (tribe: number) => boolean
  disableAi: (tribe: number) => void
  aiEnabled: (tribe: number) => boolean
  /** What the tribe's last think did. */
  aiLastAction: (tribe: number) => AiAction
  /** Thinks that did something, and thinks in all. */
  aiActions: (tribe: number) => number
  aiThinks: (tribe: number) => number
  readonly aiThinkSeconds: number
  /**
   * The weights a tribe's AI plays by (see src/world/personalities.ts). Kept
   * across enableAi; clearWorld puts the defaults back. False for a bad tribe.
   */
  configureAi: (tribe: number, weights: AiWeights) => boolean
  /** The weights as the core holds them, clamped. */
  aiWeights: (tribe: number) => AiWeights

  /** Escape hatch for future bulk reads straight out of linear memory. */
  readonly module: CoreModule
}

/** A command's result: the value in-process, a promise once the core is on a worker. */
export type Deferred<T> = T | Promise<T>

/** Runs `then` on a command's result: straight away if it is already here. */
export function settle<T, R>(value: Deferred<T>, then: (value: T) => R): R | undefined {
  if (value instanceof Promise) {
    void value.then(then)
    return undefined
  }
  return then(value)
}

/** Commands whose result only arrives after the core has run them. */
type DeferredOp =
  | 'orderFollowerMove'
  | 'sculptTerrain'
  | 'flattenTerrain'
  | 'spawnFollower'
  | 'setFollowerRole'
  | 'placeHut'
  | 'orderEnterHut'
  | 'ejectHut'
  | 'spawnTrees'
  | 'orderChop'
  | 'plantTree'
  | 'spawnShaman'
  | 'castSpell'
  | 'enableAi'
  | 'generateTerrain'
  | 'configureAi'

/**
 * What frame-time game code sees: the same simulation, wherever it runs. Reads
 * are synchronous — on a worker they come from the latest published step — but
 * a command's result may be a promise; take it with `settle`. The in-process
 * `Simulation` is one of these.
 */
export type SimulationClient = Omit<Simulation, DeferredOp> & {
  [K in DeferredOp]: (...args: Parameters<Simulation[K]>) => Deferred<ReturnType<Simulation[K]>>
} & {
  /** Where the core runs, and its own timing when that is not here. */
  readonly thread?: 'main' | 'worker'
}

export type SimulationOptions = {
  /** Fixed step length in ms. Omit for the core's default (50ms = 20Hz). */
  stepMs?: number
}

/** A Land Bridge's near end when none is given: wherever the shaman stands. */
const NO_ORIGIN: Vec3 = [0, 0, 0]

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
  const treeInstanceFloats = module._core_tree_instance_floats()
  // Sizes the heights view; the pointer itself is re-read per call.
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
    get stepAlpha() {
      return module._core_step_alpha()
    },
    reset() {
      module._core_reset()
    },
    runSteps(count: number) {
      return module._core_steps(count)
    },

    seedMatch(seed: number) {
      module._core_match_seed(seed | 0)
    },
    get matchSeed() {
      return module._core_match_seed_value() >>> 0
    },
    stateHash() {
      return module._core_state_hash() >>> 0
    },
    checkpoints() {
      return Array.from({ length: module._core_checkpoint_count() }, (_, i) => ({
        step: module._core_checkpoint_step(i),
        hash: module._core_checkpoint_hash(i) >>> 0,
      }))
    },
    checkpointEvery: module._core_checkpoint_every(),

    uploadNavGraph(graph: NavGraphUpload, heights: Float32Array, commit: NavCommitOptions) {
      // `TypedArray.set` bounds-checks against the whole heap view, not against
      // the region the core allocated, so an oversized array here would scribble
      // over unrelated core memory without raising anything.
      if (
        graph.directions.length !== graph.nodeCount * 3 ||
        graph.neighborOffsets.length !== graph.nodeCount + 1 ||
        graph.neighbors.length !== graph.linkCount ||
        heights.length !== graph.nodeCount
      ) {
        throw new Error(
          `Navigation graph arrays do not match ${graph.nodeCount} nodes and ` +
            `${graph.linkCount} links, or the heights do not match its nodes.`,
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
      // The one time TypeScript writes walkable height.
      module.HEAPF32.set(heights, module._core_nav_heights() >> 2)

      module._core_terrain_set_max_height(commit.maxHeight ?? 0)
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

    get navReady() {
      return module._core_nav_ready() === 1
    },

    navHeights() {
      if (navNodeCount === 0) {
        return new Float32Array(0)
      }
      const start = module._core_nav_heights() >> 2
      return module.HEAPF32.subarray(start, start + navNodeCount)
    },

    terrainHeightAt(direction: Vec3) {
      return module._core_terrain_height_at(direction[0], direction[1], direction[2])
    },

    sculptTerrain(centre: Vec3, angularRadius: number, delta: number) {
      return (
        module._core_terrain_sculpt(centre[0], centre[1], centre[2], angularRadius, delta) === 1
      )
    },

    flattenTerrain(centre: Vec3, angularRadius: number, targetHeight: number, rate: number) {
      return (
        module._core_terrain_flatten(
          centre[0],
          centre[1],
          centre[2],
          angularRadius,
          targetHeight,
          rate,
        ) === 1
      )
    },

    takeTerrainDirty() {
      const first = module._core_terrain_dirty_first()
      const last = module._core_terrain_dirty_last()
      if (last < first) {
        return null
      }
      module._core_terrain_clear_dirty()
      return { first, last }
    },

    generateTerrain(params: WorldGenParams) {
      const p = { ...DEFAULT_WORLDGEN, ...params }
      return module._core_terrain_generate(
        p.seed | 0,
        p.land,
        p.continents,
        p.continentSize,
        p.continentWeight,
        p.frequency,
        p.octaves,
        p.persistence,
        p.lacunarity,
        p.warp,
        p.ridges,
        p.relief,
        p.peak,
        p.smoothing,
      )
    },

    setTerrainHeights(heights: Float32Array) {
      // The same bounds check as the upload: a long array would write past
      // the core's heights into whatever lies after them.
      if (heights.length !== navNodeCount || navNodeCount === 0) {
        throw new Error(`${heights.length} heights for a ground of ${navNodeCount} nodes.`)
      }
      module.HEAPF32.set(heights, module._core_nav_heights() >> 2)
      module._core_terrain_touch_all()
    },

    nearestWalkableNode(direction: Vec3) {
      return module._core_nav_nearest_walkable(direction[0], direction[1], direction[2])
    },

    clearWorld() {
      module._core_world_clear()
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

    followerRole(id: number) {
      return module._core_follower_role(id) as Role | -1
    },

    setFollowerRole(id: number, role: Role) {
      return module._core_follower_set_role(id, role) === 1
    },

    followerHealth(id: number) {
      return module._core_follower_health(id)
    },

    setFollowerHealth(id: number, health: number) {
      module._core_follower_set_health(id, health)
    },

    followerMaxHealth: module._core_follower_max_health(),

    followerTree(id: number) {
      return module._core_follower_tree(id)
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

    hutSite(direction: Vec3, kind: HutKind = HutKind.dwelling, tribe = -1) {
      const site = module._core_hut_site(
        direction[0],
        direction[1],
        direction[2],
        kind,
        tribe,
      ) as HutSite
      const at = module._core_hut_site_point() >> 2
      const heap = module.HEAPF32
      const centre: Vec3 | null =
        heap[at] === 0 && heap[at + 1] === 0 && heap[at + 2] === 0
          ? null
          : [heap[at]!, heap[at + 1]!, heap[at + 2]!]
      return { site, centre, footprint: heap[at + 3]! }
    },

    placeHut(direction: Vec3, heading: Vec3, tribe: number, kind: HutKind = HutKind.dwelling) {
      return module._core_hut_place(
        direction[0],
        direction[1],
        direction[2],
        heading[0],
        heading[1],
        heading[2],
        tribe,
        kind,
      )
    },

    hutCost(kind: HutKind, tribe: number) {
      return module._core_hut_cost(kind, tribe)
    },

    hutTribe(id: number) {
      return module._core_hut_tribe(id)
    },

    hutKind(id: number) {
      return module._core_hut_kind(id) as HutKind | -1
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

    ejectHut(id: number) {
      return module._core_hut_eject(id)
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
    trainingCapacity: module._core_training_capacity(),
    warriorCost: module._core_warrior_cost(),
    trainSeconds: module._core_train_seconds(),

    wood(tribe: number) {
      return module._core_wood(tribe)
    },

    setWood(tribe: number, wood: number) {
      module._core_wood_set(tribe, wood)
    },

    spawnTrees(count: number) {
      return module._core_trees_spawn(count)
    },

    get treeCount() {
      return module._core_tree_count()
    },

    treeInstances() {
      const count = module._core_tree_count()
      if (count === 0) {
        return new Float32Array(0)
      }
      const start = module._core_tree_instances() >> 2
      return module.HEAPF32.subarray(start, start + count * treeInstanceFloats)
    },

    treeInstanceFloats,

    orderChop(id: number) {
      return module._core_tree_order_chop(id)
    },

    treeProgress(id: number) {
      return module._core_tree_progress(id)
    },

    plantTree(direction: Vec3, size = 1, turn = 0) {
      return module._core_tree_plant(direction[0], direction[1], direction[2], size, turn)
    },

    treeSize(id: number) {
      return module._core_tree_size(id)
    },

    treeTurn(id: number) {
      return module._core_tree_turn(id)
    },

    woodPerTree: module._core_tree_wood(),
    chopSeconds: module._core_tree_chop_seconds(),

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

    population(tribe: number) {
      return module._core_population(tribe)
    },

    setMana(tribe: number, mana: number) {
      module._core_mana_set(tribe, mana)
    },

    manaMax: module._core_mana_max(),

    spellRules: Array.from({ length: module._core_spell_count() }, (_, spell) => ({
      cost: module._core_spell_cost(spell),
      range: module._core_spell_range(spell),
      castSeconds: module._core_spell_cast_seconds(spell),
      cooldownSeconds: module._core_spell_cooldown_seconds(spell),
    })),

    // Read live: it depends on the planet radius the nav graph commits.
    spellRadius(spell: Spell) {
      return module._core_spell_radius(spell)
    },

    checkSpell(spell: Spell, tribe: number, target: Vec3, origin?: Vec3 | null) {
      const from = origin ?? NO_ORIGIN
      return module._core_spell_check(spell, tribe, ...target, ...from) as SpellResult
    },

    castSpell(spell: Spell, tribe: number, target: Vec3, origin?: Vec3 | null) {
      const from = origin ?? NO_ORIGIN
      return module._core_spell_cast(spell, tribe, ...target, ...from) as SpellResult
    },

    cancelSpell(tribe: number) {
      module._core_spell_cancel(tribe)
    },

    spellCasting(tribe: number) {
      const spell = module._core_spell_casting(tribe)
      if (spell < 0) {
        return null
      }
      const base = module._core_spell_target(tribe) >> 2
      const heap = module.HEAPF32
      return {
        spell: spell as Spell,
        progress: module._core_spell_progress(tribe),
        target: [heap[base]!, heap[base + 1]!, heap[base + 2]!],
        radius: heap[base + 3]!,
      }
    },

    spellCooldown(tribe: number, spell: Spell) {
      return module._core_spell_cooldown(tribe, spell)
    },

    lastSpellEnd(tribe: number) {
      return {
        count: module._core_spell_ended(tribe),
        spell: module._core_spell_ended_spell(tribe) as Spell,
        result: module._core_spell_ended_result(tribe) as SpellResult,
      }
    },

    landBridgePlan() {
      const count = module._core_land_bridge_stamp_count()
      if (count === 0) {
        return null
      }
      // Copied out at once: the buffer is the core's and the next bridge reuses it.
      const start = module._core_land_bridge_stamps() >> 2
      const stamps: Vec3[] = []
      for (let i = 0; i < count; i += 1) {
        const base = start + i * 3
        stamps.push([module.HEAPF32[base]!, module.HEAPF32[base + 1]!, module.HEAPF32[base + 2]!])
      }
      return {
        stamps,
        stampRadius: module._core_spell_radius(0),
        height: module._core_land_bridge_height(),
      }
    },
    setSpellUnlock(tribe: number, spell: Spell, at: number) {
      module._core_spell_set_unlock(tribe, spell, at)
    },

    spellUnlockAt(tribe: number, spell: Spell) {
      return module._core_spell_unlock_at(tribe, spell)
    },

    shamanFallen(tribe: number) {
      return module._core_shaman_fallen(tribe) !== 0
    },

    get matchOver() {
      return module._core_match_over() !== 0
    },

    get matchWinner() {
      return module._core_match_winner()
    },

    enableAi(tribe: number) {
      return module._core_ai_enable(tribe) !== 0
    },

    disableAi(tribe: number) {
      module._core_ai_disable(tribe)
    },

    aiEnabled(tribe: number) {
      return module._core_ai_enabled(tribe) !== 0
    },

    aiLastAction(tribe: number) {
      return module._core_ai_last_action(tribe) as AiAction
    },

    aiActions(tribe: number) {
      return module._core_ai_actions(tribe)
    },

    aiThinks(tribe: number) {
      return module._core_ai_thinks(tribe)
    },

    aiThinkSeconds: module._core_ai_think_seconds(),

    configureAi(tribe: number, weights: AiWeights) {
      return (
        module._core_ai_configure(
          tribe,
          weights.thinkSeconds,
          weights.hutCap,
          weights.buildReach,
          weights.forageReach,
          weights.patch,
          weights.muster,
          weights.settle,
          weights.bridges ? 1 : 0,
        ) === 1
      )
    },

    aiWeights(tribe: number) {
      const field = (index: number) => module._core_ai_personality(tribe, index)
      return {
        thinkSeconds: field(0),
        hutCap: field(1),
        buildReach: field(2),
        forageReach: field(3),
        patch: field(4),
        muster: field(5),
        settle: field(6),
        bridges: field(7) !== 0,
      }
    },
  }
}
