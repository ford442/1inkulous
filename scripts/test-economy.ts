/**
 * The match economy, headless: trees and wood, what huts cost, sending people
 * back out, training a warrior, and a warrior's first kill.
 *
 * First on the core alone — the cube-sphere topology and a flat seed go in,
 * and everything after is a core call, with no planet module, mesh or
 * renderer. Then the same loop through the game modules, driven by synthetic
 * input: a right-click on a tree, T and a click for a training hut, a
 * right-click on a hut with nobody selected, and the HUD lines that report it.
 *
 * Run: npm run test:economy   (after npm run build:wasm)
 */
import { createPlanetMesh } from '../src/engine/mesh/cubeSphere.ts'
import { mat4LookAt, type Vec3 } from '../src/engine/math.ts'
import { screenRay, worldToNdc } from '../src/engine/picking.ts'
import { createFollowers } from '../src/game/followers.ts'
import { createHuts } from '../src/game/huts.ts'
import { buildNavGraph } from '../src/game/navGraph.ts'
import { createPlanet } from '../src/game/planet.ts'
import { createShaman } from '../src/game/shaman.ts'
import { createTerrain, MAX_WALKABLE_SLOPE } from '../src/game/terrain.ts'
import { createTrees, treeIdUnderRay } from '../src/game/trees.ts'
import type { InputSnapshot, PointerClick, PointerSnapshot } from '../src/input/input.ts'
import { HutKind, HutSite } from '../src/sim/hutSite.ts'
import { Role, roleOfFlags } from '../src/sim/role.ts'
import { createSimulation, type Simulation } from '../src/sim/simulation.ts'
import { followerLine, hutLine, shamanLine, treeLine } from '../src/ui/hud.ts'
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

/** One follower out of the instance buffer the renderer reads. */
type Body = { id: number; at: Vec3; tribe: number; flags: number; role: Role }

function bodies(sim: Simulation): Body[] {
  const data = sim.followerInstances()
  const stride = sim.followerInstanceFloats
  const out: Body[] = []
  for (let id = 0; id < data.length / stride; id += 1) {
    const base = id * stride
    out.push({
      id,
      at: normalize([data[base], data[base + 1], data[base + 2]]),
      tribe: data[base + 6],
      flags: data[base + 7],
      role: roleOfFlags(data[base + 7]),
    })
  }
  return out
}

function treeAt(sim: Simulation, id: number): Vec3 {
  const data = sim.treeInstances()
  const base = id * sim.treeInstanceFloats
  return normalize([data[base], data[base + 1], data[base + 2]])
}

function treePositions(sim: Simulation): Vec3[] {
  return Array.from({ length: sim.treeCount }, (_, id) => treeAt(sim, id))
}

function selectOnly(sim: Simulation, ids: number[]): void {
  sim.clearFollowerSelection()
  for (const id of ids) sim.setFollowerSelected(id, true)
}

function tickUntil(sim: Simulation, seconds: number, done: () => boolean): number {
  let steps = 0
  while (steps < seconds * 20 && !done()) {
    sim.tick(50)
    steps += 1
  }
  return steps
}

const tickSeconds = (sim: Simulation, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 20); i += 1) sim.tick(50)
}

// --- on the core alone -------------------------------------------------------

