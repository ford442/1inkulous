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
ok('version string', version === '0.3.0', version)
ok('encoded version matches', m._core_version() === 300, String(m._core_version()))

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

/** Mirrors kFollowerSpacing in cpp/include/1inkulous/followers.hpp. */
const SPACING = 0.024

/** Smallest distance between any two of `ids`, along the ground. */
function closestPair(ids) {
  const at = ids.map((f) => {
    const p = followerPosition(f)
    const r = Math.hypot(...p)
    return [p[0] / r, p[1] / r, p[2] / r]
  })
  let best = Infinity
  for (let a = 0; a < at.length; a += 1) {
    for (let b = a + 1; b < at.length; b += 1) {
      best = Math.min(best, angleTo(at[a], at[b]) * RADIUS)
    }
  }
  return best
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

// The neighbour ids index the per-node buffers just as directly.
m.HEAP32.set(grid.offsets, m._core_nav_neighbor_offsets() >> 2)
const strayNeighbors = Int32Array.from(grid.neighbors)
strayNeighbors[7] = grid.nodeCount + 3
m.HEAP32.set(strayNeighbors, m._core_nav_neighbors() >> 2)
m._core_nav_commit(RADIUS, 0.55)
ok('a neighbour id past the last node is refused', m._core_nav_ready() === 0)

// Back to the real thing.
uploadGrid(grid.heights)
ok('a well-formed graph is accepted again', m._core_nav_ready() === 1)

const centre = gridDirection((GRID - 1) / 2, (GRID - 1) / 2)
ok('nearest walkable node found', m._core_nav_nearest_walkable(...centre) === nodeAt(8, 8),
   String(m._core_nav_nearest_walkable(...centre)))

// The core keeps a direction hash so this is not a scan, but the answer has to
// be the scan's answer. The oracle below is that scan, over the directions this
// test already built — nothing is read back out of the module.
const WATER = 1e-6

function naiveNearestWalkable(directions, heights, x, y, z) {
  const len = Math.hypot(x, y, z)
  if (!(len > 0)) return -1
  const nx = x / len
  const ny = y / len
  const nz = z / len
  let best = -1
  let bestDot = -2
  for (let node = 0; node < heights.length; node += 1) {
    if (!(heights[node] > WATER)) continue
    const dot = directions[node * 3] * nx + directions[node * 3 + 1] * ny + directions[node * 3 + 2] * nz
    if (dot > bestDot) {
      bestDot = dot
      best = node
    }
  }
  return best
}

function checkNearest(name, directions, heights, samples) {
  let mismatches = 0
  let detail = `${samples.length} directions`
  for (const [x, y, z] of samples) {
    const got = m._core_nav_nearest_walkable(x, y, z)
    const expect = naiveNearestWalkable(directions, heights, x, y, z)
    if (got !== expect) {
      mismatches += 1
      if (mismatches === 1) detail = `got ${got}, scan ${expect}`
    }
  }
  ok(name, mismatches === 0, mismatches ? `${mismatches} mismatches — ${detail}` : detail)
}

let ownsDirection = true
let ownDetail = ''
for (let node = 0; node < grid.nodeCount; node += 1) {
  const x = grid.directions[node * 3]
  const y = grid.directions[node * 3 + 1]
  const z = grid.directions[node * 3 + 2]
  const got = m._core_nav_nearest_walkable(x, y, z)
  if (got !== node) {
    ownsDirection = false
    ownDetail = `node ${node} -> ${got}`
    break
  }
}
ok("nearest walkable of a node's own direction is that node", ownsDirection, ownDetail)

const patchSamples = []
for (let node = 0; node < grid.nodeCount; node += 4) {
  patchSamples.push([
    grid.directions[node * 3],
    grid.directions[node * 3 + 1],
    grid.directions[node * 3 + 2],
  ])
}
for (let j = 0; j < GRID; j += 2) {
  for (let i = 0; i < GRID - 1; i += 2) {
    const a = gridDirection(i, j)
    const b = gridDirection(i + 1, j)
    patchSamples.push([(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5])
  }
}
// Off the patch entirely, so the ring is empty and the scan fallback has to agree.
patchSamples.push([0, 1, 0], [0, 0, 1], [-1, 0.2, 0.3], [0.3, -0.9, 0.1])
checkNearest('nearest walkable matches a linear scan', grid.directions, grid.heights, patchSamples)

const floodedCentre = Float32Array.from(grid.heights)
floodedCentre[nodeAt(8, 8)] = 0
writeHeights(floodedCentre)
const waterDir = gridDirection(8, 8)
const waterHit = m._core_nav_nearest_walkable(...waterDir)
const waterOracle = naiveNearestWalkable(grid.directions, floodedCentre, ...waterDir)
const waterNeighbours = []
for (let dj = -1; dj <= 1; dj += 1) {
  for (let di = -1; di <= 1; di += 1) {
    if (di === 0 && dj === 0) continue
    waterNeighbours.push(nodeAt(8 + di, 8 + dj))
  }
}
ok('a water sample matches the linear scan', waterHit === waterOracle, `${waterHit} vs ${waterOracle}`)
ok('a water sample returns a neighbouring land node',
   waterNeighbours.includes(waterHit) && floodedCentre[waterHit] > WATER,
   String(waterHit))

writeHeights(new Float32Array(grid.nodeCount))
ok('open water has no walkable node', m._core_nav_nearest_walkable(...centre) === -1)
writeHeights(grid.heights)

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
// clear flag, so check where each of them actually ended up. The group gathers
// round the point rather than on it, a spot each.
const crowd = Array.from({ length: 64 }, (_, f) => f)
const crowdWalking = crowd.filter(isWalking).length
const crowdFurthest = Math.max(...crowd.map((f) => angleTo(followerPosition(f), far)))
ok('the crowd all arrived', crowdWalking === 0 && crowdFurthest < 0.3,
   `${crowdWalking} still walking, furthest ${crowdFurthest.toFixed(3)} rad out`)
ok('someone holds the point itself',
   crowd.some((f) => angleTo(followerPosition(f), far) < 0.01))
const crowdGap = closestPair(crowd)
ok('nobody in the crowd stands on anybody else', crowdGap > SPACING * 0.8,
   `closest pair ${crowdGap.toFixed(4)} apart, spacing ${SPACING}`)

const packed = instances()
ok('instance buffer is packed and sized', packed.data.length === 64 * 8)
ok('tribe survives the round trip', packed.data[6] === 0 && packed.data[8 + 6] === 1)

// ---------------------------------------------------------------------------
// Smoothing. A grid A* walks the links, so anything that is not a row, a column
// or a 45-degree diagonal comes out as a staircase. The core string-pulls the
// node route into straight legs; core_nav_route shows both.

/** Reads the route buffer the last route call filled. */
function readRoute(count) {
  const start = m._core_route_points() >> 2
  const points = []
  for (let k = 0; k < count; k += 1) {
    points.push(Array.from(m.HEAPF32.subarray(start + k * 3, start + k * 3 + 3)))
  }
  return points
}

/** Length along the ground of a polyline of directions, from `from`. */
function routeLength(from, points) {
  let total = 0
  let previous = from
  for (const point of points) {
    total += angleTo(previous, point) * RADIUS
    previous = point
  }
  return total
}

/** Unit direction `t` of the way along the great circle from a to b. */
function slerp(a, b, t) {
  const angle = angleTo(a, b)
  if (angle < 1e-12) return a
  const s = Math.sin(angle)
  const wa = Math.sin((1 - t) * angle) / s
  const wb = Math.sin(t * angle) / s
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]
}

/** Nearest node of any kind, by scan: the cell a direction falls in. */
function naiveNearest(x, y, z) {
  let best = -1
  let bestDot = -2
  for (let node = 0; node < grid.nodeCount; node += 1) {
    const dot = grid.directions[node * 3] * x + grid.directions[node * 3 + 1] * y +
      grid.directions[node * 3 + 2] * z
    if (dot > bestDot) {
      bestDot = dot
      best = node
    }
  }
  return best
}

/** Whether every leg of a route keeps out of cells whose node is in `wet`. */
function routeStaysDry(from, points, wet) {
  let previous = from
  for (const point of points) {
    for (let k = 0; k <= 64; k += 1) {
      if (wet(naiveNearest(...slerp(previous, point, k / 64)))) return false
    }
    previous = point
  }
  return true
}

writeHeights(grid.heights)
const kinkFrom = gridDirection(1, 1)
const kinkTo = gridDirection(15, 5)
const rawCount = m._core_nav_route(...kinkFrom, ...kinkTo, 0)
const rawRoute = readRoute(rawCount)
const smoothCount = m._core_nav_route(...kinkFrom, ...kinkTo, 1)
const smoothRoute = readRoute(smoothCount)
const straight = angleTo(kinkFrom, kinkTo) * RADIUS
ok('a grid route off the diagonal is a staircase of nodes', rawCount === 14,
   `${rawCount} nodes, ${(routeLength(kinkFrom, rawRoute) / straight * 100 - 100).toFixed(1)}% longer than straight`)
ok('string-pulled across open ground it is one straight leg', smoothCount === 1,
   `${smoothCount} waypoints`)
ok('and that leg is the great circle',
   Math.abs(routeLength(kinkFrom, smoothRoute) - straight) < 1e-4,
   `${routeLength(kinkFrom, smoothRoute).toFixed(4)} vs ${straight.toFixed(4)}`)

// Round the end of the water channel the follower took earlier: still fewer,
// longer legs than the node route, and none of them cut through the water.
writeHeights(gapped)
const dryFrom = gridDirection(2, 3)
const dryTo = gridDirection(14, 3)
const dryRaw = m._core_nav_route(...dryFrom, ...dryTo, 0)
const dryRawRoute = readRoute(dryRaw)
const drySmooth = m._core_nav_route(...dryFrom, ...dryTo, 1)
const drySmoothRoute = readRoute(drySmooth)
ok('a route round water smooths to a few legs', drySmooth > 0 && drySmooth <= 5 && drySmooth < dryRaw / 3,
   `${dryRaw} nodes -> ${drySmooth} waypoints`)
ok('the smoothed route is shorter than the node route',
   routeLength(dryFrom, drySmoothRoute) < routeLength(dryFrom, dryRawRoute) - 0.01,
   `${routeLength(dryFrom, drySmoothRoute).toFixed(3)} vs ${routeLength(dryFrom, dryRawRoute).toFixed(3)}`)
ok('no smoothed leg crosses a water cell',
   routeStaysDry(dryFrom, drySmoothRoute, (node) => gapped[node] <= WATER))

// Walking it: the follower keeps to the great circle instead of zig-zagging
// down the grid.
writeHeights(grid.heights)
m._core_followers_clear()
const walker = m._core_follower_spawn(...kinkFrom, 0)
m._core_follower_set_selected(walker, 1)
m._core_follower_order_move(...kinkTo)
const plane = (() => {
  const c = [
    kinkFrom[1] * kinkTo[2] - kinkFrom[2] * kinkTo[1],
    kinkFrom[2] * kinkTo[0] - kinkFrom[0] * kinkTo[2],
    kinkFrom[0] * kinkTo[1] - kinkFrom[1] * kinkTo[0],
  ]
  const l = Math.hypot(...c)
  return c.map((v) => v / l)
})()
let offLine = 0
for (let frame = 0; frame < 200 && isWalking(walker); frame += 1) {
  m._core_tick(200)
  const p = followerPosition(walker)
  const r = Math.hypot(...p)
  offLine = Math.max(offLine, Math.abs(p[0] * plane[0] + p[1] * plane[1] + p[2] * plane[2]) / r)
}
ok('a walker on a smoothed route keeps to the straight line', offLine < 1e-3,
   `strays ${offLine.toFixed(5)} rad at most`)
ok('and arrives on the point', !isWalking(walker) && angleTo(followerPosition(walker), kinkTo) < 1e-4)

// ---------------------------------------------------------------------------
// Separation. Followers have room of their own: put a dozen on one node and
// they shuffle apart, and two walking straight at each other step round.

/** Spawns one follower per [i, j] grid cell given, all tribe 0. */
const spawnAll = (cells) => cells.map(([i, j]) => m._core_follower_spawn(...gridDirection(i, j), 0))

function selectOnly(ids) {
  m._core_follower_clear_selection()
  for (const id of ids) m._core_follower_set_selected(id, 1)
}

m._core_followers_clear()
const stack = spawnAll(Array.from({ length: 12 }, () => [8, 8]))
ok('a dozen spawned on one node start on top of each other', closestPair(stack) < 1e-6)
simulate(5)
const stackGap = closestPair(stack)
ok('and spread out to their spacing', stackGap > SPACING * 0.9,
   `closest pair ${stackGap.toFixed(4)} apart`)
ok('without anyone setting off anywhere', stack.every((f) => !isWalking(f)))
ok('and stay a village, not a scatter',
   Math.max(...stack.map((f) => angleTo(followerPosition(f), gridDirection(8, 8)))) < SPACING * 4)

m._core_followers_clear()
const [westward, eastward] = spawnAll([[2, 8], [14, 8]])
selectOnly([westward])
m._core_follower_order_move(...gridDirection(14, 8))
selectOnly([eastward])
m._core_follower_order_move(...gridDirection(2, 8))
let headOnGap = Infinity
for (let frame = 0; frame < 150; frame += 1) {
  m._core_tick(200)
  headOnGap = Math.min(headOnGap, closestPair([westward, eastward]))
}
ok('two walkers meeting head-on step round each other', headOnGap > SPACING * 0.75,
   `closest ${headOnGap.toFixed(4)}, spacing ${SPACING}`)
ok('and both still get where they were going',
   !isWalking(westward) && !isWalking(eastward) &&
   angleTo(followerPosition(westward), gridDirection(14, 8)) < 0.02 &&
   angleTo(followerPosition(eastward), gridDirection(2, 8)) < 0.02,
   `${angleTo(followerPosition(westward), gridDirection(14, 8)).toFixed(4)}, ` +
   `${angleTo(followerPosition(eastward), gridDirection(2, 8)).toFixed(4)} rad short`)

// ---------------------------------------------------------------------------
// Ground that changes under a walker. A wall right across its way and it gives
// up where it stands; a wall with a way round and it takes the way round.

m._core_followers_clear()
writeHeights(grid.heights)
const [blockedWalker] = spawnAll([[2, 8]])
selectOnly([blockedWalker])
m._core_follower_order_move(...gridDirection(14, 8))
simulate(2)
const sealed = Float32Array.from(grid.heights)
for (let j = 0; j < GRID; j += 1) sealed[nodeAt(10, j)] = 0.4
writeHeights(sealed)
simulate(10)
const blockedAt = followerPosition(blockedWalker)
ok('a cliff raised across the whole way stops a walker', !isWalking(blockedWalker))
ok('on its own side of the cliff',
   angleTo(blockedAt, gridDirection(2, 8)) < angleTo(gridDirection(2, 8), gridDirection(10, 8)),
   `${angleTo(blockedAt, gridDirection(2, 8)).toFixed(3)} rad along, cliff at ` +
   `${angleTo(gridDirection(2, 8), gridDirection(10, 8)).toFixed(3)}`)

const [detourWalker] = (m._core_followers_clear(), spawnAll([[2, 8]]))
writeHeights(grid.heights)
selectOnly([detourWalker])
m._core_follower_order_move(...gridDirection(14, 8))
simulate(2)
const breached = Float32Array.from(grid.heights)
for (let j = 2; j < GRID; j += 1) breached[nodeAt(10, j)] = 0.4
writeHeights(breached)
simulate(40)
ok('a cliff with a way round it re-routes the walker instead',
   !isWalking(detourWalker) && angleTo(followerPosition(detourWalker), gridDirection(14, 8)) < 0.02,
   `${angleTo(followerPosition(detourWalker), gridDirection(14, 8)).toFixed(4)} rad short`)

// ---------------------------------------------------------------------------
// The milestone in one go: a group, picked as a group, sent round a hill. The
// hill is a cliff-sided block in the middle of the patch; going over it is not
// an option, so they go round, on a smooth path, and finish standing apart.

const hill = Float32Array.from(grid.heights)
const onHill = (i, j) => i >= 6 && i <= 10 && j >= 5 && j <= 11
for (let j = 0; j < GRID; j += 1) {
  for (let i = 0; i < GRID; i += 1) {
    if (onHill(i, j)) hill[nodeAt(i, j)] = 0.4
  }
}
writeHeights(hill)
m._core_followers_clear()
const band = spawnAll([
  [1, 7], [2, 7], [3, 7], [1, 8], [2, 8], [3, 8], [1, 9], [2, 9], [3, 9], [2, 10], [3, 10], [2, 6],
])
selectOnly(band)
const hillGoal = gridDirection(14, 8)
ok('the whole group takes the order', m._core_follower_order_move(...hillGoal) === band.length)
const hillLegs = band.map((f) => m._core_follower_route(f))
ok('each takes a handful of straight legs, not a node per cell',
   hillLegs.every((legs) => legs >= 1 && legs <= 4), hillLegs.join(' '))
let onTop = 0
let highest = 0
let hillCrowd = Infinity
for (let frame = 0; frame < 300 && band.some(isWalking); frame += 1) {
  m._core_tick(200)
  for (const f of band) {
    const p = followerPosition(f)
    const cell = naiveNearest(...p)
    if (onHill(cell % GRID, Math.floor(cell / GRID))) onTop += 1
    highest = Math.max(highest, Math.hypot(...p))
  }
  if (frame > 10) hillCrowd = Math.min(hillCrowd, closestPair(band))
}
ok('nobody sets foot on the hill', onTop === 0, `${onTop} follower-frames in a hill cell`)
// Brushing past its foot, a follower may stand a little way up the bottom of
// the slope the mesh draws there — never most of the way up the face.
ok('nobody climbs its face either', highest < RADIUS + LAND + (0.4 - LAND) * 0.25,
   `highest ${(highest - RADIUS - LAND).toFixed(4)} above the plain, cliff ${0.4 - LAND}`)
ok('nobody walks through anybody on the way', hillCrowd > SPACING * 0.5,
   `closest ${hillCrowd.toFixed(4)}, spacing ${SPACING}`)
const hillFurthest = Math.max(...band.map((f) => angleTo(followerPosition(f), hillGoal)))
ok('the group arrives round the far side', band.every((f) => !isWalking(f)) && hillFurthest < 0.12,
   `furthest ${hillFurthest.toFixed(3)} rad from the point`)
const hillGap = closestPair(band)
ok('and stands apart, not stacked on the goal vertex', hillGap > SPACING * 0.9,
   `closest pair ${hillGap.toFixed(4)} apart`)
writeHeights(grid.heights)

// ---------------------------------------------------------------------------
// Cost at the size the game actually runs at. The default planet is a 24-quad
// cube-sphere: 3458 welded nodes and a little over 26000 links. A 60x60 patch
// is the same order, and a mass order across its diagonal is the worst case:
// one search out from the goal that has to cover the whole patch, then a
// string-pull and a line test the length of the world for every follower.

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

const bigSamples = []
for (let node = 0; node < bigNodes; node += 17) {
  bigSamples.push([
    bigDirections[node * 3],
    bigDirections[node * 3 + 1],
    bigDirections[node * 3 + 2],
  ])
}
for (let j = 0; j < BIG; j += 7) {
  for (let i = 0; i < BIG - 1; i += 7) {
    const node = j * BIG + i
    const next = node + 1
    bigSamples.push([
      (bigDirections[node * 3] + bigDirections[next * 3]) * 0.5,
      (bigDirections[node * 3 + 1] + bigDirections[next * 3 + 1]) * 0.5,
      (bigDirections[node * 3 + 2] + bigDirections[next * 3 + 2]) * 0.5,
    ])
  }
}
bigSamples.push([0, 1, 0], [-0.2, -0.9, 0.4])
checkNearest('nearest walkable on a 3600-node graph matches a linear scan',
  bigDirections, bigHeights, bigSamples)

let bigOwns = true
let bigOwnDetail = ''
for (let node = 0; node < bigNodes; node += 17) {
  const got = m._core_nav_nearest_walkable(
    bigDirections[node * 3], bigDirections[node * 3 + 1], bigDirections[node * 3 + 2])
  if (got !== node) {
    bigOwns = false
    bigOwnDetail = `node ${node} -> ${got}`
    break
  }
}
ok("a large-graph node's own direction resolves to itself", bigOwns, bigOwnDetail)

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
ok('a mass order fits inside one frame', orderMs < 16, `${orderMs.toFixed(1)}ms for 60 followers`)

const stepStarted = process.hrtime.bigint()
for (let i = 0; i < 200; i += 1) m._core_tick(50)
const stepMs = Number(process.hrtime.bigint() - stepStarted) / 1e6
// Steering, avoidance and separation run every step for everyone; a fifth of a
// millisecond per step for a crowd this size is half a percent of the step.
ok('200 steps of 60 walking followers stay cheap',
   stepMs < 50, `${stepMs.toFixed(1)}ms total, ${(stepMs / 200 * 1000).toFixed(0)}us per step`)

console.log(out.join('\n'))
const failed = out.filter((r) => r.startsWith('FAIL'))
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${out.length} checks passed`)
process.exit(failed.length ? 1 : 0)
