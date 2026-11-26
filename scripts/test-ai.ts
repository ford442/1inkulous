/**
 * The enemy tribe, headless: the core's AI playing tribe 1 with nobody at the
 * controls, and the match it is playing.
 *
 * First on the core alone, on a flat planet with no planet module, mesh or
 * renderer: an AI village with a few trees planted round it chops, builds,
 * trains a warrior and sends him at the other shaman. Then the crossing: a
 * strait between the warrior and his target is bridged when the tribe can
 * pay and left alone when it cannot. Then Swamp on a crowd of enemies, and
 * not on one with her own people in it. Then the ending: a shaman cut down
 * by a warrior, her people deaf to orders, the AI stopped and the HUD saying
 * who fell. Last, the world the game opens on (the campaign's first): two
 * shamans, one planet.
 *
 * Run: npm run test:ai   (after npm run build:wasm)
 */
import { createPlanetMesh } from '../src/engine/mesh/cubeSphere.ts'
import type { Vec3 } from '../src/engine/math.ts'
import { createGame } from '../src/game/game.ts'
import { buildNavGraph } from '../src/game/navGraph.ts'
import { matchOutcome } from '../src/world/match.ts'
import { openingWorld } from './worlds.ts'
import { PLAYER_TRIBE } from '../src/game/shaman.ts'
import { MAX_WALKABLE_SLOPE } from '../src/game/terrain.ts'
import { AiAction } from '../src/sim/ai.ts'
import { HutKind, Role, Spell, SpellResult, createSimulation, type Simulation } from '../src/sim/simulation.ts'
import { roleOfFlags } from '../src/sim/role.ts'
import { matchBanner, opponentLine, type MatchReadout } from '../src/ui/hud.ts'

/** The tribe the core plays against the player in these checks: red. */
const ENEMY_TRIBE = 1

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

const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2])
  return [v[0] / length, v[1] / length, v[2] / length]
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const angle = (a: Vec3, b: Vec3) =>
  Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))))
const along = (from: Vec3, toward: Vec3, distance: number): Vec3 =>
  normalize([
    from[0] * Math.cos(distance) + toward[0] * Math.sin(distance),
    from[1] * Math.cos(distance) + toward[1] * Math.sin(distance),
    from[2] * Math.cos(distance) + toward[2] * Math.sin(distance),
  ])

const RADIUS = 1
const MAX_HEIGHT = 0.06
const LAND = MAX_HEIGHT / 3
const graph = buildNavGraph(createPlanetMesh({ resolution: 24, radius: RADIUS }))

// Red's home, and two directions along the ground from it.
const home: Vec3 = [0, 0, 1]
const east: Vec3 = [1, 0, 0]
const north: Vec3 = [0, 1, 0]
const west: Vec3 = [-1, 0, 0]

async function flatCore(): Promise<Simulation> {
  const core = await createSimulation()
  core.uploadNavGraph(graph, new Float32Array(graph.nodeCount).fill(LAND), {
    planetRadius: RADIUS,
    maxSlope: MAX_WALKABLE_SLOPE,
    maxHeight: MAX_HEIGHT,
  })
  return core
}

const seconds = (sim: Simulation, s: number) => {
  for (let i = 0; i < Math.round(s * 20); i += 1) sim.tick(50)
}
function tickUntil(sim: Simulation, maxSeconds: number, done: () => boolean): number {
  let steps = 0
  while (steps < maxSeconds * 20 && !done()) {
    sim.tick(50)
    steps += 1
  }
  return steps / 20
}

const positionOf = (sim: Simulation, id: number): Vec3 => {
  const data = sim.followerInstances()
  const base = id * sim.followerInstanceFloats
  return normalize([data[base], data[base + 1], data[base + 2]])
}
const walking = (sim: Simulation, id: number) =>
  (sim.followerInstances()[id * sim.followerInstanceFloats + 7] & 2) !== 0

/** Ids of `tribe`'s followers that are `role` (the shaman counts as a brave). */
function members(sim: Simulation, tribe: number, role?: Role): number[] {
  const data = sim.followerInstances()
  const stride = sim.followerInstanceFloats
  const out: number[] = []
  for (let id = 0; id < data.length / stride; id += 1) {
    if (data[id * stride + 6] === tribe && (role === undefined || roleOfFlags(data[id * stride + 7]) === role)) {
      out.push(id)
    }
  }
  return out
}
function hutsOf(sim: Simulation, tribe: number, kind?: HutKind): number {
  let total = 0
  for (let id = 0; id < sim.hutCount; id += 1) {
    if (sim.hutTribe(id) === tribe && (kind === undefined || sim.hutKind(id) === kind)) total += 1
  }
  return total
}

