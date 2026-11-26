/**
 * The browser half of `npm run check:webgpu` (scripts/check-webgpu.mjs runs
 * it in headless Chromium). Builds the real game on the real core, draws it
 * with the real renderer — offscreen, so it works where a headless browser
 * cannot present to a canvas — and reports to `window.__check`:
 *
 * - every shader module's compilation messages (an error fails the check);
 * - which optional features the device got, and GPU pass timings when it can
 *   measure them;
 * - after a sculpt, whether the normals the GPU rebuilt match the CPU's;
 * - that a spell landing puts particles on screen, and the day–night sun;
 * - the frames themselves, as RGBA, for the runner to save as PNGs.
 *
 * `?features=` withholds optional features, as in the game.
 *
 * `?follower=fixture` draws the followers from the optimiser-made glTF in
 * scripts/fixtures, `?follower=box` from a deliberately different shape, both
 * loaded through the real manifest, asset manager and mesh glue (a stand-in
 * `fetch` serves the bytes). The runner compares their close-ups with the
 * procedural pawn's. Without `?follower` and `?features` the page also renders
 * every synthesised sound offline and drives the real audio engine and HUD
 * against the browser's own `AudioContext` and `localStorage`.
 */
import { createGameAssets } from '../../src/assets/manager'
import { followerMeshFromAssets } from '../../src/assets/models'
import { createAudioEngine } from '../../src/audio/engine'
import { AUDIO_SETTINGS_KEY } from '../../src/audio/settings'
import { createNoise, SOUND_IDS, SOUNDS } from '../../src/audio/sounds'
import type { ShaderDiagnostic } from '../../src/engine/materials'
import { createRenderer } from '../../src/engine/renderer'
import { withheldFeatures } from '../../src/engine/webgpu'
import { refreshGeometry, VERTEX_FLOATS } from '../../src/engine/mesh/cubeSphere'
import { FOLLOWER_HEIGHT_FRACTION, FOLLOWER_RADIUS_FRACTION } from '../../src/game/followers'
import { createGame } from '../../src/game/game'
import { fetchWorld } from '../../src/world/campaign'
import type { InputSnapshot } from '../../src/input/input'
import { createSimulation } from '../../src/sim/simulation'
import { Spell } from '../../src/sim/spell'
import { createHud } from '../../src/ui/hud'
import { CANVAS_ASPECT } from '../../src/viewport'
import { writeGlb } from '../glb-writer'

type Frame = { name: string; width: number; height: number; rgba: string }
type Result = {
  ok: boolean
  failures: string[]
  notes: string[]
  features: Record<string, boolean>
  status: string
  diagnostics: ShaderDiagnostic[]
  gpu: unknown
  normals: { compared: number; worstDegrees: number } | null
  /** Triangles in the follower mesh the renderer was given, when it was given one. */
  followerTriangles: number | null
  frames: Frame[]
}

const failures: string[] = []
const notes: string[] = []
const check = (name: string, condition: boolean, detail = '') => {
  if (!condition) failures.push(detail ? `${name} — ${detail}` : name)
  else notes.push(detail ? `ok ${name} — ${detail}` : `ok ${name}`)
}

const idle = (pressed: string[] = []): InputSnapshot => ({
  keys: new Set(),
  pressed: new Set(pressed),
  pointer: {
    position: null,
    ndc: null,
    delta: { x: 0, y: 0 },
    buttons: { left: false, middle: false, right: false },
    wheel: 0,
    dragging: false,
    dragRect: null,
    drags: [],
    clicks: [],
  },
})

const base64 = (bytes: Uint8Array) => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}

/** A box 0.5 wide and 1 tall: nothing like the pawn, so a swap shows. */
function boxGlb(): Uint8Array {
  const [w, h, d] = [0.25, 1, 0.25]
  const p = (x: number, y: number, z: number): [number, number, number] => [x * w, y * h, z * d]
  // 12 triangles, counter-clockwise from outside.
  const quads: [number, number, number][][] = [
    [p(-1, 0, 1), p(1, 0, 1), p(1, 1, 1), p(-1, 1, 1)],
    [p(1, 0, -1), p(-1, 0, -1), p(-1, 1, -1), p(1, 1, -1)],
    [p(1, 0, 1), p(1, 0, -1), p(1, 1, -1), p(1, 1, 1)],
    [p(-1, 0, -1), p(-1, 0, 1), p(-1, 1, 1), p(-1, 1, -1)],
    [p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1)],
    [p(-1, 0, -1), p(1, 0, -1), p(1, 0, 1), p(-1, 0, 1)],
  ]
  const positions: number[] = []
  for (const [a, b, c, e] of quads) {
    positions.push(...a!, ...b!, ...c!, ...a!, ...c!, ...e!)
  }
  return writeGlb([{ material: 'body', positions: new Float32Array(positions) }])
}

