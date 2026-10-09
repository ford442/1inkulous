/**
 * Rubber-band selection, without the WASM core or a GPU.
 *
 * Run: npm run test:select
 */
import { mat4LookAt, normalize, type Vec3 } from '../src/engine/math.ts'
import { screenRay, worldToNdc, type RayCamera } from '../src/engine/picking.ts'
import { createCamera } from '../src/game/camera.ts'
import { createFollowers, followerIdsInDragRect } from '../src/game/followers.ts'
import { createPlanet } from '../src/game/planet.ts'
import { selectionBandLayout } from '../src/ui/hud.ts'
import type { DragRect, InputSnapshot, PointerSnapshot } from '../src/input/input.ts'
import type { Simulation } from '../src/sim/simulation.ts'
import { CANVAS_ASPECT, CANVAS_HEIGHT, CANVAS_WIDTH } from '../src/viewport.ts'

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

function sameIds(actual: readonly number[], expected: readonly number[]): boolean {
  if (actual.length !== expected.length) {
    return false
  }
  for (let i = 0; i < actual.length; i += 1) {
    if (actual[i] !== expected[i]) {
      return false
    }
  }
  return true
}

function ndcOf(x: number, y: number): { x: number; y: number } {
  return {
    x: (x / CANVAS_WIDTH) * 2 - 1,
    y: 1 - (y / CANVAS_HEIGHT) * 2,
  }
}

const eye: Vec3 = [0, 0, 6]
const viewMatrix = mat4LookAt(eye, [0, 0, 0], [0, 1, 0])
const camera: RayCamera = { eye, viewMatrix, fovY: Math.PI / 4 }

const center = worldToNdc(camera, [0, 0, 1], CANVAS_ASPECT)
const behind = worldToNdc(camera, [0, 0, 8], CANVAS_ASPECT)
check('centre of the view projects to the origin', center !== null && Math.hypot(center.x, center.y) < 1e-6, JSON.stringify(center))
check('a point behind the camera does not project', behind === null)

if (center) {
  const ray = screenRay(camera, center.x, center.y, CANVAS_ASPECT)
  const vx = 0 - ray.origin[0]
  const vy = 0 - ray.origin[1]
  const vz = 1 - ray.origin[2]
  const cx = vy * ray.direction[2] - vz * ray.direction[1]
  const cy = vz * ray.direction[0] - vx * ray.direction[2]
  const cz = vx * ray.direction[1] - vy * ray.direction[0]
  const cross = Math.hypot(cx, cy, cz)
  const along = vx * ray.direction[0] + vy * ray.direction[1] + vz * ray.direction[2]
  check('projecting and casting a ray round-trip', cross < 1e-5 && along > 0, `cross ${cross}`)
}

const nearOffset = normalize([0.35, 0.15, 1])
const offScreen: Vec3 = [5, 0, 5]
const positions: Vec3[] = [
  [0, 0, 1],
  nearOffset,
  [0, 0, -1],
  offScreen,
]
const projected = positions.map((position) => worldToNdc(camera, position, CANVAS_ASPECT))
check('near followers project on screen', projected[0] !== null && projected[1] !== null)
check(
  'offset follower is not on the centre point',
  projected[0] !== null &&
    projected[1] !== null &&
    Math.hypot(projected[1]!.x - projected[0]!.x, projected[1]!.y - projected[0]!.y) > 0.05,
)
check('off-screen follower is outside the viewport', projected[3] !== null && (Math.abs(projected[3]!.x) > 1 || Math.abs(projected[3]!.y) > 1), JSON.stringify(projected[3]))

const STRIDE = 8
const instances = new Float32Array(positions.length * STRIDE)
positions.forEach((position, id) => {
  instances[id * STRIDE] = position[0]
  instances[id * STRIDE + 1] = position[1]
  instances[id * STRIDE + 2] = position[2]
})

