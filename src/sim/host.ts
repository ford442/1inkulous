import {
  applyCommand,
  createTripleBuffer,
  H,
  HUT_KIND_COUNT,
  HUT_META,
  MAX_FOLLOWERS,
  MAX_HUTS,
  MAX_TREES,
  MAX_TRIBES,
  snapshotLayout,
  SPELL_COUNT,
  stateDigest,
  T,
  tripleBufferWriter,
  viewSnapshot,
  type FromHost,
  type SnapshotLayout,
  type ToHost,
} from './protocol'
import { createSimulation, type Simulation } from './simulation'
import type { HutKind } from './hutSite'
import type { Spell } from './spell'

/** The two ends a host needs: a worker's `self`, or one side of a MessageChannel. */
export type HostPort = {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown, transfer: Transferable[]) => void
}

/**
 * The core's side of the channel: owns the WebAssembly module and the
 * fixed-step clock, applies commands in the order they arrive, and publishes
 * a snapshot after anything changes. Transport-agnostic, so a Node test can run
 * it over a MessageChannel on one thread.
 */
export function serveCore(port: HostPort): void {
  let core: Simulation | null = null
  let layout: SnapshotLayout | null = null
  let manual = false
  let paused = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastTime = 0
  let simMsTotal = 0
  let simStepsTotal = 0
  // Terrain edits are sticky in the header: see H.terrainRev.
  let terrainRev = 0
  let dirtyFirst = -1
  let dirtyLast = -1
  let writer: ReturnType<typeof tripleBufferWriter> | null = null
  const pool: ArrayBuffer[] = []
  // Messages that arrive while the module is still loading wait their turn.
  const backlog: ToHost[] = []

  const send = (message: FromHost, transfer: Transferable[] = []) => port.postMessage(message, transfer)

  const fill = (buffer: ArrayBufferLike) => {
    const sim = core!
    const shape = layout!
    const { header, floats } = viewSnapshot(buffer, shape)
    header[H.seq]! += 1
    header[H.stepMs] = sim.stepMs
    header[H.stepCount] = sim.stepCount
    header[H.elapsedMs] = sim.elapsedMs
    const followers = Math.min(sim.followerCount, MAX_FOLLOWERS)
    const huts = Math.min(sim.hutCount, MAX_HUTS)
    const trees = Math.min(sim.treeCount, MAX_TREES)
    header[H.followerCount] = followers
    header[H.selectedCount] = sim.selectedFollowerCount
    header[H.hutCount] = huts
    header[H.housedCount] = sim.housedCount
    header[H.treeCount] = trees
    header[H.matchOver] = sim.matchOver ? 1 : 0
    header[H.matchWinner] = sim.matchWinner

    const dirty = sim.takeTerrainDirty()
    if (dirty) {
      terrainRev += 1
      dirtyFirst = dirty.first
      dirtyLast = dirty.last
    }
    header[H.terrainRev] = terrainRev
    header[H.dirtyFirst] = dirtyFirst
    header[H.dirtyLast] = dirtyLast
    header[H.simMsTotal] = simMsTotal
    header[H.simStepsTotal] = simStepsTotal

    for (let tribe = 0; tribe < MAX_TRIBES; tribe += 1) {
      const at = H.tribes + tribe * T.size
      header[at + T.wood] = sim.wood(tribe)
      header[at + T.mana] = sim.mana(tribe)
      header[at + T.income] = sim.manaIncome(tribe)
      header[at + T.population] = sim.population(tribe)
      header[at + T.shamanId] = sim.shamanId(tribe)
      header[at + T.fallen] = sim.shamanFallen(tribe) ? 1 : 0
      header[at + T.aiEnabled] = sim.aiEnabled(tribe) ? 1 : 0
      header[at + T.aiLastAction] = sim.aiLastAction(tribe)
      header[at + T.aiActions] = sim.aiActions(tribe)
      header[at + T.aiThinks] = sim.aiThinks(tribe)
      const cast = sim.spellCasting(tribe)
      header[at + T.castSpell] = cast ? cast.spell : -1
      header[at + T.castProgress] = cast ? cast.progress : 0
      header[at + T.castX] = cast ? cast.target[0] : 0
      header[at + T.castY] = cast ? cast.target[1] : 0
      header[at + T.castZ] = cast ? cast.target[2] : 0
      header[at + T.castRadius] = cast ? cast.radius : 0
      const ended = sim.lastSpellEnd(tribe)
      header[at + T.endCount] = ended.count
      header[at + T.endSpell] = ended.spell
      header[at + T.endResult] = ended.result
      for (let spell = 0; spell < SPELL_COUNT; spell += 1) {
        header[at + T.cooldowns + spell] = sim.spellCooldown(tribe, spell as Spell)
      }
      for (let kind = 0; kind < HUT_KIND_COUNT; kind += 1) {
        header[at + T.hutCosts + kind] = sim.hutCost(kind as HutKind, tribe)
      }
    }

    floats.set(sim.followerInstances().subarray(0, followers * shape.followerFloats), shape.followers)
    floats.set(sim.hutInstances().subarray(0, huts * shape.hutFloats), shape.huts)
    floats.set(sim.treeInstances().subarray(0, trees * shape.treeFloats), shape.trees)
    floats.set(sim.navHeights(), shape.heights)
    for (let id = 0; id < huts; id += 1) {
      const at = shape.hutMeta + id * HUT_META.size
      floats[at + HUT_META.tribe] = sim.hutTribe(id)
      floats[at + HUT_META.kind] = sim.hutKind(id)
      floats[at + HUT_META.occupants] = sim.hutOccupants(id)
    }
  }

  let seq = 0
  const publish = () => {
    if (writer) {
      fill(writer.slot)
      writer.publish()
      return
    }
    const buffer = pool.pop() ?? new ArrayBuffer(layout!.bytes)
    // A recycled buffer carries an old sequence; restamp from ours.
    new Float64Array(buffer, 0, 1)[0] = seq
    fill(buffer)
    seq += 1
    send({ type: 'snapshot', buffer }, [buffer])
  }

  const advance = (ms: number) => {
    const started = performance.now()
    const steps = core!.tick(ms)
    if (steps > 0) {
      simMsTotal += performance.now() - started
      simStepsTotal += steps
    }
    return steps
  }

  const schedule = () => {
    if (manual || paused || timer !== null || !core) {
      return
    }
    // Sleep until the next step is due rather than spinning.
    const wait = Math.max(1, core.stepMs - core.module._core_pending_ms())
    timer = setTimeout(loop, wait)
  }

  function loop() {
    timer = null
    const now = performance.now()
    const steps = advance(now - lastTime)
    lastTime = now
    if (steps > 0) {
      publish()
    }
    schedule()
  }

  const handle = async (message: ToHost) => {
    switch (message.type) {
      case 'init': {
        manual = message.options.clock === 'manual'
        core = await createSimulation(
          message.options.stepMs === undefined ? {} : { stepMs: message.options.stepMs },
        )
        for (const command of message.log) {
          applyCommand(core, command)
        }
        // Digest before the snapshot's first fill clears the terrain's dirty range.
        const digest = stateDigest(core)
        layout = snapshotLayout(
          core.navHeights().length,
          core.followerInstanceFloats,
          core.hutInstanceFloats,
          core.treeInstanceFloats,
        )
        const shared =
          message.options.shared && typeof SharedArrayBuffer !== 'undefined'
            ? createTripleBuffer(layout.bytes)
            : null
        writer = shared ? tripleBufferWriter(shared) : null
        // The first snapshot goes out before `ready`, so the client never has
        // a frame with nothing to read.
        publish()
        send({ type: 'ready', digest, layout, shared })
        lastTime = performance.now()
        schedule()
        while (backlog.length > 0) {
          await handle(backlog.shift()!)
        }
        return
      }
      case 'commands': {
        const results: { id: number; value: unknown }[] = []
        message.commands.forEach((command, i) => {
          const value = applyCommand(core!, command)
          const id = message.ids[i]
          if (id !== null && id !== undefined) {
            results.push({ id, value })
          }
        })
        if (results.length > 0) {
          send({ type: 'results', results })
        }
        // Straight away, so a selection or an order shows on the next frame
        // rather than at the next step.
        publish()
        return
      }
      case 'query': {
        const { query } = message
        const value =
          query.op === 'hutSite' ? core!.hutSite(...query.args) : core!.checkSpell(...query.args)
        send({ type: 'answer', id: message.id, value })
        return
      }
      case 'advance':
        if (advance(message.ms) > 0) {
          publish()
        }
        return
      case 'pause':
        paused = true
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        return
      case 'resume':
        if (paused) {
          paused = false
          // A hidden tab is not owed the time it was away.
          lastTime = performance.now()
          schedule()
        }
        return
      case 'recycle':
        if (layout && message.buffer.byteLength === layout.bytes && pool.length < 4) {
          pool.push(message.buffer)
        }
        return
      case 'dispose':
        paused = true
        if (timer !== null) {
          clearTimeout(timer)
        }
        port.onmessage = null
        return
    }
  }

  let busy = Promise.resolve()
  port.onmessage = (event: MessageEvent) => {
    const message = event.data as ToHost
    if (!core && message.type !== 'init') {
      backlog.push(message)
      return
    }
    // In order, even across the init's await.
    busy = busy
      .then(() => handle(message))
      .catch((error: unknown) => {
        send({ type: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error) })
      })
  }
}