/**
 * The game's own asset manager, with a `fetch` that serves the one model the
 * variant asks for and nothing else: the real manifest, URL handling,
 * streaming, parsing and mesh glue, without a file in `public/`.
 */
function assetsServing(bytes: () => Promise<Uint8Array>) {
  const serve = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('models/follower.glb')) {
      const body = await bytes()
      return new Response(body.slice().buffer, {
        headers: { 'content-type': 'model/gltf-binary', 'content-length': String(body.length) },
      })
    }
    return new Response('not here', { status: 404 })
  }) as typeof fetch
  return createGameAssets({ fetch: serve, baseUrl: location.href })
}

/** Each synthesised sound rendered offline: audible, finite, and over by its own end. */
async function checkSynthesis() {
  const rate = 44100
  for (const id of SOUND_IDS) {
    const ctx = new OfflineAudioContext(1, rate * 3, rate)
    const noise = createNoise(ctx)
    const seconds = SOUNDS[id].synth({ ctx, out: ctx.destination, when: 0.01, noise, pitch: 1 })
    const data = (await ctx.startRendering()).getChannelData(0)
    let peak = 0
    let finite = true
    let lastAudible = 0
    for (let i = 0; i < data.length; i += 1) {
      const v = data[i]!
      finite &&= Number.isFinite(v)
      peak = Math.max(peak, Math.abs(v))
      if (Math.abs(v) > 1e-3) lastAudible = i
    }
    const endsAt = lastAudible / rate
    check(`${id}: renders audible sound`, finite && peak > 0.05 && peak < 3, `peak ${peak.toFixed(2)}`)
    check(`${id}: is over when its recipe says (${seconds.toFixed(2)}s)`, endsAt > 0.02 && endsAt <= 0.01 + seconds + 0.15,
      `last audible at ${endsAt.toFixed(2)}s`)
  }
}

/** The real engine and HUD against the browser's AudioContext and localStorage. */
async function checkAudioEngine() {
  localStorage.removeItem(AUDIO_SETTINGS_KEY)
  const hud = createHud()
  hud.setLoading({ label: 'Loading assets', fraction: 0.4 })
  const label = document.querySelector('#hud-loading-label')?.textContent ?? ''
  check('the loading screen shows its label and percentage', label === 'Loading assets — 40%', label)
  check('and a progress bar the screen reader can read',
    document.querySelector('.loading-bar')?.getAttribute('aria-valuenow') === '40')
  hud.setLoading(null)
  check('and goes away when told', document.querySelector('#hud-loading') === null)

  const make = () =>
    createAudioEngine({ planetRadius: 1, createContext: () => new AudioContext() })
  const engine = make()
  hud.bindAudio({
    setMuted: (muted) => engine.setMuted(muted),
    setMasterVolume: (volume) => engine.setVolume('master', volume),
  })
  check('before a gesture the engine is locked', engine.state === 'locked')
  engine.unlock()
  engine.setListener({ position: [0, 0, 3], forward: [0, 0, -1], up: [0, 1, 0] })
  for (let i = 0; i < 40 && engine.state !== 'running'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  check('the browser lets it run', engine.state === 'running', engine.state)
  check('a sound at a place plays through the browser\'s panner', engine.play('chop', [0, 0, 1]) && engine.voiceCount === 1)
  check('as does one behind the planet', engine.play('spellImpact', [0, 0, -1]) && engine.voiceCount === 2)
  check('and a UI sound', engine.play('click'))

  const mute = document.querySelector<HTMLButtonElement>('#hud-audio-mute')!
  hud.setAudio({ muted: engine.settings.muted, master: engine.settings.master, state: engine.state })
  check('the mute button reads sound on', mute.textContent === 'sound on', mute.textContent ?? '')
  mute.click()
  hud.setAudio({ muted: engine.settings.muted, master: engine.settings.master, state: engine.state })
  check('clicking it mutes the engine', engine.settings.muted && mute.textContent === 'sound off' && mute.getAttribute('aria-pressed') === 'true')
  check('and nothing plays while it is muted', !engine.play('death', [0, 0, 1]))
  const volume = document.querySelector<HTMLInputElement>('#hud-audio-volume')!
  volume.value = '30'
  volume.dispatchEvent(new Event('input'))
  check('the slider sets the master volume', Math.abs(engine.settings.master - 0.3) < 1e-9)

  const stored = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) ?? 'null') as { muted?: boolean; master?: number } | null
  check('both are in localStorage', stored?.muted === true && stored.master === 0.3, JSON.stringify(stored))
  const reloaded = make()
  check('and a fresh engine, as after a reload, comes back muted at that volume', reloaded.settings.muted && Math.abs(reloaded.settings.master - 0.3) < 1e-9)
  reloaded.unlock()
  check('and plays nothing until unmuted', !reloaded.play('chop', [0, 0, 1]))
  reloaded.setMuted(false)
  for (let i = 0; i < 40 && reloaded.state !== 'running'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  check('unmuting makes it sound again', reloaded.play('chop', [0, 0, 1]))
  localStorage.removeItem(AUDIO_SETTINGS_KEY)
}

