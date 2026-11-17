/**
 * The device setup and the frame's sizing, as far as they can be checked
 * without a GPU: how the drawing buffer follows devicePixelRatio while input
 * stays in CSS pixels, which limits get requested, what a lost device or a GPU
 * error looks like to the player and to the console, and a few facts about the
 * renderer's source that only show up on screen otherwise (the exposure curve
 * is still the only tone mapping; every pipeline is multisampled).
 *
 * Run: npm run test:gpu
 */
import { readFileSync } from 'node:fs'
import {
  createGpuErrorReporter,
  deviceLossMessage,
  planRequiredLimits,
  unsupportedMessage,
  WebGpuUnavailableError,
} from '../src/engine/webgpu.ts'
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

// --- the renderer's source, for what only shows on screen ------------------------

const renderer = read('src/engine/renderer.ts')
const context = read('src/engine/webgpu.ts')
const shaders = ['planet', 'follower', 'hut', 'tree'].map((name) => [name, read(`src/engine/shaders/${name}.wgsl`)] as const)

for (const [name, source] of shaders) {
  const curves = source.match(/exp\(-1\.35 \* color\)/g)?.length ?? 0
  check(`${name}.wgsl keeps its own exposure curve, once`, curves === 1, `${curves}`)
}
check('the shaders are files, not strings inside the renderer',
  !/\/\*\s*wgsl\s*\*\//.test(renderer) && /planet\.wgsl\?raw/.test(renderer) &&
    /follower\.wgsl\?raw/.test(renderer) && /hut\.wgsl\?raw/.test(renderer) &&
    /tree\.wgsl\?raw/.test(renderer))

const pipelines = withoutComments(renderer).match(/createRenderPipeline\(/g)?.length ?? 0
const multisampled = withoutComments(renderer).match(/multisample:\s*\{\s*count:\s*SAMPLE_COUNT\s*\}/g)?.length ?? 0
check('every render pipeline is multisampled', pipelines === 5 && multisampled === pipelines,
  `${multisampled} of ${pipelines}`)
check('the sample count is 4', /const SAMPLE_COUNT = 4\b/.test(renderer))
check('colour and depth targets are multisampled to match',
  (withoutComments(renderer).match(/sampleCount:\s*SAMPLE_COUNT/g)?.length ?? 0) === 2)
check('and the colour target is resolved to the canvas texture',
  /resolveTarget:\s*context\.getCurrentTexture\(\)/.test(withoutComments(renderer)))

const configure = withoutComments(context)
check('the canvas is opaque', /alphaMode:\s*'opaque'/.test(configure) && !/premultiplied/.test(configure))
check('the canvas context gets no tone mapping of its own',
  !/toneMapping/.test(configure) && !/toneMapping/.test(withoutComments(renderer)))
check('no optional device features are requested', !/requiredFeatures/.test(configure))

if (failures.length > 0) {
  console.error(`\n${failures.length} gpu check(s) failed`)
  process.exit(1)
}
console.log('\nall gpu checks passed')
