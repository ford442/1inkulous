/**
 * The device setup and the frame's sizing, as far as they can be checked
 * without a GPU: how the drawing buffer follows devicePixelRatio while input
 * stays in CSS pixels, which limits get requested, what a lost device or a GPU
 * error looks like to the player and to the console, and a few facts about the
 * renderer's source that only show up on screen otherwise (the exposure curve
 * is applied once, at the end; every scene pipeline is multisampled).
 *
 * And the parts of the new frame that are plain arithmetic: which optional
 * features get requested, GPU timings, WGSL composition and #ifdefs, the
 * frame and particle layouts the shaders and the CPU must agree on, the
 * particle ring, reversed Z, the shadow box, the sun and spell landings.
 * `npm run check:webgpu` covers what needs a GPU.
 *
 * Run: npm run test:gpu
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { passDurations } from '../src/engine/gpuTimer.ts'
import { FRAME, FRAME_BYTES, FRAME_FLOATS } from '../src/engine/materials.ts'
import { mat4PerspectiveReversedZ } from '../src/engine/math.ts'
import {
  consumeDirtyRange,
  createPlanetMesh,
  refreshVertices,
  VERTEX_FLOATS,
} from '../src/engine/mesh/cubeSphere.ts'
import {
  burstsForLanding,
  MAX_BURSTS,
  packBursts,
  PARTICLE_BYTES,
  PARTICLE_CAPACITY,
  STEP_FLOATS,
} from '../src/engine/particles.ts'
import { linearClear, sunShadowMatrix } from '../src/engine/renderer.ts'
import {
  createGpuErrorReporter,
  deviceLossMessage,
  planFeatures,
  planRequiredLimits,
  unsupportedMessage,
  WebGpuUnavailableError,
  withheldFeatures,
} from '../src/engine/webgpu.ts'
import { specializeWgsl } from '../src/engine/wgsl.ts'
import { createSpellEvents, type SpellEventSource } from '../src/game/spellEffects.ts'
import { createSun, DAY_SECONDS, dayStart, followSunDirection, SPIN_AXIS, turnSun } from '../src/game/sun.ts'
import type { InputSnapshot } from '../src/input/input.ts'
import type { SpellCast, SpellEnd } from '../src/sim/simulation.ts'
import { Spell, SpellResult, SPELLS } from '../src/sim/spell.ts'
import { gpuLine } from '../src/ui/hud.ts'
import { composeWgsl } from './wgsl.mjs'
import {
  CANVAS_ASPECT,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  drawingBufferSize,
  effectivePixelRatio,
  MAX_PIXEL_RATIO,
} from '../src/viewport.ts'

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
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// --- the drawing buffer follows devicePixelRatio ------------------------------

const size = (ratio: number) => drawingBufferSize(ratio)
check('1x draws at the CSS size', size(1).width === 1024 && size(1).height === 768)
check('2x draws at twice the CSS size', size(2).width === 2048 && size(2).height === 1536,
  `${size(2).width}x${size(2).height}`)
check('past the cap it stops at 2x', size(3).width === 2048 && size(3).height === 1536 &&
  MAX_PIXEL_RATIO === 2, `3x asks for ${size(3).width}x${size(3).height}`)
check('a fractional ratio rounds to whole pixels',
  size(1.5).width === 1536 && size(1.5).height === 1152 &&
    size(1.25).width === 1280 && size(1.25).height === 960,
  `1.5x ${size(1.5).width}x${size(1.5).height}, 1.25x ${size(1.25).width}x${size(1.25).height}`)
check('a zoomed-out page draws 1:1 with its device pixels',
  size(0.5).width === 512 && size(0.5).height === 384)
check('a ratio that says nothing falls back to 1x',
  [0, -2, NaN, Infinity, -Infinity].every((ratio) => effectivePixelRatio(ratio) === 1) &&
    size(NaN).width === 1024)
check('the buffer never collapses to nothing', size(1e-9).width >= 1 && size(1e-9).height >= 1)
check('and keeps the viewport aspect at every ratio',
  [0.5, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].every((ratio) => {
    const { width, height } = size(ratio)
    return Math.abs(width / height - CANVAS_ASPECT) < 0.002
  }))

// --- input stays in CSS pixels ------------------------------------------------

type Listener = (event: Record<string, unknown>) => void
const listeners = new Map<string, Listener[]>()
const target = {
  addEventListener(type: string, fn: Listener) {
    listeners.set(type, [...(listeners.get(type) ?? []), fn])
  },
  removeEventListener() {},
  dispatch(type: string, event: Record<string, unknown>) {
    for (const fn of listeners.get(type) ?? []) fn(event)
  },
}
// A 2x display: the drawing buffer is twice the CSS box, and the page says so.
Object.assign(globalThis, { window: { ...target, devicePixelRatio: 2 } })
const canvas = {
  ...target,
  width: 2048,
  height: 1536,
  tabIndex: 0,
  focus() {},
  setPointerCapture() {},
  releasePointerCapture() {},
  hasPointerCapture: () => true,
}
const { createInput } = await import('../src/input/input.ts')
const input = createInput(canvas as unknown as HTMLCanvasElement)
const point = (type: string, x: number, y: number) =>
  canvas.dispatch(type, {
    button: 0, pointerId: 1, offsetX: x, offsetY: y, movementX: 0, movementY: 0,
    ctrlKey: false, shiftKey: false, preventDefault() {},
  })

point('pointerdown', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2)
point('pointerup', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2)
const click = input.snapshot().pointer.clicks[0]
check('a click at the middle of the CSS box is the middle of NDC, on a 2x display',
  click !== undefined && Math.abs(click.ndc.x) < 1e-9 && Math.abs(click.ndc.y) < 1e-9,
  click ? `ndc ${click.ndc.x}, ${click.ndc.y}` : 'no click')
check('and its position is reported in CSS pixels, not drawing-buffer pixels',
  click?.position.x === CANVAS_WIDTH / 2 && click.position.y === CANVAS_HEIGHT / 2,
  click ? `${click.position.x}, ${click.position.y}` : '')
input.endFrame()
point('pointerdown', CANVAS_WIDTH, CANVAS_HEIGHT)
point('pointerup', CANVAS_WIDTH, CANVAS_HEIGHT)
const corner = input.snapshot().pointer.clicks[0]
check('the far corner of the CSS box is NDC (1, -1), not (0.5, -0.5)',
  corner !== undefined && Math.abs(corner.ndc.x - 1) < 1e-9 && Math.abs(corner.ndc.y + 1) < 1e-9,
  corner ? `ndc ${corner.ndc.x}, ${corner.ndc.y}` : 'no click')

// --- limits ---------------------------------------------------------------------

const adapter = { maxBufferSize: 1024 ** 3, maxUniformBufferBindingSize: 65536 }
const today = { maxBufferSize: 130_000, maxUniformBufferBindingSize: 192 }

check('a frame inside the defaults requests no limits at all',
  Object.keys(planRequiredLimits(today, adapter).requiredLimits).length === 0 &&
    planRequiredLimits(today, adapter).shortfalls.length === 0)

const big = planRequiredLimits({ maxBufferSize: 512 * 1024 ** 2, maxUniformBufferBindingSize: 192 }, adapter)
check('a buffer past the guaranteed size is requested, alone',
  big.requiredLimits.maxBufferSize === 512 * 1024 ** 2 &&
    !('maxUniformBufferBindingSize' in big.requiredLimits) && big.shortfalls.length === 0)

const tooBig = planRequiredLimits({ maxBufferSize: 2 * 1024 ** 3, maxUniformBufferBindingSize: 192 }, adapter)
check('one the adapter cannot give is a shortfall with a reason, not a request',
  tooBig.shortfalls.length === 1 && tooBig.shortfalls[0].includes('maxBufferSize') &&
    Object.keys(tooBig.requiredLimits).length === 0, tooBig.shortfalls[0])

check('an adapter that does not report the limit at all cannot be assumed to have it',
  planRequiredLimits({ maxBufferSize: 512 * 1024 ** 2, maxUniformBufferBindingSize: 192 }, {}).shortfalls.length === 1)

// --- what the player and the console are told ---------------------------------

const missing = unsupportedMessage(true)
const insecure = unsupportedMessage(false)
check('no navigator.gpu on a secure page says the browser lacks WebGPU',
  /does not support WebGPU/.test(missing) && /Chrome/.test(missing))
check('and on an insecure page says that, a different fix',
  /http/.test(insecure) && /https/.test(insecure) && insecure !== missing)
check('both are whole sentences', missing.endsWith('.') && insecure.endsWith('.'))
check('the error class carries its sentence', new WebGpuUnavailableError(missing).message === missing &&
  new WebGpuUnavailableError(missing) instanceof Error)

const lossText = deviceLossMessage({ reason: 'unknown', message: 'GPU hung' })
check('a lost device says what happened and how to go on',
  /lost/.test(lossText) && /reload/i.test(lossText) && lossText.includes('unknown') &&
    lossText.includes('GPU hung'), lossText)
check('and copes with a loss that has no message',
  /destroyed/.test(deviceLossMessage({ reason: 'destroyed', message: '' })))

// --- GPU errors do not flood -----------------------------------------------------

{
  const reported: string[] = []
  let prevented = 0
  const handle = createGpuErrorReporter((message) => reported.push(message), 3)
  const send = (message: string) => handle({ error: { message }, preventDefault: () => { prevented += 1 } })

  for (let frame = 0; frame < 1000; frame += 1) send('buffer is invalid')
  check('the same error every frame is reported once', reported.length === 1 &&
    reported[0] === 'buffer is invalid', `${reported.length} reports from 1000 events`)
  send('pipeline is invalid')
  send('bind group is invalid')
  check('different errors each get a line', reported.length === 3)
  send('a fourth kind')
  send('a fifth kind')
  send('a fourth kind')
  check('past the limit it says so once and goes quiet', reported.length === 4 &&
    /suppressed/.test(reported[3]), `${reported.length} reports`)
  check('every event is cancelled, so the browser adds no console flood of its own',
    prevented === 1000 + 5, `${prevented} prevented`)
}

// --- optional features: what is asked for, and what the game does without ---

const ALL = ['timestamp-query', 'shader-f16', 'float32-filterable']
{
  const none = planFeatures([])
  check('an adapter with no optional features is asked for none, and every path is off',
    none.requiredFeatures.length === 0 && !none.enabled.timestampQuery && !none.enabled.shaderF16 &&
      !none.enabled.float32Filterable)
  const all = planFeatures([...ALL, 'texture-compression-bc', 'subgroups'])
  check('an adapter with all three gets all three, and nothing else it happens to have',
    all.requiredFeatures.length === 3 && ALL.every((name) => all.requiredFeatures.includes(name as never)) &&
      all.enabled.timestampQuery && all.enabled.shaderF16 && all.enabled.float32Filterable,
    all.requiredFeatures.join(', '))
  const some = planFeatures(['timestamp-query'])
  check('a feature the adapter lacks is never requested',
    some.requiredFeatures.length === 1 && some.enabled.timestampQuery && !some.enabled.shaderF16)
  const withheld = planFeatures(ALL, ['timestamp-query'])
  check('a withheld feature is left off even where the adapter has it',
    !withheld.enabled.timestampQuery && withheld.enabled.shaderF16 &&
      !withheld.requiredFeatures.includes('timestamp-query'))
  check('?features=none withholds every optional feature',
    withheldFeatures('none').length === 3 && planFeatures(ALL, withheldFeatures('none')).requiredFeatures.length === 0)
  check('?features=-shader-f16 withholds just that one, and ignores what it does not know',
    withheldFeatures('-shader-f16,-made-up,timestamp-query').join() === 'shader-f16')
  check('no ?features= withholds nothing', withheldFeatures(null).length === 0 && withheldFeatures('').length === 0)
}

// --- GPU timings ------------------------------------------------------------------

{
  const stamps = [1_000_000n, 1_500_000n, 2_000_000n, 4_250_000n, 0n, 0n, 9n, 5n]
  const durations = passDurations(stamps, ['compute', 'shadow', 'scene', 'post'])
  check('timestamps become milliseconds per pass',
    durations[0]?.ms === 0.5 && durations[1]?.ms === 2.25, JSON.stringify(durations.slice(0, 2)))
  check('a pass with no stamps, or stamps that run backwards, gives no number',
    durations[2] === null && durations[3] === null)
  check('the HUD says plainly when the GPU cannot be timed',
    /n\/a/.test(gpuLine(null, false)) && gpuLine(null, true) === 'gpu —')
  const line = gpuLine({ totalMs: 2.75, passes: [{ name: 'shadow', ms: 0.5 }, { name: 'scene', ms: 2.25 }, { name: 'compute', ms: 0 }] }, true)
  check('and otherwise gives the total and each pass that ran', line === 'gpu 2.75ms (shadow 0.50 · scene 2.25)', line)
}

// --- WGSL composition -----------------------------------------------------------------

{
  const files: Record<string, string> = {
    '/s/main.wgsl': '#include "lib/a.wgsl"\n#include "lib/b.wgsl"\nfn main() {}\n',
    '/s/lib/a.wgsl': '#include "common.wgsl"\nfn a() {}\n',
    '/s/lib/b.wgsl': '#include "common.wgsl"\nfn b() {}\n',
    '/s/lib/common.wgsl': 'struct Common { x: f32 }\n',
    '/s/loop.wgsl': '#include "loop2.wgsl"\n',
    '/s/loop2.wgsl': '#include "loop.wgsl"\n',
    '/s/missing.wgsl': '#include "nope.wgsl"\n',
  }
  const reader = (file: string) => {
    const text = files[file]
    if (text === undefined) throw new Error(`no ${file}`)
    return text
  }
  const composed = composeWgsl('/s/main.wgsl', reader)
  check('an include shared by two includes is pulled in once',
    (composed.code.match(/struct Common/g)?.length ?? 0) === 1 && /fn a\(\)/.test(composed.code) &&
      /fn b\(\)/.test(composed.code) && !/#include/.test(composed.code))
  check('and every file that went in is reported, for the dev server to watch', composed.files.length === 4)
  let cycle = ''
  try { composeWgsl('/s/loop.wgsl', reader) } catch (error) { cycle = String(error) }
  check('an include cycle is an error that names the chain', /cycle/.test(cycle) && /loop2\.wgsl/.test(cycle), cycle)
  let missing = ''
  try { composeWgsl('/s/missing.wgsl', reader) } catch (error) { missing = String(error) }
  check('a missing include names the file and who asked for it', /nope\.wgsl/.test(missing) && /missing\.wgsl/.test(missing), missing)
}

{
  const source = 'a\n#ifdef F16\nb\n#ifndef X\nc\n#else\nd\n#endif\n#else\ne\n#endif\nf'
  const on = specializeWgsl(source, { F16: true })
  const off = specializeWgsl(source, {})
  check('#ifdef keeps its branch when the feature is on', on.split('\n').filter(Boolean).join('') === 'abcf', on)
  check('and the #else when it is off', off.split('\n').filter(Boolean).join('') === 'aef', off)
  check('line numbers survive, so a compile error still points at the right line',
    on.split('\n').length === source.split('\n').length && off.split('\n').length === source.split('\n').length)
  const throws = (code: string) => { try { specializeWgsl(code); return false } catch { return true } }
  check('an unbalanced #ifdef, #else or #endif is an error, not a silently wrong shader',
    throws('#ifdef A\nx') && throws('#endif') && throws('#else') && throws('#ifdef A\n#else\n#else\n#endif'))
}

// --- the shaders, composed as the GPU gets them ----------------------------------------

const shaderDir = new URL('../src/engine/shaders/', import.meta.url)
const shaderNames = readdirSync(shaderDir).filter((name) => name.endsWith('.wgsl'))
const composedShaders = new Map(
  shaderNames.map((name) => [name, composeWgsl(fileURLToPath(new URL(name, shaderDir))).code] as const),
)
check('every shader composes', composedShaders.size >= 10, [...composedShaders.keys()].join(', '))

for (const [name, code] of composedShaders) {
  const curves = code.match(/exp\(-1\.35 \* color\)/g)?.length ?? 0
  check(`${name} ${name === 'composite.wgsl' ? 'applies the exposure curve, once' : 'leaves exposure to the composite'}`,
    curves === (name === 'composite.wgsl' ? 1 : 0), `${curves}`)
  const frames = code.match(/struct Frame \{/g)?.length ?? 0
  check(`${name} declares the frame at most once`, frames <= 1, `${frames}`)
}

// The frame block's floats, from the struct itself: what FRAME_FLOATS must match.
{
  const frameStruct = /struct Frame \{([\s\S]*?)\n\}/.exec(read('src/engine/shaders/lib/frame.wgsl'))?.[1] ?? ''
  const fields = [...frameStruct.matchAll(/^\s*(\w+):\s*(mat4x4f|vec4f)/gm)]
  const floats = fields.reduce((sum, [, , type]) => sum + (type === 'mat4x4f' ? 16 : 4), 0)
  check('FRAME_FLOATS matches struct Frame in frame.wgsl', floats === FRAME_FLOATS && FRAME_BYTES === FRAME_FLOATS * 4,
    `${floats} in the struct, ${FRAME_FLOATS} in materials.ts`)
  const offsets = fields.map(([, field]) => FRAME[field as keyof typeof FRAME])
  let at = 0
  const inOrder = fields.every(([, field, type], i) => {
    const ok = offsets[i] === at
    at += type === 'mat4x4f' ? 16 : 4
    return ok && field !== undefined
  })
  check('and each FRAME offset is where its field sits', inOrder, fields.map(([, f]) => f).join(', '))
}

// struct Particle, laid out by WGSL's rules in both variants. The f16 one
// cannot be run here (SwiftShader has no shader-f16), so this is what keeps
// PARTICLE_BYTES honest for it.
{
  const LAYOUT: Record<string, { size: number; align: number }> = {
    f32: { size: 4, align: 4 }, f16: { size: 2, align: 2 },
    vec3f: { size: 12, align: 16 }, vec3h: { size: 6, align: 8 }, vec4f: { size: 16, align: 16 },
  }
  const structSize = (body: string) => {
    let offset = 0
    let align = 1
    for (const [, type] of body.matchAll(/^\s*\w+:\s*(\w+),/gm)) {
      const layout = LAYOUT[type!]!
      offset = Math.ceil(offset / layout.align) * layout.align + layout.size
      align = Math.max(align, layout.align)
    }
    return Math.ceil(offset / align) * align
  }
  const particle = read('src/engine/shaders/lib/particle.wgsl')
  const [f16Body, f32Body] = [...particle.matchAll(/struct Particle \{([\s\S]*?)\n\}/g)].map((m) => m[1]!)
  check('a particle is PARTICLE_BYTES.f32 bytes without shader-f16',
    structSize(f32Body!) === PARTICLE_BYTES.f32, `${structSize(f32Body!)}`)
  check('and PARTICLE_BYTES.f16 with it, a third smaller',
    structSize(f16Body!) === PARTICLE_BYTES.f16 && PARTICLE_BYTES.f16 < PARTICLE_BYTES.f32, `${structSize(f16Body!)}`)
  check('the f16 variant enables f16 before anything else in both particle shaders',
    ['particle_step.wgsl', 'particle_draw.wgsl'].every((name) => {
      const code = specializeWgsl(composedShaders.get(name)!, { SHADER_F16: true })
      const firstStatement = code.split('\n').map((line) => line.replace(/\/\/.*/, '').trim()).find(Boolean)
      return firstStatement === 'enable f16;'
    }))
  check('and the f32 variant never mentions f16 types',
    ['particle_step.wgsl', 'particle_draw.wgsl'].every((name) =>
      !/\b(f16|vec3h|enable)\b/.test(withoutComments(specializeWgsl(composedShaders.get(name)!, {})))))
}

