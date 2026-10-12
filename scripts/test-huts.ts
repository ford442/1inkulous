/**
 * Huts and the flatten brush, without the WASM core or a GPU: the planet's
 * flatten primitive, hut picking, and build mode / enter orders through
 * createHuts against a fake core.
 *
 * Run: npm run test:huts
 */
import { mat4LookAt, type Vec3 } from '../src/engine/math.ts'
import { screenRay, worldToNdc, type RayCamera } from '../src/engine/picking.ts'
import { createHuts, doorTowards, hutIdUnderRay } from '../src/game/huts.ts'
import { createPlanet } from '../src/game/planet.ts'
import { HutSite } from '../src/sim/hutSite.ts'
import { hutLine } from '../src/ui/hud.ts'
import type { InputSnapshot, PointerClick, PointerSnapshot } from '../src/input/input.ts'
import type { Simulation } from '../src/sim/simulation.ts'
import { CANVAS_ASPECT } from '../src/viewport.ts'

const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`ok  ${name}`)
    return
  }
  const message = detail ? `${name} — ${detail}` : name
  failures.push(message)
  console.error(`FAIL ${message}`)
}

// --- flatten ---------------------------------------------------------------

{
  const planet = createPlanet({ resolution: 24, terrain: 'placeholder', seed: 1 })
  const { mesh } = planet
  // Somewhere on land with some relief to level out.
  let centre: Vec3 = [0, 0, 1]
  for (let i = 0; i < mesh.vertexCount; i += 1) {
    const h = mesh.heights[i]
    if (h > planet.maxHeight * 0.3 && h < planet.maxHeight * 0.7) {
      centre = [mesh.directions[i * 3], mesh.directions[i * 3 + 1], mesh.directions[i * 3 + 2]]
      break
    }
  }
  const radius = 0.15
  const target = planet.heightAt(centre)
  const before = Float32Array.from(mesh.heights)
  const revision = mesh.revision

  const inside: number[] = []
  const outside: number[] = []
  const cosRadius = Math.cos(radius)
  for (let i = 0; i < mesh.vertexCount; i += 1) {
    const dot =
      mesh.directions[i * 3] * centre[0] +
      mesh.directions[i * 3 + 1] * centre[1] +
      mesh.directions[i * 3 + 2] * centre[2]
    if (dot > cosRadius) inside.push(i)
    else outside.push(i)
  }

  const moved = planet.flatten(centre, radius, target, planet.maxHeight * 0.05)
  check('a flatten stroke moves the ground', moved && mesh.revision > revision)
  check('and never past the target', inside.every((i) =>
    Math.abs(mesh.heights[i] - target) <= Math.abs(before[i] - target) + 1e-7))
  check('nor outside the brush', outside.every((i) => mesh.heights[i] === before[i]))

  // Held on the spot, the core of the brush lands exactly on the target.
  for (let frame = 0; frame < 400; frame += 1) {
    planet.flatten(centre, radius, target, planet.maxHeight * 0.05)
  }
  const core = inside.filter((i) => {
    const dot =
      mesh.directions[i * 3] * centre[0] +
      mesh.directions[i * 3 + 1] * centre[1] +
      mesh.directions[i * 3 + 2] * centre[2]
    return Math.acos(Math.min(1, dot)) < radius * 0.7
  })
  check('held long enough, the pad is exactly level',
    core.length > 0 && core.every((i) => mesh.heights[i] === Math.fround(target)),
    `${core.length} vertices in the pad`)
  const settled = mesh.revision
  check('and a level pad stops re-uploading',
    !planet.flatten(centre, radius * 0.7, target, planet.maxHeight * 0.05) && mesh.revision === settled)
  check('a zero-rate stroke does nothing', !planet.flatten(centre, radius, 0, 0))
}

// --- picking ---------------------------------------------------------------

