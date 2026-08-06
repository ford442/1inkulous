#!/usr/bin/env node
//
// Headless checks for the WebAssembly simulation core, run with:
//   npm run test:core            (after npm run build:wasm)
//
// Exercises the module through the same Emscripten glue the browser loads, so a
// regression in the C ABI, the fixed-step clock, or the export list fails here
// rather than in the game loop. Exits non-zero on failure, for CI.

import { existsSync } from 'node:fs'

const GLUE = new URL('../src/wasm/core.js', import.meta.url)
if (!existsSync(GLUE)) {
  console.error('error: src/wasm/core.js is missing. Run `npm run build:wasm` first.')
  process.exit(1)
}

const { default: createCoreModule } = await import(GLUE.href)

const out = []
const ok = (name, pass, detail = '') => out.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)

const m = await createCoreModule()
const version = m.UTF8ToString(m._core_version_text())
ok('version string', version === '0.2.0', version)
ok('encoded version matches', m._core_version() === 200, String(m._core_version()))

// default step
m._core_init(0)
ok('default step is 50ms (20Hz)', m._core_step_ms() === 50, String(m._core_step_ms()))
ok('starts at zero', m._core_step_count() === 0 && m._core_elapsed_ms() === 0)

// a frame shorter than one step runs nothing but accumulates
ok('short frame runs no steps', m._core_tick(16.7) === 0)
ok('short frame accumulates', Math.abs(m._core_pending_ms() - 16.7) < 1e-9, String(m._core_pending_ms()))
// three 16.7ms frames = 50.1ms -> exactly one step
m._core_tick(16.7)
ok('third short frame yields one step', m._core_tick(16.7) === 1)
ok('elapsed is whole steps only', m._core_elapsed_ms() === 50, String(m._core_elapsed_ms()))
ok('remainder carried', Math.abs(m._core_pending_ms() - 0.1) < 1e-9, String(m._core_pending_ms()))

// a long frame runs several steps
m._core_reset()
ok('reset clears', m._core_step_count() === 0 && m._core_pending_ms() === 0)
ok('220ms frame runs 4 steps with 20ms carried', m._core_tick(220) === 4 && Math.abs(m._core_pending_ms() - 20) < 1e-9,
   `${m._core_pending_ms()}ms pending`)

// stall guard
m._core_reset()
const stalled = m._core_tick(60_000)
ok('60s stall is capped, not replayed', stalled === 5, `${stalled} steps (cap 250ms / 50ms)`)

// garbage input is ignored
m._core_reset()
ok('negative delta ignored', m._core_tick(-100) === 0 && m._core_pending_ms() === 0)
ok('NaN delta ignored', m._core_tick(NaN) === 0 && m._core_pending_ms() === 0)
ok('Infinity delta capped', m._core_tick(Infinity) === 5)

// simulated time tracks real time over a long run at a fixed frame rate
m._core_init(50)
let steps = 0
for (let i = 0; i < 600; i += 1) steps += m._core_tick(16.6667) // 10s at 60fps
ok('10s at 60fps yields 200 steps', steps === 200, `${steps} steps, ${m._core_elapsed_ms()}ms simulated`)

// custom step length
m._core_init(10)
ok('custom step honoured', m._core_step_ms() === 10 && m._core_tick(100) === 10)

// re-init resets the clock
m._core_init(0)
ok('re-init resets clock', m._core_step_count() === 0 && m._core_step_ms() === 50)

// linear memory is reachable for future bulk reads
ok('heap views exposed', m.HEAPF32 instanceof Float32Array && m.HEAPU8.byteLength > 0,
   `${(m.HEAPU8.byteLength / 1024 / 1024).toFixed(0)}MB linear memory`)

// ---------------------------------------------------------------------------
// Navigation and followers.
//
// The real graph is the planet mesh's welded vertex grid, built in TypeScript.
// Here we stand in a plain lat/long patch of the same shape — unit directions,
// 8-way links, one height per node — which exercises the same code paths in the
// core without dragging the mesh into Node.

const GRID = 17            // nodes per side
const SPAN = 0.8           // radians covered, in both directions
const RADIUS = 1
const LAND = 0.02          // height of ordinary ground

const nodeAt = (i, j) => j * GRID + i

function gridDirection(i, j) {
  const lon = (i / (GRID - 1) - 0.5) * SPAN
  const lat = (j / (GRID - 1) - 0.5) * SPAN
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]
}