// --- particles: the ring, and what each spell throws up --------------------------------

{
  const burst = (count: number) => ({
    center: [0, 1, 0] as [number, number, number], radius: 0.1, color: [1, 1, 1] as [number, number, number],
    size: 0.01, count, speed: 0.1, life: 1, spread: 0.5, variation: 0.2,
  })
  const packed = packBursts([burst(100), burst(50)], 8150, { dt: 0.016, planetRadius: 1, gravity: 0.35, capacity: 8192 })
  const counts = new Uint32Array(packed.data.buffer, 16, 4)
  check('bursts take the next slots of the ring and wrap round it',
    packed.data[8 + 8] === 8150 && packed.data[8 + 16 + 8] === (8150 + 100) % 8192 &&
      packed.cursor === (8150 + 150) % 8192, `cursor ${packed.cursor}`)
  check('the step is told the capacity and how many to spawn', counts[0] === 8192 && counts[1] === 150 && packed.data[3] === 2)
  const flood = packBursts(Array.from({ length: 40 }, () => burst(500)), 0, { dt: 0.016, planetRadius: 1, gravity: 0.35, capacity: 8192 })
  check(`past ${MAX_BURSTS} bursts the rest wait, and a frame never spawns more than the ring holds`,
    flood.bursts <= MAX_BURSTS && flood.total <= 8192, `${flood.bursts} bursts, ${flood.total} particles`)
  check('a burst with no particles takes no slot',
    packBursts([burst(0), burst(10)], 0, { dt: 0, planetRadius: 1, gravity: 0, capacity: 64 }).bursts === 1)
  check('the step block is the size the shader declares', packed.data.length === STEP_FLOATS && STEP_FLOATS === 8 + MAX_BURSTS * 16)

  const surface: [number, number, number] = [0, 1.01, 0]
  const looks = SPELLS.map((spell) => burstsForLanding({ spell, radius: 0.1 }, surface, 1))
  check('every spell throws something up when it lands', looks.every((bursts) => bursts.length > 0 &&
    bursts.every((b) => b.count > 0 && b.life > 0 && b.center === surface)))
  check('Swamp\'s bubbles rise (negative size); Blast\'s debris falls',
    looks[Spell.swamp]!.some((b) => b.size < 0) && looks[Spell.blast]!.every((b) => b.size > 0))
  check('and one spell landing fits the ring several times over',
    looks.every((bursts) => bursts.reduce((sum, b) => sum + b.count, 0) * 4 <= PARTICLE_CAPACITY))
}

