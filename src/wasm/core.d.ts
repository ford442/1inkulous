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

  /**
   * Terrain: the core's height per node is the walkable surface and the one
   * the mesh draws. Seeded through `_core_nav_heights` before commit; edited
   * only through these afterwards.
   */
  _core_terrain_set_max_height: (maxHeight: number) => void
  _core_terrain_max_height: () => number
  /** Height under a direction, on the triangle a walker there stands on. */
  _core_terrain_height_at: (x: number, y: number, z: number) => number
  /** 1 if any node moved. */
  _core_terrain_sculpt: (x: number, y: number, z: number, angularRadius: number, delta: number) => number
  /** 1 if any node moved. */
  _core_terrain_flatten: (
    x: number,
    y: number,
    z: number,
    angularRadius: number,
    targetHeight: number,
    rate: number,
  ) => number
  /** Inclusive node range edited since the last clear; first > last when clean. */
  _core_terrain_dirty_first: () => number
  _core_terrain_dirty_last: () => number
  _core_terrain_clear_dirty: () => void
  /**
   * Route between two directions into the route buffer: string-pulled legs, or
   * the raw A* nodes when `smooth` is 0. Returns the waypoint count, -1 if none.
   */
  _core_nav_route: (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    smooth: number,
  ) => number

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
  /** Copies a follower's remaining waypoints into the route buffer; returns how many. */
  _core_follower_route: (id: number) => number
  /** Pointer to the route buffer: 3 floats (a unit direction) per waypoint. */
  _core_route_points: () => number
  _core_follower_speed: () => number
  _core_follower_set_speed: (speed: number) => void
  /** Hut a follower was ordered into, or -1. */
  _core_follower_hut: (id: number) => number
  /** Tree a follower was sent to chop, or -1. */
  _core_follower_tree: (id: number) => number
  /** 0 brave, 1 warrior — see Role; -1 for a bad id. */
  _core_follower_role: (id: number) => number
  /** 1 on success; 0 for a bad id or role, or the shaman. For tests and scenarios. */
  _core_follower_set_role: (id: number, role: number) => number
  _core_follower_health: (id: number) => number
  _core_follower_max_health: () => number
  /** For tests and scenarios; one set to 0 is removed on the next step. */
  _core_follower_set_health: (id: number, health: number) => void

  /**
   * 0 when `tribe` can build a hut of `kind` on the node nearest the
   * direction, else a reason — see HutSite. A negative tribe skips the wood.
   */
  _core_hut_site: (x: number, y: number, z: number, kind: number, tribe: number) => number
  /**
   * Pointer to 4 floats from the last site check: the anchor's unit direction
   * and the angle to its furthest footprint node.
   */
  _core_hut_site_point: () => number
  /**
   * Builds a hut of `kind` there and charges the tribe. A negative tribe
   * leaves it unclaimed and free. Returns the id, or -1.
   */
  _core_hut_place: (
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
    tribe: number,
    kind: number,
  ) => number
  /** Wood a tribe's next hut of `kind` costs: 0 for its first dwelling. */
  _core_hut_cost: (kind: number, tribe: number) => number
  _core_hut_count: () => number
  _core_huts_clear: () => void
  /** Pointer to the packed hut instance buffer; moves as huts are built. */
  _core_hut_instances: () => number
  _core_hut_instance_floats: () => number
  _core_hut_occupants: (id: number) => number
  _core_huts_housed: () => number
  _core_hut_tribe: (id: number) => number
  /** 0 dwelling, 1 training hut — see HutKind; -1 for a bad id. */
  _core_hut_kind: (id: number) => number
  _core_hut_order_enter: (id: number) => number
  /** Sends everyone inside back out of the door as braves. Returns how many. */
  _core_hut_eject: (id: number) => number
  _core_hut_radius: () => number
  _core_hut_capacity: () => number
  _core_training_capacity: () => number
  _core_warrior_cost: () => number
  _core_train_seconds: () => number

  _core_wood: (tribe: number) => number
  _core_wood_set: (tribe: number, wood: number) => void
  /** Scatters up to `count` trees from a seed. Returns how many stand. */
  _core_trees_spawn: (count: number, seed: number) => number
  _core_tree_count: () => number
  _core_trees_clear: () => void
  /** Pointer to the packed tree instance buffer; moves as trees fall. */
  _core_tree_instances: () => number
  _core_tree_instance_floats: () => number
  /** Sends selected braves to chop a tree. Returns how many went. */
  _core_tree_order_chop: (id: number) => number
  /** 0..1 through chopping; -1 for a bad id. */
  _core_tree_progress: (id: number) => number
  _core_tree_wood: () => number
  _core_tree_chop_seconds: () => number
  /** Plants one tree on the walkable node nearest the direction. Its id, or -1. */
  /** Everyone of the tribe, walking or housed, as of the last step. */
  _core_population: (tribe: number) => number
  _core_tree_plant: (x: number, y: number, z: number) => number

  /** Spawns a tribe's shaman. Returns her follower id, or -1 if it has one already. */
  _core_shaman_spawn: (x: number, y: number, z: number, tribe: number) => number
  /** A tribe's shaman's follower id, or -1. */
  _core_shaman: (tribe: number) => number
  _core_mana: (tribe: number) => number
  _core_mana_income: (tribe: number) => number
  _core_mana_max: () => number
  _core_mana_set: (tribe: number, mana: number) => void
  /** How many spells there are; ids run from 0. See Spell in src/sim/spell.ts. */
  _core_spell_count: () => number
  /** Per spell: mana spent when it lands, reach from the shaman, cast time, cooldown. */
  _core_spell_cost: (spell: number) => number
  _core_spell_range: (spell: number) => number
  _core_spell_cast_seconds: (spell: number) => number
  _core_spell_cooldown_seconds: (spell: number) => number
  /** Angular radius in radians of the disc a spell writes (a bridge's stamps). */
  _core_spell_radius: (spell: number) => number
  /**
   * 0 when the spell would go ahead, else a reason — see SpellResult. The
   * origin is a Land Bridge's near end, all zero for the shaman. Changes nothing.
   */
  _core_spell_check: (
    spell: number,
    tribe: number,
    x: number,
    y: number,
    z: number,
    ox: number,
    oy: number,
    oz: number,
  ) => number
  /** As the check; on 0 the shaman starts casting. The mana goes when it lands. */
  _core_spell_cast: (
    spell: number,
    tribe: number,
    x: number,
    y: number,
    z: number,
    ox: number,
    oy: number,
    oz: number,
  ) => number
  _core_spell_cancel: (tribe: number) => void
  /** The spell a tribe is casting, or -1. */
  _core_spell_casting: (tribe: number) => number
  /** 0..1 through the cast. */
  _core_spell_progress: (tribe: number) => number
  /** Pointer to 4 floats: where the cast lands (a unit direction) and its angular radius. */
  _core_spell_target: (tribe: number) => number
  /** Seconds before a tribe may cast a spell again. */
  _core_spell_cooldown: (tribe: number, spell: number) => number
  /** Casts a tribe has seen end so far, and the last one's spell and result. */
  _core_spell_ended: (tribe: number) => number
  _core_spell_ended_spell: (tribe: number) => number
  _core_spell_ended_result: (tribe: number) => number
  _core_land_bridge_stamp_count: () => number
  /** Pointer to the stamps the last bridge to land laid: 3 floats (a unit direction) each. */
  _core_land_bridge_stamps: () => number
  /** Height above sea level the stamps raise the centre line to. */
  _core_land_bridge_height: () => number

  /** 1 once the tribe's shaman has been killed. */
  _core_shaman_fallen: (tribe: number) => number
  /** 1 once a shaman has fallen and at most one stands. */
  _core_match_over: () => number
  /** The tribe whose shaman is left standing, or -1. */
  _core_match_winner: () => number

  /** Hands a tribe to the core's AI. 1 on success. */
  _core_ai_enable: (tribe: number) => number
  _core_ai_disable: (tribe: number) => void
  _core_ai_enabled: (tribe: number) => number
  /** Mirrors inkulous::AiAction. */
  _core_ai_last_action: (tribe: number) => number
  _core_ai_actions: (tribe: number) => number
  _core_ai_thinks: (tribe: number) => number
  _core_ai_think_seconds: () => number

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
