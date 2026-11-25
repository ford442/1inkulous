import type { StampedCommand } from './replay'
import type { Simulation } from './simulation'

/**
 * What crosses between the main thread and the core's worker.
 *
 * Everything here is plain data: structured-cloneable for `postMessage`, and
 * the same shape a replay log or a lockstep peer would carry. Neither side of
 * the channel (src/sim/host.ts, src/sim/workerClient.ts) talks to the other in
 * any way this file does not describe.
 */

/**
 * The calls that change the core. Each is a command, named after the method it
 * replays on the in-process adapter so the two cannot drift: a command is that
 * method's name and exactly its arguments.
 */
export const COMMAND_OPS = [
  'tick',
  'reset',
  'seedMatch',
  'uploadNavGraph',
  'sculptTerrain',
  'flattenTerrain',
  'takeTerrainDirty',
  'spawnFollower',
  'setFollowerSelected',
  'clearFollowerSelection',
  'orderFollowerMove',
  'setFollowerRole',
  'setFollowerHealth',
  'placeHut',
  'orderEnterHut',
  'ejectHut',
  'setWood',
  'spawnTrees',
  'orderChop',
  'plantTree',
  'spawnShaman',
  'setMana',
  'castSpell',
  'cancelSpell',
  'enableAi',
  'disableAi',
] as const satisfies readonly (keyof Simulation)[]

export type CommandOp = (typeof COMMAND_OPS)[number]

type MethodArgs<K extends keyof Simulation> = Simulation[K] extends (...args: infer A) => unknown
  ? A
  : never

/** One change to the core: `MoveFollowers` is `{ op: 'orderFollowerMove', args: [target] }`. */
export type Command = { [K in CommandOp]: { readonly op: K; readonly args: MethodArgs<K> } }[CommandOp]

export type CommandResult<K extends CommandOp> = ReturnType<Simulation[K]>

const COMMAND_SET: ReadonlySet<string> = new Set(COMMAND_OPS)
export const isCommandOp = (name: PropertyKey): name is CommandOp =>
  typeof name === 'string' && COMMAND_SET.has(name)

export function applyCommand(simulation: Simulation, command: Command): unknown {
  const method = simulation[command.op] as (...args: readonly unknown[]) => unknown
  return method.apply(simulation, command.args)
}

/**
 * Questions whose answer depends on arguments, so no snapshot can hold it in
 * advance. Asked over the channel; the client keeps the latest answer.
 */
export const QUERY_OPS = ['hutSite', 'checkSpell'] as const satisfies readonly (keyof Simulation)[]
export type QueryOp = (typeof QUERY_OPS)[number]
export type Query = { [K in QueryOp]: { readonly op: K; readonly args: MethodArgs<K> } }[QueryOp]

// --- messages ---------------------------------------------------------------

export type HostOptions = {
  stepMs?: number
  /** 'manual' advances only on `advance` messages: for tests. */
  clock?: 'auto' | 'manual'
  /** Offer SharedArrayBuffer snapshots; the host still falls back without them. */
  shared?: boolean
}

export type ToHost =
  /** `log` is every command that built the world, stamped with its step: see replay.ts. */
  | { readonly type: 'init'; readonly options: HostOptions; readonly log: readonly StampedCommand[] }
  /** `ids[i]` asks for the result of `commands[i]`; null wants none. */
  | { readonly type: 'commands'; readonly commands: readonly Command[]; readonly ids: readonly (number | null)[] }
  | { readonly type: 'query'; readonly id: number; readonly query: Query }
  /** The match so far as a Replay, answered with that id. */
  | { readonly type: 'replay'; readonly id: number }
  | { readonly type: 'advance'; readonly ms: number }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  /** A transferred snapshot the client has finished with, for reuse. */
  | { readonly type: 'recycle'; readonly buffer: ArrayBuffer }
  | { readonly type: 'dispose' }

export type SharedSnapshots = {
  readonly control: SharedArrayBuffer
  readonly slots: readonly SharedArrayBuffer[]
}

