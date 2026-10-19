/**
 * The shaman, mana and Land Bridge, end to end: the real WebAssembly core,
 * the real planet and nav graph, and the game module driven by synthetic
 * input. The village is cut off by a moat; a bridge cast through the UI has
 * to raise walkable land across it that the next order uses, with no graph
 * rebuild, while every refused cast leaves the terrain exactly as it was.
 *
 * Run: npm run test:shaman   (after npm run build:wasm)
 */
import { mat4LookAt, type Vec3 } from '../src/engine/math.ts'
import { worldToNdc } from '../src/engine/picking.ts'
import { createFollowers } from '../src/game/followers.ts'
import { createPlanet } from '../src/game/planet.ts'
import { createShaman, PLAYER_TRIBE } from '../src/game/shaman.ts'
import type { InputSnapshot, PointerClick, PointerSnapshot } from '../src/input/input.ts'
import { LandBridge } from '../src/sim/landBridge.ts'
import { createSimulation } from '../src/sim/simulation.ts'
import { shamanLine } from '../src/ui/hud.ts'
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

/** Mirrors kFlagShaman in cpp/include/1inkulous/followers.hpp. */
const FLAG_SHAMAN = 1 << 2
const OFFSET_FLAGS = 7

const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2])
  return [v[0] / length, v[1] / length, v[2] / length]
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const angle = (a: Vec3, b: Vec3) =>
  Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))))

/** The point `distance` radians from unit `from` along unit tangent `toward`. */
const along = (from: Vec3, toward: Vec3, distance: number): Vec3 =>
  normalize([
    from[0] * Math.cos(distance) + toward[0] * Math.sin(distance),
    from[1] * Math.cos(distance) + toward[1] * Math.sin(distance),
    from[2] * Math.cos(distance) + toward[2] * Math.sin(distance),
  ])

const simulation = await createSimulation()
const planet = createPlanet()
// A small village, so the moat below can ring it without drowning anyone.
const followers = createFollowers(planet, simulation, { spawnCount: 8 })

let uploads = 0
const upload = simulation.uploadNavGraph
simulation.uploadNavGraph = (...args) => {
  uploads += 1
  upload(...args)
}

// --- the shaman ------------------------------------------------------------

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

const shamanAt = (): Vec3 => {
  const data = simulation.followerInstances()
  const base = simulation.shamanId(PLAYER_TRIBE) * simulation.followerInstanceFloats
  return normalize([data[base], data[base + 1], data[base + 2]])
}

// --- mana --------------------------------------------------------------------

check('mana starts empty', simulation.mana(PLAYER_TRIBE) === 0)
for (let i = 0; i < 20; i += 1) simulation.tick(50)
// Eight followers cycle the four tribes, so two are blue; she makes three.
check('a second of play pays each blue a second of mana',
  Math.abs(simulation.mana(PLAYER_TRIBE) - 3) < 1e-9 && simulation.manaIncome(PLAYER_TRIBE) === 3,
  `${simulation.mana(PLAYER_TRIBE)} mana, +${simulation.manaIncome(PLAYER_TRIBE)}/s`)
check('and the other tribes theirs', Math.abs(simulation.mana(1) - 2) < 1e-9, `${simulation.mana(1)}`)

// --- a moat round the village -------------------------------------------

const home = shamanAt()
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

// Level land well past the moat, so there is a far shore all the way round.
for (let i = 0; i < 20; i += 1) planet.flatten(home, 0.5, planet.maxHeight / 3, 1)
followers.syncTerrain()
const farShore = along(home, east, 0.28)
check('before the moat, the far shore is a walk away',
  simulation.module._core_nav_route(...home, ...farShore, 0) > 0)

const MOAT = 0.18
for (let k = 0; k < 64; k += 1) {
  const theta = (k / 64) * Math.PI * 2
  const tangent = normalize([
    east[0] * Math.cos(theta) + north[0] * Math.sin(theta),
    east[1] * Math.cos(theta) + north[1] * Math.sin(theta),
    east[2] * Math.cos(theta) + north[2] * Math.sin(theta),
  ])
  planet.sculpt(along(home, tangent, MOAT), 0.07, -1)
}
followers.syncTerrain()
for (let i = 0; i < 10; i += 1) simulation.tick(50)

check('the far shore is land', !planet.isWaterAt(farShore) && !planet.isWaterAt(home))
check('the moat between is water', planet.isWaterAt(along(home, east, MOAT)))
check('and no route crosses it',
  simulation.module._core_nav_route(...shamanAt(), ...farShore, 0) === -1)

// --- casting through the game module -------------------------------------

let focused: Vec3 | null = null
const eye: Vec3 = [home[0] * 3, home[1] * 3, home[2] * 3]
const camera = {
  eye,
  viewMatrix: mat4LookAt(eye, [0, 0, 0], north),
  fovY: Math.PI / 4,
  focusOn(direction: Vec3) {
    focused = direction
  },
}
const view = { camera, aspect: CANVAS_ASPECT }
const ndcOf = (direction: Vec3) => worldToNdc(camera, planet.surfacePointAt(direction), CANVAS_ASPECT)!

