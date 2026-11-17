/**
 * The core owns the terrain. The brush, driven by synthetic input, edits the
 * core; the graph sees the edit at once, a follower's feet on the next step,
 * and the planet mesh on the frame-end sync — every duplicate vertex along the
 * seams included. Picking reads the core on the walkers' own triangles, so the
 * ground a click lands on is the ground a follower sent there stands on.
 *
 * Run: npm run test:terrain   (after npm run build:wasm)
 */
import { mat4LookAt, type Vec3 } from '../src/engine/math.ts'
import { screenRay, worldToNdc } from '../src/engine/picking.ts'
import { createFollowers } from '../src/game/followers.ts'
import { createPlanet } from '../src/game/planet.ts'
import { createSculptor } from '../src/game/sculpt.ts'
import { createTerrain } from '../src/game/terrain.ts'
import type { InputSnapshot, PointerSnapshot } from '../src/input/input.ts'
import { createSimulation } from '../src/sim/simulation.ts'
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

const simulation = await createSimulation()
const planet = createPlanet()
const generated = Float32Array.from(planet.mesh.heights)
const terrain = createTerrain(planet, simulation)
// Six people to stand on the ground and be sent across it.
createFollowers(terrain, simulation, { spawnCount: 6, shamanTribe: null })
const { mesh } = planet

const meshMatchesCore = () => {
  const heights = simulation.navHeights()
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    if (mesh.heights[v] !== heights[mesh.weldIds[v]]) return false
  }
  return true
}

// --- seeded once ------------------------------------------------------------

check('after load the core holds the generated field',
  simulation.navHeights().every((h, node) => h === generated[terrain.graph.nodeVertex[node]]))
check('and the mesh is a view of it, seams and all', meshMatchesCore())
check('with nothing dirty to copy yet', terrain.syncMesh() === 0)

const probe = normalize([0.31, -0.42, 0.85])
check('planet height queries read the core',
  planet.heightAt(probe) === simulation.terrainHeightAt(probe) &&
    planet.isWaterAt(probe) === simulation.terrainHeightAt(probe) <= 0)

// --- the brush ---------------------------------------------------------------

const followerAt = (id: number): { dir: Vec3; radius: number } => {
  const data = simulation.followerInstances()
  const base = id * simulation.followerInstanceFloats
  const p: Vec3 = [data[base], data[base + 1], data[base + 2]]
  return { dir: normalize(p), radius: Math.hypot(p[0], p[1], p[2]) }
}