// --- frame maths: reversed Z, the shadow box, the clear colour -------------------------

{
  const p = mat4PerspectiveReversedZ(Math.PI / 3, 4 / 3, 0.05, 100)
  const depthAt = (z: number) => (p[10]! * z + p[14]!) / (p[11]! * z)
  check('reversed Z puts the near plane at depth 1 and the far plane at 0',
    Math.abs(depthAt(-0.05) - 1) < 1e-6 && Math.abs(depthAt(-100)) < 1e-6,
    `${depthAt(-0.05)}, ${depthAt(-100)}`)
  check('and depth falls with distance', depthAt(-1) > depthAt(-10) && depthAt(-10) > depthAt(-50))

  const radius = 1
  const maxHeight = 0.06
  let inside = true
  let worst = 0
  for (const sun of [[0.3, 0.8, 0.5], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-0.6, -0.2, 0.77]] as [number, number, number][]) {
    const len = Math.hypot(...sun)
    const m = sunShadowMatrix([sun[0] / len, sun[1] / len, sun[2] / len], radius, maxHeight)
    for (let i = 0; i < 200; i += 1) {
      const a = (i * 2.399963) % (Math.PI * 2)
      const z = 1 - (2 * (i + 0.5)) / 200
      const r = Math.sqrt(1 - z * z) * (radius + maxHeight)
      const v = [Math.cos(a) * r, Math.sin(a) * r, z * (radius + maxHeight)]
      const x = m[0]! * v[0]! + m[4]! * v[1]! + m[8]! * v[2]! + m[12]!
      const y = m[1]! * v[0]! + m[5]! * v[1]! + m[9]! * v[2]! + m[13]!
      const d = m[2]! * v[0]! + m[6]! * v[1]! + m[10]! * v[2]! + m[14]!
      worst = Math.max(worst, Math.abs(x), Math.abs(y))
      inside &&= Math.abs(x) <= 1 && Math.abs(y) <= 1 && d >= 0 && d <= 1
    }
  }
  check('the shadow map holds the whole planet and its peaks from any sun, the pole included',
    inside && worst > 0.9, `widest at ${worst.toFixed(3)} of the map`)

  const display: [number, number, number] = [0.04, 0.05, 0.09]
  const linear = linearClear(display)
  check('the linear clear colour comes back out of the exposure curve as the game\'s background',
    linear.every((c, i) => Math.abs(1 - Math.exp(-1.35 * c) - display[i]!) < 1e-9))
}

