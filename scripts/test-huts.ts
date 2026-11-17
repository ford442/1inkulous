/**
 * Huts, headless. Hut picking; build mode and
 * enter orders through createHuts against a fake core; and then the real
 * WebAssembly core on the real planet and nav graph: B places a hut through
 * the UI, routes and walkers go round its footprint, anyone standing on the
 * pad is moved off, and the hut takes people in and breeds them out of the
 * door.
 *
 * The flatten brush that makes a pad is the core's, and is covered by
 * test:terrain.
 *
 * Run: npm run test:huts   (after npm run build:wasm)
 */
import { mat4LookAt, type Vec3 } from '../src/engine/math.ts'
import { screenRay, worldToNdc, type RayCamera } from '../src/engine/picking.ts'
import { createFollowers } from '../src/game/followers.ts'
import { createHuts, doorTowards, hutIdUnderRay, siteProblem } from '../src/game/huts.ts'
import { createPlanet } from '../src/game/planet.ts'
import { createTerrain } from '../src/game/terrain.ts'
import { HutKind, HutSite } from '../src/sim/hutSite.ts'
import { hutLine } from '../src/ui/hud.ts'
import type { InputSnapshot, PointerClick, PointerSnapshot } from '../src/input/input.ts'
import { createSimulation, type HutSiteReport, type Simulation } from '../src/sim/simulation.ts'
import { CANVAS_ASPECT } from '../src/viewport.ts'

const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`ok  ${name}${detail ? `  — ${detail}` : ""}`)
    return
  }
  const message = detail ? `${name} — ${detail}` : name
  failures.push(message)
  console.error(`FAIL ${message}`)
}

// --- picking ---------------------------------------------------------------

const eye: Vec3 = [0, 0, 6]
const camera: RayCamera = { eye, viewMatrix: mat4LookAt(eye, [0, 0, 0], [0, 1, 0]), fovY: Math.PI / 4 }
const STRIDE = 9
const HUT_RADIUS = 0.05

{
  const instances = new Float32Array([
    // In front, at the centre of the view.
    0, 0, 1.02, 0, 1, 0, 0, 0, 0,
    // Behind the planet, on the same line of sight.
    0, 0, -1.02, 0, 1, 0, 1, 0, 0,
    // Off to the side.
    0.3, 0, 0.954, 0, 1, 0, 2, 0, 1,
  ])
  const ray = screenRay(camera, 0, 0, CANVAS_ASPECT)
  check('a ray through a hut picks it, not the one behind the planet',
    hutIdUnderRay(instances, STRIDE, ray, eye, HUT_RADIUS, HUT_RADIUS) === 0)

  const side = worldToNdc(camera, [0.3, 0, 0.954 + HUT_RADIUS * 0.5], CANVAS_ASPECT)!
  check('a ray at the side hut picks that one',
    hutIdUnderRay(instances, STRIDE, screenRay(camera, side.x, side.y, CANVAS_ASPECT), eye, HUT_RADIUS, HUT_RADIUS) === 2)

  const miss = worldToNdc(camera, [0.15, 0, 0.99], CANVAS_ASPECT)!
  check('bare ground between them picks nothing',
    hutIdUnderRay(instances, STRIDE, screenRay(camera, miss.x, miss.y, CANVAS_ASPECT), eye, HUT_RADIUS, HUT_RADIUS) === -1)
}

{
  const site: Vec3 = [0, 0.6, 0.8]
  const door = doorTowards(site, eye)
  const along = door[0] * site[0] + door[1] * site[1] + door[2] * site[2]
  const towardsEye = door[0] * eye[0] + door[1] * eye[1] + door[2] * eye[2]
  check('a door is tangent to the ground and faces the camera',
    Math.abs(along) < 1e-9 && towardsEye > 0 && Math.abs(Math.hypot(...door) - 1) < 1e-9)
  const overhead = doorTowards([0, 0, 1], eye)
  check('straight below the camera it still gets a tangent',
    Math.abs(overhead[2]) < 1e-9 && Math.abs(Math.hypot(...overhead) - 1) < 1e-9)
}