function buildGrid() {
  const nodeCount = GRID * GRID
  const directions = new Float32Array(nodeCount * 3)
  const heights = new Float32Array(nodeCount).fill(LAND)
  const offsets = new Int32Array(nodeCount + 1)
  const links = []

  for (let j = 0; j < GRID; j += 1) {
    for (let i = 0; i < GRID; i += 1) {
      const node = nodeAt(i, j)
      const [x, y, z] = gridDirection(i, j)
      directions[node * 3] = x
      directions[node * 3 + 1] = y
      directions[node * 3 + 2] = z

      for (let dj = -1; dj <= 1; dj += 1) {
        for (let di = -1; di <= 1; di += 1) {
          if (di === 0 && dj === 0) continue
          const ni = i + di
          const nj = j + dj
          if (ni < 0 || nj < 0 || ni >= GRID || nj >= GRID) continue
          links.push(nodeAt(ni, nj))
        }
      }
      offsets[node + 1] = links.length
    }
  }

  return { nodeCount, directions, heights, offsets, neighbors: Int32Array.from(links) }
}

const grid = buildGrid()

function uploadGrid(heights) {
  m._core_nav_alloc(grid.nodeCount, grid.neighbors.length)
  m.HEAPF32.set(grid.directions, m._core_nav_directions() >> 2)
  m.HEAP32.set(grid.offsets, m._core_nav_neighbor_offsets() >> 2)
  m.HEAP32.set(grid.neighbors, m._core_nav_neighbors() >> 2)
  m.HEAPF32.set(heights, m._core_nav_heights() >> 2)
  m._core_nav_commit(RADIUS, 0.55)
}

/** Overwrites the core's heights in place, the way a sculpt stroke does. */
const writeHeights = (heights) => m.HEAPF32.set(heights, m._core_nav_heights() >> 2)

function instances() {
  const count = m._core_follower_count()
  const stride = m._core_follower_instance_floats()
  const start = m._core_follower_instances() >> 2
  return { count, stride, data: m.HEAPF32.subarray(start, start + count * stride) }
}

function followerPosition(id) {
  const { data, stride } = instances()
  return [data[id * stride], data[id * stride + 1], data[id * stride + 2]]
}

const isWalking = (id) => {
  const { data, stride } = instances()
  return (data[id * stride + 7] & 2) !== 0
}

const angleTo = (a, b) => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const la = Math.hypot(...a)
  const lb = Math.hypot(...b)
  return Math.acos(Math.max(-1, Math.min(1, dot / (la * lb))))
}

/** Runs the clock, reporting the largest and smallest radius seen on the way. */
function simulate(seconds, id) {
  let minRadius = Infinity
  let maxRadius = 0
  const frames = Math.ceil((seconds * 1000) / 200)
  for (let frame = 0; frame < frames; frame += 1) {
    m._core_tick(200)
    if (id !== undefined) {
      const r = Math.hypot(...followerPosition(id))
      minRadius = Math.min(minRadius, r)
      maxRadius = Math.max(maxRadius, r)
    }
  }
  return { minRadius, maxRadius }
}

m._core_init(0)
m._core_followers_clear()
uploadGrid(grid.heights)

ok('nav graph accepted', m._core_nav_ready() === 1 && m._core_nav_node_count() === grid.nodeCount,
   `${m._core_nav_node_count()} nodes, ${grid.neighbors.length} links`)

// The CSR topology arrives as raw memory, and find_path indexes the neighbour
// list with the range between two offsets. A malformed table has to be caught at
// commit time, not read past the end of the buffer.
m._core_nav_alloc(grid.nodeCount, grid.neighbors.length)
m.HEAPF32.set(grid.directions, m._core_nav_directions() >> 2)
m.HEAP32.set(grid.neighbors, m._core_nav_neighbors() >> 2)
const brokenOffsets = Int32Array.from(grid.offsets)
brokenOffsets[brokenOffsets.length - 1] = grid.neighbors.length * 4
m.HEAP32.set(brokenOffsets, m._core_nav_neighbor_offsets() >> 2)
m._core_nav_commit(RADIUS, 0.55)
ok('an offset table running past the neighbour list is refused', m._core_nav_ready() === 0)

const backwardsOffsets = Int32Array.from(grid.offsets)
backwardsOffsets[5] = backwardsOffsets[4] - 1
m.HEAP32.set(backwardsOffsets, m._core_nav_neighbor_offsets() >> 2)
m._core_nav_commit(RADIUS, 0.55)
ok('an offset table that goes backwards is refused', m._core_nav_ready() === 0)

// Back to the real thing.
uploadGrid(grid.heights)
ok('a well-formed graph is accepted again', m._core_nav_ready() === 1)

const centre = gridDirection((GRID - 1) / 2, (GRID - 1) / 2)
ok('nearest walkable node found', m._core_nav_nearest_walkable(...centre) === nodeAt(8, 8),
   String(m._core_nav_nearest_walkable(...centre)))