// --- the sun ------------------------------------------------------------------------------

{
  const unit = (v: number[]) => Math.abs(Math.hypot(...v) - 1) < 1e-9
  const eye: [number, number, number] = [0.5, 1.2, 2.8]
  const follow = followSunDirection(eye)
  const toEye = (() => { const l = Math.hypot(...eye); return eye.map((c) => c / l) })()
  check('the following sun is a unit vector on the viewer\'s side of the planet',
    unit(follow) && follow[0] * toEye[0]! + follow[1] * toEye[1]! + follow[2] * toEye[2]! > 0.4)
  const same = (a: number[], b: number[]) => a.every((c, i) => Math.abs(c - b[i]!) < 1e-9)
  check('the turning sun stays a unit vector all day, and is back where it began a day later',
    [0, 0.13, 0.25, 0.5, 0.77, 0.999].every((f) => unit(turnSun(follow, f))) && same(turnSun(follow, 1), follow) &&
      same(turnSun(follow, 0), follow))
  const along = (v: number[]) => v[0]! * SPIN_AXIS[0] + v[1]! * SPIN_AXIS[1] + v[2]! * SPIN_AXIS[2]
  check('it turns about the planet\'s axis: its height over the equator never changes',
    [0.1, 0.4, 0.8].every((f) => Math.abs(along(turnSun(follow, f)) - along(follow)) < 1e-9))
  const overPole = dayStart(SPIN_AXIS)
  check('a sun over the pole is brought down far enough that the day has a night',
    unit(overPole) && Math.abs(along(overPole)) < 0.6 && same(dayStart(follow), follow))
  const sun = createSun()
  const press = (codes: string[]) => ({ keys: new Set<string>(), pressed: new Set(codes) }) as unknown as InputSnapshot
  sun.update(16, press([]), eye)
  check('the sun follows the camera until N is pressed', sun.mode === 'follow' && sun.dayFraction === null)
  const before = sun.direction
  sun.update(0, press(['KeyN']), eye)
  check('N turns the day on, without the sun jumping',
    sun.mode === 'cycle' && before.every((c, i) => Math.abs(c - sun.direction[i]!) < 1e-9))
  const start = sun.dayFraction!
  sun.update(DAY_SECONDS * 250, press([]), eye)
  check('and the day turns: a quarter of it passes in a quarter of DAY_SECONDS',
    Math.abs(((sun.dayFraction! - start + 1) % 1) - 0.25) < 1e-9)
  sun.update(0, press(['KeyN']), eye)
  check('N again puts the sun back with the camera', sun.mode === 'follow')
}