// --- build mode and enter orders, against a fake core ----------------------

let site: HutSite = HutSite.ok
const placed: Array<{ direction: Vec3; heading: Vec3; tribe: number; kind: HutKind }> = []
const sitesAsked: Array<{ kind: HutKind | undefined; tribe: number | undefined }> = []
// The fake core snaps every site a little way off the cursor, the way the real
// one snaps to the nearest nav node.
const SNAPPED: Vec3 = [0, 0.02 / Math.hypot(0.02, 1), 1 / Math.hypot(0.02, 1)]
const FOOTPRINT = 0.07
const entered: number[] = []
const ejected: number[] = []
let selectedCount = 0
let hutData = new Float32Array(0)

const simulation = {
  hutRadius: HUT_RADIUS,
  hutCapacity: 3,
  hutInstanceFloats: STRIDE,
  get hutCount() {
    return hutData.length / STRIDE
  },
  housedCount: 2,
  followerCount: 7,
  get selectedFollowerCount() {
    return selectedCount
  },
  trainingCapacity: 1,
  warriorCost: 5,
  hutSite(_direction: Vec3, kind?: HutKind, tribe?: number): HutSiteReport {
    sitesAsked.push({ kind, tribe })
    return { site, centre: SNAPPED, footprint: FOOTPRINT }
  },
  placeHut(direction: Vec3, heading: Vec3, tribe: number, kind: HutKind = HutKind.dwelling) {
    placed.push({ direction, heading, tribe, kind })
    hutData = new Float32Array([...hutData, direction[0] * 1.0, direction[1] * 1.0, direction[2] * 1.0, ...heading, tribe, 0, kind])
    return placed.length - 1
  },
  hutCost(kind: HutKind) {
    return kind === HutKind.training ? 15 : placed.length === 0 ? 0 : 10
  },
  hutTribe(id: number) {
    return hutData[id * STRIDE + 6]
  },
  hutKind(id: number) {
    return hutData[id * STRIDE + 8]
  },
  wood() {
    return 0
  },
  ejectHut(id: number) {
    ejected.push(id)
    return 3
  },
  hutOccupants() {
    return 0
  },
  orderEnterHut(id: number) {
    entered.push(id)
    return 2
  },
  hutInstances() {
    return hutData
  },
} as unknown as Simulation

const planet = createPlanet({ resolution: 8, terrain: 'flat', radius: 1 })
const huts = createHuts(planet, simulation)
const view = { camera, aspect: CANVAS_ASPECT }

function pointer(partial: Partial<PointerSnapshot> = {}): PointerSnapshot {
  return {
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
  }
}

function click(button: 'left' | 'right', ndc = { x: 0, y: 0 }, shiftKey = false, held: string[] = []): PointerClick {
  return { button, position: { x: 0, y: 0 }, ndc, ctrlKey: false, shiftKey, held: new Set(held) }
}

function frame(partial: Partial<InputSnapshot> & { clicks?: PointerClick[] } = {}) {
  return huts.update(16, {
    keys: partial.keys ?? new Set(),
    pressed: partial.pressed ?? new Set(),
    pointer: pointer({ clicks: partial.clicks ?? [] }),
  }, view)
}

check('build mode starts off, with no ghost', !huts.building && huts.ghost === null && frame().building === false)

frame({ pressed: new Set(['KeyB']) })
check('B turns build mode on, and the ghost snaps to the node the core would build on',
  huts.building && huts.ghost !== null && huts.ghost.direction === SNAPPED)
check('the ghost asks the core about its site, and carries the footprint it would block',
  huts.ghost?.site === HutSite.ok && huts.ghost.footprint === FOOTPRINT)