export type FromHost =
  | {
      readonly type: 'ready'
      readonly digest: number
      /** The core's own state hash once the log was replayed: stricter than the digest. */
      readonly hash: number
      readonly layout: SnapshotLayout
      readonly shared: SharedSnapshots | null
    }
  | { readonly type: 'results'; readonly results: readonly { id: number; value: unknown }[] }
  | { readonly type: 'answer'; readonly id: number; readonly value: unknown }
  | { readonly type: 'snapshot'; readonly buffer: ArrayBuffer }
  | { readonly type: 'error'; readonly message: string }

// --- snapshot layout --------------------------------------------------------

/** Mirror kMaxFollowers, kMaxHuts, kMaxTrees and kMaxTribes in cpp/include/1inkulous/. */
export const MAX_FOLLOWERS = 1024
export const MAX_HUTS = 256
export const MAX_TREES = 512
export const MAX_TRIBES = 4
export const SPELL_COUNT = 4
export const HUT_KIND_COUNT = 2

/** Header slots, as Float64 indices. */
export const H = {
  seq: 0,
  stepMs: 1,
  stepCount: 2,
  elapsedMs: 3,
  followerCount: 4,
  selectedCount: 5,
  hutCount: 6,
  housedCount: 7,
  treeCount: 8,
  matchOver: 9,
  matchWinner: 10,
  /** Goes up by one with each publish that carried a terrain edit. */
  terrainRev: 11,
  /** The nodes the edit that set `terrainRev` moved; kept until the next edit. */
  dirtyFirst: 12,
  dirtyLast: 13,
  /** Milliseconds inside `core_tick`, and steps run, since the host started. */
  simMsTotal: 14,
  simStepsTotal: 15,
  /**
   * The clock as the host last ran it: time carried towards the next step,
   * and when, in ms since the epoch (`performance.timeOrigin + now()`, so the
   * main thread can read it against its own clock); -1 on a manual clock.
   * From these the client works out how far to draw between poses.
   */
  pendingMs: 16,
  clockAt: 17,
  matchSeed: 18,
  /** The newest state-hash checkpoint: its step (0 before the first) and hash. */
  checkpointStep: 19,
  checkpointHash: 20,
  tribes: 21,
} as const

/** Per-tribe fields, offsets inside one tribe's block. */
export const T = {
  wood: 0,
  mana: 1,
  income: 2,
  population: 3,
  shamanId: 4,
  fallen: 5,
  aiEnabled: 6,
  aiLastAction: 7,
  aiActions: 8,
  aiThinks: 9,
  castSpell: 10,
  castProgress: 11,
  castX: 12,
  castY: 13,
  castZ: 14,
  castRadius: 15,
  endCount: 16,
  endSpell: 17,
  endResult: 18,
  cooldowns: 19,
  hutCosts: 19 + SPELL_COUNT,
  size: 19 + SPELL_COUNT + HUT_KIND_COUNT,
} as const

/** Per-hut fields in the hut table. */
export const HUT_META = { tribe: 0, kind: 1, occupants: 2, size: 3 } as const

export type SnapshotLayout = {
  readonly nodeCount: number
  readonly followerFloats: number
  readonly hutFloats: number
  readonly treeFloats: number
  readonly headerCount: number
  /** Float32 element offsets into the slot. */
  readonly followers: number
  readonly huts: number
  readonly trees: number
  readonly heights: number
  readonly hutMeta: number
  readonly bytes: number
}