// spawn, select, order
const corner = gridDirection(1, 1)
const far = gridDirection(GRID - 2, GRID - 2)
const id = m._core_follower_spawn(...corner, 0)
ok('follower spawned', id === 0 && m._core_follower_count() === 1, `id ${id}`)
// Read back before any fixed step has run: the instance buffer has to be sized
// at spawn time, or this reads past the end of it.
ok('spawns on its node, readable before the first step',
   angleTo(followerPosition(id), corner) < 1e-5)
ok('instance stride is 8 floats', m._core_follower_instance_floats() === 8)

ok('nothing selected yet', m._core_follower_selected_count() === 0)
ok('order with no selection routes nobody', m._core_follower_order_move(...far) === 0)

m._core_follower_set_selected(id, 1)
ok('selection flag set', m._core_follower_selected_count() === 1 && (instances().data[7] & 1) === 1)

ok('move order finds a route', m._core_follower_order_move(...far) === 1)
ok('walking flag set', isWalking(id))

// The trip is ~1.1 radians at 0.06 units/s; 30s is comfortably enough.
const flat = simulate(30, id)
ok('arrives at the destination', angleTo(followerPosition(id), far) < 0.02,
   `${angleTo(followerPosition(id), far).toFixed(4)} rad short`)
ok('stops on arrival', !isWalking(id))
ok('stays on the surface, never through the core',
   Math.abs(flat.minRadius - (RADIUS + LAND)) < 1e-3 && Math.abs(flat.maxRadius - (RADIUS + LAND)) < 1e-3,
   `radius ${flat.minRadius.toFixed(4)}..${flat.maxRadius.toFixed(4)}`)

// The follower now stands on the far side. A channel of water down the middle
// cuts it off from where it came.
const flooded = Float32Array.from(grid.heights)
for (let j = 0; j < GRID; j += 1) flooded[nodeAt(8, j)] = 0
writeHeights(flooded)
ok('a channel of water blocks the route back', m._core_follower_order_move(...corner) === 0)

// A wall of cliff does the same, without any water: it is the slope that stops
// them, not the shoreline.
const walled = Float32Array.from(grid.heights)
for (let j = 0; j < GRID; j += 1) walled[nodeAt(8, j)] = 0.4
writeHeights(walled)
ok('a cliff blocks the route back', m._core_follower_order_move(...corner) === 0)

// A gentle rise of the same shape is walkable, and the follower's feet should
// climb it rather than cutting the chord.
const ramped = Float32Array.from(grid.heights)
for (let j = 0; j < GRID; j += 1) {
  ramped[nodeAt(7, j)] = LAND + 0.005
  ramped[nodeAt(8, j)] = LAND + 0.01
  ramped[nodeAt(9, j)] = LAND + 0.005
}
writeHeights(ramped)
ok('a gentle rise is walkable', m._core_follower_order_move(...corner) === 1)
const ramp = simulate(40, id)
ok('crosses the rise and arrives', angleTo(followerPosition(id), corner) < 0.02,
   `${angleTo(followerPosition(id), corner).toFixed(4)} rad short`)
ok('follows the ground over the rise',
   ramp.maxRadius > RADIUS + LAND + 0.009 && ramp.minRadius > RADIUS + LAND - 1e-3,
   `radius ${ramp.minRadius.toFixed(4)}..${ramp.maxRadius.toFixed(4)}`)

// Water that stops one row short of the edge: no straight line through, but a
// way round the end of it.
const gapped = Float32Array.from(grid.heights)
for (let j = 0; j < GRID - 1; j += 1) gapped[nodeAt(8, j)] = 0
writeHeights(gapped)

m._core_follower_clear_selection()
ok('selection cleared', m._core_follower_selected_count() === 0)
ok('an order with nobody selected routes nobody', m._core_follower_order_move(...far) === 0)
m._core_follower_set_selected(id, 1)

ok('routes around the water through the gap', m._core_follower_order_move(...far) === 1)
const detour = simulate(60, id)
ok('arrives by the long way', angleTo(followerPosition(id), far) < 0.02,
   `${angleTo(followerPosition(id), far).toFixed(4)} rad short`)
ok('never sets foot in the water', detour.minRadius > RADIUS + LAND * 0.5,
   `closest approach ${detour.minRadius.toFixed(5)}`)

