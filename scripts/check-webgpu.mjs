/**
 * Headless WebGPU check: `npm run check:webgpu`.
 *
 * Serves the repo with Vite (so every `.wgsl` is composed exactly as in the
 * game), opens scripts/webgpu-check/ in headless Chromium on its software
 * WebGPU adapter (SwiftShader), and fails on any shader compilation error, GPU
 * validation error, or failed check there. It runs twice: once with every
 * optional feature the adapter has, once with `?features=none`, the path an
 * adapter without them takes.
 *
 * Needs the core built (`npm run build:wasm`) and Playwright with Chromium,
 * which this repo does not install: it is found on NODE_PATH or a global
 * install. Without it the check says so and exits 2, so a machine that cannot
 * run it is never mistaken for one where it passed.
 *
 * Frames are written as PNGs to the directory given as the first argument
 * (default: webgpu-check-out/).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(process.argv[2] ?? join(root, 'webgpu-check-out'))

let chromium
try {
  ;({ chromium } = createRequire(import.meta.url)('playwright'))
} catch {
  console.error('check:webgpu needs Playwright with Chromium (not a dependency of this repo).')
  process.exit(2)
}

// SwiftShader: a software Vulkan device Chromium's WebGPU runs on with no GPU.
const ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  // The audio checks start an AudioContext without a click, as a test must.
  '--autoplay-policy=no-user-gesture-required',
]

const VARIANTS = [
  { name: 'all-features', query: '' },
  { name: 'no-features', query: '?features=none' },
  // The follower swap: a loaded model must draw (the optimiser-made copy of the
  // pawn as the pawn does, a box as something plainly different).
  { name: 'loaded-fixture', query: '?follower=fixture' },
  { name: 'loaded-box', query: '?follower=box' },
]

/** A minimal RGBA8 PNG encoder: enough to look at a frame. */
function png(width, height, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes) => {
    let c = 0xffffffff
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'ascii')
    data.copy(out, 8)
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const server = await createServer({ root, logLevel: 'error', server: { port: 0 } })
await server.listen()
const { port } = server.httpServer.address()
const browser = await chromium.launch({ args: ARGS })
mkdirSync(outDir, { recursive: true })

/**
 * Pixels in `region` whose colour differs by more than `threshold` in any
 * channel. The frame is `width` pixels wide.
 */
function differing(a, b, width, region, threshold = 16) {
  let count = 0
  for (let y = region.y0; y < region.y1; y += 1) {
    for (let x = region.x0; x < region.x1; x += 1) {
      const i = (y * width + x) * 4
      if (
        Math.abs(a[i] - b[i]) > threshold ||
        Math.abs(a[i + 1] - b[i + 1]) > threshold ||
        Math.abs(a[i + 2] - b[i + 2]) > threshold
      ) {
        count += 1
      }
    }
  }
  return count
}

/**
 * Where the village stands in the close-up (1024x768): all of it on dry land.
 * The sea is animated from the wall clock (the renderer's own time), so a page
 * that took longer to start has other waves, and comparing whole frames would
 * count water. Land does not move. The framing is fixed — seed 1, the camera
 * on the player's home, a set zoom — so these numbers are too.
 */
const VILLAGE = { x0: 330, y0: 230, x1: 700, y1: 520 }

const closeups = new Map()
const closeupSize = new Map()
let failed = false
try {
  for (const variant of VARIANTS) {
    const page = await browser.newPage()
    const consoleErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(String(error)))
    await page.goto(`http://localhost:${port}/scripts/webgpu-check/index.html${variant.query}`)
    await page.waitForFunction(() => globalThis.__check !== undefined, null, { timeout: 120_000 })
    const result = await page.evaluate(() => globalThis.__check)
    await page.close()

    console.log(`\n=== ${variant.name}`)
    if (result.status) console.log(result.status)
    if (result.features) console.log('features', result.features)
    for (const note of result.notes ?? []) console.log(note)
    if (result.gpu) {
      console.log(
        'gpu',
        `${result.gpu.totalMs.toFixed(3)}ms/frame:`,
        result.gpu.passes.map((p) => `${p.name} ${p.ms.toFixed(3)}`).join(', '),
      )
    }
    for (const frame of result.frames ?? []) {
      if (frame.name === 'closeup') {
        closeups.set(variant.name, Buffer.from(frame.rgba, 'base64'))
        closeupSize.set(variant.name, frame.width)
      }
      const file = join(outDir, `${variant.name}-${frame.name}.png`)
      writeFileSync(file, png(frame.width, frame.height, Buffer.from(frame.rgba, 'base64')))
      console.log(`frame ${file}`)
    }
    const problems = [...(result.failures ?? []), ...consoleErrors.map((e) => `console error: ${e}`)]
    for (const problem of problems) console.error(`FAIL ${problem}`)
    if (problems.length > 0 || !result.ok) failed = true
  }
  // The swap, seen from outside: the optimiser's copy of the pawn must draw as
  // the pawn does, and a box must not.
  const base = closeups.get('all-features')
  const fixture = closeups.get('loaded-fixture')
  const box = closeups.get('loaded-box')
  if (base && fixture && box) {
    // Measured here, in the village: the loaded pawn differs from the procedural
    // one by next to nothing (what 16-bit positions and 8-bit normals cannot
    // hold: 0 pixels past the threshold, 11 levels at most), the box by thousands.
    const width = closeupSize.get('all-features') ?? 1024
    const fixtureDiff = differing(base, fixture, width, VILLAGE)
    const boxDiff = differing(base, box, width, VILLAGE)
    console.log(`\n=== follower swap (village close-up, pixels differing from the procedural pawn)`)
    console.log(`loaded pawn (quantised, meshopt-compressed): ${fixtureDiff}`)
    console.log(`loaded box: ${boxDiff}`)
    if (fixtureDiff > 300) {
      console.error(`FAIL the loaded pawn should draw as the procedural one does: ${fixtureDiff} pixels differ`)
      failed = true
    }
    if (boxDiff < 3000 || boxDiff < fixtureDiff * 10) {
      console.error(`FAIL a loaded box should visibly replace the pawn: only ${boxDiff} pixels differ`)
      failed = true
    }
  } else {
    console.error('FAIL the follower-swap variants did not each produce a close-up')
    failed = true
  }
} finally {
  await browser.close()
  await server.close()
}

if (failed) {
  console.error('\nheadless WebGPU check failed')
  process.exit(1)
}
console.log('\nheadless WebGPU check passed')
