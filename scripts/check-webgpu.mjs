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
]

const VARIANTS = [
  { name: 'all-features', query: '' },
  { name: 'no-features', query: '?features=none' },
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
      const file = join(outDir, `${variant.name}-${frame.name}.png`)
      writeFileSync(file, png(frame.width, frame.height, Buffer.from(frame.rgba, 'base64')))
      console.log(`frame ${file}`)
    }
    const problems = [...(result.failures ?? []), ...consoleErrors.map((e) => `console error: ${e}`)]
    for (const problem of problems) console.error(`FAIL ${problem}`)
    if (problems.length > 0 || !result.ok) failed = true
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