// a crowd, which is what the renderer will be drawing
writeHeights(grid.heights)
m._core_followers_clear()
let spawned = 0
for (let j = 1; j < GRID - 1 && spawned < 64; j += 1) {
  for (let i = 1; i < GRID - 1 && spawned < 64; i += 1) {
    if (m._core_follower_spawn(...gridDirection(i, j), spawned % 4) >= 0) spawned += 1
  }
}
ok('64 followers spawned', m._core_follower_count() === 64, String(m._core_follower_count()))
for (let f = 0; f < 64; f += 1) m._core_follower_set_selected(f, 1)
ok('whole crowd routes at once', m._core_follower_order_move(...far) === 64)

const started = Date.now()
simulate(30)
const elapsed = Date.now() - started
ok('30s of 64 followers simulates in well under real time', elapsed < 3000, `${elapsed}ms`)
// Not just "stopped walking": a follower that gave up halfway would also have a
// clear flag, so check where each of them actually ended up.
ok('the crowd all arrived',
   Array.from({ length: 64 }, (_, f) =>
     !isWalking(f) && angleTo(followerPosition(f), far) < 0.02).every(Boolean))

const packed = instances()
ok('instance buffer is packed and sized', packed.data.length === 64 * 8)
ok('tribe survives the round trip', packed.data[6] === 0 && packed.data[8 + 6] === 1)

// ---------------------------------------------------------------------------
// Cost at the size the game actually runs at. The default planet is a 24-quad
// cube-sphere: 3458 welded nodes and a little over 26000 links. A 60x60 patch
// is the same order, and a mass order across its diagonal is the worst case —
// every follower runs its own full-width A*.

const BIG = 60
const bigNodes = BIG * BIG
const bigDirections = new Float32Array(bigNodes * 3)
const bigHeights = new Float32Array(bigNodes).fill(LAND)
const bigOffsets = new Int32Array(bigNodes + 1)
const bigLinks = []

for (let j = 0; j < BIG; j += 1) {
  for (let i = 0; i < BIG; i += 1) {
    const node = j * BIG + i
    const lon = (i / (BIG - 1) - 0.5) * 1.2
    const lat = (j / (BIG - 1) - 0.5) * 1.2
    bigDirections[node * 3] = Math.cos(lat) * Math.cos(lon)
    bigDirections[node * 3 + 1] = Math.sin(lat)
    bigDirections[node * 3 + 2] = Math.cos(lat) * Math.sin(lon)

    for (let dj = -1; dj <= 1; dj += 1) {
      for (let di = -1; di <= 1; di += 1) {
        if (di === 0 && dj === 0) continue
        const ni = i + di
        const nj = j + dj
        if (ni < 0 || nj < 0 || ni >= BIG || nj >= BIG) continue
        bigLinks.push(nj * BIG + ni)
      }
    }
    bigOffsets[node + 1] = bigLinks.length
  }
}

m._core_followers_clear()
m._core_nav_alloc(bigNodes, bigLinks.length)
m.HEAPF32.set(bigDirections, m._core_nav_directions() >> 2)
m.HEAP32.set(bigOffsets, m._core_nav_neighbor_offsets() >> 2)
m.HEAP32.set(Int32Array.from(bigLinks), m._core_nav_neighbors() >> 2)
m.HEAPF32.set(bigHeights, m._core_nav_heights() >> 2)
m._core_nav_commit(RADIUS, 0.55)

const corner3 = [bigDirections[0], bigDirections[1], bigDirections[2]]
const opposite = [
  bigDirections[(bigNodes - 1) * 3],
  bigDirections[(bigNodes - 1) * 3 + 1],
  bigDirections[(bigNodes - 1) * 3 + 2],
]

for (let f = 0; f < 60; f += 1) {
  m._core_follower_spawn(...corner3, 0)
  m._core_follower_set_selected(f, 1)
}

const orderStarted = process.hrtime.bigint()
const routed = m._core_follower_order_move(...opposite)
const orderMs = Number(process.hrtime.bigint() - orderStarted) / 1e6
ok('60 followers path across a 3600-node graph', routed === 60, `${orderMs.toFixed(1)}ms`)
ok('a mass order fits inside one frame', orderMs < 16, `${orderMs.toFixed(1)}ms for 60 searches`)

const stepStarted = process.hrtime.bigint()
for (let i = 0; i < 200; i += 1) m._core_tick(50)
const stepMs = Number(process.hrtime.bigint() - stepStarted) / 1e6
ok('200 steps of 60 walking followers are effectively free',
   stepMs < 20, `${stepMs.toFixed(1)}ms total, ${(stepMs / 200 * 1000).toFixed(0)}us per step`)

console.log(out.join('\n'))
const failed = out.filter((r) => r.startsWith('FAIL'))
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${out.length} checks passed`)
process.exit(failed.length ? 1 : 0)