let synced = 0
const shaman = createShaman(planet, simulation, {
  syncTerrain: () => {
    synced += 1
    followers.syncTerrain()
  },
})

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

frame(['KeyF'])
check('F selects the shaman alone and looks at her',
  simulation.selectedFollowerCount === 1 && focused !== null && angle(focused, home) < 1e-3)

check('aiming starts off', !frame().targeting && shaman.preview === null)
frame(['KeyL'])
check('L aims a Land Bridge from her to the cursor',
  shaman.targeting && shaman.preview !== null && angle(shaman.preview.to, farShore) < 0.01 &&
    angle(shaman.preview.from, shamanAt()) < 1e-6)
check('which the core turns down for want of mana', shaman.preview?.result === LandBridge.noMana)
check('and the HUD says so', shamanLine(shaman).includes('not enough mana'), shamanLine(shaman))

const heights = Float32Array.from(planet.mesh.heights)
const revision = planet.mesh.revision
const unchanged = () =>
  planet.mesh.revision === revision && planet.mesh.heights.every((h, i) => h === heights[i])

const manaBefore = simulation.mana(PLAYER_TRIBE)
const poor = click('left', farShore)
const poorResult = frame([], { clicks: [poor] })
check('a cast with no mana is still a cast, not an order', poorResult.consumed.has(poor) && shaman.targeting)
check('but deforms nothing and spends nothing',
  unchanged() && synced === 0 && simulation.mana(PLAYER_TRIBE) === manaBefore,
  `${simulation.mana(PLAYER_TRIBE)} mana`)

simulation.setMana(PLAYER_TRIBE, simulation.manaMax)
const inside = along(home, north, 0.08)
check('a bridge over dry ground is refused',
  simulation.castLandBridge(PLAYER_TRIBE, home, inside).result === LandBridge.dry && unchanged())
check('so is one out of her reach',
  simulation.checkLandBridge(PLAYER_TRIBE, home, along(home, east, 0.45)) === LandBridge.outOfRange)
check('and neither touches the mana', simulation.mana(PLAYER_TRIBE) === simulation.manaMax)

const homeHeight = planet.heightAt(home)
const farHeight = planet.heightAt(farShore)
frame()
check('with mana in hand the preview turns good', shaman.preview?.result === LandBridge.ok)
const good = click('left', farShore)
const cast = frame([], { clicks: [good] })
check('a click casts it and stops aiming', cast.consumed.has(good) && !shaman.targeting)
check('the mana is spent',
  simulation.mana(PLAYER_TRIBE) === simulation.manaMax - simulation.landBridgeCost,
  `${simulation.mana(PLAYER_TRIBE)} left`)
check('the land rose', planet.mesh.revision > revision && !planet.isWaterAt(along(home, east, MOAT)),
  `${planet.heightAt(along(home, east, MOAT)).toFixed(4)} at the old moat`)
check('the higher ground at its ends was left alone',
  planet.heightAt(home) === homeHeight && Math.abs(planet.heightAt(farShore) - farHeight) < 1e-3,
  `${homeHeight.toFixed(4)} -> ${planet.heightAt(home).toFixed(4)} at her feet`)
check('the nav heights went to the core at once', synced === 1)

// --- shore to shore, by dragging ---------------------------------------------

simulation.setMana(PLAYER_TRIBE, simulation.manaMax)
const nearSide = along(home, north, 0.1)
const farSide = along(home, north, 0.28)
// The first bridge joined the island to the far shore, so the north is a walk
// away now — round by the east.
const detour = simulation.module._core_nav_route(...nearSide, ...farSide, 0)
check('the north is still across water', planet.isWaterAt(along(home, north, MOAT)) && detour > 0,
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
  shaman.preview !== null && angle(shaman.preview.from, nearSide) < 0.01 &&
    shaman.preview.result === LandBridge.ok)
const dragged = frame([], { ndc: drag.currentNdc, drags: [drag] })
const direct = simulation.module._core_nav_route(...nearSide, ...farSide, 0)
check('releasing it casts across', dragged.targeting && !shaman.targeting && synced === 2 &&
  !planet.isWaterAt(along(home, north, MOAT)))
check('and the walk north is straight over it', direct > 0 && direct * 2 < detour,
  `${detour} nodes -> ${direct}`)

// --- walking it ------------------------------------------------------------

const route = simulation.module._core_nav_route(...shamanAt(), ...farShore, 1)
check('a route crosses where the moat was', route > 0, `${route} legs`)
check('without the graph being rebuilt', uploads === 0)

const routed = simulation.orderFollowerMove(farShore)
check('the next order takes her over it', routed === 1)
for (let i = 0; i < 30 * 20; i += 1) simulation.tick(50)
check('and she gets there', angle(shamanAt(), farShore) < 0.04,
  `${(angle(shamanAt(), farShore) * planet.radius).toFixed(3)} from the far shore`)

if (failures.length > 0) {
  console.error(`\n${failures.length} shaman check(s) failed`)
  process.exit(1)
}
console.log('\nall shaman checks passed')
