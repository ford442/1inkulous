/**
 * Build mode for land-claim huts, against a fake core. The accept / reject
 * rules live in the WASM core and are covered by test:core.
 *
 * Run: npm run test:buildings
 */
import { mat4LookAt, type Vec3 } from '../src/engine/math.ts'
import type { RayCamera } from '../src/engine/picking.ts'
import { createBuildings, siteProblem } from '../src/game/buildings.ts'
import { createPlanet } from '../src/game/planet.ts'
import { BuildingKind, BuildingSite } from '../src/sim/buildingSite.ts'
import { buildingLine } from '../src/ui/hud.ts'
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

const eye: Vec3 = [0, 0, 6]
const camera: RayCamera = { eye, viewMatrix: mat4LookAt(eye, [0, 0, 0], [0, 1, 0]), fovY: Math.PI / 4 }

let site: BuildingSite = BuildingSite.ok
const placed: Array<{ direction: Vec3; tribe: number; kind: number }> = []
let buildingData = new Float32Array(0)

const simulation = {
  buildingRadius: 0.05,
  buildingInstanceFloats: 8,
  get buildingCount() {
    return buildingData.length / 8
  },
  buildingSite() {
    return site
  },
  placeBuilding(direction: Vec3, tribe: number, kind: number) {
    placed.push({ direction, tribe, kind })
    buildingData = new Float32Array([
      ...buildingData,
      direction[0],
      direction[1],
      direction[2],
      tribe,
      kind,
      0,
      0,
      0,
    ])
    return placed.length - 1
  },
  buildingInstances() {
    return buildingData
  },
} as unknown as Simulation

const planet = createPlanet({ resolution: 8, terrain: 'flat', radius: 1 })
const buildings = createBuildings(planet, simulation)
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

function click(
  button: 'left' | 'right',
  ndc = { x: 0, y: 0 },
  shiftKey = false,
  held: string[] = [],
): PointerClick {
  return { button, position: { x: 0, y: 0 }, ndc, ctrlKey: false, shiftKey, held: new Set(held) }
}

function frame(partial: Partial<InputSnapshot> & { clicks?: PointerClick[] } = {}) {
  return buildings.update(16, {
    keys: partial.keys ?? new Set(),
    pressed: partial.pressed ?? new Set(),
    pointer: pointer({ clicks: partial.clicks ?? [] }),
  }, view)
}

check('build mode starts off', !buildings.building && buildings.ghost === null && buildingLine(buildings) === '0 huts')

frame({ pressed: new Set(['KeyB']) })
check('B arms build mode and the ghost sits on the planet',
  buildings.building && buildings.ghost !== null && Math.abs((buildings.ghost?.direction[2] ?? 0) - 1) < 1e-6)
check('the ghost asks the core and draws as a good hut',
  buildings.ghost?.site === BuildingSite.ok && buildings.ghostInstance()?.[5] === -1)
check('the HUD counts huts and offers the click',
  buildingLine(buildings) === '0 huts · click to place', buildingLine(buildings))

site = BuildingSite.steep
frame()
check('a cliff is marked bad', buildings.ghostInstance()?.[5] === -2)
check('and the HUD names it', buildingLine(buildings).includes('too steep'), buildingLine(buildings))
check('the refusal text is the steep one', siteProblem(BuildingSite.steep).includes('flatten'))

const refused = click('left')
const refusedResult = frame({ clicks: [refused] })
check('a click on a bad site places nothing and is not a selection',
  placed.length === 0 && refusedResult.consumed.has(refused) && buildings.building)

frame({ keys: new Set(['KeyC']) })
check('holding C hides the ghost so the brush can work', buildings.ghost === null && buildings.building)

site = BuildingSite.ok
const build = click('left')
const built = frame({ clicks: [build] })
check('a click on flat land places a free hut and leaves build mode',
  placed.length === 1 && placed[0].tribe === 0 && placed[0].kind === BuildingKind.hut &&
  built.consumed.has(build) && !buildings.building)
check('the HUD counts it', buildingLine(buildings) === '1 huts', buildingLine(buildings))

frame({ pressed: new Set(['KeyB']) })
const sculptClick = click('left', { x: 0, y: 0 }, false, ['KeyC'])
check('a click under C is the brush, not a hut',
  !frame({ clicks: [sculptClick] }).consumed.has(sculptClick) && placed.length === 1)

site = BuildingSite.water
const wet = click('left')
frame({ clicks: [wet] })
check('water is refused', placed.length === 1 && buildings.notice === 'needs dry land')

site = BuildingSite.occupied
const taken = click('left')
frame({ clicks: [taken] })
check('an occupied pad is refused', placed.length === 1 && buildings.notice === 'a hut already stands there')

site = BuildingSite.ok
const queued = click('left', { x: 0.3, y: 0 }, true)
frame({ clicks: [queued] })
check('Shift-click places and keeps build mode', placed.length === 2 && buildings.building)

const cancel = click('right')
check('right-click cancels build mode', frame({ clicks: [cancel] }).consumed.has(cancel) && !buildings.building)

frame({ pressed: new Set(['KeyB']) })
frame({ pressed: new Set(['Escape']) })
check('Escape cancels build mode', !buildings.building)

if (failures.length > 0) {
  console.error(`\n${failures.length} building check(s) failed`)
  process.exit(1)
}
console.log('\nall building checks passed')
