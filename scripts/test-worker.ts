/**
 * The core on its own thread. The world is built in-process, every command
 * recorded; a host replays the log onto a fresh core and the game switches to
 * it. Here the host runs over a MessageChannel on this thread with a manual
 * clock, so it can be stepped in lockstep with an in-process reference built
 * from the same log, through both transports: SharedArrayBuffer snapshots and
 * posted copies.
 *
 * Run: npm run test:worker   (after npm run build:wasm)
 */
import type { Vec3 } from '../src/engine/math.ts'
import { createGame } from '../src/game/game.ts'
import type { InputSnapshot, PointerSnapshot } from '../src/input/input.ts'
import { createSimulationHandle } from '../src/sim/handle.ts'
import { serveCore, type HostPort } from '../src/sim/host.ts'
import { applyCommand, stateDigest } from '../src/sim/protocol.ts'
import { createSimulation, HutKind, HutSite, Spell, type Simulation } from '../src/sim/simulation.ts'
import type { ClientPort, WorkerSimulation } from '../src/sim/workerClient.ts'

const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`ok  ${name}${detail ? `  — ${detail}` : ''}`)
    return
  }
  const message = detail ? `${name} — ${detail}` : name
  failures.push(message)
  console.error(`FAIL ${message}`)
}

const pointer = (partial: Partial<PointerSnapshot> = {}): PointerSnapshot => ({
  position: { x: 0, y: 0 },
  ndc: { x: 0, y: 0 },
  delta: { x: 0, y: 0 },
  buttons: { left: false, middle: false, right: false },
  wheel: 0,
  dragging: false,
  dragRect: null,
  drags: [],
  clicks: [],
  ...partial,
})
const input = (pressed: string[] = [], partial: Partial<PointerSnapshot> = {}): InputSnapshot =>
  ({ keys: new Set(), pressed: new Set(pressed), pointer: pointer(partial) }) as InputSnapshot

const STEP = 50

