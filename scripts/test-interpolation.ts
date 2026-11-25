/**
 * Smooth motion between fixed steps.
 *
 * The core steps at a fixed rate; the display runs at whatever it runs at.
 * Each follower's instance carries the pose the last step began from as well
 * as the one it left, and the renderer draws between them by the clock's
 * leftover fraction. Here, with a 30Hz simulation and 144Hz frames:
 *
 * - drawn where the shader would draw it (interpolatePose, the TypeScript twin
 *   of follower.wgsl), a walker covers the same ground every frame;
 * - drawn where the last step left it, as before, it stands still for four
 *   frames in five and then jumps;
 * - the previous pose is the one the step began from, and someone put
 *   somewhere — spawned, set down off a hut's pad — is drawn where they are;
 * - the worker's alpha arithmetic, the maths of the blend itself, and what the
 *   shader and renderer source must keep saying for all of this to be true.
 *
 * Run: npm run test:interpolation   (after npm run build:wasm)
 */
import { readFileSync } from 'node:fs'
import { createPlanetMesh } from '../src/engine/mesh/cubeSphere.ts'
import type { Vec3 } from '../src/engine/math.ts'
import { FOLLOWER_PREVIOUS_OFFSET, interpolatePose } from '../src/game/followers.ts'
import { buildNavGraph } from '../src/game/navGraph.ts'
import { MAX_WALKABLE_SLOPE } from '../src/game/terrain.ts'
import { createSimulation, HutKind } from '../src/sim/simulation.ts'
import { stepAlphaAt } from '../src/sim/workerClient.ts'

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

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const normalize = (v: ArrayLike<number>): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2])
  return [v[0] / length, v[1] / length, v[2] / length]
}
const angle = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const p = normalize(a)
  const q = normalize(b)
  return Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])))
}
const along = (from: Vec3, toward: Vec3, distance: number): Vec3 =>
  normalize([
    from[0] * Math.cos(distance) + toward[0] * Math.sin(distance),
    from[1] * Math.cos(distance) + toward[1] * Math.sin(distance),
    from[2] * Math.cos(distance) + toward[2] * Math.sin(distance),
  ])
const spread = (values: number[]) => {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const deviation = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length)
  return { mean, cv: deviation / mean, min: Math.min(...values), max: Math.max(...values) }
}

const SIM_HZ = 30
const DISPLAY_HZ = 144
const RADIUS = 1
const LAND = 0.02

// --- the blend itself ------------------------------------------------------------

{
  // Two poses a little apart on the sphere, at different heights, and a turn.
  const stride = 14
  const data = new Float32Array(stride)
  const before: Vec3 = normalize([0.02, 0, 1])
  const after: Vec3 = normalize([-0.02, 0.01, 1])
  data.set([after[0] * 1.03, after[1] * 1.03, after[2] * 1.03, 0, 1, 0], 0)
  data.set([before[0] * 1.01, before[1] * 1.01, before[2] * 1.01, 1, 0, 0], FOLLOWER_PREVIOUS_OFFSET)
  const at = (alpha: number) => Array.from(interpolatePose(data, stride, 0, alpha))
  const start = at(0)
  const end = at(1)
  const half = at(0.5)
  check('blend: at 0 it is the previous pose', Math.abs(start[0] - data[8]) < 1e-6 && Math.abs(start[3] - 1) < 1e-6)
  check('blend: at 1 the current one', Math.abs(end[0] - data[0]) < 1e-6 && Math.abs(end[4] - 1) < 1e-6)
  check('blend: halfway it stands on the sphere, at the height halfway',
    Math.abs(Math.hypot(half[0], half[1], half[2]) - 1.02) < 1e-6 &&
    Math.abs(angle(half, before) - angle(half, after)) < 1e-6)
  check('blend: and faces halfway round the turn, a unit vector',
    Math.abs(Math.hypot(half[3], half[4], half[5]) - 1) < 1e-6 && Math.abs(half[3] - half[4]) < 1e-6)
  check('blend: alpha out of range is clamped', at(-1)[0] === start[0] && at(2)[0] === end[0])
  data.set([0, 0, -1], FOLLOWER_PREVIOUS_OFFSET + 3)
  data.set([0, 0, 1], 3)
  const flipped = at(0.5)
  check('blend: a heading turned right round has no halfway, and faces its new way',
    flipped[3] === 0 && flipped[4] === 0 && flipped[5] === 1)
}

