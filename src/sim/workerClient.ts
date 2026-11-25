import type { Vec3 } from '../engine/math'
import type { AiAction } from './ai'
import { HutKind, HutSite } from './hutSite'
import {
  H,
  HUT_META,
  MAX_TRIBES,
  stateDigest,
  T,
  tripleBufferReader,
  viewSnapshot,
  type Command,
  type CommandOp,
  type FromHost,
  type HostOptions,
  type Query,
  type SnapshotLayout,
  type SnapshotView,
  type ToHost,
} from './protocol'
import type {
  HutSiteReport,
  NodeRange,
  Simulation,
  SimulationClient,
  SpellCast,
  SpellEnd,
} from './simulation'
import { SpellResult, type Spell } from './spell'
import type { Role } from './role'
import type { Replay, StampedCommand } from './replay'

/** The main thread's end: a Worker, or one side of a MessageChannel. */
/**
 * A read from a snapshot array. The layout is fixed by protocol.ts, so an index
 * outside it is a bug in one side of the wire, not a value to default.
 */
function read(array: ArrayLike<number>, index: number): number {
  const value = array[index]
  if (value === undefined) {
    throw new RangeError(`snapshot index ${index} is outside the snapshot`)
  }
  return value
}

export type ClientPort = {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown, transfer: Transferable[]) => void
}

export type WorkerSimulation = SimulationClient & {
  readonly thread: 'worker'
  /** 'shared' reads a SharedArrayBuffer triple buffer; 'transfer' takes posted copies. */
  readonly transport: 'shared' | 'transfer'
  /**
   * The core's own time per fixed step on the worker since the last call, in
   * milliseconds, averaged; null when no step ran.
   */
  takeSimMsPerStep: () => number | null
  pause: () => void
  resume: () => void
  /** Manual clock only: runs the host `ms` forward. */
  advance: (ms: number) => void
  /** Resolves once every command sent so far has run and its snapshot is out. */
  flush: () => Promise<void>
  /** The match so far, from the host's log: after every command sent before the call. */
  exportReplay: () => Promise<Replay>
  dispose: () => void
}

/**
 * How far between poses to draw, from the worker's side of the clock: the
 * host stamps when its clock last ran (`clockAt`, ms since the epoch, or
 * negative on a manual clock) and the time it carried towards the next step;
 * the time since then is ours to add. Held at 1 when the worker is late,
 * rather than drawn past where it has got to.
 */
export function stepAlphaAt(pendingMs: number, clockAt: number, stepMs: number, now: number): number {
  if (!(stepMs > 0)) {
    return 0
  }
  const since = clockAt >= 0 ? Math.max(0, now - clockAt) : 0
  return Math.min(1, Math.max(0, (pendingMs + since) / stepMs))
}

/**
 * Moves the core onto the other end of `port`.
 *
 * `shadow` is the in-process core the world was built on, and `log` every
 * command that built it. The host replays the log on a fresh core and must
 * report the same digest, or this rejects. Afterwards `shadow` is only a mirror
 * of the ground: its heights follow each snapshot, so picking can ask it the
 * height under a ray without a round trip. Nothing else of it is read again.
 */