// --- spell landings, as the renderer hears of them ---------------------------------------

{
  const casting = new Map<number, SpellCast | null>()
  const ends = new Map<number, SpellEnd>()
  const source: SpellEventSource = {
    spellCasting: (tribe) => casting.get(tribe) ?? null,
    lastSpellEnd: (tribe) => ends.get(tribe) ?? { count: 0, spell: Spell.blast, result: SpellResult.ok },
  }
  const events = createSpellEvents(source, [0, 1])
  const target: [number, number, number] = [0, 0, 1]
  casting.set(0, { spell: Spell.blast, progress: 0.4, target, radius: 0.08 })
  check('nothing lands while a cast is under way', events.poll().length === 0)
  casting.set(0, null)
  ends.set(0, { count: 1, spell: Spell.blast, result: SpellResult.ok })
  const landed = events.poll()
  check('a cast that ends well lands where it was aimed, once',
    landed.length === 1 && landed[0]!.spell === Spell.blast && landed[0]!.target === target &&
      landed[0]!.radius === 0.08 && events.poll().length === 0)
  casting.set(1, { spell: Spell.swamp, progress: 0.9, target, radius: 0.1 })
  events.poll()
  casting.set(1, null)
  ends.set(1, { count: 1, spell: Spell.swamp, result: SpellResult.cancelled })
  check('one cut short lands nothing', events.poll().length === 0)
  casting.set(0, { spell: Spell.flatten, progress: 0.9, target: [1, 0, 0], radius: 0.05 })
  events.poll()
  ends.set(0, { count: 2, spell: Spell.flatten, result: SpellResult.ok })
  casting.set(0, { spell: Spell.blast, progress: 0.01, target, radius: 0.08 })
  const both = events.poll()
  check('a cast that lands as the next begins goes where it was aimed, not where the next is',
    both.length === 1 && both[0]!.spell === Spell.flatten && both[0]!.target[0] === 1)
}

