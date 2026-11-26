/**
 * What the world does, as the speakers hear it — against the real core.
 *
 * `test:audio` checks the event derivation against scripted state; this checks
 * it against the game: a follower is killed, a tree planted and chopped down, a
 * hut raised, a spell cast, and `game.takeEvents()` must say each so, where it
 * happened, once — with the core in-process and with it behind a worker, where
 * every read comes from a published snapshot and the simulation the game holds
 * is a proxy that forwards to it (src/sim/handle.ts).
 *
 * The worker run is the one that earns its keep: the events are gated on the
 * step count, which on a worker is a header in the snapshot, not a field of the
 * core. If that read ever went stale, every event would silently stop.
 *
 * Run: npm run test:events   (after npm run build:wasm)
 */
import { createGame, type Game } from '../src/game/game.ts'
import { openingWorld } from './worlds.ts'
import type { GameEvent } from '../src/game/gameEvents.ts'
import type { InputSnapshot } from '../src/input/input.ts'
import { createSimulationHandle } from '../src/sim/handle.ts'
import { serveCore, type HostPort } from '../src/sim/host.ts'
import { createSimulation, HutKind, HutSite, Spell, SpellResult } from '../src/sim/simulation.ts'
import type { ClientPort, WorkerSimulation } from '../src/sim/workerClient.ts'
import { CANVAS_ASPECT } from '../src/viewport.ts'

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

const idle: InputSnapshot = {
  keys: new Set(),
  pressed: new Set(),
  pointer: {
    position: null,
    ndc: null,
    delta: { x: 0, y: 0 },
    buttons: { left: false, middle: false, right: false },
    wheel: 0,
    dragging: false,
    dragRect: null,
    drags: [],
    clicks: [],
  },
}

type Vec = [number, number, number]
const STEP = 50
const FLAG_SHAMAN = 4
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)
const unit = (v: Vec): Vec => {
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}