const centerNdc = projected[0]!
const offsetNdc = projected[1]!
const tight = followerIdsInDragRect(
  instances,
  STRIDE,
  camera,
  CANVAS_ASPECT,
  { x: centerNdc.x - 0.02, y: centerNdc.y - 0.02 },
  { x: centerNdc.x + 0.02, y: centerNdc.y + 0.02 },
)
check('a tight box selects only the follower under it', sameIds(tight, [0]), JSON.stringify(tight))

const both = followerIdsInDragRect(
  instances,
  STRIDE,
  camera,
  CANVAS_ASPECT,
  { x: Math.min(centerNdc.x, offsetNdc.x) - 0.05, y: Math.min(centerNdc.y, offsetNdc.y) - 0.05 },
  { x: Math.max(centerNdc.x, offsetNdc.x) + 0.05, y: Math.max(centerNdc.y, offsetNdc.y) + 0.05 },
)
check('a box around two followers selects both', sameIds(both, [0, 1]), JSON.stringify(both))

const fullscreen = followerIdsInDragRect(
  instances,
  STRIDE,
  camera,
  CANVAS_ASPECT,
  { x: -1, y: -1 },
  { x: 1, y: 1 },
)
check(
  'the far side of the planet is not selected',
  sameIds(fullscreen, [0, 1]),
  JSON.stringify(fullscreen),
)

const oversized = followerIdsInDragRect(
  instances,
  STRIDE,
  camera,
  CANVAS_ASPECT,
  { x: -4, y: -4 },
  { x: 4, y: 4 },
)
check(
  'an off-screen follower is not selected even when the box covers its projection',
  sameIds(oversized, [0, 1]),
  JSON.stringify(oversized),
)

// --- gesture application through createFollowers, with a fake core ---

const selected = new Set<number>()
const orders: Vec3[] = []
const simulation = {
  uploadNavGraph() {},
  writeNavHeights() {},
  spawnFollower() {
    return 0
  },
  get followerCount() {
    return instances.length / STRIDE
  },
  get selectedFollowerCount() {
    return selected.size
  },
  setFollowerSelected(id: number, on: boolean) {
    if (on) {
      selected.add(id)
    } else {
      selected.delete(id)
    }
  },
  clearFollowerSelection() {
    selected.clear()
  },
  orderFollowerMove(direction: Vec3) {
    orders.push(direction)
    return selected.size
  },
  followerInstances() {
    return instances
  },
  followerInstanceFloats: STRIDE,
} as unknown as Simulation

const planet = createPlanet({ resolution: 2, terrain: 'placeholder', radius: 1 })
const followers = createFollowers(planet, simulation, { spawnCount: 0 })

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

function frame(input: InputSnapshot): void {
  followers.update(16, input, view)
}

function drag(start: { x: number; y: number }, current: { x: number; y: number }, shiftKey: boolean, held: string[] = []): DragRect {
  return {
    startNdc: start,
    currentNdc: current,
    button: 'left',
    shiftKey,
    held: new Set(held),
  }
}

const village = drag(
  { x: Math.min(centerNdc.x, offsetNdc.x) - 0.05, y: Math.min(centerNdc.y, offsetNdc.y) - 0.05 },
  { x: Math.max(centerNdc.x, offsetNdc.x) + 0.05, y: Math.max(centerNdc.y, offsetNdc.y) + 0.05 },
  false,
)

selected.clear()
frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({
    buttons: { left: true, middle: false, right: false },
    dragging: true,
    dragRect: village,
  }),
})
check('the band is shown during a plain drag', followers.selectionBand === village)

frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({ drags: [village] }),
})
check(
  'releasing the box selects both followers',
  selected.has(0) && selected.has(1) && selected.size === 2,
  [...selected].join(','),
)
check('the band is gone after release', followers.selectionBand === null)

const onlyCentre = drag(
  { x: centerNdc.x - 0.02, y: centerNdc.y - 0.02 },
  { x: centerNdc.x + 0.02, y: centerNdc.y + 0.02 },
  false,
)
frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({ drags: [onlyCentre] }),
})
check('a plain drag replaces the selection', selected.size === 1 && selected.has(0), [...selected].join(','))