{
  const RADIUS = 1
  const MAX_HEIGHT = 0.06
  const LAND = MAX_HEIGHT / 3
  const core = await createSimulation()
  const graph = buildNavGraph(createPlanetMesh({ resolution: 24, radius: RADIUS }))
  core.uploadNavGraph(graph, new Float32Array(graph.nodeCount).fill(LAND), {
    planetRadius: RADIUS,
    maxSlope: MAX_WALKABLE_SLOPE,
    maxHeight: MAX_HEIGHT,
  })
  const home: Vec3 = [0, 0, 1]
  const { east, north } = frameAt(home)
  const west: Vec3 = [-east[0], -east[1], -east[2]]
  const south: Vec3 = [-north[0], -north[1], -north[2]]

  // --- trees -----------------------------------------------------------------

  check('core: no trees and no wood before the match starts',
    core.treeCount === 0 && [0, 1, 2, 3].every((tribe) => core.wood(tribe) === 0))
  const planted = core.spawnTrees(60, 7)
  const forest = treePositions(core)
  check('core: trees are scattered from the height field', planted === 60 && core.treeCount === 60 &&
    core.treeInstanceFloats === 8 && core.treeInstances().length === 60 * 8, `${planted} planted`)
  check('core: every one on dry land', forest.every((at) => core.terrainHeightAt(at) > 0))
  check('core: the same seed plants the same forest',
    core.spawnTrees(60, 7) === 60 && treePositions(core).every((at, i) => angle(at, forest[i]) < 1e-7))
  check('core: another seed another', core.spawnTrees(60, 8) === 60 &&
    treePositions(core).some((at, i) => angle(at, forest[i]) > 1e-3))
  core.spawnTrees(60, 7)

  // The tree nearest home, and a brave a short walk off.
  let tree = 0
  for (let id = 1; id < core.treeCount; id += 1) {
    if (angle(treeAt(core, id), home) < angle(treeAt(core, tree), home)) tree = id
  }
  const trunk = treeAt(core, tree)
  const { east: treeEast } = frameAt(trunk)
  const chopper = core.spawnFollower(along(trunk, treeEast, 0.12), 0)
  const warrior = core.spawnFollower(along(trunk, treeEast, 0.12), 0)
  check('core: everyone is born a brave', core.followerRole(chopper) === Role.brave &&
    core.followerHealth(chopper) === core.followerMaxHealth && core.followerMaxHealth > 0)
  check('core: a warrior is made in a training hut, or by hand for a test',
    core.setFollowerRole(warrior, Role.warrior) && core.followerRole(warrior) === Role.warrior)
  selectOnly(core, [warrior])
  check('core: a warrior does not chop', core.orderChop(tree) === 0 && core.followerTree(warrior) === -1)
  selectOnly(core, [chopper, warrior])
  check('core: a brave sent to a tree goes, and the warrior with it stays put',
    core.orderChop(tree) === 1 && core.followerTree(chopper) === tree && core.followerTree(warrior) === -1)
  check('core: a bad tree sends nobody', core.orderChop(core.treeCount) === 0 && core.orderChop(-1) === 0)

  let chopping = 0
  const steps = tickUntil(core, 30, () => {
    const progress = core.treeProgress(tree)
    if (progress > 0 && progress < 1 && core.treeCount === 60) chopping += 1
    return core.treeCount < 60
  })
  check('core: the brave walks up and fells it', core.treeCount === 59,
    `${(steps / 20).toFixed(1)}s, ${core.treeCount} trees left`)
  check('core: over a few seconds of fixed steps, not at once',
    chopping >= core.chopSeconds * 20 - 2 && chopping <= core.chopSeconds * 20 + 1,
    `${chopping} steps chopping, ${core.chopSeconds}s a tree`)
  check('core: the tree leaves the set', treePositions(core).every((at) => angle(at, trunk) > 1e-6))
  check('core: and its wood goes to the tribe', core.wood(0) === core.woodPerTree && core.wood(1) === 0,
    `${core.wood(0)} wood`)
  check('core: the order is over', core.followerTree(chopper) === -1 && !core.module._core_follower_route(chopper))

  // Three on one tree, and a fourth turned away.
  {
    let next = 0
    for (let id = 1; id < core.treeCount; id += 1) {
      if (angle(treeAt(core, id), home) < angle(treeAt(core, next), home)) next = id
    }
    const at = treeAt(core, next)
    const crew = [0.1, 0.11, 0.12, 0.13].map((d) => core.spawnFollower(along(at, frameAt(at).north, d), 0))
    selectOnly(core, crew)
    check('core: a chop order sends at most three to one tree', core.orderChop(next) === 3)
    const woodBefore = core.wood(0)
    const before = core.treeCount
    let crewChopping = 0
    tickUntil(core, 30, () => {
      if (core.treeProgress(next) > 0) crewChopping += 1
      return core.treeCount < before
    })
    check('core: and three fell it faster than one', core.treeCount === before - 1 &&
      crewChopping < core.chopSeconds * 20 * 0.5 && core.wood(0) === woodBefore + core.woodPerTree,
      `${crewChopping} steps`)
    m_clear(core)
  }

  // --- what huts cost ----------------------------------------------------------

  core.setWood(0, core.woodPerTree)
  const dwelling = along(home, south, 0.25)
  const second = along(home, west, 0.25)
  const training = along(home, north, 0.25)
  check('core: a tribe\'s first hut is free', core.hutCost(HutKind.dwelling, 0) === 0 &&
    core.hutSite(dwelling, HutKind.dwelling, 0).site === HutSite.ok)
  const first = core.placeHut(dwelling, east, 0)
  check('core: so the opening village can build one with no wood at all',
    first === 0 && core.wood(0) === core.woodPerTree && core.hutKind(first) === HutKind.dwelling)
  const price = core.hutCost(HutKind.dwelling, 0)
  check('core: the next one costs wood', price > core.woodPerTree && core.hutCost(HutKind.dwelling, 1) === 0,
    `${price} wood`)
  check('core: which the site check names when the tribe is short',
    core.hutSite(second, HutKind.dwelling, 0).site === HutSite.noWood &&
      core.hutSite(second).site === HutSite.ok)
  check('core: and placing it is refused, with nothing spent',
    core.placeHut(second, east, 0) === -1 && core.hutCount === 1 && core.wood(0) === core.woodPerTree)
  core.setWood(0, price + 2)
  check('core: with the wood in hand it goes up, and is paid for',
    core.placeHut(second, east, 0) === 1 && core.wood(0) === 2, `${core.wood(0)} left`)
  check('core: an unclaimed hut costs nobody anything', core.hutCost(HutKind.dwelling, -1) === 0)

  const trainingPrice = core.hutCost(HutKind.training, 0)
  check('core: a training hut is never free', trainingPrice > 0 &&
    core.hutSite(training, HutKind.training, 0).site === HutSite.noWood &&
    core.placeHut(training, east, 0, HutKind.training) === -1 && core.wood(0) === 2)
  core.setWood(0, trainingPrice)
  const school = core.placeHut(training, east, 0, HutKind.training)
  check('core: it goes up on the same site rules, and is paid for',
    school === 2 && core.hutKind(school) === HutKind.training && core.wood(0) === 0 &&
      core.hutSite(training).site === HutSite.occupied)
  check('core: and the buffer says which kind each is', (() => {
    const data = core.hutInstances()
    const stride = core.hutInstanceFloats
    return stride === 9 && data[8] === HutKind.dwelling && data[2 * stride + 8] === HutKind.training
  })())

  // --- going in and coming back out ----------------------------------------

  const settlers = [0.08, 0.09, 0.1].map((d) => core.spawnFollower(along(dwelling, east, d), 0))
  core.setFollowerRole(settlers[2], Role.warrior)
  selectOnly(core, settlers)
  check('core: only braves go into a hut', core.orderEnterHut(first) === 2)
  core.setFollowerRole(settlers[2], Role.brave)
  selectOnly(core, [settlers[2]])
  core.orderEnterHut(first)
  tickUntil(core, 20, () => core.hutOccupants(first) === 3)
  check('core: three inside', core.hutOccupants(first) === 3)
  const outside = core.followerCount
  const ejected = core.ejectHut(first)
  const out = bodies(core).slice(outside)
  check('core: eject sends them back out of the door', ejected === 3 &&
    core.hutOccupants(first) === 0 && core.followerCount === outside + 3, `${ejected} out`)
  check('core: as braves of the hut\'s tribe, rejoining the follower set',
    out.length === 3 && out.every((body) => body.role === Role.brave && body.tribe === 0))
  {
    const heading: Vec3 = [core.hutInstances()[3], core.hutInstances()[4], core.hutInstances()[5]]
    const door = along(dwelling, heading, 0.08)
    const back = along(dwelling, [-heading[0], -heading[1], -heading[2]], 0.08)
    check('core: standing at the door, clear of the pad', out.every((body) =>
      angle(body.at, door) < angle(body.at, back) && angle(body.at, dwelling) > 0.06),
      out.map((body) => angle(body.at, dwelling).toFixed(3)).join(', '))
  }
  check('core: an empty hut ejects nobody', core.ejectHut(first) === 0 && core.ejectHut(99) === 0)
  check('core: an ejected brave can go straight back in', (() => {
    selectOnly(core, [out[0].id])
    return core.orderEnterHut(first) === 1
  })())

  // --- training a warrior ------------------------------------------------------

  m_clear(core)
  core.setWood(0, 0)
  const recruit = core.spawnFollower(along(training, east, 0.1), 0)
  const spare = core.spawnFollower(along(training, east, 0.11), 0)
  selectOnly(core, [recruit])
  check('core: a training hut takes nobody while the tribe is short of wood',
    core.orderEnterHut(school) === 0 && core.followerTree(recruit) === -1)
  core.setWood(0, core.warriorCost + 1)
  check('core: with the wood, one brave goes in', core.orderEnterHut(school) === 1)
  selectOnly(core, [spare])
  check('core: and it has room for one only', core.trainingCapacity === 1 && core.orderEnterHut(school) === 0)
  tickUntil(core, 20, () => core.hutOccupants(school) === 1)
  check('core: the brave is consumed and the wood spent at the door',
    core.hutOccupants(school) === 1 && core.wood(0) === 1 && core.followerCount === 1)
  tickSeconds(core, core.trainSeconds - 1)
  check('core: training takes time', core.hutOccupants(school) === 1 &&
    bodies(core).every((body) => body.role === Role.brave))
  tickSeconds(core, 1.5)
  const trained = bodies(core).filter((body) => body.role === Role.warrior)
  check('core: then a warrior steps out', core.hutOccupants(school) === 0 && trained.length === 1 &&
    core.followerCount === 2 && trained[0].tribe === 0, `${trained.length} warriors`)
  check('core: the role rides in the flags the renderer reads, beside the brave\'s',
    trained.length === 1 && (trained[0].flags >> 3) === Role.warrior &&
      bodies(core).some((body) => (body.flags >> 3) === Role.brave))
  check('core: and the warrior will not go back in', (() => {
    selectOnly(core, [trained[0].id])
    return core.orderEnterHut(school) === 0 && core.orderEnterHut(first) === 0
  })())

  // A trainee let out early is a brave again, and the kit goes back on the pile.
  {
    core.setWood(0, core.warriorCost)
    selectOnly(core, [bodies(core).find((body) => body.role === Role.brave)!.id])
    core.orderEnterHut(school)
    tickUntil(core, 20, () => core.hutOccupants(school) === 1)
    const spent = core.wood(0)
    const ejectedTrainee = core.ejectHut(school)
    check('core: ejecting a trainee lets out a brave and refunds the wood',
      ejectedTrainee === 1 && spent === 0 && core.wood(0) === core.warriorCost &&
        bodies(core).filter((body) => body.role === Role.warrior).length === 1)
  }

  // --- a fight -------------------------------------------------------------

  m_clear(core)
  const field = along(home, east, 0.6)
  const red = core.spawnFollower(field, 1)
  const blue = core.spawnFollower(field, 0)
  tickSeconds(core, 2)
  check('core: two braves of different tribes side by side do not fight',
    core.followerHealth(red) === core.followerMaxHealth && core.followerHealth(blue) === core.followerMaxHealth)

  const fighter = core.spawnFollower(field, 0)
  core.setFollowerRole(fighter, Role.warrior)
  tickSeconds(core, 1)
  const hit = core.followerMaxHealth - core.followerHealth(red)
  check('core: a warrior next to an enemy wears its health down on the fixed step',
    hit > 0 && Math.abs(hit - 20) < 1e-6, `${hit.toFixed(2)} in a second`)
  check('core: and leaves its own tribe alone', core.followerHealth(blue) === core.followerMaxHealth &&
    core.followerHealth(fighter) === core.followerMaxHealth)
  const reds = () => bodies(core).filter((body) => body.tribe === 1).length
  const killSteps = tickUntil(core, 10, () => reds() === 0)
  check('core: until the enemy is gone from the set', reds() === 0 && core.followerCount === 2,
    `${(1 + killSteps / 20).toFixed(2)}s to kill, ${core.followerCount} left`)
  check('core: the warrior is unhurt', core.followerHealth(bodies(core).find((b) => b.role === Role.warrior)!.id) ===
    core.followerMaxHealth)

  // Out of reach is out of the fight.
  const far = core.spawnFollower(along(field, north, 0.2), 2)
  tickSeconds(core, 1)
  check('core: an enemy out of reach is not touched', core.followerHealth(far) === core.followerMaxHealth)

  check('core: a follower set to no health is gone next step', (() => {
    const before = core.followerCount
    core.setFollowerHealth(far, 0)
    core.tick(50)
    return core.followerCount === before - 1
  })())
}