const target = followerAt(0)
const eye: Vec3 = [target.dir[0] * 3, target.dir[1] * 3, target.dir[2] * 3]
const helper: Vec3 = Math.abs(target.dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
const camera = { eye, viewMatrix: mat4LookAt(eye, [0, 0, 0], helper), fovY: Math.PI / 4 }
const view = { camera, aspect: CANVAS_ASPECT }
const ndcOf = (direction: Vec3) =>
  worldToNdc(camera, planet.surfacePointAt(direction), CANVAS_ASPECT)!

function pointer(partial: Partial<PointerSnapshot> = {}): PointerSnapshot {
  return {
    position: { x: 0, y: 0 },
    ndc: ndcOf(target.dir),
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

const input = (keys: string[], partial: Partial<PointerSnapshot>): InputSnapshot =>
  ({ keys: new Set(keys), pressed: new Set(), pointer: pointer(partial) }) as InputSnapshot

const sculptor = createSculptor(terrain)
const heightBefore = simulation.terrainHeightAt(target.dir)
const revisionBefore = mesh.revision

// Hold C and drag a little across the follower, raising.
const start = ndcOf(target.dir)
for (let frame = 0; frame < 20; frame += 1) {
  const ndc = { x: start.x + (frame - 10) * 0.002, y: start.y }
  sculptor.update(16, input(['KeyC'], { ndc, buttons: { left: true, middle: false, right: false } }), view)
}
const heightAfter = simulation.terrainHeightAt(target.dir)
check('C and a left drag raise the ground in the core', sculptor.mode === 'raise' && heightAfter > heightBefore + 1e-3,
  `${heightBefore.toFixed(4)} -> ${heightAfter.toFixed(4)}`)
check('the mesh has not been touched by the stroke itself', mesh.revision === revisionBefore)
check('and picks it up on the frame-end sync', terrain.syncMesh() > 0 && mesh.revision > revisionBefore &&
  meshMatchesCore())
check('which then has nothing left to do', terrain.syncMesh() === 0)

check('the follower stands where she stood until the core steps', followerAt(0).radius === target.radius)
simulation.tick(50)
const lifted = followerAt(0)
check('then her feet are on the new ground',
  Math.abs(lifted.radius - (planet.radius + simulation.terrainHeightAt(lifted.dir))) < 1e-5 &&
    lifted.radius > target.radius + 1e-3,
  `radius ${target.radius.toFixed(4)} -> ${lifted.radius.toFixed(4)}`)

// Right button digs; dig deep enough and the graph loses the ground.
const node = simulation.module._core_nav_nearest_walkable(...lifted.dir)
for (let frame = 0; frame < 120; frame += 1) {
  sculptor.update(50, input(['KeyC'], { ndc: ndcOf(lifted.dir), buttons: { left: false, middle: false, right: true } }), view)
}
terrain.syncMesh()
check('C and a right drag lower it to the sea', sculptor.mode === 'lower' &&
  simulation.terrainHeightAt(lifted.dir) === 0 && planet.isWaterAt(lifted.dir))
check('and the graph knows it at once',
  simulation.module._core_nav_nearest_walkable(...lifted.dir) !== node)
check('as does the mesh', meshMatchesCore())

// Shift flattens towards where the stroke began.
const pad = normalize([lifted.dir[0] + 0.1, lifted.dir[1], lifted.dir[2] + 0.05])
const padLevel = simulation.terrainHeightAt(pad)
for (let frame = 0; frame < 200; frame += 1) {
  sculptor.update(50, input(['KeyC', 'ShiftLeft'], { ndc: ndcOf(pad), buttons: { left: true, middle: false, right: false } }), view)
}
terrain.syncMesh()
const padNode = simulation.module._core_nav_nearest_walkable(...pad)
const { neighborOffsets, neighbors } = terrain.graph
const nodeDir = (n: number): Vec3 => [
  terrain.graph.directions[n * 3],
  terrain.graph.directions[n * 3 + 1],
  terrain.graph.directions[n * 3 + 2],
]
// The pad node and its neighbours that sit well inside the brush; cells here
// are about as wide as the brush, so some neighbours fall outside it.
const padRing = [padNode]
for (let link = neighborOffsets[padNode]; link < neighborOffsets[padNode + 1]; link += 1) {
  if (angle(nodeDir(neighbors[link]), pad) < sculptor.brushRadius * 0.8) padRing.push(neighbors[link])
}
const level = simulation.navHeights()[padNode]
check('C with Shift flattens a level pad', sculptor.mode === 'flatten' && padNode >= 0 &&
  padRing.length > 3 && padRing.every((n) => simulation.navHeights()[n] === level),
  `${padRing.length} nodes at ${level.toFixed(5)}`)
// The target is read where the stroke's first pick landed, a hair from `pad`.
check('at the height where the stroke began', Math.abs(level - padLevel) < 1e-3,
  `${padLevel.toFixed(5)} -> ${level.toFixed(5)}`)
check('and the mesh draws the same pad', meshMatchesCore())

// --- a click and a path agree -----------------------------------------------

// Somewhere on dry, open ground a little way off, clear of the hole just dug.
const heights = simulation.navHeights()
let goalNode = -1
for (let n = 0; n < terrain.graph.nodeCount && goalNode < 0; n += 1) {
  const d = nodeDir(n)
  const away = angle(d, lifted.dir)
  if (away < 0.25 || away > 0.4 || heights[n] <= 0) continue
  let open = true
  for (let link = neighborOffsets[n]; link < neighborOffsets[n + 1]; link += 1) {
    if (heights[neighbors[link]] <= 0) open = false
  }
  if (open && simulation.module._core_nav_route(...followerAt(1).dir, ...d, 0) > 0) goalNode = n
}
const goal = nodeDir(goalNode)
// A little off the node, so the height is read inside a triangle.
const clickAt = ndcOf(normalize([goal[0] + 0.01, goal[1] - 0.007, goal[2]]))
const ray = screenRay(camera, clickAt.x, clickAt.y, CANVAS_ASPECT)
const picked = planet.pickDirection(ray)!
const surface = planet.surfacePointAt(picked)
const toPoint: Vec3 = [surface[0] - ray.origin[0], surface[1] - ray.origin[1], surface[2] - ray.origin[2]]
const offRay = Math.hypot(...toPoint) * Math.sin(angle(toPoint, ray.direction))
check('a pick lands on the core\'s surface', picked !== null && offRay < 1e-4,
  `${offRay.toExponential(2)} off the ray`)

simulation.clearFollowerSelection()
simulation.setFollowerSelected(1, true)
check('a follower ordered there routes', simulation.orderFollowerMove(picked) === 1)
for (let i = 0; i < 30 * 20; i += 1) simulation.tick(50)
const arrived = followerAt(1)
check('arrives', angle(arrived.dir, picked) < 0.01, `${angle(arrived.dir, picked).toFixed(4)} rad off`)
check('and stands at the height the click read',
  Math.abs(arrived.radius - (planet.radius + planet.heightAt(arrived.dir))) < 1e-5,
  `${(arrived.radius - planet.radius).toFixed(5)} vs ${planet.heightAt(arrived.dir).toFixed(5)}`)

if (failures.length > 0) {
  console.error(`\n${failures.length} terrain check(s) failed`)
  process.exit(1)
}
console.log('\nall terrain checks passed')