/** Everything a think did, as the AI reports it: watched once per fixed step. */
function watchActions(sim: Simulation, tribe: number) {
  const seen: AiAction[] = []
  let thinks = sim.aiThinks(tribe)
  return {
    seen,
    tick() {
      sim.tick(50)
      if (sim.aiThinks(tribe) !== thinks) {
        thinks = sim.aiThinks(tribe)
        seen.push(sim.aiLastAction(tribe))
      }
    },
  }
}

/** Rings `centre` with water `radius` radians out, using the core's own sculpt. */
function digMoat(sim: Simulation, centre: Vec3, a: Vec3, b: Vec3, radius: number): void {
  for (let k = 0; k < 64; k += 1) {
    const theta = (k / 64) * Math.PI * 2
    const tangent = normalize([
      a[0] * Math.cos(theta) + b[0] * Math.sin(theta),
      a[1] * Math.cos(theta) + b[1] * Math.sin(theta),
      a[2] * Math.cos(theta) + b[2] * Math.sin(theta),
    ])
    sim.sculptTerrain(along(centre, tangent, radius), 0.07, -1)
  }
}

// --- a village left alone: wood, a hut, a warrior, an attack ---------------

{
  const core = await flatCore()
  const target = along(home, west, 1.2)
  core.spawnShaman(target, PLAYER_TRIBE)
  core.spawnShaman(home, ENEMY_TRIBE)
  for (const [dir, d] of [[east, 0.05], [north, 0.05], [west, 0.05], [east, 0.08]] as const) {
    core.spawnFollower(along(home, dir, d), ENEMY_TRIBE)
  }
  // Four trees a short walk out, and none anywhere else: twenty wood.
  const planted = [east, north, west, [0, -1, 0] as Vec3].map((dir) => core.plantTree(along(home, dir, 0.2)))
  check('core: a tree is planted where it is asked for, once',
    planted.every((id, i) => id === i) && core.treeCount === 4 &&
      core.plantTree(along(home, east, 0.2)) === -1 && core.treeCount === 4)

  check('core: nothing plays a tribe until it is handed one',
    !core.aiEnabled(ENEMY_TRIBE) && core.aiThinks(ENEMY_TRIBE) === 0)
  check('core: a tribe with no shaman and no hut cannot be handed over', !core.enableAi(2))
  check('core: tribe 1 is', core.enableAi(ENEMY_TRIBE) && core.aiEnabled(ENEMY_TRIBE))

  seconds(core, 1)
  check('core: its mana rises with its population',
    core.population(ENEMY_TRIBE) === 5 && core.manaIncome(ENEMY_TRIBE) === 5 &&
      Math.abs(core.mana(ENEMY_TRIBE) - 5) < 1e-6,
    `${core.population(ENEMY_TRIBE)} people, ${core.mana(ENEMY_TRIBE).toFixed(2)} mana`)
  check('core: it does not think every step', core.aiThinks(ENEMY_TRIBE) === 0)

  // The acceptance check: a few seconds of simulated time, no renderer.
  const watch = watchActions(core, ENEMY_TRIBE)
  for (let i = 0; i < 8 * 20; i += 1) watch.tick()
  check('core: it thinks every couple of seconds', core.aiThinks(ENEMY_TRIBE) === Math.floor(9 / core.aiThinkSeconds),
    `${core.aiThinks(ENEMY_TRIBE)} thinks in 9s`)
  check('core: and does at most one thing each time',
    core.aiActions(ENEMY_TRIBE) <= core.aiThinks(ENEMY_TRIBE), watch.seen.join(','))
  check('core: a hut appears — the free first dwelling, on level ground',
    hutsOf(core, ENEMY_TRIBE, HutKind.dwelling) === 1 && watch.seen.includes(AiAction.build))
  check('core: and wood increases', core.wood(ENEMY_TRIBE) > 0 && watch.seen.includes(AiAction.chop),
    `${core.wood(ENEMY_TRIBE)} wood, ${core.treeCount} trees left`)

  // Left longer: the rest of the trees, a training hut, a warrior.
  for (let i = 0; i < 60 * 20 && members(core, ENEMY_TRIBE, Role.warrior).length === 0; i += 1) watch.tick()
  check('core: it builds a training hut once it has the wood', hutsOf(core, ENEMY_TRIBE, HutKind.training) === 1)
  check('core: trains a warrior in it', members(core, ENEMY_TRIBE, Role.warrior).length === 1 &&
    watch.seen.includes(AiAction.train), `${core.wood(ENEMY_TRIBE)} wood left`)
  const warrior = members(core, ENEMY_TRIBE, Role.warrior)[0]
  const startGap = angle(positionOf(core, warrior), target)
  seconds(core, 2 * core.aiThinkSeconds)
  const nowWarrior = members(core, ENEMY_TRIBE, Role.warrior)[0]
  check('core: and walks him at the player\'s shaman',
    core.aiLastAction(ENEMY_TRIBE) === AiAction.attack || walking(core, nowWarrior))
  seconds(core, 5)
  const gap = angle(positionOf(core, members(core, ENEMY_TRIBE, Role.warrior)[0]), target)
  check('core: closing on her', gap < startGap - 0.1, `${startGap.toFixed(2)} -> ${gap.toFixed(2)} rad`)
  check('core: the flat ground never needed a Flatten', core.lastSpellEnd(ENEMY_TRIBE).count === 0)
}