check('asking for a dwelling, built by the player, so the wood is judged too',
  sitesAsked.at(-1)?.kind === HutKind.dwelling && sitesAsked.at(-1)?.tribe === 0 &&
    huts.ghost?.kind === HutKind.dwelling && huts.ghostInstance()?.[8] === HutKind.dwelling)
check('and is drawn as one more hut instance, marked good',
  huts.ghostInstance()?.[7] === -1 && Math.abs((huts.ghostInstance()?.[1] ?? 0) - SNAPPED[1]) < 1e-3)
check('the HUD says where it stands, and that the first one is free',
  hutLine(huts).includes('placing a hut: click to build (free'), hutLine(huts))

site = HutSite.uneven
frame()
check('an uneven site is marked bad', huts.ghostInstance()?.[7] === -2)
check('and the HUD says to flatten it', hutLine(huts).includes('flatten'), hutLine(huts))

const refused = click('left')
const refusedResult = frame({ clicks: [refused] })
check('a click on a bad site builds nothing, but is still not a selection',
  placed.length === 0 && refusedResult.consumed.has(refused) && huts.building)

frame({ keys: new Set(['KeyC']) })
check('holding C hides the ghost so the brush can work', huts.ghost === null && huts.building)

site = HutSite.ok
const build = click('left')
const built = frame({ clicks: [build] })
check('a click on a good site builds there, for the player, and leaves build mode',
  placed.length === 1 && placed[0].direction === SNAPPED && placed[0].tribe === 0 &&
  built.consumed.has(build) && !huts.building && !built.building)
check('with a door along the ground', Math.abs(Math.hypot(...placed[0].heading) - 1) < 1e-9 &&
  Math.abs(placed[0].heading[0] * placed[0].direction[0] + placed[0].heading[1] * placed[0].direction[1] +
    placed[0].heading[2] * placed[0].direction[2]) < 1e-9)

frame({ pressed: new Set(['KeyB']) })
const sculptClick = click('left', { x: 0, y: 0 }, false, ['KeyC'])
check('a click under C is the brush, not a build', !frame({ clicks: [sculptClick] }).consumed.has(sculptClick) &&
  placed.length === 1)
site = HutSite.water
frame({ clicks: [click('left')] })
check('water is refused and named', placed.length === 1 && huts.notice === siteProblem(HutSite.water))
site = HutSite.occupied
frame({ clicks: [click('left')] })
check('so is a pad touching another hut', placed.length === 1 && huts.notice === 'too close to another hut')
site = HutSite.noWood
frame({ clicks: [click('left')] })
check('and a site the tribe cannot pay for, with the price', placed.length === 1 &&
  huts.notice !== null && huts.notice.includes('not enough wood (10 needed)'), huts.notice ?? '')
site = HutSite.ok
const queued = click('left', { x: 0.3, y: 0 }, true)
frame({ clicks: [queued] })
check('Shift-click builds and keeps placing', placed.length === 2 && huts.building)
const cancel = click('right')
check('right-click cancels build mode', frame({ clicks: [cancel] }).consumed.has(cancel) && !huts.building)
frame({ pressed: new Set(['KeyB']) })
frame({ pressed: new Set(['Escape']) })
check('so does Escape', !huts.building)

frame({ pressed: new Set(['KeyT']) })
check('T is build mode for a training hut', huts.building && huts.buildKind === HutKind.training &&
  sitesAsked.at(-1)?.kind === HutKind.training && huts.ghostInstance()?.[8] === HutKind.training)
check('and the HUD names it and its price', hutLine(huts).includes('placing a training hut: click to build (15 wood'),
  hutLine(huts))
frame({ pressed: new Set(['KeyB']) })
check('B from there switches to a hut', huts.buildKind === HutKind.dwelling)
frame({ pressed: new Set(['KeyT']) })
frame({ clicks: [click('left', { x: 0.1, y: 0 })] })
check('a click places a training hut, for the player', placed.length === 3 &&
  placed[2].kind === HutKind.training && placed[2].tribe === 0 && !huts.building)