// --- the worker's side of the clock ----------------------------------------------

{
  const step = 1000 / SIM_HZ
  check('worker alpha: a manual clock is the leftover over the step', stepAlphaAt(step / 4, -1, step, 1e12) === 0.25)
  check('worker alpha: adds the time since the host last ran its clock',
    Math.abs(stepAlphaAt(10, 5000, step, 5010) - 20 / step) < 1e-12)
  check('worker alpha: holds at 1 when the worker is late', stepAlphaAt(10, 5000, step, 6000) === 1)
  check('worker alpha: never runs backwards on a clock read early', stepAlphaAt(10, 5000, step, 4990) === 10 / step)
  check('worker alpha: no step, no blend', stepAlphaAt(10, 5000, 0, 5010) === 0)
}

// --- a walker at 144Hz on a 30Hz core --------------------------------------------

const core = await createSimulation({ stepMs: 1000 / SIM_HZ })
const graph = buildNavGraph(createPlanetMesh({ resolution: 24, radius: RADIUS }))
core.uploadNavGraph(graph, new Float32Array(graph.nodeCount).fill(LAND), {
  planetRadius: RADIUS,
  maxSlope: MAX_WALKABLE_SLOPE,
})
const stride = core.followerInstanceFloats
const home: Vec3 = [0, 0, 1]
const east: Vec3 = [1, 0, 0]

const walker = core.spawnFollower(home, 0)
{
  const data = core.followerInstances()
  const base = walker * stride
  check('a follower just spawned has both poses the same: drawn where it is',
    [0, 1, 2, 3, 4, 5].every((k) => data[base + k] === data[base + FOLLOWER_PREVIOUS_OFFSET + k]))
}
core.setFollowerSelected(walker, true)
check('it is sent a long way', core.orderFollowerMove(along(home, east, 0.8)) === 1)
core.runSteps(3)
{
  const before = Array.from(core.followerInstances().subarray(walker * stride, walker * stride + 6))
  core.runSteps(1)
  const data = core.followerInstances()
  const base = walker * stride
  check('after a step the previous pose is the one the step began from',
    [0, 1, 2, 3, 4, 5].every((k) => data[base + FOLLOWER_PREVIOUS_OFFSET + k] === before[k]) &&
    angle(data.subarray(base, base + 3), before) > 0)
}

const frameMs = 1000 / DISPLAY_HZ
const drawnSteps: number[] = []
const rawSteps: number[] = []
let alphaHonest = true
let lastDrawn: number[] | null = null
let lastRaw: number[] | null = null
for (let frame = 0; frame < DISPLAY_HZ * 3; frame += 1) {
  core.tick(frameMs)
  const alpha = core.stepAlpha
  alphaHonest &&= alpha >= 0 && alpha < 1 && Math.abs(alpha - core.module._core_pending_ms() / core.stepMs) < 1e-12
  const data = core.followerInstances()
  const drawn = Array.from(interpolatePose(data, stride, walker, alpha))
  const raw = Array.from(data.subarray(walker * stride, walker * stride + 3))
  if (lastDrawn && lastRaw) {
    drawnSteps.push(angle(drawn, lastDrawn))
    rawSteps.push(angle(raw, lastRaw))
  }
  lastDrawn = drawn
  lastRaw = raw
}
const walking = (core.followerInstances()[walker * stride + 7] & 2) !== 0
const smooth = spread(drawnSteps)
const stuttering = spread(rawSteps)
const still = rawSteps.filter((d) => d < 1e-7).length / rawSteps.length
// Speed is along the planet's surface at sea level: world units over the radius.
const expected = core.module._core_follower_speed() / RADIUS / DISPLAY_HZ