const eye: Vec3 = [0, 0, 6]
const camera: RayCamera = { eye, viewMatrix: mat4LookAt(eye, [0, 0, 0], [0, 1, 0]), fovY: Math.PI / 4 }
const STRIDE = 8
const HUT_RADIUS = 0.05

{
  const instances = new Float32Array([
    // In front, at the centre of the view.
    0, 0, 1.02, 0, 1, 0, 0, 0,
    // Behind the planet, on the same line of sight.
    0, 0, -1.02, 0, 1, 0, 1, 0,
    // Off to the side.
    0.3, 0, 0.954, 0, 1, 0, 2, 0,
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
const placed: Array<{ direction: Vec3; heading: Vec3 }> = []
const entered: number[] = []
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
  hutSite() {
    return site
  },
  placeHut(direction: Vec3, heading: Vec3) {
    placed.push({ direction, heading })
    hutData = new Float32Array([...hutData, direction[0] * 1.0, direction[1] * 1.0, direction[2] * 1.0, ...heading, -1, 0])
    return placed.length - 1
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
check('B turns build mode on, and the ghost follows the cursor onto the planet',
  huts.building && huts.ghost !== null && Math.abs(huts.ghost.direction[2] - 1) < 1e-6)
check('the ghost asks the core about its site', huts.ghost?.site === HutSite.ok)
check('and is drawn as one more hut instance, marked good',
  huts.ghostInstance()?.[7] === -1 && Math.abs((huts.ghostInstance()?.[2] ?? 0) - 1) < 1e-6)
check('the HUD says where it stands', hutLine(huts).includes('click to build'), hutLine(huts))

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
check('a click on a good site builds there and leaves build mode',
  placed.length === 1 && built.consumed.has(build) && !huts.building && !built.building)
check('with a door along the ground', Math.abs(Math.hypot(...placed[0].heading) - 1) < 1e-9 &&
  Math.abs(placed[0].heading[0] * placed[0].direction[0] + placed[0].heading[1] * placed[0].direction[1] +
    placed[0].heading[2] * placed[0].direction[2]) < 1e-9)

frame({ pressed: new Set(['KeyB']) })
const sculptClick = click('left', { x: 0, y: 0 }, false, ['KeyC'])
check('a click under C is the brush, not a build', !frame({ clicks: [sculptClick] }).consumed.has(sculptClick) &&
  placed.length === 1)
const queued = click('left', { x: 0.3, y: 0 }, true)
frame({ clicks: [queued] })
check('Shift-click builds and keeps placing', placed.length === 2 && huts.building)
const cancel = click('right')
check('right-click cancels build mode', frame({ clicks: [cancel] }).consumed.has(cancel) && !huts.building)
frame({ pressed: new Set(['KeyB']) })
frame({ pressed: new Set(['Escape']) })
check('so does Escape', !huts.building)

const onHut = click('right')
selectedCount = 0
check('right-click on a hut with nobody selected is left alone', !frame({ clicks: [onHut] }).consumed.has(onHut) &&
  entered.length === 0)
selectedCount = 3
const order = frame({ clicks: [onHut] })
check('with followers selected it is an enter order for that hut',
  order.consumed.has(onHut) && entered.length === 1 && entered[0] === 0)
check('and the HUD says how many went', huts.notice === '2 going in' && hutLine(huts).includes('2 going in'))
const ground = click('right', { x: -0.6, y: 0.4 })
check('right-click on bare ground stays a move order', !frame({ clicks: [ground] }).consumed.has(ground) &&
  entered.length === 1)
check('the HUD counts everyone, walking and housed', hutLine(huts).startsWith('population 9 · 2 huts, 2 inside'),
  hutLine(huts))
huts.update(5000, { keys: new Set(), pressed: new Set(), pointer: pointer() }, view)
check('the notice ages out', huts.notice === null)

if (failures.length > 0) {
  console.error(`\n${failures.length} hut check(s) failed`)
  process.exit(1)
}
console.log('\nall hut checks passed')