// --- normals left to the GPU ---------------------------------------------------------------

{
  const mesh = createPlanetMesh({ resolution: 6, radius: 1 })
  consumeDirtyRange(mesh)
  mesh.normalsOnGpu = true
  const normalsBefore = Array.from({ length: mesh.vertexCount }, (_, v) => mesh.vertexData.slice(v * VERTEX_FLOATS + 3, v * VERTEX_FLOATS + 6))
  const moved = 20
  mesh.heights[moved] = 0.2
  refreshVertices(mesh, [moved])
  const range = consumeDirtyRange(mesh)
  const untouched = normalsBefore.every((n, v) => n.every((c, i) => c === mesh.vertexData[v * VERTEX_FLOATS + 3 + i]))
  // Every vertex the CPU would have given a new normal must be in the range the GPU recomputes.
  const reference = createPlanetMesh({ resolution: 6, radius: 1 })
  consumeDirtyRange(reference)
  reference.heights[moved] = 0.2
  refreshVertices(reference, [moved])
  const cpuRange = consumeDirtyRange(reference)
  check('with normals on the GPU the CPU moves the vertex but leaves every normal alone', untouched &&
    mesh.vertexData[moved * VERTEX_FLOATS]! !== normalsBefore[0]![0])
  check('and marks dirty every vertex whose normal the CPU would have changed',
    range !== null && cpuRange !== null && range.min <= cpuRange.min && range.max >= cpuRange.max,
    `${range?.min}..${range?.max} covers ${cpuRange?.min}..${cpuRange?.max}`)
}