frame({ pressed: new Set(['KeyT']) })
frame({ pressed: new Set(['KeyT']) })
check('T again leaves build mode', !huts.building)

const onHut = click('right')
selectedCount = 0
check('right-click on the player\'s hut with nobody selected empties it',
  frame({ clicks: [onHut] }).consumed.has(onHut) && entered.length === 0 && ejected.length === 1 &&
    ejected[0] === 0)
check('and the HUD says how many came out', huts.notice === '3 came out')
hutData[6] = 2
check('anyone else\'s is left alone', !frame({ clicks: [onHut] }).consumed.has(onHut) && ejected.length === 1)
hutData[6] = 0
selectedCount = 3
const order = frame({ clicks: [onHut] })
check('with followers selected it is an enter order for that hut',
  order.consumed.has(onHut) && entered.length === 1 && entered[0] === 0)
check('and the HUD says how many went', huts.notice === '2 going in' && hutLine(huts).includes('2 going in'))
const ground = click('right', { x: -0.6, y: 0.4 })
check('right-click on bare ground stays a move order', !frame({ clicks: [ground] }).consumed.has(ground) &&
  entered.length === 1)
check('the HUD counts everyone, walking and housed', hutLine(huts).startsWith('population 9 · 3 huts, 2 inside'),
  hutLine(huts))
huts.update(5000, { keys: new Set(), pressed: new Set(), pointer: pointer() }, view)
check('the notice ages out', huts.notice === null)
check('and the line offers both build keys, with their prices',
  hutLine(huts).endsWith('B hut (10 wood) · T training hut (15 wood)'), hutLine(huts))

await realCore()


// --- the real core ---------------------------------------------------------

