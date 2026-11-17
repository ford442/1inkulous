/**
 * The shaman, mana and her spells: Land Bridge, Blast, Flatten and Swamp, all
 * on one check / cast path.
 *
 * First on the core alone: the cube-sphere topology and a flat seed go in,
 * and everything after that is a core call — moats are dug with the core's
 * sculpt, casts are refused, started, cancelled and landed, and no planet,
 * mesh view or renderer exists. That is the path an enemy shaman's AI will
 * take, and one section has a second tribe's shaman do exactly that.
 *
 * Then through the game module, driven by synthetic input: each spell's key
 * aims it, a click or a drag starts the cast, the HUD lists every spell with
 * its cost and the reason a red aim is red, and the planet mesh picks a
 * landed spell up from the dirty range — while every refused or cancelled
 * cast leaves the ground, the mana and the mesh exactly as they were.
 *
 * Run: npm run test:shaman   (after npm run build:wasm)
 */
import { createPlanetMesh } from '../src/engine/mesh/cubeSphere.ts'
import { mat4LookAt, type Vec3 } from '../src/engine/math.ts'
import { worldToNdc } from '../src/engine/picking.ts'
import { createFollowers } from '../src/game/followers.ts'
import { buildNavGraph } from '../src/game/navGraph.ts'
import { createPlanet } from '../src/game/planet.ts'
import { createShaman, PLAYER_TRIBE, SPELL_KEYS } from '../src/game/shaman.ts'
import { createTerrain, MAX_WALKABLE_SLOPE } from '../src/game/terrain.ts'
import type { InputSnapshot, PointerClick, PointerSnapshot } from '../src/input/input.ts'
import { HutKind, HutSite } from '../src/sim/hutSite.ts'
import { createSimulation, type Simulation } from '../src/sim/simulation.ts'
import { Spell, SpellResult } from '../src/sim/spell.ts'
import { shamanLine, spellLine } from '../src/ui/hud.ts'
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

/** Mirror kFlagShaman and kFlagCasting in cpp/include/1inkulous/followers.hpp. */
const FLAG_SHAMAN = 1 << 2
const FLAG_CASTING = 1 << 6
const OFFSET_FLAGS = 7

const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2])
  return [v[0] / length, v[1] / length, v[2] / length]
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const angle = (a: Vec3, b: Vec3) =>
  Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))))
const negate = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]]

/** The point `distance` radians from unit `from` along unit tangent `toward`. */
const along = (from: Vec3, toward: Vec3, distance: number): Vec3 =>
  normalize([
    from[0] * Math.cos(distance) + toward[0] * Math.sin(distance),
    from[1] * Math.cos(distance) + toward[1] * Math.sin(distance),
    from[2] * Math.cos(distance) + toward[2] * Math.sin(distance),
  ])