const onlyOffset = drag(
  { x: offsetNdc.x - 0.02, y: offsetNdc.y - 0.02 },
  { x: offsetNdc.x + 0.02, y: offsetNdc.y + 0.02 },
  true,
)
frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({ drags: [onlyOffset] }),
})
check(
  'shift-drag adds and keeps the previous follower',
  selected.has(0) && selected.has(1) && selected.size === 2,
  [...selected].join(','),
)

const emptyBox = drag({ x: 0.85, y: 0.85 }, { x: 0.95, y: 0.95 }, false)
frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({ drags: [emptyBox] }),
})
check('a plain drag on empty ground clears the selection', selected.size === 0)

frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({ drags: [village] }),
})
const shiftEmpty = drag({ x: 0.85, y: 0.85 }, { x: 0.95, y: 0.95 }, true)
frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({ drags: [shiftEmpty] }),
})
check('shift-drag on empty ground keeps the selection', selected.size === 2, [...selected].join(','))

const beforeSculpt = selected.size
frame({
  keys: new Set(['KeyC']),
  pressed: new Set(),
  pointer: pointer({
    buttons: { left: true, middle: false, right: false },
    dragging: true,
    dragRect: { ...village, held: new Set(['KeyC']) },
  }),
})
check('hold-C does not show a selection band', followers.selectionBand === null)
frame({
  keys: new Set(['KeyC']),
  pressed: new Set(),
  pointer: pointer({ drags: [{ ...village, held: new Set(['KeyC']) }] }),
})
check('hold-C on release does not change the selection', selected.size === beforeSculpt)

frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({ drags: [{ ...village, held: new Set(['KeyC']) }] }),
})
check(
  'a drag that overlapped C is ignored after C is released',
  selected.size === beforeSculpt,
)

// Click behaviour stays: pick one, click ground clears, right-click orders.
selected.clear()
const clickNdc = centerNdc
frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({
    clicks: [
      {
        button: 'left',
        position: { x: 0, y: 0 },
        ndc: clickNdc,
        ctrlKey: false,
        shiftKey: false,
        held: new Set(),
      },
    ],
  }),
})
check('a click still selects the follower under the cursor', selected.size === 1 && selected.has(0), [...selected].join(','))

frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({
    clicks: [
      {
        button: 'left',
        position: { x: 0, y: 0 },
        ndc: { x: 0.9, y: 0.9 },
        ctrlKey: false,
        shiftKey: false,
        held: new Set(),
      },
    ],
  }),
})
check('a click on the ground still clears', selected.size === 0)

frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({ drags: [village] }),
})
orders.length = 0
frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({
    clicks: [
      {
        button: 'right',
        position: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },
        ndc: { x: 0, y: 0 },
        ctrlKey: false,
        shiftKey: false,
        held: new Set(),
      },
    ],
  }),
})
check('right-click still orders the whole selection', orders.length === 1 && selected.size === 2, `orders ${orders.length}`)

frame({
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({
    clicks: [
      {
        button: 'left',
        position: { x: 0, y: 0 },
        ndc: clickNdc,
        ctrlKey: false,
        shiftKey: false,
        held: new Set(['KeyC']),
      },
    ],
  }),
})
check('a sculpt click still does not pick', selected.size === 2)

// --- orbit moved off the left button ---

const orbit = createCamera({ planetRadius: 1, maxTerrainHeight: 0 })
const yawBeforeLeft = orbit.yaw
for (let i = 0; i < 8; i += 1) {
  orbit.update(16, {
    keys: new Set(),
    pressed: new Set(),
    pointer: pointer({
      dragging: true,
      delta: { x: 30, y: -12 },
      buttons: { left: true, middle: false, right: false },
    }),
  })
}
check('left-drag does not orbit', Math.abs(orbit.yaw - yawBeforeLeft) < 1e-9, `${orbit.yaw}`)