export function snapshotLayout(
  nodeCount: number,
  followerFloats: number,
  hutFloats: number,
  treeFloats: number,
): SnapshotLayout {
  const headerCount = H.tribes + MAX_TRIBES * T.size
  let at = (headerCount * 8) / 4
  const take = (count: number) => {
    const start = at
    at += count
    return start
  }
  const followers = take(MAX_FOLLOWERS * followerFloats)
  const huts = take(MAX_HUTS * hutFloats)
  const trees = take(MAX_TREES * treeFloats)
  const heights = take(nodeCount)
  const hutMeta = take(MAX_HUTS * HUT_META.size)
  return {
    nodeCount,
    followerFloats,
    hutFloats,
    treeFloats,
    headerCount,
    followers,
    huts,
    trees,
    heights,
    hutMeta,
    // Rounded up to 8 so a slot can sit in an array of them.
    bytes: Math.ceil((at * 4) / 8) * 8,
  }
}

/** Typed views over one snapshot slot. */
export type SnapshotView = {
  readonly header: Float64Array
  readonly floats: Float32Array
}

export const viewSnapshot = (buffer: ArrayBufferLike, layout: SnapshotLayout): SnapshotView => ({
  header: new Float64Array(buffer, 0, layout.headerCount),
  floats: new Float32Array(buffer, 0, layout.bytes / 4),
})

// --- triple buffer ----------------------------------------------------------

/**
 * Three slots: the host writes one, one holds the latest finished step, the
 * client reads the third. `Atomics.exchange` on a single word hands slots back
 * and forth, so neither side ever waits and the reader never sees a half-written
 * step. Word 0 is the ready slot's index, with FRESH set until the reader takes
 * it; word 1 is the publish sequence.
 */
export const FRESH = 4
const SLOT_MASK = 3

export function createTripleBuffer(bytes: number): SharedSnapshots {
  const control = new SharedArrayBuffer(8)
  // Writer starts on 0, ready is 1 (nothing new yet), reader holds 2.
  new Int32Array(control)[0] = 1
  return { control, slots: [0, 1, 2].map(() => new SharedArrayBuffer(bytes)) }
}

export function tripleBufferWriter(shared: SharedSnapshots) {
  const control = new Int32Array(shared.control)
  let writing = 0
  return {
    get slot() {
      return shared.slots[writing]
    },
    /** Publishes the slot just written and moves on to the free one. */
    publish() {
      Atomics.add(control, 1, 1)
      writing = Atomics.exchange(control, 0, writing | FRESH) & SLOT_MASK
    },
  }
}

export function tripleBufferReader(shared: SharedSnapshots) {
  const control = new Int32Array(shared.control)
  let reading = 2
  return {
    get slot() {
      return shared.slots[reading]
    },
    get sequence() {
      return Atomics.load(control, 1)
    },
    /** Swaps in the latest published slot. False when nothing new was published. */
    acquire(): boolean {
      if ((Atomics.load(control, 0) & FRESH) === 0) {
        return false
      }
      reading = Atomics.exchange(control, 0, reading) & SLOT_MASK
      return true
    },
  }
}

// --- digest -----------------------------------------------------------------

/**
 * A hash of everything a replay has to reproduce: who stands where, the huts,
 * the trees, the ground and every tribe's stock. Equal on both sides of the
 * channel, or the worker did not rebuild the same world.
 */
export function stateDigest(simulation: Simulation): number {
  let hash = 0x811c9dc5
  const mix = (value: number) => {
    hash = Math.imul(hash ^ (value | 0), 0x01000193)
  }
  const mixFloats = (data: Float32Array) => {
    const bits = new Int32Array(data.buffer, data.byteOffset, data.length)
    for (let i = 0; i < bits.length; i += 1) {
      mix(bits[i])
    }
  }
  mixFloats(simulation.followerInstances())
  mixFloats(simulation.hutInstances())
  mixFloats(simulation.treeInstances())
  mixFloats(simulation.navHeights())
  mix(simulation.stepCount)
  mix(simulation.selectedFollowerCount)
  for (let tribe = 0; tribe < MAX_TRIBES; tribe += 1) {
    mix(simulation.wood(tribe))
    mix(Math.round(simulation.mana(tribe) * 1000))
    mix(simulation.shamanId(tribe))
    mix(simulation.aiEnabled(tribe) ? 1 : 0)
  }
  return hash >>> 0
}
