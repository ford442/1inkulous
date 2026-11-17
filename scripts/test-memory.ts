/**
 * The core's linear memory is sized, not left to grow. Growing it is not free:
 * it replaces every typed-array view over the heap (the instance buffers the
 * renderer reads each frame) and can stall a frame while the browser copies.
 * So the opening village, and the worst a match can ask of the planet — a full
 * tribe and as many huts as will stand, all of them sent across the world —
 * must fit in the heap the module starts with.
 *
 * It also reports how much heap that actually took, which is the number
 * INITIAL_MEMORY is sized from (cpp/CMakeLists.txt): build with a small
 * -DCORE_INITIAL_MEMORY plus linear growth and the final size is the footprint.
 *
 * And it holds the other half of the bargain: the module declares a ceiling, so
 * a leak aborts instead of growing without limit.
 *
 * Run: npm run test:memory   (after npm run build:wasm)
 */
import type { Vec3 } from '../src/engine/math.ts'
import { createGame } from '../src/game/game.ts'
import { createPlanet } from '../src/game/planet.ts'
import { createTerrain } from '../src/game/terrain.ts'
import { createSimulation, type Simulation } from '../src/sim/simulation.ts'
import { coreDir } from './core-dir.mjs'
import { readMemoryLimitsFile } from './wasm-memory.mjs'

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

/** Mirror kMaxFollowers and kMaxHuts in cpp/include/1inkulous/. */
const MAX_FOLLOWERS = 1024
const MAX_HUTS = 256

const MB = 1024 * 1024
const megabytes = (bytes: number) => `${(bytes / MB).toFixed(2)}MB`

/**
 * A watch on the heap. Growing linear memory detaches the old ArrayBuffer and
 * installs a new one, so identity is a complete test for "did it grow".
 */
function watchHeap(simulation: Simulation) {
  const initial = simulation.module.HEAPU8.buffer
  const initialBytes = initial.byteLength
  return {
    initialBytes,
    grew: () => simulation.module.HEAPU8.buffer !== initial,
    bytes: () => simulation.module.HEAPU8.byteLength,
  }
}

const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2])
  return [v[0] / length, v[1] / length, v[2] / length]
}

function runSeconds(simulation: Simulation, seconds: number): void {
  for (let i = 0; i < seconds * 20; i += 1) simulation.tick(50)
}

function selectAll(simulation: Simulation): void {
  for (let id = 0; id < simulation.followerCount; id += 1) {
    simulation.setFollowerSelected(id, true)
  }
}

// --- what the binary declares --------------------------------------------

{
  const limits = readMemoryLimitsFile(`${coreDir()}/core.wasm`)
  check('the module declares its memory', limits !== null)
  check('and a ceiling, so a leak aborts instead of growing the tab',
    limits?.maximumBytes != null && limits.maximumBytes <= 256 * MB,
    limits ? `${megabytes(limits.initialBytes)} initial, ${limits.maximumBytes === null ? 'no maximum' : megabytes(limits.maximumBytes) + ' maximum'}` : '')
}

// --- the opening village --------------------------------------------------

{
  const simulation = await createSimulation()
  const heap = watchHeap(simulation)
  const game = createGame(simulation)

  check('the opening village is on the planet',
    game.followers.count > 0 && simulation.navReady,
    `${game.followers.count} followers, ${game.huts.count} huts`)

  // Send everyone to the far side, sculpt under them, and let it play out.
  selectAll(simulation)
  const home = game.followers.homeDirection ?? ([0, 0, 1] as Vec3)
  const away = normalize([-home[0], -home[1], -home[2]])
  const routed = simulation.orderFollowerMove(away)
  game.terrain.sculpt(home, 0.12, 0.01)
  game.terrain.flatten(away, 0.1, 0.01, 0.01)
  runSeconds(simulation, 30)
  game.terrain.syncMesh()

  check('the whole tribe took the order', routed > 0, `${routed} routed`)
  check('the opening village never grows the heap', !heap.grew(),
    `${megabytes(heap.initialBytes)} initial, ${megabytes(heap.bytes())} after 30s`)
}

// --- the worst case ---------------------------------------------------------

/**
 * A full tribe and as many huts as the planet takes, all ordered across the
 * world. The default planet is too small to hold kMaxHuts (the footprints run
 * out of land first), so a planet at twice its resolution covers the ceiling.
 */
async function fillToTheCaps(resolution: number, label: string, wantAllHuts: boolean) {
  const simulation = await createSimulation()
  const heap = watchHeap(simulation)
  const planet = createPlanet({ resolution })
  const terrain = createTerrain(planet, simulation)
  const { graph } = terrain

  // Land nodes, spread out: where followers stand and huts could go.
  const land: Vec3[] = []
  const heights = simulation.navHeights()
  for (let node = 0; node < graph.nodeCount; node += 1) {
    if (heights[node] > 0) {
      land.push([
        graph.directions[node * 3],
        graph.directions[node * 3 + 1],
        graph.directions[node * 3 + 2],
      ])
    }
  }
  check(`${label}: there is land to fill`, land.length > MAX_HUTS, `${land.length} land nodes`)

  // Level the ground first, so the hut sites are not refused for slope.
  for (const direction of land) {
    terrain.flatten(direction, 0.06, planet.maxHeight * 0.1, planet.maxHeight)
  }
  terrain.syncMesh()

  let huts = 0
  for (let i = 0; i < land.length && huts < MAX_HUTS; i += 1) {
    if (simulation.placeHut(land[i], land[(i + 1) % land.length], i % 4) >= 0) huts += 1
  }
  check(`${label}: huts fill ${wantAllHuts ? 'to the ceiling' : 'the land'}`,
    simulation.hutCount === huts && (wantAllHuts ? huts === MAX_HUTS : huts > 0),
    `${huts} of ${MAX_HUTS}`)

  for (let i = 0; simulation.followerCount < MAX_FOLLOWERS; i += 1) {
    if (simulation.spawnFollower(land[(i * 7) % land.length], i % 4) < 0) break
  }
  check(`${label}: the tribe fills to the ceiling`, simulation.followerCount === MAX_FOLLOWERS,
    `${simulation.followerCount} followers`)

  // One search each for the whole tribe, then the long steady state.
  selectAll(simulation)
  const far = land[Math.floor(land.length / 2)]
  const routed = simulation.orderFollowerMove(normalize([-far[0], -far[1], -far[2]]))
  runSeconds(simulation, 20)

  check(`${label}: a full tribe routes`, routed > 0, `${routed} of ${simulation.followerCount}`)
  check(`${label}: never grows the heap`, !heap.grew(),
    `${megabytes(heap.initialBytes)} initial, ${megabytes(heap.bytes())} after`)
}

await fillToTheCaps(24, 'default planet', false)
await fillToTheCaps(48, 'twice the resolution', true)

if (failures.length > 0) {
  console.error(`\n${failures.length} memory check(s) failed`)
  process.exit(1)
}
console.log('\nall memory checks passed')