// --- through the game modules, on the real planet ---------------------------

{
  const sim = await createSimulation()
  const planet = createPlanet()
  const terrain = createTerrain(planet, sim)
  const followers = createFollowers(terrain, sim, { spawnCount: 6, tribe: 0 })
  const shaman = createShaman(planet, sim)
  const huts = createHuts(planet, sim)
  const trees = createTrees(planet, sim)
  const home = followers.homeDirection!

  check('a match starts with a forest, all of it on dry land', trees.count > 50 &&
    treePositions(sim).every((at) => !planet.isWaterAt(at) && sim.terrainHeightAt(at) > 0),
    `${trees.count} trees`)
  check('and with no wood, so its first hut is free', sim.wood(0) === 0 &&
    huts.dwellingCost === 0 && hutLine(huts).includes('B hut (free)'), hutLine(huts))
  check('the HUD shows wood next to mana', shamanLine(shaman).includes('· wood 0 ·'), shamanLine(shaman))
  check('and the trees on their own line', treeLine(trees).startsWith(`${trees.count} trees`))

  // The tree nearest a brave who can walk to it.
  const brave = bodies(sim).find((body) => sim.shamanId(0) !== body.id)!
  let target = -1
  for (let id = 0; id < sim.treeCount; id += 1) {
    const at = treeAt(sim, id)
    if (sim.module._core_nav_route(...brave.at, ...at, 0) < 0) continue
    if (target < 0 || angle(at, brave.at) < angle(treeAt(sim, target), brave.at)) target = id
  }
  const trunk = treeAt(sim, target)
  const { north } = frameAt(trunk)
  const eye: Vec3 = [trunk[0] * 1.6, trunk[1] * 1.6, trunk[2] * 1.6]
  const camera = { eye, viewMatrix: mat4LookAt(eye, [0, 0, 0], north), fovY: Math.PI / 4 }
  const view = { camera, aspect: CANVAS_ASPECT }
  const point = (direction: Vec3, lift = 0): Vec3 => {
    const ground = planet.surfacePointAt(direction)
    return [ground[0] + direction[0] * lift, ground[1] + direction[1] * lift, ground[2] + direction[2] * lift]
  }
  const ndcOf = (at: Vec3) => worldToNdc(camera, at, CANVAS_ASPECT)!
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
  const click = (button: 'left' | 'right', at: Vec3): PointerClick =>
    ({ button, position: { x: 0, y: 0 }, ndc: ndcOf(at), ctrlKey: false, shiftKey: false, held: new Set() })
  const input = (clicks: PointerClick[] = [], pressed: string[] = [], ndc = { x: 0, y: 0 }): InputSnapshot =>
    ({ keys: new Set(), pressed: new Set(pressed), pointer: pointer({ clicks, ndc }) }) as InputSnapshot

  check('a ray at a tree picks it', treeIdUnderRay(sim.treeInstances(), sim.treeInstanceFloats,
    screenRayAt(camera, ndcOf(point(trunk, trees.height * 0.5))), eye, trees.radius, trees.height) === target)

  const onTree = click('right', point(trunk, trees.height * 0.5))
  sim.clearFollowerSelection()
  check('with nobody selected a right-click on a tree is not an order',
    !trees.update(16, input([onTree]), view).consumed.has(onTree))
  selectOnly(sim, [brave.id])
  const order = trees.update(16, input([onTree]), view)
  check('with a brave selected it is a chop order for that tree', order.consumed.has(onTree) &&
    sim.followerTree(brave.id) === target && trees.notice === '1 chopping', trees.notice ?? '')
  check('and the HUD says so', treeLine(trees).includes('1 chopping'), treeLine(trees))
  const standing = sim.treeCount
  tickUntil(sim, 60, () => sim.treeCount < standing)
  check('the brave walks there and fells it', sim.treeCount === standing - 1 &&
    treePositions(sim).every((at) => angle(at, trunk) > 1e-6))
  check('and the wood shows on the HUD', sim.wood(0) === sim.woodPerTree &&
    shamanLine(shaman).includes(`· wood ${sim.woodPerTree} ·`), shamanLine(shaman))

  // A level pad at home, the free hut on it, and people inside.
  for (let i = 0; i < 40; i += 1) terrain.flatten(home, 0.45, planet.maxHeight / 3, 1)
  terrain.syncMesh()
  const { east: homeEast, north: homeNorth } = frameAt(home)
  const homeEye: Vec3 = [home[0] * 4, home[1] * 4, home[2] * 4]
  const homeView = {
    camera: { eye: homeEye, viewMatrix: mat4LookAt(homeEye, [0, 0, 0], homeNorth), fovY: Math.PI / 4 },
    aspect: CANVAS_ASPECT,
  }
  const homeNdc = (at: Vec3) => worldToNdc(homeView.camera, at, CANVAS_ASPECT)!
  const homeClick = (button: 'left' | 'right', at: Vec3): PointerClick =>
    ({ button, position: { x: 0, y: 0 }, ndc: homeNdc(at), ctrlKey: false, shiftKey: false, held: new Set() })
  const hutFrame = (clicks: PointerClick[] = [], pressed: string[] = [], at: Vec3 = home) =>
    huts.update(16, input(clicks, pressed, homeNdc(point(at))), homeView)

  hutFrame([], ['KeyB'])
  hutFrame([homeClick('left', point(home))])
  const dwelling = 0
  check('B and a click put the free hut up', sim.hutCount === 1 && sim.hutKind(dwelling) === 0 &&
    sim.wood(0) === sim.woodPerTree, `${sim.hutCount} huts, ${sim.wood(0)} wood`)
  check('after which the next one is priced on the HUD', hutLine(huts).includes(`B hut (${sim.hutCost(0, 0)} wood)`),
    hutLine(huts))

  const site = along(home, homeEast, 0.3)
  hutFrame([], ['KeyT'], site)
  check('T previews a training hut the tribe cannot yet pay for',
    huts.ghost?.kind === 1 && huts.ghost.site === HutSite.noWood &&
      hutLine(huts).includes('not enough wood'), hutLine(huts))
  hutFrame([homeClick('left', point(site))], [], site)
  check('a click there builds nothing', sim.hutCount === 1 && huts.building)
  sim.setWood(0, sim.hutCost(1, 0))
  hutFrame([homeClick('left', point(site))], [], site)
  check('with the wood it goes up, and is paid for', sim.hutCount === 2 && sim.hutKind(1) === 1 &&
    sim.wood(0) === 0 && !huts.building)

  const hutPoint = (id: number): Vec3 => {
    const data = sim.hutInstances()
    const base = id * sim.hutInstanceFloats
    const at: Vec3 = [data[base], data[base + 1], data[base + 2]]
    const up = normalize(at)
    return [at[0] + up[0] * huts.radius * 0.5, at[1] + up[1] * huts.radius * 0.5, at[2] + up[2] * huts.radius * 0.5]
  }
  const settlers = bodies(sim).filter((body) => body.role === Role.brave && body.id !== sim.shamanId(0))
    .slice(0, 3).map((body) => body.id)
  selectOnly(sim, settlers)
  hutFrame([homeClick('right', hutPoint(dwelling))])
  check('a right-click sends the selected braves in', huts.notice === '3 going in', huts.notice ?? '')
  tickUntil(sim, 30, () => sim.hutOccupants(dwelling) === 3)
  check('and they are housed', sim.hutOccupants(dwelling) === 3)
  sim.clearFollowerSelection()
  const before = sim.followerCount
  hutFrame([homeClick('right', hutPoint(dwelling))])
  check('a right-click on it with nobody selected sends them back out', sim.hutOccupants(dwelling) === 0 &&
    sim.followerCount === before + 3 && huts.notice === '3 came out', huts.notice ?? '')

  selectOnly(sim, [bodies(sim).find((body) => body.role === Role.brave && body.id !== sim.shamanId(0))!.id])
  hutFrame([homeClick('right', hutPoint(1))])
  check('the training hut turns a brave away while there is no wood to train with',
    huts.notice?.includes(`needs ${sim.warriorCost} wood`) === true, huts.notice ?? '')
  sim.setWood(0, sim.warriorCost)
  hutFrame([homeClick('right', hutPoint(1))])
  check('and takes one when there is', huts.notice === '1 going in', huts.notice ?? '')
  tickUntil(sim, 60, () => followers.warriorCount > 0)
  check('who comes out a warrior, counted on the HUD', followers.warriorCount === 1 &&
    followerLine(followers).includes('(1 warrior)'), followerLine(followers))
}

/** A camera ray through an NDC point. */
function screenRayAt(camera: { eye: Vec3; viewMatrix: Float32Array; fovY: number }, ndc: { x: number; y: number }) {
  return screenRay(camera, ndc.x, ndc.y, CANVAS_ASPECT)
}

/** Clears the followers, keeping the world. */
function m_clear(sim: Simulation): void {
  sim.module._core_followers_clear()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} economy check(s) failed`)
  process.exit(1)
}
console.log('\nall economy checks passed')