// --- a strait in the way: bridged if she can pay, left alone if not --------

async function islandMatch() {
  const core = await flatCore()
  const MOAT = 0.3
  digMoat(core, home, east, north, MOAT)
  const target = along(home, east, 0.5)
  core.spawnShaman(target, PLAYER_TRIBE)
  // Red's shaman in the middle of the island, her warrior at the shore
  // facing the player across the water.
  core.spawnShaman(home, ENEMY_TRIBE)
  const warrior = core.spawnFollower(along(home, east, 0.18), ENEMY_TRIBE)
  core.setFollowerRole(warrior, Role.warrior)
  core.enableAi(ENEMY_TRIBE)
  return { core, target, warrior }
}

{
  const { core, target, warrior } = await islandMatch()
  check('core: the strait is water, and no route crosses it',
    core.terrainHeightAt(along(home, east, 0.3)) <= 0 &&
      core.module._core_nav_route(...positionOf(core, warrior), ...target, 0) === -1)
  const watch = watchActions(core, ENEMY_TRIBE)
  for (let i = 0; i < 20 * 20; i += 1) watch.tick()
  check('core: short of the mana, she neither walks to the shore nor casts',
    !watch.seen.includes(AiAction.toShore) && !watch.seen.includes(AiAction.cast) &&
      core.lastSpellEnd(ENEMY_TRIBE).count === 0 && core.landBridgePlan() === null,
    `${core.mana(ENEMY_TRIBE).toFixed(0)} mana; did ${watch.seen.join(',')}`)
  check('core: and the strait is still a strait',
    core.module._core_nav_route(...positionOf(core, members(core, ENEMY_TRIBE, Role.warrior)[0]), ...target, 0) === -1)

  core.setMana(ENEMY_TRIBE, core.manaMax)
  const took = tickUntil(core, 30, () =>
    core.lastSpellEnd(ENEMY_TRIBE).count > 0 && core.lastSpellEnd(ENEMY_TRIBE).spell === Spell.landBridge)
  const ending = core.lastSpellEnd(ENEMY_TRIBE)
  check('core: able to pay, she bridges it', ending.spell === Spell.landBridge && ending.result === SpellResult.ok &&
    core.landBridgePlan() !== null, `after ${took.toFixed(1)}s`)
  check('core: paid for at the price the player pays',
    core.mana(ENEMY_TRIBE) < core.manaMax - core.spellRules[Spell.landBridge].cost + 30)
  const soldier = members(core, ENEMY_TRIBE, Role.warrior)[0]
  check('core: the warrior can walk to her now',
    core.module._core_nav_route(...positionOf(core, soldier), ...target, 0) > 0)
  const before = angle(positionOf(core, soldier), target)
  seconds(core, 2 * core.aiThinkSeconds + 6)
  const after = angle(positionOf(core, members(core, ENEMY_TRIBE, Role.warrior)[0]), target)
  check('core: and goes', after < before - 0.1, `${before.toFixed(2)} -> ${after.toFixed(2)} rad`)
}

// --- Swamp on a crowd of enemies, never on her own -------------------------