export function connectWorkerSimulation(
  port: ClientPort,
  shadow: Simulation,
  log: readonly StampedCommand[],
  options: HostOptions = {},
): Promise<WorkerSimulation> {
  const expected = stateDigest(shadow)
  const expectedHash = shadow.stateHash()
  const send = (message: ToHost, transfer: Transferable[] = []) => port.postMessage(message, transfer)

  let layout: SnapshotLayout | null = null
  let reader: ReturnType<typeof tripleBufferReader> | null = null
  // Transfer mode: the newest posted snapshot not yet swapped in.
  let incoming: ArrayBuffer | null = null
  let current: ArrayBuffer | SharedArrayBuffer | null = null
  let view: SnapshotView | null = null

  let nextId = 1
  const pending = new Map<number, (value: unknown) => void>()
  const answers = new Map<number, (value: unknown) => void>()
  let queue: Command[] = []
  let queueIds: (number | null)[] = []
  let flushScheduled = false
  let failure: Error | null = null

  return new Promise<WorkerSimulation>((resolve, reject) => {
    port.onmessage = (event: MessageEvent) => {
      const message = event.data as FromHost
      switch (message.type) {
        case 'snapshot':
          if (incoming) {
            send({ type: 'recycle', buffer: incoming }, [incoming])
          }
          incoming = message.buffer
          return
        case 'ready': {
          if (message.digest !== expected || message.hash !== expectedHash) {
            reject(
              new Error(
                `The worker's core rebuilt a different world (digest ${message.digest} vs ${expected}, ` +
                  `state hash ${message.hash} vs ${expectedHash}).`,
              ),
            )
            return
          }
          layout = message.layout
          reader = message.shared ? tripleBufferReader(message.shared) : null
          const client = build(message.shared ? 'shared' : 'transfer')
          client.tick(0)
          resolve(client)
          return
        }
        case 'results':
          for (const { id, value } of message.results) {
            pending.get(id)?.(value)
            pending.delete(id)
          }
          return
        case 'answer':
          answers.get(message.id)?.(message.value)
          answers.delete(message.id)
          return
        case 'error':
          failure = new Error(`Simulation worker failed: ${message.message}`)
          console.error(failure)
          reject(failure)
          return
      }
    }
    send({ type: 'init', options, log })
  })

  function build(transport: 'shared' | 'transfer'): WorkerSimulation {
    const shape = layout!
    const nodeCount = shape.nodeCount
    let lastSteps = 0
    let lastRev = 0
    let dirty: NodeRange | null = null
    let simMsSeen = 0
    let simStepsSeen = 0

    // Constants, read once from the core the world was built on. Identical on
    // the worker: same binary, same commit.
    const spellRadii = shadow.spellRules.map((_, spell) => shadow.spellRadius(spell as Spell))

    const header = (index: number) => read(view!.header, index)
    const tribeField = (tribe: number, field: number) =>
      tribe >= 0 && tribe < MAX_TRIBES ? header(H.tribes + tribe * T.size + field) : 0

    const flushQueue = () => {
      flushScheduled = false
      if (queue.length === 0) {
        return
      }
      send({ type: 'commands', commands: queue, ids: queueIds })
      queue = []
      queueIds = []
    }

    function command<K extends CommandOp>(op: K, args: unknown[], wantResult: true): Promise<unknown>
    function command<K extends CommandOp>(op: K, args: unknown[], wantResult: false): void
    function command(op: CommandOp, args: unknown[], wantResult: boolean): Promise<unknown> | void {
      if (failure) {
        throw failure
      }
      queue.push({ op, args } as unknown as Command)
      let result: Promise<unknown> | undefined
      if (wantResult) {
        const id = nextId++
        queueIds.push(id)
        result = new Promise((done) => pending.set(id, done))
      } else {
        queueIds.push(null)
      }
      // One message per frame's worth of calls: a rubber band selects dozens.
      if (!flushScheduled) {
        flushScheduled = true
        queueMicrotask(flushQueue)
      }
      return result
    }

    /**
     * An argument-dependent question, answered a frame late: each call returns
     * the latest answer to arrive and asks again with the newest arguments,
     * one question in flight at a time.
     */
    function latestAnswer<V>(op: Query['op'], fallback: V) {
      let latest = fallback
      let inFlight = false
      let waiting: unknown[] | null = null
      const ask = (args: unknown[]) => {
        inFlight = true
        const id = nextId++
        answers.set(id, (value) => {
          latest = value as V
          inFlight = false
          if (waiting) {
            const next = waiting
            waiting = null
            ask(next)
          }
        })
        send({ type: 'query', id, query: { op, args } as unknown as Query })
      }
      return (args: unknown[]): V => {
        if (inFlight) {
          waiting = args
        } else {
          ask(args)
        }
        return latest
      }
    }

    const hutSiteAnswer = latestAnswer<HutSiteReport>('hutSite', {
      site: HutSite.noGrid,
      centre: null,
      footprint: 0,
    })
    const checkSpellAnswer = latestAnswer<SpellResult>('checkSpell', SpellResult.noGrid)

    const floatsAt = (start: number, count: number) => view!.floats.subarray(start, start + count)

    const swapIn = (): boolean => {
      if (reader) {
        if (!reader.acquire()) {
          return false
        }
        current = reader.slot
      } else {
        if (!incoming) {
          return false
        }
        if (current instanceof ArrayBuffer) {
          send({ type: 'recycle', buffer: current }, [current])
        }
        current = incoming
        incoming = null
      }
      view = viewSnapshot(current, shape)
      return true
    }

    const offThread = (name: string) => () => {
      throw new Error(`${name} is not available while the core runs on a worker.`)
    }

    const client: WorkerSimulation = {
      thread: 'worker',
      transport,
      version: shadow.version,
      get stepMs() {
        return header(H.stepMs)
      },
      get stepCount() {
        return header(H.stepCount)
      },
      get elapsedMs() {
        return header(H.elapsedMs)
      },

      // The worker keeps its own clock; a frame only swaps in what it finished.
      tick() {
        if (!swapIn()) {
          return 0
        }
        const rev = header(H.terrainRev)
        if (rev !== lastRev) {
          // One edit since we last looked: its range. More: we missed some, so all of it.
          const range: NodeRange =
            rev === lastRev + 1 && header(H.dirtyFirst) >= 0
              ? { first: header(H.dirtyFirst), last: header(H.dirtyLast) }
              : { first: 0, last: nodeCount - 1 }
          dirty = dirty
            ? { first: Math.min(dirty.first, range.first), last: Math.max(dirty.last, range.last) }
            : range
          lastRev = rev
          // Keep the picking mirror on the same ground the renderer draws.
          shadow
            .navHeights()
            .set(floatsAt(shape.heights + range.first, range.last - range.first + 1), range.first)
        }
        const steps = header(H.stepCount) - lastSteps
        lastSteps = header(H.stepCount)
        return steps
      },
      get stepAlpha() {
        return stepAlphaAt(
          header(H.pendingMs),
          header(H.clockAt),
          header(H.stepMs),
          performance.timeOrigin + performance.now(),
        )
      },
      reset() {
        command('reset', [], false)
      },
      runSteps: offThread('runSteps') as (count: number) => number,
      seedMatch: (...args) => command('seedMatch', args, false),
      get matchSeed() {
        return header(H.matchSeed)
      },
      stateHash: offThread('stateHash') as () => number,
      checkpoints: offThread('checkpoints') as () => { step: number; hash: number }[],
      checkpointEvery: shadow.checkpointEvery,
      takeSimMsPerStep() {
        const steps = header(H.simStepsTotal) - simStepsSeen
        const ms = header(H.simMsTotal) - simMsSeen
        simStepsSeen = header(H.simStepsTotal)
        simMsSeen = header(H.simMsTotal)
        return steps > 0 ? ms / steps : null
      },
      pause: () => send({ type: 'pause' }),
      resume: () => send({ type: 'resume' }),
      advance: (ms) => send({ type: 'advance', ms }),
      flush() {
        flushQueue()
        // The host takes messages in order, so any answer comes after every
        // command sent before the question.
        const id = nextId++
        const done = new Promise<void>((settled) => answers.set(id, () => settled()))
        send({
          type: 'query',
          id,
          query: { op: 'checkSpell', args: [0 as Spell, -1, [0, 0, 1], null] },
        })
        return done
      },
      exportReplay() {
        flushQueue()
        const id = nextId++
        const replay = new Promise<Replay>((done) => answers.set(id, (value) => done(value as Replay)))
        send({ type: 'replay', id })
        return replay
      },
      dispose() {
        flushQueue()
        send({ type: 'dispose' })
        port.onmessage = null
      },

      uploadNavGraph: offThread('uploadNavGraph'),
      navReady: shadow.navReady,
      navHeights: () => floatsAt(shape.heights, nodeCount),
      terrainHeightAt: (direction: Vec3) => shadow.terrainHeightAt(direction),
      sculptTerrain: (...args) => command('sculptTerrain', args, true) as Promise<boolean>,
      flattenTerrain: (...args) => command('flattenTerrain', args, true) as Promise<boolean>,
      takeTerrainDirty() {
        const taken = dirty
        dirty = null
        return taken
      },

      spawnFollower: (...args) => command('spawnFollower', args, true) as Promise<number>,
      get followerCount() {
        return header(H.followerCount)
      },
      get selectedFollowerCount() {
        return header(H.selectedCount)
      },
      setFollowerSelected: (...args) => command('setFollowerSelected', args, false),
      clearFollowerSelection: () => command('clearFollowerSelection', [], false),
      orderFollowerMove: (...args) => command('orderFollowerMove', args, true) as Promise<number>,
      followerRole: offThread('followerRole') as (id: number) => Role | -1,
      setFollowerRole: (...args) => command('setFollowerRole', args, true) as Promise<boolean>,
      followerHealth: offThread('followerHealth') as (id: number) => number,
      setFollowerHealth: (...args) => command('setFollowerHealth', args, false),
      followerMaxHealth: shadow.followerMaxHealth,
      followerTree: offThread('followerTree') as (id: number) => number,
      followerInstances: () =>
        floatsAt(shape.followers, header(H.followerCount) * shape.followerFloats),
      followerInstanceFloats: shape.followerFloats,

      hutSite: (direction: Vec3, kind: HutKind = HutKind.dwelling, tribe = -1) =>
        hutSiteAnswer([direction, kind, tribe]),
      placeHut: (...args) => command('placeHut', args, true) as Promise<number>,
      hutCost: (kind: HutKind, tribe: number) => tribeField(tribe, T.hutCosts + kind),
      hutTribe: (id: number) => hutMeta(id, HUT_META.tribe),
      hutKind: (id: number) => hutMeta(id, HUT_META.kind) as HutKind | -1,
      get hutCount() {
        return header(H.hutCount)
      },
      get housedCount() {
        return header(H.housedCount)
      },
      hutOccupants: (id: number) => Math.max(0, hutMeta(id, HUT_META.occupants)),
      orderEnterHut: (...args) => command('orderEnterHut', args, true) as Promise<number>,
      ejectHut: (...args) => command('ejectHut', args, true) as Promise<number>,
      hutInstances: () => floatsAt(shape.huts, header(H.hutCount) * shape.hutFloats),
      hutInstanceFloats: shape.hutFloats,
      hutRadius: shadow.hutRadius,
      hutCapacity: shadow.hutCapacity,
      trainingCapacity: shadow.trainingCapacity,
      warriorCost: shadow.warriorCost,
      trainSeconds: shadow.trainSeconds,

      wood: (tribe: number) => tribeField(tribe, T.wood),
      setWood: (...args) => command('setWood', args, false),
      spawnTrees: (...args) => command('spawnTrees', args, true) as Promise<number>,
      get treeCount() {
        return header(H.treeCount)
      },
      treeInstances: () => floatsAt(shape.trees, header(H.treeCount) * shape.treeFloats),
      treeInstanceFloats: shape.treeFloats,
      orderChop: (...args) => command('orderChop', args, true) as Promise<number>,
      treeProgress: offThread('treeProgress') as (id: number) => number,
      plantTree: (...args) => command('plantTree', args, true) as Promise<number>,
      woodPerTree: shadow.woodPerTree,
      chopSeconds: shadow.chopSeconds,

      spawnShaman: (...args) => command('spawnShaman', args, true) as Promise<number>,
      shamanId: (tribe: number) => (tribe >= 0 && tribe < MAX_TRIBES ? tribeField(tribe, T.shamanId) : -1),
      mana: (tribe: number) => tribeField(tribe, T.mana),
      manaIncome: (tribe: number) => tribeField(tribe, T.income),
      population: (tribe: number) => tribeField(tribe, T.population),
      setMana: (...args) => command('setMana', args, false),
      manaMax: shadow.manaMax,
      spellRules: shadow.spellRules,
      spellRadius: (spell: Spell) => spellRadii[spell] ?? 0,
      checkSpell: (spell: Spell, tribe: number, target: Vec3, origin?: Vec3 | null) =>
        checkSpellAnswer([spell, tribe, target, origin ?? null]),
      castSpell: (...args) => command('castSpell', args, true) as Promise<SpellResult>,
      cancelSpell: (...args) => command('cancelSpell', args, false),
      spellCasting(tribe: number): SpellCast | null {
        const spell = tribeField(tribe, T.castSpell)
        if (spell < 0 || tribe < 0 || tribe >= MAX_TRIBES) {
          return null
        }
        return {
          spell: spell as Spell,
          progress: tribeField(tribe, T.castProgress),
          target: [tribeField(tribe, T.castX), tribeField(tribe, T.castY), tribeField(tribe, T.castZ)],
          radius: tribeField(tribe, T.castRadius),
        }
      },
      spellCooldown: (tribe: number, spell: Spell) => tribeField(tribe, T.cooldowns + spell),
      lastSpellEnd: (tribe: number): SpellEnd => ({
        count: tribeField(tribe, T.endCount),
        spell: tribeField(tribe, T.endSpell) as Spell,
        result: tribeField(tribe, T.endResult) as SpellResult,
      }),
      landBridgePlan: offThread('landBridgePlan') as () => null,

      shamanFallen: (tribe: number) => tribeField(tribe, T.fallen) !== 0,
      get matchOver() {
        return header(H.matchOver) !== 0
      },
      get matchWinner() {
        return header(H.matchWinner)
      },

      enableAi: (...args) => command('enableAi', args, true) as Promise<boolean>,
      disableAi: (...args) => command('disableAi', args, false),
      aiEnabled: (tribe: number) => tribeField(tribe, T.aiEnabled) !== 0,
      aiLastAction: (tribe: number) => tribeField(tribe, T.aiLastAction) as AiAction,
      aiActions: (tribe: number) => tribeField(tribe, T.aiActions),
      aiThinks: (tribe: number) => tribeField(tribe, T.aiThinks),
      aiThinkSeconds: shadow.aiThinkSeconds,

      get module(): never {
        throw new Error('The core module lives on the worker; there is no main-thread module to reach.')
      },
    }

    function hutMeta(id: number, field: number): number {
      if (!(id >= 0 && id < header(H.hutCount))) {
        return -1
      }
      return read(view!.floats, shape.hutMeta + id * HUT_META.size + field)
    }

    return client
  }
}