async function scenarios(onWorker: boolean) {
  const label = onWorker ? 'worker' : 'in-process'
  console.log(`\n--- the core ${onWorker ? 'behind a worker' : 'in-process'}`)

  const core = await createSimulation()
  const handle = createSimulationHandle(core)
  const game: Game = createGame(handle.simulation, { scenario: openingWorld(), seed: 1 })
  const channel = new MessageChannel()
  let worker: WorkerSimulation | null = null
  if (onWorker) {
    serveCore(channel.port2 as unknown as HostPort)
    worker = await handle.moveToWorker(channel.port1 as unknown as ClientPort, { clock: 'manual', shared: false })
  }
  const sim = handle.current
  const tribe = game.match.playerTribe

  const seen: GameEvent[] = []
  /** Runs `ms` of game time a step at a time, as frames would, collecting what the game reports. */
  const pump = async (ms: number) => {
    for (let t = 0; t < ms; t += STEP) {
      if (worker) {
        worker.advance(STEP)
        await worker.flush()
        worker.tick(STEP)
      } else {
        sim.tick(STEP)
      }
      game.update(16, idle, CANVAS_ASPECT)
      seen.push(...game.takeEvents())
    }
  }
  const since = (from: number, type: GameEvent['type']) => seen.slice(from).filter((e) => e.type === type)

  const braves = () => {
    const data = sim.followerInstances()
    const stride = sim.followerInstanceFloats
    const out: { id: number; at: Vec }[] = []
    for (let id = 0; id * stride < data.length; id += 1) {
      const b = id * stride
      if (Math.round(data[b + 6]!) === tribe && (Math.round(data[b + 7]!) & FLAG_SHAMAN) === 0) {
        out.push({ id, at: [data[b]!, data[b + 1]!, data[b + 2]!] })
      }
    }
    return out
  }

  // --- nothing at the start is news ------------------------------------------------
  await pump(2000)
  const quiet = seen.filter((e) => e.type === 'death' || e.type === 'spellLanded' || e.type === 'hutBuilt')
  check(`${label}: the opening seconds report no death, landing or new hut`, quiet.length === 0, JSON.stringify(quiet))
  check(`${label}: and the game is stepping (so a quiet world is not a stalled one)`, sim.stepCount >= 40, `step ${sim.stepCount}`)

  // --- a death ---------------------------------------------------------------------------
  {
    const victim = braves()[3]!
    const before = seen.length
    const population = sim.population(tribe)
    await sim.setFollowerHealth(victim.id, 0)
    await pump(300)
    const deaths = since(before, 'death') as Extract<GameEvent, { type: 'death' }>[]
    check(`${label}: a follower killed is one death event, of its tribe`, deaths.length === 1 && deaths[0]!.tribe === tribe &&
      sim.population(tribe) === population - 1, `${deaths.length} deaths, population ${population} -> ${sim.population(tribe)}`)
    check(`${label}: placed where it stood`, deaths[0]?.position != null && dist(deaths[0].position, victim.at) < 0.06,
      deaths[0]?.position ? `${dist(deaths[0].position, victim.at).toExponential(1)} away` : 'no position')
    const again = seen.length
    await pump(500)
    check(`${label}: and it is not reported again`, since(again, 'death').length === 0)
  }

  // --- a tree planted, chopped, felled ------------------------------------------------------
  {
    const chopper = braves()[0]!
    const spot = unit([chopper.at[0] + 0.03, chopper.at[1] - 0.02, chopper.at[2]])
    const before = seen.length
    const trees = sim.treeCount
    await sim.plantTree(spot)
    await pump(100)
    check(`${label}: planting a tree is not a chop`, sim.treeCount === trees + 1 && since(before, 'chop').length === 0)

    // The tree nearest the spot: the one just planted.
    const data = sim.treeInstances()
    const stride = sim.treeInstanceFloats
    let tree = 0
    let best = Infinity
    for (let id = 0; id * stride < data.length; id += 1) {
      const d = dist(unit([data[id * stride]!, data[id * stride + 1]!, data[id * stride + 2]!]), spot)
      if (d < best) {
        best = d
        tree = id
      }
    }
    const treeAt: Vec = [data[tree * stride]!, data[tree * stride + 1]!, data[tree * stride + 2]!]
    const wood = sim.wood(tribe)
    sim.clearFollowerSelection()
    sim.setFollowerSelected(chopper.id, true)
    check(`${label}: a brave is sent to chop it`, (await sim.orderChop(tree)) === 1)
    await pump(14000)

    // The whole planet's chopping is reported — the enemy is felling its own
    // forest meanwhile — so look at the events at this tree.
    const atTree = (e: { position: readonly number[] }) => dist(e.position, treeAt) < 0.03
    const elsewhere = since(before, 'chop').filter((e) => !atTree(e as Extract<GameEvent, { type: 'chop' }>)).length
    const blows = (since(before, 'chop') as Extract<GameEvent, { type: 'chop' }>[]).filter(atTree)
    const felled = (since(before, 'treeFelled') as Extract<GameEvent, { type: 'treeFelled' }>[]).filter(atTree)
    check(`${label}: the chopping is blows, at the tree`, blows.length >= 4 && blows.length <= 6, `${blows.length} blows here, ${elsewhere} elsewhere`)
    check(`${label}: and the felling is one event, at the tree, after its blows`, felled.length === 1 &&
      seen.indexOf(felled[0]!) > seen.indexOf(blows[blows.length - 1]!), `${felled.length} felled here`)
    check(`${label}: the wood arrived (so it really was chopped down)`, sim.wood(tribe) === wood + sim.woodPerTree, `${wood} -> ${sim.wood(tribe)}`)
  }

  // --- a hut ------------------------------------------------------------------------------------------
  {
    // A dry, level pad near home. The in-process core still judges sites by the
    // world as it was built, which is the same ground.
    const home = game.match.playerHome!
    let site: Vec | null = null
    for (let ring = 1; ring <= 14 && !site; ring += 1) {
      for (let a = 0; a < 16 && !site; a += 1) {
        const angle = (a / 16) * Math.PI * 2
        const candidate = unit([
          home[0] + Math.cos(angle) * ring * 0.03,
          home[1] + Math.sin(angle) * ring * 0.03,
          home[2] + 0.0,
        ])
        if (core.hutSite(candidate, HutKind.dwelling, tribe).site === HutSite.ok) site = candidate
      }
    }
    check(`${label}: a place to build was found`, site !== null)
    if (site) {
      const before = seen.length
      await sim.setWood(tribe, 100)
      const id = await sim.placeHut(site, [0, 1, 0], tribe, HutKind.dwelling)
      check(`${label}: the hut was placed`, id >= 0, `id ${id}`)
      await pump(200)
      const built = since(before, 'hutBuilt') as Extract<GameEvent, { type: 'hutBuilt' }>[]
      check(`${label}: it is one hutBuilt event, of its tribe and kind, at the pad`, built.length === 1 && built[0]!.tribe === tribe &&
        built[0]!.kind === HutKind.dwelling && Math.hypot(...unit(built[0]!.position)) > 0 && dist(unit(built[0]!.position), site) < 0.08,
        built[0] ? `${dist(unit(built[0].position), site).toExponential(1)} from the site` : 'none')
    }
  }

  // --- a spell ------------------------------------------------------------------------------------------
  {
    await sim.setMana(tribe, sim.manaMax)
    // The opening world holds Blast back until the tribe has grown; this is
    // about how a cast sounds, not when it may be cast.
    await sim.setSpellUnlock(tribe, Spell.blast, 0)
    const shamanId = sim.shamanId(tribe)
    const data = sim.followerInstances()
    const b = shamanId * sim.followerInstanceFloats
    const target = unit([data[b]! + 0.01, data[b + 1]!, data[b + 2]!])
    const before = seen.length
    const result = await sim.castSpell(Spell.blast, tribe, target)
    check(`${label}: a Blast was begun`, result === SpellResult.ok, `result ${result}`)
    await pump(sim.spellRules[Spell.blast]!.castSeconds * 1000 + 1500)
    const cast = since(before, 'spellCast') as Extract<GameEvent, { type: 'spellCast' }>[]
    const landed = since(before, 'spellLanded') as Extract<GameEvent, { type: 'spellLanded' }>[]
    check(`${label}: a cast is heard once, at its target, as it begins`, cast.length === 1 && cast[0]!.tribe === tribe && cast[0]!.spell === Spell.blast &&
      dist(unit(cast[0]!.position), target) < 1e-4, `${cast.length}`)
    check(`${label}: and the landing once, later, there`, landed.length === 1 && dist(unit(landed[0]!.position), target) < 1e-4 &&
      seen.indexOf(landed[0]!) > seen.indexOf(cast[0]!), `${landed.length}`)
  }

  worker?.dispose()
  channel.port1.close()
  channel.port2.close()
}

await scenarios(false)
await scenarios(true)

if (failures.length > 0) {
  console.error(`\n${failures.length} event check(s) failed`)
  process.exit(1)
}
console.log('\nall event checks passed')
process.exit(0)