async function realCore(): Promise<void> {
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
  const tick = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 20); i += 1) real.tick(50)
  }

  const real = await createSimulation()
  const m = real.module
  const world = createPlanet()
  const ground = createTerrain(world, real)
  const people = createFollowers(ground, real, { spawnCount: 4, tribe: 0, shamanTribe: 0 })
  const { graph } = ground
  const nodeDirection = (node: number): Vec3 =>
    [graph.directions[node * 3], graph.directions[node * 3 + 1], graph.directions[node * 3 + 2]]

  // A wide level pad round the village, then nobody standing on it but the
  // people this section puts there.
  const home = people.homeDirection!
  for (let i = 0; i < 40; i += 1) ground.flatten(home, 0.45, world.maxHeight / 3, 1)
  ground.syncMesh()
  m._core_followers_clear()

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
  const west: Vec3 = [-east[0], -east[1], -east[2]]
  const south: Vec3 = [-north[0], -north[1], -north[2]]

  // B and a click at the middle of a view looking straight down at home.
  const realEye: Vec3 = [home[0] * 4, home[1] * 4, home[2] * 4]
  const realView = {
    camera: { eye: realEye, viewMatrix: mat4LookAt(realEye, [0, 0, 0], north), fovY: Math.PI / 4 },
    aspect: CANVAS_ASPECT,
  }
  const ui = createHuts(world, real)
  const press = (clicks: PointerClick[] = [], pressed: string[] = []) =>
    ui.update(16, { keys: new Set(), pressed: new Set(pressed), pointer: pointer({ clicks }) }, realView)

  press([], ['KeyB'])
  const ghost = ui.ghost
  check('the real ghost sits on a nav node, with a footprint a cell or so across',
    ghost !== null && ghost.site === HutSite.ok && ghost.footprint > 0.03 && ghost.footprint < 0.15 &&
      graph.directions.length > 0,
    ghost ? `site ${ghost.site}, footprint ${ghost.footprint.toFixed(4)} rad` : 'no ghost')
  const heightsBefore = Float32Array.from(ground.heights())
  press([click('left')])
  check('B and a click place a hut through the real core', real.hutCount === 1 && m._core_hut_tribe(0) === 0,
    `${real.hutCount} huts`)
  check('placing does not sculpt', real.takeTerrainDirty() === null &&
    heightsBefore.every((h, i) => h === ground.heights()[i]))

  const centre = ghost!.direction
  const extent = ghost!.footprint
  const hutRadius = real.hutRadius / world.radius
  check('the hut stands where the ghost was drawn', (() => {
    const data = real.hutInstances()
    return angle([data[0], data[1], data[2]], centre) < 1e-5
  })())
  check('the pad is no longer ground to stand on',
    real.hutSite(centre).site === HutSite.occupied &&
      angle(nodeDirection(m._core_nav_nearest_walkable(...centre)), centre) > extent * 0.6)
  check('nor is the ground right beside it', real.hutSite(along(centre, east, extent * 1.6)).site === HutSite.occupied)
  check('one HUD line for huts', hutLine(ui).startsWith('population') && hutLine(ui).includes('1 hut,'), hutLine(ui))

  // --- routes go round ------------------------------------------------------

  const readRoute = (count: number): Vec3[] => {
    const start = m._core_route_points() >> 2
    const points: Vec3[] = []
    for (let i = 0; i < count; i += 1) {
      points.push([m.HEAPF32[start + i * 3], m.HEAPF32[start + i * 3 + 1], m.HEAPF32[start + i * 3 + 2]])
    }
    return points
  }
  /** Closest any point on the polyline comes to the hut's centre. */
  const closest = (from: Vec3, points: Vec3[]) => {
    let best = Infinity
    let previous = from
    for (const point of points) {
      for (let t = 0; t <= 1; t += 1 / 64) {
        const p = normalize([
          previous[0] + (point[0] - previous[0]) * t,
          previous[1] + (point[1] - previous[1]) * t,
          previous[2] + (point[2] - previous[2]) * t,
        ])
        best = Math.min(best, angle(p, centre))
      }
      previous = point
    }
    return best
  }
  const length = (from: Vec3, points: Vec3[]) => {
    let total = 0
    let previous = from
    for (const point of points) {
      total += angle(previous, point)
      previous = point
    }
    return total
  }

  for (const [name, a, b] of [
    ['west to east', along(centre, west, 0.2), along(centre, east, 0.2)],
    ['south-west to north-east, the diagonal', along(centre, normalize([west[0] + south[0], west[1] + south[1], west[2] + south[2]]), 0.2),
      along(centre, normalize([east[0] + north[0], east[1] + north[1], east[2] + north[2]]), 0.2)],
  ] as Array<[string, Vec3, Vec3]>) {
    const nodes = readRoute(m._core_nav_route(...a, ...b, 0))
    check(`a node route ${name} takes no footprint node`,
      nodes.length > 0 && nodes.every((node) => angle(node, centre) > extent * 1.01),
      `${nodes.length} nodes, closest ${Math.min(...nodes.map((n) => angle(n, centre))).toFixed(4)}`)
    const count = m._core_nav_route(...a, ...b, 1)
    const legs = readRoute(count)
    const near = closest(a, legs)
    check(`the string-pulled route ${name} goes round the pad`,
      count > 1 && near > hutRadius && near > extent * 0.6 && length(a, legs) > angle(a, b) * 1.005,
      `${count} legs, closest ${near.toFixed(4)} (footprint ${extent.toFixed(4)}), ` +
        `${length(a, legs).toFixed(4)} vs straight ${angle(a, b).toFixed(4)}`)
  }

  // A follower ordered straight across walks round, never through the walls.
  {
    const from = along(centre, west, 0.2)
    const to = along(centre, east, 0.2)
    const walker = real.spawnFollower(from, 0)
    real.setFollowerSelected(walker, true)
    check('a follower is ordered to the far side', real.orderFollowerMove(to) === 1)
    let nearest = Infinity
    for (let i = 0; i < 20 * 20; i += 1) {
      real.tick(50)
      const data = real.followerInstances()
      const base = walker * real.followerInstanceFloats
      nearest = Math.min(nearest, angle([data[base], data[base + 1], data[base + 2]], centre))
    }
    const data = real.followerInstances()
    const base = walker * real.followerInstanceFloats
    const end: Vec3 = [data[base], data[base + 1], data[base + 2]]
    check('and walks round the hut to get there', nearest > hutRadius && nearest > extent * 0.6 && angle(end, to) < 0.05,
      `closest ${nearest.toFixed(4)}, finished ${angle(end, to).toFixed(4)} from the goal`)
    m._core_followers_clear()
  }

  // --- someone standing where a hut goes up ---------------------------------

  {
    const site = along(centre, east, 0.3)
    const stander = real.spawnFollower(site, 0)
    const report = real.hutSite(site)
    check('a second site is good while someone stands on it', stander >= 0 && report.site === HutSite.ok,
      `site ${report.site}`)
    // The tribe's first hut was free; this one is paid for.
    real.setWood(0, real.hutCost(HutKind.dwelling, 0))
    const second = real.placeHut(site, north, 0)
    const data = real.followerInstances()
    const at: Vec3 = [data[0], data[1], data[2]]
    check('the hut goes up and the follower is moved off the pad',
      second === 1 && real.followerCount === 1 && angle(at, report.centre!) > report.footprint * 1.01,
      `${angle(at, report.centre!).toFixed(4)} from the centre, footprint ${report.footprint.toFixed(4)}`)
    m._core_followers_clear()
  }

  // --- going in, and breeding ------------------------------------------------

  const settlers = [0.16, 0.18, 0.2].map((d) => real.spawnFollower(along(centre, south, d), 0))
  for (const id of settlers) real.setFollowerSelected(id, true)
  check('three are sent in', real.orderEnterHut(0) === 3)
  for (let i = 0; i < 15 * 20 && real.housedCount < 3; i += 1) real.tick(50)
  check('they walk round to the door and are housed',
    real.hutOccupants(0) === 3 && real.housedCount === 3 && real.followerCount === 0,
    `${real.hutOccupants(0)} inside, ${real.followerCount} outside`)
  check('mana counts them inside', real.manaIncome(0) === 3, `+${real.manaIncome(0)}/s`)

  tick(10.5)
  check('a full hut breeds one every ten seconds', real.followerCount === 1, `${real.followerCount} born`)
  {
    const data = real.followerInstances()
    const born: Vec3 = [data[0], data[1], data[2]]
    const heading: Vec3 = [real.hutInstances()[3], real.hutInstances()[4], real.hutInstances()[5]]
    const door = along(centre, heading, extent)
    const back = along(centre, [-heading[0], -heading[1], -heading[2]], extent)
    check('out of the door, clear of the pad',
      angle(born, centre) > extent * 1.01 && angle(born, door) < angle(born, back) &&
        data[6] === 0,
      `${angle(born, centre).toFixed(4)} from the centre`)
  }

  // --- sculpting under it ----------------------------------------------------

  {
    const before = Math.hypot(real.hutInstances()[0], real.hutInstances()[1], real.hutInstances()[2])
    ground.sculpt(centre, extent * 2, world.maxHeight * 0.05)
    real.tick(50)
    const after = Math.hypot(real.hutInstances()[0], real.hutInstances()[1], real.hutInstances()[2])
    check('a sculpt stroke under a standing hut lifts it with the ground', after > before + 1e-4,
      `${before.toFixed(5)} -> ${after.toFixed(5)}`)
    check('and the pad stays blocked', real.hutSite(centre).site !== HutSite.ok)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} hut check(s) failed`)
  process.exit(1)
}
console.log('\nall hut checks passed')