/** A tangent frame at `home`: two unit directions along the ground. */
function frameAt(home: Vec3): { east: Vec3; north: Vec3 } {
  const helper: Vec3 = Math.abs(home[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const east = normalize([
    helper[0] - home[0] * dot(helper, home),
    helper[1] - home[1] * dot(helper, home),
    helper[2] - home[2] * dot(helper, home),
  ])
  const north = normalize([
    home[1] * east[2] - home[2] * east[1],
    home[2] * east[0] - home[0] * east[2],
    home[0] * east[1] - home[1] * east[0],
  ])
  return { east, north }
}

const MOAT = 0.18

/** Rings `home` with water MOAT radians out, using the core's own sculpt. */
function digMoat(sim: Simulation, home: Vec3, east: Vec3, north: Vec3): void {
  for (let k = 0; k < 64; k += 1) {
    const theta = (k / 64) * Math.PI * 2
    const tangent = normalize([
      east[0] * Math.cos(theta) + north[0] * Math.sin(theta),
      east[1] * Math.cos(theta) + north[1] * Math.sin(theta),
      east[2] * Math.cos(theta) + north[2] * Math.sin(theta),
    ])
    sim.sculptTerrain(along(home, tangent, MOAT), 0.07, -1)
  }
}

const positionOf = (sim: Simulation, id: number): Vec3 => {
  const data = sim.followerInstances()
  const base = id * sim.followerInstanceFloats
  return normalize([data[base], data[base + 1], data[base + 2]])
}
const flagsOf = (sim: Simulation, id: number) =>
  sim.followerInstances()[id * sim.followerInstanceFloats + OFFSET_FLAGS]
const walking = (sim: Simulation, id: number) => (flagsOf(sim, id) & 2) !== 0
const shamanAtIn = (sim: Simulation, tribe = PLAYER_TRIBE): Vec3 =>
  positionOf(sim, sim.shamanId(tribe))
const castingFlag = (sim: Simulation, tribe = PLAYER_TRIBE) =>
  (flagsOf(sim, sim.shamanId(tribe)) & FLAG_CASTING) !== 0

/** Ticks until `tribe`'s cast ends. How it ended, and how long that took. */
function waitCast(sim: Simulation, tribe = PLAYER_TRIBE, maxSeconds = 5) {
  const before = sim.lastSpellEnd(tribe).count
  let steps = 0
  while (sim.lastSpellEnd(tribe).count === before && steps < maxSeconds * 20) {
    sim.tick(50)
    steps += 1
  }
  return { ...sim.lastSpellEnd(tribe), ended: sim.lastSpellEnd(tribe).count === before + 1, seconds: steps * 0.05 }
}

const seconds = (sim: Simulation, s: number) => {
  for (let i = 0; i < Math.round(s * 20); i += 1) sim.tick(50)
}

/** The route the core would take, as unit directions, or null. */
function routeOf(sim: Simulation, from: Vec3, to: Vec3): Vec3[] | null {
  const count = sim.module._core_nav_route(...from, ...to, 1)
  if (count < 0) return null
  const base = sim.module._core_route_points() >> 2
  const heap = sim.module.HEAPF32
  return [from, ...Array.from({ length: count }, (_, i): Vec3 => [heap[base + i * 3], heap[base + i * 3 + 1], heap[base + i * 3 + 2]])]
}

/** Every point of a polyline of directions, sampled finely, over dry ground. */
const staysDry = (sim: Simulation, points: Vec3[]) => {
  for (let i = 0; i + 1 < points.length; i += 1) {
    for (let k = 0; k <= 40; k += 1) {
      const a = points[i]
      const b = points[i + 1]
      const t = k / 40
      const p = normalize([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
      if (!(sim.terrainHeightAt(p) > 0)) return false
    }
  }
  return true
}

/** Ids of the nav nodes within `radius` radians of `centre`. */
const nodesWithin = (centre: Vec3, radius: number) => {
  const ids: number[] = []
  for (let node = 0; node < graph.nodeCount; node += 1) {
    const d: Vec3 = [graph.directions[node * 3], graph.directions[node * 3 + 1], graph.directions[node * 3 + 2]]
    if (angle(d, centre) < radius) ids.push(node)
  }
  return ids
}

/** Closest a polyline of directions comes to `centre`, sampled finely along each leg. */
function closestApproach(points: Vec3[], centre: Vec3): number {
  let best = Infinity
  for (let i = 0; i + 1 < points.length; i += 1) {
    for (let k = 0; k <= 40; k += 1) {
      const t = k / 40
      const a = points[i]
      const b = points[i + 1]
      const p = normalize([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
      best = Math.min(best, angle(p, centre))
    }
  }
  return best
}

// --- on the core alone -------------------------------------------------------

const RADIUS = 1
const MAX_HEIGHT = 0.06
const LAND = MAX_HEIGHT / 3
// The topology only: welded vertex ids and their links. Nothing here draws.
const graph = buildNavGraph(createPlanetMesh({ resolution: 24, radius: RADIUS }))
const home: Vec3 = [0, 0, 1]
const { east, north } = frameAt(home)
const west = negate(east)
const south = negate(north)

/** A core on level land with the player's shaman at `home` and mana in hand. */
async function freshCore(): Promise<Simulation> {
  const core = await createSimulation()
  core.uploadNavGraph(graph, new Float32Array(graph.nodeCount).fill(LAND), {
    planetRadius: RADIUS,
    maxSlope: MAX_WALKABLE_SLOPE,
    maxHeight: MAX_HEIGHT,
  })
  core.spawnShaman(home, PLAYER_TRIBE)
  core.setMana(PLAYER_TRIBE, core.manaMax)
  return core
}

const sameHeights = (core: Simulation, snapshot: Float32Array) =>
  core.navHeights().every((h, i) => h === snapshot[i])

{
  const core = await createSimulation()
  core.uploadNavGraph(graph, new Float32Array(graph.nodeCount).fill(LAND), {
    planetRadius: RADIUS,
    maxSlope: MAX_WALKABLE_SLOPE,
    maxHeight: MAX_HEIGHT,
  })
  check('core: the seed is the terrain, with nothing dirty', core.navReady &&
    core.takeTerrainDirty() === null && core.terrainHeightAt([0.3, 0.2, 0.9]) === Math.fround(LAND))

  check('core: four spells, every one costing about what a bridge does',
    core.spellRules.length === 4 &&
      core.spellRules.every((rules) => rules.cost >= 150 && rules.cost <= 250 && rules.range > 0),
    core.spellRules.map((rules) => rules.cost).join(', '))
  check('core: each takes long enough to cancel, and rests a few seconds after',
    core.spellRules.every((rules) => rules.castSeconds >= 0.5 && rules.cooldownSeconds >= 2 &&
      rules.cooldownSeconds <= 8),
    core.spellRules.map((rules) => `${rules.castSeconds}s/${rules.cooldownSeconds}s`).join(', '))

  check('core: with no shaman nothing is cast',
    [Spell.landBridge, Spell.blast, Spell.flatten, Spell.swamp].every((spell) =>
      core.checkSpell(spell, PLAYER_TRIBE, along(home, east, 0.1)) === SpellResult.noShaman))
  check('core: and an unknown spell is named as one',
    core.module._core_spell_check(9, PLAYER_TRIBE, ...home, 0, 0, 0) === SpellResult.unknownSpell)

  const shamanId = core.spawnShaman(home, PLAYER_TRIBE)
  core.spawnFollower(along(home, east, 0.05), PLAYER_TRIBE)
  core.spawnFollower(along(home, north, 0.05), PLAYER_TRIBE)
  check('core: a shaman and two of her people', shamanId >= 0 && core.followerCount === 3)
  seconds(core, 1)
  check('core: a second of prayer is three mana', Math.abs(core.mana(PLAYER_TRIBE) - 3) < 1e-9,
    `${core.mana(PLAYER_TRIBE)}`)

  // --- Land Bridge on the shared path --------------------------------------

  const farShore = along(home, east, 0.28)
  check('core: before the moat, the far shore is a walk away',
    core.module._core_nav_route(...home, ...farShore, 0) > 0)
  digMoat(core, home, east, north)
  check('core: the moat is water and the far shore land',
    core.terrainHeightAt(along(home, east, MOAT)) <= 0 && core.terrainHeightAt(farShore) > 0 &&
      core.terrainHeightAt(home) > 0)
  check('core: and no route crosses it', core.module._core_nav_route(...home, ...farShore, 0) === -1)
  check('core: digging it left a dirty range for the mesh, had there been one',
    core.takeTerrainDirty() !== null && core.takeTerrainDirty() === null)

  const snapshot = Float32Array.from(core.navHeights())
  const untouched = () => core.takeTerrainDirty() === null && sameHeights(core, snapshot)
  const bridgeCost = core.spellRules[Spell.landBridge].cost

  core.setMana(PLAYER_TRIBE, 0)
  check('core: a bridge with no mana is refused at the start',
    core.castSpell(Spell.landBridge, PLAYER_TRIBE, farShore) === SpellResult.noMana &&
      core.spellCasting(PLAYER_TRIBE) === null && !castingFlag(core))
  check('core: and changes nothing', untouched() && core.mana(PLAYER_TRIBE) === 0)

  core.setMana(PLAYER_TRIBE, core.manaMax)
  check('core: so is one over dry ground, and one out of her reach',
    core.castSpell(Spell.landBridge, PLAYER_TRIBE, along(home, north, 0.08)) === SpellResult.dry &&
      core.castSpell(Spell.landBridge, PLAYER_TRIBE, along(home, east, 0.45)) === SpellResult.outOfRange)
  check('core: neither touches the ground or the mana',
    untouched() && core.mana(PLAYER_TRIBE) === core.manaMax)

  const homeHeight = core.terrainHeightAt(home)
  check('core: with mana in hand the bridge starts',
    core.castSpell(Spell.landBridge, PLAYER_TRIBE, farShore) === SpellResult.ok)
  const casting = core.spellCasting(PLAYER_TRIBE)
  check('core: she is casting it, flagged for the renderer, with the disc on the far end',
    casting !== null && casting.spell === Spell.landBridge && casting.progress === 0 &&
      castingFlag(core) && angle(casting.target, farShore) < 1e-6 &&
      Math.abs(casting.radius - core.spellRadius(Spell.landBridge)) < 1e-6)
  check('core: nothing is raised and nothing spent until it lands',
    untouched() && core.mana(PLAYER_TRIBE) === core.manaMax)
  seconds(core, 0.5)
  check('core: halfway through it is still only a promise',
    Math.abs((core.spellCasting(PLAYER_TRIBE)?.progress ?? 0) - 0.5) < 0.06 && untouched(),
    `${core.spellCasting(PLAYER_TRIBE)?.progress.toFixed(2)}`)
  const landed = waitCast(core)
  check('core: it lands when its time is up',
    landed.ended && landed.spell === Spell.landBridge && landed.result === SpellResult.ok &&
      Math.abs(landed.seconds + 0.5 - core.spellRules[Spell.landBridge].castSeconds) < 0.06,
    `after ${(landed.seconds + 0.5).toFixed(2)}s`)
  check('core: and is paid for then', core.mana(PLAYER_TRIBE) === core.manaMax - bridgeCost,
    `${core.mana(PLAYER_TRIBE)} left`)
  check('core: her casting flag is gone', !castingFlag(core) && core.spellCasting(PLAYER_TRIBE) === null)
  check('core: the core raised the land itself', core.terrainHeightAt(along(home, east, MOAT)) > 0,
    `${core.terrainHeightAt(along(home, east, MOAT)).toFixed(4)} at the old moat`)
  check('core: and left the higher ground at her feet alone', core.terrainHeightAt(home) === homeHeight)
  const changed: number[] = []
  core.navHeights().forEach((h, node) => {
    if (h !== snapshot[node]) changed.push(node)
  })
  const raised = core.takeTerrainDirty()
  check('core: the dirty range holds every node it raised', raised !== null && changed.length > 0 &&
    raised.first <= Math.min(...changed) && raised.last >= Math.max(...changed),
    raised ? `${changed.length} nodes in ${raised.first}..${raised.last}` : 'clean')
  const plan = core.landBridgePlan()
  check('core: the stamps it laid are still there to draw',
    plan !== null && plan.stamps.length >= 3 && angle(plan.stamps[0], home) < 1e-5,
    `${plan?.stamps.length} stamps`)

  const northShore = along(home, north, 0.28)
  check('core: straight after, a second bridge waits out the cooldown',
    core.spellCooldown(PLAYER_TRIBE, Spell.landBridge) > 0 &&
      core.castSpell(Spell.landBridge, PLAYER_TRIBE, northShore) === SpellResult.cooling &&
      core.spellCasting(PLAYER_TRIBE) === null,
    `${core.spellCooldown(PLAYER_TRIBE, Spell.landBridge).toFixed(2)}s to go`)
  seconds(core, core.spellRules[Spell.landBridge].cooldownSeconds)
  check('core: and goes ahead once it is over',
    core.spellCooldown(PLAYER_TRIBE, Spell.landBridge) === 0 &&
      core.checkSpell(Spell.landBridge, PLAYER_TRIBE, northShore) === SpellResult.ok)

  check('core: a route crosses where the moat was',
    core.module._core_nav_route(...shamanAtIn(core), ...farShore, 1) > 0)
  core.clearFollowerSelection()
  core.setFollowerSelected(core.shamanId(PLAYER_TRIBE), true)
  check('core: the next order takes her over it', core.orderFollowerMove(farShore) === 1)
  seconds(core, 30)
  check('core: and she gets there', angle(shamanAtIn(core), farShore) < 0.04,
    `${(angle(shamanAtIn(core), farShore) * RADIUS).toFixed(3)} from the far shore`)
}

// --- cancelling, and running short -----------------------------------------

{
  const core = await freshCore()
  const target = along(home, east, 0.15)
  const snapshot = Float32Array.from(core.navHeights())
  core.setMana(PLAYER_TRIBE, 400)

  check('core: a Blast starts', core.castSpell(Spell.blast, PLAYER_TRIBE, target) === SpellResult.ok &&
    core.spellCasting(PLAYER_TRIBE)?.spell === Spell.blast)
  seconds(core, 0.5)
  core.clearFollowerSelection()
  core.setFollowerSelected(core.shamanId(PLAYER_TRIBE), true)
  core.orderFollowerMove(along(home, north, 0.1))
  core.tick(50)
  const cut = core.lastSpellEnd(PLAYER_TRIBE)
  check('core: an order halfway through cancels it',
    cut.count === 1 && cut.spell === Spell.blast && cut.result === SpellResult.cancelled &&
      core.spellCasting(PLAYER_TRIBE) === null && !castingFlag(core))
  check('core: with nothing spent and nothing raised',
    core.mana(PLAYER_TRIBE) >= 400 && sameHeights(core, snapshot) &&
      core.spellCooldown(PLAYER_TRIBE, Spell.blast) === 0,
    `${core.mana(PLAYER_TRIBE).toFixed(2)} mana`)
  check('core: and she walks off as told', walking(core, core.shamanId(PLAYER_TRIBE)))

  seconds(core, 3)
  check('core: a cast stops her where she stands',
    core.castSpell(Spell.blast, PLAYER_TRIBE, target) === SpellResult.ok &&
      !walking(core, core.shamanId(PLAYER_TRIBE)))
  const second = along(home, west, 0.15)
  check('core: a second cast is a second order',
    core.castSpell(Spell.swamp, PLAYER_TRIBE, second) === SpellResult.ok &&
      core.lastSpellEnd(PLAYER_TRIBE).count === 2 &&
      core.lastSpellEnd(PLAYER_TRIBE).result === SpellResult.cancelled &&
      core.spellCasting(PLAYER_TRIBE)?.spell === Spell.swamp)
  check('core: but a refused one is not: the cast under way carries on',
    core.castSpell(Spell.flatten, PLAYER_TRIBE, along(home, east, 0.6)) === SpellResult.outOfRange &&
      core.spellCasting(PLAYER_TRIBE)?.spell === Spell.swamp)

  // Short mana when the time comes: refused then, and nothing written.
  core.setMana(PLAYER_TRIBE, 10)
  const poor = waitCast(core)
  check('core: a cast that runs out of mana before it lands is refused then',
    poor.ended && poor.spell === Spell.swamp && poor.result === SpellResult.noMana)
  check('core: and writes no height and starts no cooldown',
    sameHeights(core, snapshot) && core.spellCooldown(PLAYER_TRIBE, Spell.swamp) === 0 &&
      core.mana(PLAYER_TRIBE) >= 10 && !castingFlag(core))

  core.setMana(PLAYER_TRIBE, 0)
  check('core: one that cannot pay from the start never starts',
    core.castSpell(Spell.blast, PLAYER_TRIBE, target) === SpellResult.noMana &&
      core.spellCasting(PLAYER_TRIBE) === null && core.lastSpellEnd(PLAYER_TRIBE).count === 3)

  // Holding the key: the first lands, the rest bounce off the cooldown.
  core.setMana(PLAYER_TRIBE, core.manaMax)
  core.castSpell(Spell.blast, PLAYER_TRIBE, target)
  check('core: a Blast lands', waitCast(core).result === SpellResult.ok)
  let refused = 0
  for (let i = 0; i < 20; i += 1) {
    if (core.castSpell(Spell.blast, PLAYER_TRIBE, target) === SpellResult.cooling) refused += 1
    core.tick(50)
  }
  check('core: and a second straight after is refused for a few seconds',
    refused === 20 && core.mana(PLAYER_TRIBE) >= core.manaMax - core.spellRules[Spell.blast].cost,
    `${refused} of 20 refused, ${core.mana(PLAYER_TRIBE).toFixed(0)} mana`)
}

// --- out of range: another tribe's shaman, on the same path ----------------

{
  const core = await freshCore()
  const enemy = core.spawnShaman(along(home, north, 0.2), 1)
  core.setMana(1, core.manaMax)
  check('core: a second tribe has a shaman of its own', enemy >= 0 && core.shamanId(1) === enemy)

  // Her Blast lands between our shaman and the edge of our reach, so the
  // shove throws ours further away from it.
  const blastAt = along(home, west, 0.03)
  const reach = along(home, west, 0.27)
  check('core: the enemy casts through the very same call',
    core.castSpell(Spell.blast, 1, blastAt) === SpellResult.ok)
  seconds(core, 0.5)
  check('core: ours starts a Blast at the edge of her reach',
    core.castSpell(Spell.blast, PLAYER_TRIBE, reach) === SpellResult.ok)
  const theirs = waitCast(core, 1)
  core.tick(50)
  const ours = core.lastSpellEnd(PLAYER_TRIBE)
  check('core: theirs lands and throws ours out of range',
    theirs.result === SpellResult.ok && angle(shamanAtIn(core), reach) * RADIUS > core.spellRules[Spell.blast].range,
    `${(angle(shamanAtIn(core), reach) * RADIUS).toFixed(3)} from her target`)
  check('core: which ends ours with nothing spent',
    ours.count === 1 && ours.result === SpellResult.outOfRange && core.mana(PLAYER_TRIBE) === core.manaMax &&
      core.spellCasting(PLAYER_TRIBE) === null)
  check('core: and nothing written at her target', core.terrainHeightAt(reach) === Math.fround(LAND),
    `${core.terrainHeightAt(reach).toFixed(4)}`)
}

// --- Blast ---------------------------------------------------------------------

{
  const core = await freshCore()
  const target = along(home, east, 0.15)
  const brave = core.spawnFollower(target, PLAYER_TRIBE)
  const before = core.terrainHeightAt(target)
  const radius = core.spellRadius(Spell.blast)
  check('core: a brave stands where the Blast will land', angle(positionOf(core, brave), target) < 0.02)
  check('core: and the Blast starts', core.castSpell(Spell.blast, PLAYER_TRIBE, target) === SpellResult.ok)
  check('core: it lands', waitCast(core).result === SpellResult.ok)
  check('core: the ground there is a hill',
    core.terrainHeightAt(target) > before + 0.015 &&
      core.terrainHeightAt(along(target, north, radius * 1.5)) === Math.fround(LAND),
    `${before.toFixed(4)} -> ${core.terrainHeightAt(target).toFixed(4)}`)
  const thrown = positionOf(core, brave)
  check('core: the brave is thrown off it',
    angle(thrown, target) > radius && angle(thrown, target) < radius * 1.6,
    `${(angle(thrown, target) / radius).toFixed(2)} radii from the centre`)
  check('core: onto ground it can walk away from',
    core.terrainHeightAt(thrown) > 0 && core.module._core_nav_route(...thrown, ...home, 1) > 0)
  check('core: nobody is left on the stamp',
    Array.from({ length: core.followerCount }, (_, id) => id)
      .filter((id) => id !== core.shamanId(PLAYER_TRIBE))
      .every((id) => angle(positionOf(core, id), target) >= radius))
  seconds(core, core.spellRules[Spell.blast].cooldownSeconds)
  core.module._core_terrain_set_max_height(core.terrainHeightAt(target))
  core.sculptTerrain(target, radius, 1)
  check('core: with the hill at the ceiling and nobody on it, there is nothing to blast',
    core.checkSpell(Spell.blast, PLAYER_TRIBE, target) === SpellResult.nothing)
}

// --- Flatten -------------------------------------------------------------------

{
  const core = await freshCore()
  const pad = along(home, east, 0.15)
  core.sculptTerrain(along(pad, north, 0.03), 0.07, 0.012)
  core.sculptTerrain(along(pad, west, 0.04), 0.06, -0.008)
  core.takeTerrainDirty()
  check('core: rough ground will not take a hut',
    core.hutSite(pad, HutKind.dwelling, PLAYER_TRIBE).site === HutSite.uneven)
  check('core: Flatten on it starts', core.castSpell(Spell.flatten, PLAYER_TRIBE, pad) === SpellResult.ok)
  const level = core.terrainHeightAt(pad)
  check('core: and lands', waitCast(core).result === SpellResult.ok)
  check('core: pulling the disc to the height at its centre',
    Math.abs(core.terrainHeightAt(along(pad, north, 0.05)) - level) < 1e-6 &&
      Math.abs(core.terrainHeightAt(along(pad, west, 0.05)) - level) < 1e-6,
    `${level.toFixed(4)}`)
  const site = core.hutSite(pad, HutKind.dwelling, PLAYER_TRIBE).site
  check('core: a pad B will accept', site === HutSite.ok, `site ${site}`)
  // The click a player makes is rarely the exact centre.
  const offCentre = [0.02, -0.02].flatMap((d) => [along(pad, north, d), along(pad, east, d)])
  check('core: even a click a little off its centre',
    offCentre.every((at) => core.hutSite(at, HutKind.dwelling, PLAYER_TRIBE).site === HutSite.ok))
  check('core: and the hut goes up', core.placeHut(pad, east, PLAYER_TRIBE) >= 0)
  seconds(core, core.spellRules[Spell.flatten].cooldownSeconds)
  check('core: flattening it again would do nothing',
    core.checkSpell(Spell.flatten, PLAYER_TRIBE, pad) === SpellResult.nothing)
  const pond = along(home, west, 0.15)
  core.sculptTerrain(pond, 0.08, -1)
  check('core: nor will it level a pad under water',
    core.checkSpell(Spell.flatten, PLAYER_TRIBE, pond) === SpellResult.wet)
}

// --- Swamp ---------------------------------------------------------------------

{
  const core = await freshCore()
  const bog = along(home, east, 0.12)
  const radius = core.spellRadius(Spell.swamp)
  // Far enough out that the traveller below is still short of the bog when
  // it lands, a cast time after setting off.
  const top = along(bog, north, 0.32)
  const bottom = along(bog, south, 0.32)
  const direct = routeOf(core, top, bottom)
  check('core: on open land the way north to south runs straight through',
    direct !== null && closestApproach(direct, bog) < 0.02,
    direct ? `${direct.length} waypoints, ${closestApproach(direct, bog).toFixed(3)} from the centre` : 'no route')

  // One brave walking through the middle as it lands, one on the way that
  // has not reached it yet.
  const caught = core.spawnFollower(along(bog, west, 0.04), PLAYER_TRIBE)
  const traveller = core.spawnFollower(top, PLAYER_TRIBE)
  check('core: the Swamp starts', core.castSpell(Spell.swamp, PLAYER_TRIBE, bog) === SpellResult.ok)
  core.clearFollowerSelection()
  core.setFollowerSelected(caught, true)
  core.orderFollowerMove(along(bog, east, 0.3))
  core.clearFollowerSelection()
  core.setFollowerSelected(traveller, true)
  core.orderFollowerMove(bottom)
  core.clearFollowerSelection()
  check('core: ordering others is not ordering her', core.spellCasting(PLAYER_TRIBE)?.spell === Spell.swamp)
  const sunk = waitCast(core)
  check('core: it lands', sunk.result === SpellResult.ok)
  const drowned = nodesWithin(bog, radius * 0.9)
  check('core: every node of the disc is water, all but its very rim',
    drowned.length >= 9 && drowned.every((node) => core.navHeights()[node] === 0) && core.terrainHeightAt(bog) === 0,
    `${drowned.length} nodes`)
  const stranded = positionOf(core, caught)
  check('core: the brave caught in the middle is set down on dry ground',
    core.terrainHeightAt(stranded) > 0 && angle(stranded, bog) > radius * 0.8,
    `${(angle(stranded, bog) / radius).toFixed(2)} radii out`)
  check('core: and stops there', !walking(core, caught))

  const around = routeOf(core, top, bottom)
  check('core: the next route goes around, on dry ground all the way',
    around !== null && around.length > 2 && staysDry(core, around) &&
      closestApproach(around, bog) > radius * 0.5,
    around ? `${around.length - 1} legs, ${(closestApproach(around, bog) / radius).toFixed(2)} radii at its closest` : 'no route')
  const left = core.module._core_follower_route(traveller)
  const base = core.module._core_route_points() >> 2
  const heap = core.module.HEAPF32
  const rest: Vec3[] = [positionOf(core, traveller)]
  for (let i = 0; i < left; i += 1) rest.push([heap[base + i * 3], heap[base + i * 3 + 1], heap[base + i * 3 + 2]])
  check('core: the brave already on the way was routed round it too',
    walking(core, traveller) && left > 1 && staysDry(core, rest), `${left} waypoints left`)
  seconds(core, 25)
  check('core: and gets there dry', angle(positionOf(core, traveller), bottom) < 0.04 &&
    core.terrainHeightAt(positionOf(core, traveller)) > 0)
  seconds(core, core.spellRules[Spell.swamp].cooldownSeconds)
  const lake = along(home, west, 0.2)
  core.sculptTerrain(lake, 0.3, -1)
  check('core: a Swamp on open water would do nothing',
    core.checkSpell(Spell.swamp, PLAYER_TRIBE, lake) === SpellResult.nothing)
}

// --- through the game module ---------------------------------------------

const simulation = await createSimulation()
const planet = createPlanet()
const terrain = createTerrain(planet, simulation)
// A small village, so the moat below can ring it without drowning anyone.
const followers = createFollowers(terrain, simulation, { spawnCount: 8 })

let uploads = 0
const upload = simulation.uploadNavGraph
simulation.uploadNavGraph = (...args) => {
  uploads += 1
  upload(...args)
}

const shamanId = simulation.shamanId(PLAYER_TRIBE)
check('the player has a shaman', shamanId >= 0, `follower ${shamanId}`)
check('on top of the ordinary followers', simulation.followerCount === 9,
  `${simulation.followerCount} followers`)

const flagged = () => {
  const data = simulation.followerInstances()
  const stride = simulation.followerInstanceFloats
  const ids: number[] = []
  for (let id = 0; id < data.length / stride; id += 1) {
    if ((data[id * stride + OFFSET_FLAGS] & FLAG_SHAMAN) !== 0) ids.push(id)
  }
  return ids
}
check('she alone carries the shaman flag', flagged().length === 1 && flagged()[0] === shamanId)
check('a tribe gets one shaman, not two', simulation.spawnShaman(followers.homeDirection!, PLAYER_TRIBE) === -1)
check('the other tribes have none', [1, 2, 3].every((tribe) => simulation.shamanId(tribe) === -1))

const shamanAt = () => shamanAtIn(simulation)

check('mana starts empty', simulation.mana(PLAYER_TRIBE) === 0)
seconds(simulation, 1)
// Eight followers cycle the four tribes, so two are blue; she makes three.
check('a second of play pays each blue a second of mana',
  Math.abs(simulation.mana(PLAYER_TRIBE) - 3) < 1e-9 && simulation.manaIncome(PLAYER_TRIBE) === 3,
  `${simulation.mana(PLAYER_TRIBE)} mana, +${simulation.manaIncome(PLAYER_TRIBE)}/s`)
check('and the other tribes theirs', Math.abs(simulation.mana(1) - 2) < 1e-9, `${simulation.mana(1)}`)

const village = shamanAt()
const frame0 = frameAt(village)

/** Every mesh vertex carries its node's height in the core. */
const meshMatchesCore = () => {
  const heights = simulation.navHeights()
  const { mesh } = planet
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    if (mesh.heights[v] !== heights[mesh.weldIds[v]]) return false
  }
  return true
}

// Level land well past the moat, so there is a far shore all the way round.
for (let i = 0; i < 20; i += 1) terrain.flatten(village, 0.5, planet.maxHeight / 3, 1)
terrain.syncMesh()
const farShore = along(village, frame0.east, 0.28)
check('before the moat, the far shore is a walk away',
  simulation.module._core_nav_route(...village, ...farShore, 0) > 0)

digMoat(simulation, village, frame0.east, frame0.north)
terrain.syncMesh()
seconds(simulation, 0.5)

check('the far shore is land', !planet.isWaterAt(farShore) && !planet.isWaterAt(village))
check('the moat between is water', planet.isWaterAt(along(village, frame0.east, MOAT)))
check('and no route crosses it',
  simulation.module._core_nav_route(...shamanAt(), ...farShore, 0) === -1)
check('the mesh drew the moat the core dug', meshMatchesCore())

// --- aiming and casting through the game module --------------------------

let focused: Vec3 | null = null
const eye: Vec3 = [village[0] * 3, village[1] * 3, village[2] * 3]
const camera = {
  eye,
  viewMatrix: mat4LookAt(eye, [0, 0, 0], frame0.north),
  fovY: Math.PI / 4,
  focusOn(direction: Vec3) {
    focused = direction
  },
}
const view = { camera, aspect: CANVAS_ASPECT }
const ndcOf = (direction: Vec3) => worldToNdc(camera, planet.surfacePointAt(direction), CANVAS_ASPECT)!

const shaman = createShaman(planet, simulation)

function pointer(partial: Partial<PointerSnapshot> = {}): PointerSnapshot {
  return {
    position: { x: 0, y: 0 },
    ndc: ndcOf(farShore),
    delta: { x: 0, y: 0 },
    buttons: { left: false, middle: false, right: false },
    wheel: 0,
    dragging: false,
    dragRect: null,
    drags: [],
    clicks: [],
    ...partial,
  }
}

function click(button: 'left' | 'right', at: Vec3): PointerClick {
  return { button, position: { x: 0, y: 0 }, ndc: ndcOf(at), ctrlKey: false, shiftKey: false, held: new Set() }
}

function frame(pressed: string[] = [], partial: Partial<PointerSnapshot> = {}) {
  return shaman.update(16, { keys: new Set(), pressed: new Set(pressed), pointer: pointer(partial) } as InputSnapshot, view)
}

/** Ticks the core until the player's cast ends, a frame of the module at a time. */
function playOutCast() {
  const ended = waitCast(simulation)
  frame()
  return ended
}

frame(['KeyF'])
check('F selects the shaman alone and looks at her',
  simulation.selectedFollowerCount === 1 && focused !== null && angle(focused, village) < 1e-3)

check('aiming starts off', !frame().targeting && shaman.preview === null && shaman.aiming === null)
const row = spellLine(shaman)
check('the HUD lists every spell: key, name and cost',
  ['L Land Bridge 200', 'X Blast 200', 'V Flatten 150', 'M Swamp 250'].every((slot) => row.includes(slot)), row)
const taken = ['KeyB', 'KeyC', 'KeyF', 'KeyT', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Home',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'BracketLeft', 'BracketRight', 'Escape']
check('no spell key is a key something else already owns',
  Object.values(SPELL_KEYS).every((code) => !taken.includes(code)) &&
    new Set(Object.values(SPELL_KEYS)).size === 4 && SPELL_KEYS[Spell.landBridge] === 'KeyL')

frame(['KeyL'])
check('L aims a Land Bridge from her to the cursor',
  shaman.aiming === Spell.landBridge && shaman.preview !== null &&
    angle(shaman.preview.to, farShore) < 0.01 && shaman.preview.from !== null &&
    angle(shaman.preview.from, shamanAt()) < 1e-6)
check('which the core turns down for want of mana', shaman.preview?.result === SpellResult.noMana)
check('and the HUD says so on the spell row, in red',
  spellLine(shaman).includes('✗ L Land Bridge 200: not enough mana (200 needed)'), spellLine(shaman))

const heights = Float32Array.from(simulation.navHeights())
const revision = planet.mesh.revision
// Nothing for the mesh to copy, and the core's ground as it was.
const unchanged = () =>
  terrain.syncMesh() === 0 && planet.mesh.revision === revision &&
  simulation.navHeights().every((h, i) => h === heights[i])

const manaBefore = simulation.mana(PLAYER_TRIBE)
const poor = click('left', farShore)
const poorResult = frame([], { clicks: [poor] })
check('a cast with no mana is still a cast, not an order', poorResult.consumed.has(poor) && shaman.targeting)
check('but starts nothing, deforms nothing and spends nothing',
  shaman.casting === null && unchanged() && simulation.mana(PLAYER_TRIBE) === manaBefore,
  `${simulation.mana(PLAYER_TRIBE)} mana`)

simulation.setMana(PLAYER_TRIBE, simulation.manaMax)
frame()
check('with mana in hand the preview turns good', shaman.preview?.result === SpellResult.ok &&
  spellLine(shaman).includes('▸ L Land Bridge 200: click to raise the land'), spellLine(shaman))
const good = click('left', farShore)
const cast = frame([], { clicks: [good] })
check('a click starts the cast and stops aiming', cast.consumed.has(good) && !shaman.targeting &&
  shaman.casting?.spell === Spell.landBridge && castingFlag(simulation))
check('the HUD shows it under way',
  spellLine(shaman).startsWith('casting Land Bridge 0%') && shamanLine(shaman).includes('casting'),
  `${spellLine(shaman)} | ${shamanLine(shaman)}`)
check('and nothing has risen yet, nor been paid',
  unchanged() && simulation.mana(PLAYER_TRIBE) === simulation.manaMax)

const villageHeight = planet.heightAt(village)
const farHeight = planet.heightAt(farShore)
const bridged = playOutCast()
check('it lands', bridged.result === SpellResult.ok && shaman.notice === 'the land rises', `${shaman.notice}`)
check('the mana is spent',
  simulation.mana(PLAYER_TRIBE) === simulation.manaMax - simulation.spellRules[Spell.landBridge].cost,
  `${simulation.mana(PLAYER_TRIBE)} left`)
check('the core raised it before the mesh knew',
  !planet.isWaterAt(along(village, frame0.east, MOAT)) && planet.mesh.revision === revision,
  `${planet.heightAt(along(village, frame0.east, MOAT)).toFixed(4)} at the old moat`)
check('the frame-end sync draws it', terrain.syncMesh() > 0 && planet.mesh.revision > revision &&
  meshMatchesCore())
// The end stamps lift nothing, but the last stamp out in the water spills a
// little of its falloff up the far beach: a fraction of the crest, not a hill.
const crest = simulation.module._core_land_bridge_height()
check('the higher ground at its ends was left alone',
  planet.heightAt(village) === villageHeight &&
    Math.abs(planet.heightAt(farShore) - farHeight) < crest * 0.2,
  `${villageHeight.toFixed(4)} -> ${planet.heightAt(village).toFixed(4)} at her feet, ` +
    `${farHeight.toFixed(4)} -> ${planet.heightAt(farShore).toFixed(4)} on the far shore`)
check('the spell row shows it resting', /L Land Bridge 200 \(\ds\)/.test(spellLine(shaman)), spellLine(shaman))

// --- shore to shore, by dragging ---------------------------------------------

seconds(simulation, simulation.spellRules[Spell.landBridge].cooldownSeconds)
simulation.setMana(PLAYER_TRIBE, simulation.manaMax)
const nearSide = along(village, frame0.north, 0.1)
const farSide = along(village, frame0.north, 0.28)
// The first bridge joined the island to the far shore, so the north is a walk
// away now — round by the east.
const detour = simulation.module._core_nav_route(...nearSide, ...farSide, 0)
check('the north is still across water', planet.isWaterAt(along(village, frame0.north, MOAT)) && detour > 0,
  `${detour} nodes the long way round`)
frame(['KeyL'])
const drag = {
  startNdc: ndcOf(nearSide),
  currentNdc: ndcOf(farSide),
  button: 'left' as const,
  shiftKey: false,
  held: new Set<string>(),
}
frame([], { ndc: drag.currentNdc, dragRect: drag, buttons: { left: true, middle: false, right: false } })
check('a drag previews the bridge from where it began',
  shaman.preview !== null && shaman.preview.from !== null && angle(shaman.preview.from, nearSide) < 0.01 &&
    shaman.preview.result === SpellResult.ok)
const dragged = frame([], { ndc: drag.currentNdc, drags: [drag] })
check('releasing it starts the cast', dragged.targeting && !shaman.targeting &&
  shaman.casting?.spell === Spell.landBridge)
playOutCast()
const direct = simulation.module._core_nav_route(...nearSide, ...farSide, 0)
check('which raises the land across', !planet.isWaterAt(along(village, frame0.north, MOAT)))
terrain.syncMesh()
check('and the mesh follows again', meshMatchesCore())
check('and the walk north is straight over it', direct > 0 && direct * 2 < detour,
  `${detour} nodes -> ${direct}`)

// --- the other spells' keys, and cancelling ---------------------------------

simulation.setMana(PLAYER_TRIBE, simulation.manaMax)
const inland = along(village, frame0.east, -0.08)
frame(['KeyX'], { ndc: ndcOf(inland) })
check('X aims a Blast at the cursor, a disc with no near end',
  shaman.aiming === Spell.blast && shaman.preview?.spell === Spell.blast &&
    shaman.preview.from === null && angle(shaman.preview.to, inland) < 0.01 &&
    shaman.preview.result === SpellResult.ok)
check('and its ghost disc is the size it will raise',
  shaman.radiusOf(Spell.blast) === simulation.spellRadius(Spell.blast) && shaman.radiusOf(Spell.blast) > 0)
// West is the one side of the moat no bridge crossed.
const westMoat = along(village, negate(frame0.east), MOAT)
frame(['KeyV'], { ndc: ndcOf(westMoat) })
check('V switches to Flatten; on water the row says why',
  shaman.aiming === Spell.flatten && shaman.preview?.result === SpellResult.wet &&
    spellLine(shaman).includes('✗ V Flatten 150: that is under water'), spellLine(shaman))
frame(['KeyM'], { ndc: ndcOf(along(village, frame0.east, 0.6)) })
check('M switches to Swamp; out of her reach the row says so',
  shaman.aiming === Spell.swamp && shaman.preview?.result === SpellResult.outOfRange &&
    spellLine(shaman).includes('✗ M Swamp 250: too far from the shaman'), spellLine(shaman))
frame(['KeyM'])
check('pressing it again puts it away', shaman.aiming === null && shaman.preview === null)
frame(['KeyX'])
frame(['KeyB'])
check('and B, for a hut, puts a spell away too', shaman.aiming === null)

const ground = Float32Array.from(simulation.navHeights())
frame(['KeyX'], { ndc: ndcOf(inland) })
frame([], { ndc: ndcOf(inland), clicks: [click('left', inland)] })
check('a click starts the Blast', shaman.casting?.spell === Spell.blast)
seconds(simulation, 0.4)
// The player right-clicks somewhere with her selected: a move order.
simulation.clearFollowerSelection()
simulation.setFollowerSelected(simulation.shamanId(PLAYER_TRIBE), true)
simulation.orderFollowerMove(along(village, frame0.north, 0.05))
simulation.tick(50)
frame()
check('a move order cancels it, and the HUD says so',
  shaman.casting === null && shaman.notice === 'Blast cancelled' && !castingFlag(simulation),
  `${shaman.notice}`)
check('with the ground and the mana as they were',
  simulation.navHeights().every((h, i) => h === ground[i]) && simulation.mana(PLAYER_TRIBE) === simulation.manaMax)

// --- walking it ------------------------------------------------------------

seconds(simulation, 3)
const route = simulation.module._core_nav_route(...shamanAt(), ...farShore, 1)
check('a route crosses where the moat was', route > 0, `${route} legs`)
check('without the graph being rebuilt', uploads === 0)

simulation.clearFollowerSelection()
simulation.setFollowerSelected(simulation.shamanId(PLAYER_TRIBE), true)
const routed = simulation.orderFollowerMove(farShore)
check('the next order takes her over it', routed === 1)
seconds(simulation, 30)
check('and she gets there', angle(shamanAt(), farShore) < 0.04,
  `${(angle(shamanAt(), farShore) * planet.radius).toFixed(3)} from the far shore`)

if (failures.length > 0) {
  console.error(`\n${failures.length} shaman check(s) failed`)
  process.exit(1)
}
console.log('\nall shaman checks passed')