{
  const core = await flatCore()
  core.spawnShaman(along(home, west, 1.2), PLAYER_TRIBE)
  core.spawnShaman(home, ENEMY_TRIBE)
  // A hut already up, so building is not what the first think does.
  core.placeHut(along(home, north, 0.3), east, ENEMY_TRIBE, HutKind.dwelling)
  const crowd = along(home, east, 0.2)
  for (const [dir, d] of [[east, 0], [east, 0.03], [north, 0.03], [west, 0.03], [[0, -1, 0] as Vec3, 0.03]] as const) {
    core.spawnFollower(along(crowd, dir, d), PLAYER_TRIBE)
  }
  core.setMana(ENEMY_TRIBE, core.manaMax)
  core.enableAi(ENEMY_TRIBE)
  seconds(core, core.aiThinkSeconds)
  const cast = core.spellCasting(ENEMY_TRIBE)
  check('core: five enemies in her range draw a Swamp', cast !== null && cast.spell === Spell.swamp &&
    angle(cast.target, crowd) < 0.05, cast ? `aimed ${angle(cast.target, crowd).toFixed(3)} rad off` : 'nothing cast')
  seconds(core, 2)
  check('core: which lands and leaves them a bog', core.lastSpellEnd(ENEMY_TRIBE).result === SpellResult.ok &&
    core.terrainHeightAt(crowd) <= 0)
}
{
  const core = await flatCore()
  core.spawnShaman(along(home, west, 1.2), PLAYER_TRIBE)
  core.spawnShaman(home, ENEMY_TRIBE)
  core.placeHut(along(home, north, 0.3), east, ENEMY_TRIBE, HutKind.dwelling)
  const crowd = along(home, east, 0.2)
  for (const [dir, d] of [[east, 0], [east, 0.03], [north, 0.03], [west, 0.03], [[0, -1, 0] as Vec3, 0.03]] as const) {
    core.spawnFollower(along(crowd, dir, d), PLAYER_TRIBE)
  }
  // One of her own in the thick of it.
  core.spawnFollower(along(crowd, north, 0.015), ENEMY_TRIBE)
  core.setMana(ENEMY_TRIBE, core.manaMax)
  core.enableAi(ENEMY_TRIBE)
  seconds(core, core.aiThinkSeconds)
  check('core: with one of her own among them, she holds it', core.spellCasting(ENEMY_TRIBE) === null &&
    core.lastSpellEnd(ENEMY_TRIBE).count === 0)
}

// --- the ending -------------------------------------------------------------

{
  // The player's shaman cut down by an enemy warrior.
  const core = await flatCore()
  const blue = core.spawnShaman(home, PLAYER_TRIBE)
  const brave = core.spawnFollower(along(home, north, 0.05), PLAYER_TRIBE)
  core.spawnShaman(along(home, west, 1.2), ENEMY_TRIBE)
  core.enableAi(ENEMY_TRIBE)
  const warrior = core.spawnFollower(along(home, east, 0.03), ENEMY_TRIBE)
  core.setFollowerRole(warrior, Role.warrior)
  check('core: the match is on while both shamans stand', !core.matchOver && core.matchWinner === -1 &&
    matchOutcome(core, PLAYER_TRIBE) === 'playing' && blue >= 0)
  core.setFollowerSelected(brave, true)
  const took = tickUntil(core, 20, () => core.shamanId(PLAYER_TRIBE) < 0)
  check('core: a warrior next to her kills the player\'s shaman', core.shamanId(PLAYER_TRIBE) < 0 &&
    core.shamanFallen(PLAYER_TRIBE), `in ${took.toFixed(1)}s`)
  check('core: and the match is lost', core.matchOver && core.matchWinner === ENEMY_TRIBE &&
    matchOutcome(core, PLAYER_TRIBE) === 'lost')
  const thinks = core.aiThinks(ENEMY_TRIBE)
  seconds(core, 3 * core.aiThinkSeconds)
  check('core: the AI gives no further orders once it is over', core.aiThinks(ENEMY_TRIBE) === thinks)
}