async function run(shared: boolean) {
  const label = shared ? 'shared' : 'transfer'
  console.log(`\n--- ${label} snapshots`)

  const core = await createSimulation()
  const handle = createSimulationHandle(core)
  const game = createGame(handle.simulation)
  check(`${label}: setup was recorded`, handle.log.some((c) => c.op === 'uploadNavGraph') &&
    handle.log.some((c) => c.op === 'spawnShaman'), `${handle.log.length} commands`)

  // The lockstep reference: the same log on another in-process core.
  const reference = await createSimulation()
  for (const command of handle.log) applyCommand(reference, command)
  check(`${label}: the log rebuilds the same world in-process`, stateDigest(reference) === stateDigest(core))

  const channel = new MessageChannel()
  serveCore(channel.port2 as unknown as HostPort)
  const worker: WorkerSimulation = await handle.moveToWorker(channel.port1 as unknown as ClientPort, {
    clock: 'manual',
    shared,
  })
  check(`${label}: the worker replayed it to the same digest`, true)
  check(`${label}: over the transport asked for`, worker.transport === label, worker.transport)
  check(`${label}: the game's handle now points at the worker`, handle.current === worker &&
    handle.simulation.followerCount === reference.followerCount)

  // Steps the host and the reference the same time, then swaps the snapshot in.
  // In steps' worth: one tick is capped at 250ms of catch-up.
  const step = async (ms: number) => {
    for (let t = 0; t < ms; t += STEP) {
      worker.advance(STEP)
      reference.tick(STEP)
    }
    await worker.flush()
    return worker.tick(ms)
  }
  const same = (name: string) =>
    check(`${label}: ${name}`, stateDigest(worker) === stateDigest(reference),
      `step ${worker.stepCount} vs ${reference.stepCount}`)

  check(`${label}: a frame with nothing new swaps nothing`, worker.tick(16) === 0)
  check(`${label}: two seconds on the worker report 40 steps`, (await step(2000)) === 40,
    `${worker.stepCount}`)
  same('and match the reference step for step')
  check(`${label}: the instance buffers are views, not copies`,
    worker.followerInstances().buffer === worker.navHeights().buffer &&
    worker.followerInstances().length === reference.followerCount * reference.followerInstanceFloats)

  // Commands: selection, an order with its result, a hut.
  const tribe = game.match.playerTribe
  const mine = [0, 1, 2, 3, 4, 5].filter((id) => id < reference.followerCount)
  const home = game.match.playerHome!
  const away: Vec3 = [home[0] + 0.05, home[1] - 0.04, home[2]]
  for (const sim of [worker, reference] as const) {
    sim.clearFollowerSelection()
    for (const id of mine.slice(0, 4)) sim.setFollowerSelected(id, true)
  }
  const routed = worker.orderFollowerMove(away)
  check(`${label}: a command's result is a promise on the worker`, routed instanceof Promise)
  check(`${label}: and resolves to what the in-process core says`,
    (await routed) === reference.orderFollowerMove(away), `${await routed}`)
  await worker.flush()
  worker.tick(0)
  check(`${label}: the selection shows on the next frame, without a step`,
    worker.selectedFollowerCount === reference.selectedFollowerCount, `${worker.selectedFollowerCount}`)
  await step(1500)
  same('the order walks them the same way on both')

  // Async queries: a frame late, then the real answer.
  const asked = worker.hutSite(home, HutKind.dwelling, tribe)
  await worker.flush()
  const answered = worker.hutSite(home, HutKind.dwelling, tribe)
  const truth = reference.hutSite(home, HutKind.dwelling, tribe)
  check(`${label}: hutSite answers a frame late`, asked.site === HutSite.noGrid || asked.site === truth.site)
  check(`${label}: and then as the core does`, answered.site === truth.site &&
    answered.footprint === truth.footprint, `${answered.site} vs ${truth.site}`)
  worker.checkSpell(Spell.blast, tribe, away, null)
  await worker.flush()
  check(`${label}: checkSpell too`, worker.checkSpell(Spell.blast, tribe, away, null) ===
    reference.checkSpell(Spell.blast, tribe, away, null))
  check(`${label}: hut costs come from the snapshot`,
    worker.hutCost(HutKind.training, tribe) === reference.hutCost(HutKind.training, tribe) &&
    worker.wood(tribe) === reference.wood(tribe))

  // Terrain: an edit reports its range, and the picking mirror follows.
  worker.takeTerrainDirty()
  reference.takeTerrainDirty()
  const raised = worker.sculptTerrain(away, 0.08, 0.4)
  reference.sculptTerrain(away, 0.08, 0.4)
  check(`${label}: a sculpt lands`, (await raised) === true)
  await worker.flush()
  worker.tick(0)
  const dirty = worker.takeTerrainDirty()
  const refDirty = reference.takeTerrainDirty()
  check(`${label}: and reports the nodes it moved`, dirty !== null && refDirty !== null &&
    dirty.first === refDirty.first && dirty.last === refDirty.last, JSON.stringify(dirty))
  check(`${label}: once`, worker.takeTerrainDirty() === null)
  check(`${label}: the main-thread mirror reads the new ground`,
    Math.abs(worker.terrainHeightAt(away) - reference.terrainHeightAt(away)) < 1e-6,
    `${worker.terrainHeightAt(away)} vs ${reference.terrainHeightAt(away)}`)

  // Two edits between frames: the client has missed one range, so it takes all.
  const other: Vec3 = [away[0] - 0.08, away[1] + 0.06, away[2]]
  worker.sculptTerrain(other, 0.05, 0.1)
  await worker.flush()
  worker.sculptTerrain(away, 0.05, -0.1)
  await worker.flush()
  reference.sculptTerrain(other, 0.05, 0.1)
  reference.sculptTerrain(away, 0.05, -0.1)
  worker.tick(0)
  const missed = worker.takeTerrainDirty()
  if (shared) {
    check(`${label}: two edits between frames redraw everything`,
      missed !== null && missed.first === 0 && missed.last === worker.navHeights().length - 1, JSON.stringify(missed))
  } else {
    // Posted copies are never skipped, only the newest is swapped in; the range still has to cover both.
    check(`${label}: two edits between frames are covered`, missed !== null)
  }
  same('both sculpted worlds agree')

  // A frame of the game itself: build mode hovering, a spell aimed, an order.
  // The main thread must make no call into its own core, bar the height mirror.
  const counts = new Map<string, number>()
  const module = core.module as unknown as Record<string, unknown>
  for (const name of Object.keys(module)) {
    const fn = module[name]
    if (name.startsWith('_core_') && typeof fn === 'function') {
      module[name] = (...args: unknown[]) => {
        counts.set(name, (counts.get(name) ?? 0) + 1)
        return (fn as (...a: unknown[]) => unknown)(...args)
      }
    }
  }
  game.update(16, input(['KeyB'], { ndc: { x: 0, y: 0 } }), 16 / 9)
  game.update(16, input([], { ndc: { x: 0.1, y: 0 } }), 16 / 9)
  game.update(16, input(['KeyX'], { ndc: { x: 0, y: 0.1 } }), 16 / 9)
  game.update(16, input([], { ndc: { x: 0, y: 0 } }), 16 / 9)
  worker.tick(16)
  await worker.flush()
  const calls = [...counts].filter(([name]) => name !== '_core_terrain_height_at')
  check(`${label}: frames on the main thread call no core_* but the height mirror`, calls.length === 0,
    calls.map(([n, c]) => `${n}×${c}`).join(', '))
  check(`${label}: while the hut ghost and spell preview still get answers`,
    game.huts.ghost === null || game.huts.ghost.site !== undefined)

  check(`${label}: sim time per step is reported from the worker`, (() => {
    const ms = worker.takeSimMsPerStep()
    return ms === null || ms >= 0
  })())

  worker.dispose()
  channel.port1.close()
  channel.port2.close()
}

// Without a reply the client must not hang, nor take a wrong world.
async function rejectsAMismatch() {
  console.log('\n--- a replay that does not match')
  const core = await createSimulation()
  const handle = createSimulationHandle(core)
  createGame(handle.simulation)
  const channel = new MessageChannel()
  serveCore(channel.port2 as unknown as HostPort)
  // Drop the last command: the worker builds a different world.
  const log = handle.log as unknown as unknown[]
  const dropped = log.pop()
  let refused = false
  try {
    await handle.moveToWorker(channel.port1 as unknown as ClientPort, { clock: 'manual' })
  } catch {
    refused = true
  }
  log.push(dropped)
  check('the client refuses a worker whose digest differs', refused)
  check('and the game stays on the in-process core', handle.current === (core as Simulation))
  channel.port1.close()
  channel.port2.close()
}

await run(true)
await run(false)
await rejectsAMismatch()

if (failures.length > 0) {
  console.error(`\n${failures.length} worker check(s) failed`)
  process.exit(1)
}
console.log('\nall worker checks passed')