const yawBeforeRight = orbit.yaw
orbit.update(16, {
  keys: new Set(),
  pressed: new Set(),
  pointer: pointer({
    dragging: true,
    delta: { x: 40, y: 0 },
    buttons: { left: false, middle: false, right: true },
  }),
})
check('right-drag orbits', Math.abs(orbit.yaw - yawBeforeRight) > 1e-4, `${orbit.yaw}`)

const sculptCam = createCamera({ planetRadius: 1, maxTerrainHeight: 0 })
const yawSculpt = sculptCam.yaw
sculptCam.update(
  16,
  {
    keys: new Set(['KeyC']),
    pressed: new Set(),
    pointer: pointer({
      dragging: true,
      delta: { x: 40, y: 0 },
      buttons: { left: false, middle: false, right: true },
    }),
  },
  { allowPointerOrbit: false },
)
check('sculpting still suppresses pointer orbit', Math.abs(sculptCam.yaw - yawSculpt) < 1e-9)

// --- band layout ---

const canvasBox = { left: 12, top: 34, width: CANVAS_WIDTH, height: CANVAS_HEIGHT }
const full = selectionBandLayout({ x: -1, y: 1 }, { x: 1, y: -1 }, canvasBox)
check(
  'a corner-to-corner drag covers the canvas',
  Math.abs(full.left - 12) < 1e-6 &&
    Math.abs(full.top - 34) < 1e-6 &&
    Math.abs(full.width - CANVAS_WIDTH) < 1e-6 &&
    Math.abs(full.height - CANVAS_HEIGHT) < 1e-6,
  JSON.stringify(full),
)
const reversed = selectionBandLayout({ x: 1, y: -1 }, { x: -1, y: 1 }, canvasBox)
check(
  'dragging the box backwards lands on the same rectangle',
  reversed.left === full.left && reversed.top === full.top && reversed.width === full.width && reversed.height === full.height,
)

// --- pointer gestures ---

type Listener = (event: { code?: string; button?: number; pointerId?: number; offsetX?: number; offsetY?: number; movementX?: number; movementY?: number; ctrlKey?: boolean; shiftKey?: boolean; preventDefault?: () => void }) => void

const windowListeners = new Map<string, Listener[]>()
const windowStub = {
  addEventListener(type: string, fn: Listener) {
    const list = windowListeners.get(type) ?? []
    list.push(fn)
    windowListeners.set(type, list)
  },
  removeEventListener() {},
  dispatch(type: string, event: Parameters<Listener>[0]) {
    for (const fn of windowListeners.get(type) ?? []) {
      fn(event)
    }
  },
}
Object.assign(globalThis, { window: windowStub })

const canvasListeners = new Map<string, Listener[]>()
const canvas = {
  tabIndex: 0,
  focus() {},
  setPointerCapture() {},
  releasePointerCapture() {},
  hasPointerCapture() {
    return true
  },
  addEventListener(type: string, fn: Listener) {
    const list = canvasListeners.get(type) ?? []
    list.push(fn)
    canvasListeners.set(type, list)
  },
  removeEventListener() {},
  dispatch(type: string, event: Parameters<Listener>[0]) {
    for (const fn of canvasListeners.get(type) ?? []) {
      fn(event)
    }
  },
}

const { createInput } = await import('../src/input/input.ts')
const input = createInput(canvas as unknown as HTMLCanvasElement)

function dispatchPointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  extra: { button?: number; shiftKey?: boolean } = {},
): void {
  canvas.dispatch(type, {
    button: extra.button ?? 0,
    pointerId: 1,
    offsetX: x,
    offsetY: y,
    movementX: 0,
    movementY: 0,
    ctrlKey: false,
    shiftKey: extra.shiftKey ?? false,
    preventDefault() {},
  })
}