// --- the renderer's source, for what only shows on screen ------------------------

const renderer = read('src/engine/renderer.ts')
const materials = read('src/engine/materials.ts')
const context = read('src/engine/webgpu.ts')

check('the shaders are files, not strings inside the renderer',
  !/\/\*\s*wgsl\s*\*\//.test(renderer) &&
    ['planet', 'follower', 'hut', 'tree', 'water', 'atmosphere', 'composite'].every((name) =>
      new RegExp(`shaders/${name}\\.wgsl'`).test(renderer)))
check('render pipelines come from the material factory, not hand-built in the renderer',
  (withoutComments(renderer).match(/createRenderPipeline\(/g)?.length ?? 0) === 1,
  'only the composite, which draws to the screen rather than the scene')
check('every scene pipeline is multisampled', /multisample:\s*\{\s*count:\s*SAMPLE_COUNT\s*\}/.test(withoutComments(materials)) &&
  (withoutComments(materials).match(/fragment:/g)?.length ?? 0) === 1)
check('the sample count is 4', /export const SAMPLE_COUNT = 4\b/.test(materials))
check('colour and depth targets are multisampled to match',
  (withoutComments(renderer).match(/sampleCount:\s*SAMPLE_COUNT/g)?.length ?? 0) === 2)
check('the scene is linear float, resolved before the composite reads it',
  /SCENE_FORMAT: GPUTextureFormat = 'rgba16float'/.test(materials) &&
    /resolveTarget:\s*frameTargets\.resolveView/.test(withoutComments(renderer)))
check('depth is depth32float with reversed Z: cleared to 0, tested greater',
  /DEPTH_FORMAT: GPUTextureFormat = 'depth32float'/.test(materials) && /SCENE_DEPTH_CLEAR = 0\b/.test(materials) &&
    /SCENE_DEPTH_COMPARE: GPUCompareFunction = 'greater'/.test(materials) &&
    /mat4PerspectiveReversedZ\(/.test(renderer))

const configure = withoutComments(context)
check('the canvas is opaque', /alphaMode:\s*'opaque'/.test(configure) && !/premultiplied/.test(configure))
check('the canvas context gets no tone mapping of its own',
  !/toneMapping/.test(configure) && !/toneMapping/.test(withoutComments(renderer)))
check('optional features are requested only from the plan',
  /requiredFeatures:\s*featurePlan\.requiredFeatures/.test(configure))

if (failures.length > 0) {
  console.error(`\n${failures.length} gpu check(s) failed`)
  process.exit(1)
}
console.log('\nall gpu checks passed')