{
  // The enemy shaman killed: a win, and her people deaf from then on.
  const core = await flatCore()
  core.spawnShaman(along(home, west, 1.2), PLAYER_TRIBE)
  core.spawnShaman(home, ENEMY_TRIBE)
  const reds = [east, north, west].map((dir) => core.spawnFollower(along(home, dir, 0.08), ENEMY_TRIBE))
  core.enableAi(ENEMY_TRIBE)
  core.setFollowerSelected(reds[0], true)
  check('core: before she falls, her people can be picked up and ordered',
    core.selectedFollowerCount === 1 && core.orderFollowerMove(along(home, east, 0.15)) === 1)
  seconds(core, 2)
  core.setFollowerHealth(core.shamanId(ENEMY_TRIBE), 0)
  core.tick(50)
  check('core: killing the enemy shaman wins', core.shamanFallen(ENEMY_TRIBE) && !core.shamanFallen(PLAYER_TRIBE) &&
    core.matchOver && core.matchWinner === PLAYER_TRIBE && matchOutcome(core, PLAYER_TRIBE) === 'won')
  const left = members(core, ENEMY_TRIBE)
  check('core: her people stop where they are and drop out of the selection',
    left.length === 3 && left.every((id) => !walking(core, id)) && core.selectedFollowerCount === 0)
  for (const id of left) core.setFollowerSelected(id, true)
  check('core: and take no more orders', core.selectedFollowerCount === 0 &&
    core.module._core_tree_order_chop(0) === 0 && core.orderFollowerMove(along(home, north, 0.2)) === 0)
  const thinks = core.aiThinks(ENEMY_TRIBE)
  seconds(core, 3 * core.aiThinkSeconds)
  check('core: nor does her AI think again', core.aiThinks(ENEMY_TRIBE) === thinks)

  const readout: MatchReadout = {
    playerTribe: PLAYER_TRIBE,
    outcome: matchOutcome(core, PLAYER_TRIBE),
    objective: 'Defeat every rival shaman',
    opponents: [{
      tribe: ENEMY_TRIBE, name: 'Red', shamanStanding: false, population: 3, mana: 10, income: 3, wood: 0,
      action: core.aiLastAction(ENEMY_TRIBE), personality: 'steady',
    }],
  }
  check('HUD: says who fell and who won', matchBanner(readout)?.startsWith("Red's shaman has fallen — you win") === true,
    matchBanner(readout) ?? '')
  check('HUD: and the enemy line says so too', opponentLine(readout.opponents[0]!).endsWith('shaman fallen'),
    opponentLine(readout.opponents[0]!))
  check('HUD: a loss reads as one', matchBanner({ ...readout, outcome: 'lost' })?.startsWith('Your shaman has fallen') === true)
  check('HUD: and nothing shows while the match is on', matchBanner({ ...readout, outcome: 'playing' }) === null)
}

// --- the match the game opens on --------------------------------------------

{
  const simulation = await createSimulation()
  const game = createGame(simulation, { scenario: openingWorld() })
  const { match } = game
  const enemyHome = match.tribes.find((tribe) => tribe.tribe === ENEMY_TRIBE)?.home ?? null
  check('game: two shamans on one planet', simulation.shamanId(PLAYER_TRIBE) >= 0 &&
    simulation.shamanId(ENEMY_TRIBE) >= 0 && simulation.shamanId(2) < 0 && simulation.shamanId(3) < 0)
  check('game: the enemy has a village, far round the planet', enemyHome !== null &&
    match.playerHome !== null && angle(enemyHome, match.playerHome) >= 1.2 &&
    hutsOf(simulation, ENEMY_TRIBE) === 1 && members(simulation, ENEMY_TRIBE).length > 1,
    enemyHome && match.playerHome ? `${angle(enemyHome, match.playerHome).toFixed(2)} rad apart` : '')
  check('game: tribes 2 and 3 are not on it', members(simulation, 2).length === 0 && members(simulation, 3).length === 0)
  check('game: the player opens looking at their own village',
    match.playerHome !== null && angle(game.camera.eye as Vec3, match.playerHome) < 0.05)
  check('game: and the core plays the enemy', simulation.aiEnabled(ENEMY_TRIBE) && !simulation.aiEnabled(PLAYER_TRIBE))
  const manaBefore = simulation.mana(ENEMY_TRIBE)
  seconds(simulation, 4)
  check('game: whose mana rises with its population', simulation.mana(ENEMY_TRIBE) > manaBefore &&
    simulation.manaIncome(ENEMY_TRIBE) === simulation.population(ENEMY_TRIBE) && match.opponents[0]!.population > 1,
    opponentLine(match.opponents[0]!))
  check('game: the HUD counts the player\'s followers, not the enemy\'s',
    game.followers.count === members(simulation, PLAYER_TRIBE).length)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED`)
  process.exit(1)
}
console.log('\nall AI checks passed')