async function run(): Promise<Result> {
  const params = new URLSearchParams(location.search)
  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')!
  const core = await createSimulation()
  // From the dev server's root, where public/worlds is served, not this page's directory.
  const game = createGame(core, { scenario: await fetchWorld('ember-shoal', fetch, `${location.origin}/`), seed: 1 })

  // A loaded follower, if the variant asks for one: through the game's own
  // manifest, manager and glue, as main.ts does it.
  const mode = params.get('follower')
  let followerMesh: ReturnType<typeof followerMeshFromAssets> = null
  if (mode === 'fixture' || mode === 'box') {
    const assets = assetsServing(async () =>
      mode === 'box'
        ? boxGlb()
        : new Uint8Array(await (await fetch('/scripts/fixtures/follower.optimized.glb')).arrayBuffer()),
    )
    await assets.load('model.follower')
    followerMesh = followerMeshFromAssets(assets, {
      height: game.planet.radius * FOLLOWER_HEIGHT_FRACTION,
      radius: game.planet.radius * FOLLOWER_RADIUS_FRACTION,
    })
    check('the model loaded through the manager becomes a follower mesh', followerMesh !== null,
      followerMesh ? `${followerMesh.triangleCount} triangles` : 'the glue refused it')
  }

  const renderer = await createRenderer(canvas, game, {
    offscreen: true,
    withholdFeatures: withheldFeatures(params.get('features')),
    ...(followerMesh ? { followerMesh } : {}),
  })
  if (followerMesh) {
    check('the renderer draws the loaded mesh, not the procedural pawn',
      renderer.statusMessage.includes(`followers instanced (${followerMesh.triangleCount} triangles each)`), renderer.statusMessage)
  }

  const frames: Frame[] = []
  const draw = async (count: number, input: InputSnapshot = idle()) => {
    for (let i = 0; i < count; i += 1) {
      core.tick(16)
      game.update(16, i === 0 ? input : idle(), CANVAS_ASPECT)
      renderer.render(game)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const capture = async (name: string) => {
    const shot = await renderer.capture()
    frames.push({ name, width: shot.width, height: shot.height, rgba: base64(shot.pixels) })
    return shot
  }

  // --- shaders -----------------------------------------------------------------
  await draw(3)
  const diagnostics = await renderer.diagnostics()
  const errors = diagnostics.flatMap((d) => d.messages.filter((m) => m.type === 'error').map((m) => `${d.label}:${m.line} ${m.message}`))
  check('every shader compiles', errors.length === 0, errors.join('\n') || `${diagnostics.length} modules`)
  const labels = new Set(diagnostics.map((d) => d.label))
  for (const expected of ['planet', 'water', 'atmosphere', 'followers', 'huts', 'hut-ghost', 'trees', 'particles', 'particle-step', 'terrain-normals', 'composite']) {
    check(`the ${expected} shader was built`, labels.has(expected))
  }

  // --- a frame, and that it shows something -----------------------------------
  await draw(20)
  const day = await capture('follow-sun')
  const at = (x: number, y: number) => {
    const i = (Math.floor(y) * day.width + Math.floor(x)) * 4
    return [day.pixels[i]!, day.pixels[i + 1]!, day.pixels[i + 2]!]
  }
  const centre = at(day.width / 2, day.height / 2)
  const corner = at(4, 4)
  check('the planet is drawn at the centre of the frame', centre.some((c, i) => Math.abs(c - corner[i]!) > 20),
    `centre ${centre}, corner ${corner}`)
  check('the background keeps the game\'s clear colour through the exposure curve',
    corner.every((c, i) => Math.abs(c - [10, 13, 23][i]!) <= 3), `corner ${corner}`)

  // --- the village up close: where a different follower shows -----------------------
  {
    const home = game.match.playerHome ?? [0, 1, 0]
    game.camera.focusOn(home, true)
    const zoom = idle()
    await draw(2)
    game.update(16, { ...zoom, pointer: { ...zoom.pointer, wheel: -60 } }, CANVAS_ASPECT)
    await draw(40)
    await capture('closeup')
    // Back to the opening shot, as createGame left it, for the checks below.
    game.camera.reset()
    game.camera.focusOn(home, true)
    await draw(30)
  }

  // --- GPU normals match the CPU's after a sculpt -------------------------------
  const home = game.match.playerHome ?? [0, 1, 0]
  await game.terrain.sculpt(home, 0.12, game.planet.maxHeight * 0.6)
  await draw(4)
  let normals: Result['normals'] = null
  if (game.planet.mesh.normalsOnGpu) {
    const gpu = await renderer.readPlanetVertices()
    const reference = structuredClone(game.planet.mesh)
    reference.normalsOnGpu = false
    refreshGeometry(reference)
    let worst = 0
    let compared = 0
    for (let v = 0; v < reference.vertexCount; v += 1) {
      const b = v * VERTEX_FLOATS
      const dot = gpu[b + 3]! * reference.vertexData[b + 3]! + gpu[b + 4]! * reference.vertexData[b + 4]! +
        gpu[b + 5]! * reference.vertexData[b + 5]!
      worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI)
      compared += 1
    }
    normals = { compared, worstDegrees: worst }
    check('GPU normals after a sculpt match the CPU\'s to within 0.1°', worst < 0.1, `worst ${worst.toFixed(4)}° over ${compared} vertices`)
  }
  await capture('after-sculpt')

  // --- a spell landing puts particles up ---------------------------------------
  const before = await renderer.capture()
  const take = game.takeSpellLandings
  let once = true
  game.takeSpellLandings = () => {
    const real = take()
    if (once) {
      once = false
      real.push({ spell: Spell.blast, tribe: 0, target: home, radius: 0.08 })
    }
    return real
  }
  await draw(12)
  const blast = await capture('blast')
  let changed = 0
  for (let i = 0; i < blast.pixels.length; i += 4) {
    if (Math.abs(blast.pixels[i]! - before.pixels[i]!) > 24) changed += 1
  }
  check('a blast landing changes the picture (particles)', changed > 200, `${changed} pixels changed`)

  // --- the day turns ------------------------------------------------------------
  game.sun.update(0, idle(['KeyN']), game.camera.eye)
  check('N turns the sun to the day cycle', game.sun.mode === 'cycle')
  await draw(4)
  await capture('day-cycle')

  // --- GPU timings ---------------------------------------------------------------
  await draw(10)
  await new Promise((resolve) => setTimeout(resolve, 200))
  const gpu = renderer.takeGpuTimings()
  if (renderer.features.timestampQuery) {
    check('timestamp-query gives GPU pass timings', gpu !== null && gpu.totalMs > 0,
      gpu ? `${gpu.totalMs.toFixed(3)}ms over ${gpu.frames} frames` : 'none')
  } else {
    check('without timestamp-query there are no GPU timings, and nothing pretends otherwise',
      gpu === null && !renderer.gpuTimingSupported)
  }

  if (mode === null && !params.has('features')) {
    await checkSynthesis()
    await checkAudioEngine()
  }

  return {
    ok: failures.length === 0,
    failures,
    notes,
    features: { ...renderer.features },
    status: renderer.statusMessage,
    diagnostics,
    gpu,
    normals,
    followerTriangles: followerMesh ? followerMesh.triangleCount : null,
    frames,
  }
}

const target = window as unknown as { __check?: Result | { ok: false; failures: string[] } }
run()
  .then((result) => {
    target.__check = result
  })
  .catch((error: unknown) => {
    target.__check = { ok: false, failures: [`the check threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`] }
  })