check('the clock reports its leftover fraction honestly, always in [0, 1)', alphaHonest)
check('the walker is still walking after three seconds of frames', walking)
check('drawn between poses it moves every frame', smooth.min > 0, `${drawnSteps.length} frames`)
check('by the same amount every frame', smooth.cv < 0.02 && smooth.max / smooth.min < 1.05,
  `per frame ${(smooth.mean * 1e4).toFixed(3)}e-4 rad, spread ${(smooth.cv * 100).toFixed(2)}%, ` +
    `max/min ${(smooth.max / smooth.min).toFixed(3)}`)
check('at its walking speed', Math.abs(smooth.mean / expected - 1) < 0.02,
  `${(smooth.mean / expected).toFixed(4)} of speed / ${DISPLAY_HZ}Hz`)
check('drawn where the step left it, it would stutter: still most frames, then a jump',
  still > 0.7 && stuttering.max > 4 * smooth.mean,
  `${(still * 100).toFixed(0)}% of frames still, jumps of ${(stuttering.max / smooth.mean).toFixed(1)} frames' worth`)

// Someone set down rather than walked: a hut raised over where they stand.
{
  const bystander = core.spawnFollower(along(home, [0, 1, 0], 0.3), 0)
  core.runSteps(1)
  const spot = core.followerInstances().slice(bystander * stride, bystander * stride + 3)
  const hut = core.placeHut(normalize(spot), east, -1, HutKind.dwelling)
  const data = core.followerInstances()
  const base = bystander * stride
  check('someone set down off a hut\'s pad is drawn where they land, not slid there',
    hut >= 0 && angle(data.subarray(base, base + 3), spot) > 0 &&
    [0, 1, 2, 3, 4, 5].every((k) => data[base + k] === data[base + FOLLOWER_PREVIOUS_OFFSET + k]),
    `hut ${hut}, moved ${angle(data.subarray(base, base + 3), spot).toFixed(4)} rad`)
}

// --- what the source must keep saying --------------------------------------------

{
  const header = read('cpp/include/1inkulous/followers.hpp')
  const prevOffset = Number(/kInstancePrevOffset\s*=\s*(\d+)/.exec(header)?.[1])
  const floats = Number(/kFollowerInstanceFloats\s*=\s*(\d+)/.exec(header)?.[1])
  check('FOLLOWER_PREVIOUS_OFFSET is the core\'s kInstancePrevOffset',
    prevOffset === FOLLOWER_PREVIOUS_OFFSET && floats === core.followerInstanceFloats &&
    floats >= FOLLOWER_PREVIOUS_OFFSET + 6, `${FOLLOWER_PREVIOUS_OFFSET} vs ${prevOffset}, ${floats} floats`)

  const shader = read('src/engine/shaders/follower.wgsl')
  check('follower.wgsl takes both poses as instance attributes',
    /@location\(7\)\s+previousPosition:\s*vec3f/.test(shader) && /@location\(8\)\s+previousHeading:\s*vec3f/.test(shader))
  check('and draws between them by cameraPos.w',
    /let alpha = clamp\(frame\.cameraPos\.w, 0\.0, 1\.0\)/.test(shader) &&
    /interpolatePosition\(previousPosition, currentPosition, alpha\)/.test(shader) &&
    /interpolateHeading\(previousHeading, currentHeading, alpha\)/.test(shader))
  check('with the blend interpolatePose mirrors: unit directions renormalised, radius on its own',
    /mix\(previous \/ fromRadius, current \/ toRadius, alpha\)/.test(shader) &&
    /mix\(fromRadius, toRadius, alpha\)/.test(shader))

  const renderer = read('src/engine/renderer.ts')
  check('the renderer hands the shader the alpha every frame',
    /frameData\.set\(\[eye\[0\], eye\[1\], eye\[2\], currentGame\.followers\.stepAlpha\], FRAME\.cameraPos\)/.test(renderer))
  check('and the previous pose at the core\'s offset',
    /shaderLocation: 7, offset: FOLLOWER_PREVIOUS_OFFSET \* 4/.test(renderer) &&
    /shaderLocation: 8, offset: FOLLOWER_PREVIOUS_OFFSET \* 4 \+ 12/.test(renderer))
}

if (failures.length > 0) {
  console.error(`\n${failures.length} interpolation check(s) failed`)
  process.exit(1)
}
console.log('\nall interpolation checks passed')