dispatchPointer('pointerdown', 100, 120)
dispatchPointer('pointerup', 106, 120)
let snap = input.snapshot()
check('a 6px press is a click, not a box', snap.pointer.clicks.length === 1 && snap.pointer.drags.length === 0 && snap.pointer.dragRect === null)
input.endFrame()

dispatchPointer('pointerdown', 100, 120)
dispatchPointer('pointermove', 107, 120)
snap = input.snapshot()
const live = snap.pointer.dragRect
const expectedStart = ndcOf(100, 120)
const expectedMid = ndcOf(107, 120)
check(
  'passing the slop starts a left-button drag rect',
  live !== null &&
    live.button === 'left' &&
    live.shiftKey === false &&
    Math.abs(live.startNdc.x - expectedStart.x) < 1e-9 &&
    Math.abs(live.startNdc.y - expectedStart.y) < 1e-9 &&
    Math.abs(live.currentNdc.x - expectedMid.x) < 1e-9 &&
    Math.abs(live.currentNdc.y - expectedMid.y) < 1e-9,
  JSON.stringify(live),
)
input.endFrame()

dispatchPointer('pointerup', 180, 200, { shiftKey: true })
snap = input.snapshot()
const finished = snap.pointer.drags[0]
const expectedEnd = ndcOf(180, 200)
check('release ends the drag and does not also click', snap.pointer.clicks.length === 0 && snap.pointer.drags.length === 1 && snap.pointer.dragRect === null)
check(
  'the finished rect keeps the press point, the release point, and shift',
  finished !== undefined &&
    finished.shiftKey === true &&
    finished.button === 'left' &&
    Math.abs(finished.startNdc.x - expectedStart.x) < 1e-9 &&
    Math.abs(finished.currentNdc.x - expectedEnd.x) < 1e-9 &&
    Math.abs(finished.currentNdc.y - expectedEnd.y) < 1e-9,
  JSON.stringify(finished),
)
input.endFrame()
check('drags are cleared on the next frame', input.snapshot().pointer.drags.length === 0)
input.endFrame()

windowStub.dispatch('keydown', { code: 'KeyC' })
dispatchPointer('pointerdown', 20, 20)
dispatchPointer('pointermove', 60, 20)
snap = input.snapshot()
check('C held at the press is recorded on the drag', snap.pointer.dragRect?.held.has('KeyC') === true)
windowStub.dispatch('keyup', { code: 'KeyC' })
dispatchPointer('pointerup', 60, 20)
snap = input.snapshot()
check(
  'C stays on the gesture after it is released',
  snap.pointer.drags[0]?.held.has('KeyC') === true && snap.pointer.clicks.length === 0,
)
input.endFrame()

dispatchPointer('pointerdown', 20, 20)
dispatchPointer('pointermove', 40, 20)
windowStub.dispatch('keydown', { code: 'KeyC' })
windowStub.dispatch('keyup', { code: 'KeyC' })
snap = input.snapshot()
check('C tapped mid-drag is on the live rect', snap.pointer.dragRect?.held.has('KeyC') === true)
dispatchPointer('pointerup', 40, 20)
snap = input.snapshot()
check('C tapped mid-drag is still on the release', snap.pointer.drags[0]?.held.has('KeyC') === true)
input.endFrame()

dispatchPointer('pointerdown', 10, 10, { button: 2 })
dispatchPointer('pointermove', 80, 10, { button: 2 })
dispatchPointer('pointerup', 80, 10, { button: 2 })
snap = input.snapshot()
check('a right-drag is not a selection box or a click', snap.pointer.dragRect === null && snap.pointer.drags.length === 0 && snap.pointer.clicks.length === 0)
input.endFrame()

dispatchPointer('pointerdown', 30, 30)
dispatchPointer('pointermove', 90, 90)
windowStub.dispatch('blur', {})
snap = input.snapshot()
check('losing focus cancels the box without selecting', snap.pointer.dragRect === null && snap.pointer.drags.length === 0)
input.endFrame()

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nall rubber-band checks passed')
