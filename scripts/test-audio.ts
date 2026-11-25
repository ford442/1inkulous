/**
 * Sound, without a speaker: the settings and where they are kept, the geometry
 * of the listener, the events the world raises, and the engine that turns them
 * into voices — driven against a stand-in `AudioContext` that records its graph
 * and refuses what the real one refuses (a ramp to zero, a negative time).
 *
 * The acceptance that matters: mute and volume survive a reload through
 * `localStorage`, and the engine honours them from its first sample.
 *
 * Run: npm run test:audio
 */
import { readFileSync } from 'node:fs'
import { createAudioEngine, type AudioEngineOptions } from '../src/audio/engine.ts'
import { soundForEvent } from '../src/audio/events.ts'
import {
  AUDIO_SETTINGS_KEY,
  DEFAULT_AUDIO_SETTINGS,
  gainFor,
  loadAudioSettings,
  sanitizeAudioSettings,
  saveAudioSettings,
  type AudioSettings,
  type SettingsStorage,
} from '../src/audio/settings.ts'
import { SOUND_IDS, SOUND_SAMPLE_KEYS, SOUNDS, createNoise } from '../src/audio/sounds.ts'
import {
  hiddenByPlanet,
  listenerPoseFromView,
  OCCLUDED_GAIN,
  planSource,
  type ListenerPose,
} from '../src/audio/spatial.ts'
import { MANIFEST } from '../src/assets/manifest.ts'
import { mat4LookAt, type Vec3 } from '../src/engine/math.ts'
import {
  CHOP_BLOWS,
  createGameEvents,
  removedFollowers,
  type GameEvent,
  type GameEventSource,
} from '../src/game/gameEvents.ts'
import { HutKind } from '../src/sim/hutSite.ts'
import { Spell, SpellResult } from '../src/sim/spell.ts'
import { audioLabel } from '../src/ui/hud.ts'

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

const near = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// --- settings and where they live ---------------------------------------------------

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const storage: SettingsStorage & { data: Map<string, string> } = {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
  return storage
}

{
  check('defaults are unmuted and audible', !DEFAULT_AUDIO_SETTINGS.muted && DEFAULT_AUDIO_SETTINGS.master > 0)
  const damaged = sanitizeAudioSettings({ muted: 'yes', master: 7, music: -3, sfx: NaN, ui: '0.5', extra: 1 })
  check('bad fields fall back or clamp, field by field',
    damaged.muted === false && damaged.master === 1 && damaged.music === 0 &&
    damaged.sfx === DEFAULT_AUDIO_SETTINGS.sfx && damaged.ui === DEFAULT_AUDIO_SETTINGS.ui, JSON.stringify(damaged))
  check('anything that is not an object is the defaults', [null, 3, 'x', [], undefined].every((v) => JSON.stringify(sanitizeAudioSettings(v)) === JSON.stringify(DEFAULT_AUDIO_SETTINGS)))
  check('the gain curve is monotonic, squared, and clamped', gainFor(0) === 0 && gainFor(1) === 1 && near(gainFor(0.5), 0.25) &&
    gainFor(2) === 1 && gainFor(-1) === 0 && gainFor(NaN) === 0)

  const store = memoryStorage()
  const chosen: AudioSettings = { muted: true, master: 0.35, music: 0.1, sfx: 0.7, ui: 0.25 }
  check('settings are saved', saveAudioSettings(chosen, store) && store.data.has(AUDIO_SETTINGS_KEY))
  check('and loaded back exactly', JSON.stringify(loadAudioSettings(store)) === JSON.stringify(chosen))
  check('an empty store is the defaults', JSON.stringify(loadAudioSettings(memoryStorage())) === JSON.stringify(DEFAULT_AUDIO_SETTINGS))
  check('stored text that is not JSON is the defaults, not a crash',
    JSON.stringify(loadAudioSettings(memoryStorage({ [AUDIO_SETTINGS_KEY]: '{oops' }))) === JSON.stringify(DEFAULT_AUDIO_SETTINGS))
  const partial = loadAudioSettings(memoryStorage({ [AUDIO_SETTINGS_KEY]: '{"muted":true,"master":"loud"}' }))
  check('and a half-valid one keeps what is valid', partial.muted && partial.master === DEFAULT_AUDIO_SETTINGS.master)

  const hostile: SettingsStorage = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('quota') },
  }
  check('storage that throws is survived on read and on write',
    JSON.stringify(loadAudioSettings(hostile)) === JSON.stringify(DEFAULT_AUDIO_SETTINGS) && saveAudioSettings(chosen, hostile) === false)
  check('no storage at all is fine too', loadAudioSettings(null) === DEFAULT_AUDIO_SETTINGS && saveAudioSettings(chosen, null) === false)
}

// --- the listener ------------------------------------------------------------------------

{
  const pose = (eye: Vec3, target: Vec3, up: Vec3): ListenerPose => listenerPoseFromView(mat4LookAt(eye, target, up), eye)
  const front = pose([0, 0, 5], [0, 0, 0], [0, 1, 0])
  check('a camera on +Z looking at the origin faces -Z, head up',
    near(front.forward[0], 0) && near(front.forward[1], 0) && near(front.forward[2], -1) && near(front.up[1], 1))
  const side = pose([3, 0, 0], [0, 0, 0], [0, 1, 0])
  check('from +X it faces -X', near(side.forward[0], -1) && near(side.forward[2], 0))
  const above = pose([0, 4, 3], [0, 0, 0], [0, 1, 0])
  const f = above.forward
  check('the pose has unit axes at right angles', near(Math.hypot(...f), 1, 1e-5) && near(Math.hypot(...above.up), 1, 1e-5) &&
    near(f[0] * above.up[0] + f[1] * above.up[1] + f[2] * above.up[2], 0, 1e-5))
  check('and looks down towards the planet', f[1] < 0 && f[2] < 0)

  const eye: Vec3 = [0, 0, 3]
  check('the far side of the planet hides a source', hiddenByPlanet(eye, [0, 0, -1], 0.985))
  check('the near side does not', !hiddenByPlanet(eye, [0, 0, 1], 0.985))
  check('past the horizon (90° round) is hidden, short of it (60°) is not',
    hiddenByPlanet(eye, [1, 0, 0], 0.985) && !hiddenByPlanet(eye, [0.866, 0, 0.5], 0.985))
  check('a source at the eye is not hidden by anything', !hiddenByPlanet([0, 0, 3], [0, 0, 3], 0.985))
  const near1 = planSource(front, [0, 0, 1], 1)
  const far1 = planSource(front, [0, 0, -1], 1)
  check('a hidden source is quieter and duller than a clear one', near1.gain === 1 && far1.gain === OCCLUDED_GAIN && far1.cutoffHz < near1.cutoffHz)
  check('and distance is the straight line', near(near1.distance, 4) && near(far1.distance, 6))
}

// --- a stand-in AudioContext ---------------------------------------------------------------

class Param {
  value = 0
  events: { kind: string; value: number; time: number }[] = []
  private note(kind: string, value: number, time: number) {
    if (!Number.isFinite(value) || !Number.isFinite(time) || time < 0) {
      throw new RangeError(`${kind}(${value}, ${time}) is not allowed`)
    }
    this.events.push({ kind, value, time })
  }
  setValueAtTime(value: number, time: number) { this.note('set', value, time); this.value = value; return this }
  linearRampToValueAtTime(value: number, time: number) { this.note('linear', value, time); this.value = value; return this }
  exponentialRampToValueAtTime(value: number, time: number) {
    if (value <= 0) throw new RangeError('exponentialRampToValueAtTime needs a positive target')
    this.note('exp', value, time); this.value = value; return this
  }
  setTargetAtTime(value: number, time: number, constant: number) {
    if (!(constant > 0)) throw new RangeError('time constant must be positive')
    this.note('target', value, time); return this
  }
}

class Node {
  kind: string
  out: Node[] = []
  disconnected = false
  params: Record<string, Param> = {}
  started: number | null = null
  stopped: number | null = null
  // What the engine and the recipes set on one kind of node or another.
  type = ''
  buffer: unknown = null
  loop = false
  panningModel = ''
  distanceModel = ''
  refDistance = 0
  rolloffFactor = 0
  maxDistance = 0
  constructor(kind: string, params: string[] = []) {
    this.kind = kind
    for (const name of params) this.params[name] = new Param()
    Object.assign(this, this.params)
  }
  connect(to: Node) { this.out.push(to); return to }
  disconnect() { this.disconnected = true; this.out = [] }
  start(time = 0) {
    if (this.started !== null) throw new Error('already started')
    if (time < 0) throw new RangeError('negative start')
    this.started = time
  }
  stop(time = 0) { this.stopped = time }
}

class FakeContext {
  state = 'suspended'
  currentTime = 1
  sampleRate = 8000
  destination = new Node('destination')
  listener: Record<string, unknown> = {}
  nodes: Node[] = []
  resumes = 0
  suspends = 0
  decoded: ArrayBuffer[] = []
  decodeFails = false
  constructor(legacyListener = false) {
    if (legacyListener) {
      this.listener = { calls: [] as unknown[][], setPosition: (...a: number[]) => (this.listener.calls as unknown[][]).push(['pos', ...a]), setOrientation: (...a: number[]) => (this.listener.calls as unknown[][]).push(['ori', ...a]) }
    } else {
      for (const name of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) this.listener[name] = new Param()
    }
  }
  private make(kind: string, params: string[] = [], extra: Record<string, unknown> = {}) {
    const node = Object.assign(new Node(kind, params), extra)
    this.nodes.push(node)
    return node
  }
  createGain() { return this.make('gain', ['gain']) }
  createOscillator() { return this.make('osc', ['frequency'], { type: 'sine' }) }
  createBiquadFilter() { return this.make('biquad', ['frequency', 'Q'], { type: 'lowpass' }) }
  createBufferSource() { return this.make('source', ['playbackRate'], { buffer: null, loop: false }) }
  createDynamicsCompressor() { return this.make('limiter', ['threshold', 'knee', 'ratio', 'attack', 'release']) }
  createPanner() { return this.make('panner', ['positionX', 'positionY', 'positionZ'], { panningModel: '', distanceModel: '', refDistance: 0, rolloffFactor: 0, maxDistance: 0 }) }
  createBuffer(channels: number, length: number, rate: number) {
    const data = new Float32Array(length)
    return { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: () => data }
  }
  async decodeAudioData(bytes: ArrayBuffer) {
    this.decoded.push(bytes)
    if (this.decodeFails) throw new Error('unsupported codec')
    return { duration: 0.5, length: 4000, sampleRate: 8000, numberOfChannels: 1, getChannelData: () => new Float32Array(1) }
  }
  async resume() { this.resumes += 1; this.state = 'running' }
  async suspend() { this.suspends += 1; this.state = 'suspended' }
  ofKind(kind: string) { return this.nodes.filter((n) => n.kind === kind) }
}

function harness(extra: Partial<AudioEngineOptions> = {}, settings?: Partial<AudioSettings>, legacy = false) {
  const storage = memoryStorage()
  if (settings) saveAudioSettings({ ...DEFAULT_AUDIO_SETTINGS, ...settings }, storage)
  const contexts: FakeContext[] = []
  let clock = 0
  const warnings: string[] = []
  const engine = createAudioEngine({
    planetRadius: 1,
    storage,
    createContext: () => {
      const ctx = new FakeContext(legacy)
      contexts.push(ctx)
      return ctx as unknown as AudioContext
    },
    random: () => 0.5,
    now: () => clock,
    log: { warn: (m) => warnings.push(m) },
    ...extra,
  })
  return {
    engine, storage, contexts, warnings,
    get ctx() { return contexts[0]! },
    advance: (ms: number) => { clock += ms },
    /** Moves the audio clock too, so voices can run out. */
    wait: (seconds: number) => { clock += seconds * 1000; for (const c of contexts) c.currentTime += seconds },
    ready() { engine.unlock(); engine.setListener(LISTENER) },
  }
}

const LISTENER: ListenerPose = { position: [0, 0, 3], forward: [0, 0, -1], up: [0, 1, 0] }
const NEAR: Vec3 = [0, 0, 1]
const FAR: Vec3 = [0, 0, -1]

// --- the engine ----------------------------------------------------------------------------------

{
  const h = harness()
  check('before a gesture there is no audio context, and nothing plays', h.contexts.length === 0 && h.engine.state === 'locked' && !h.engine.play('chop', NEAR))
  h.engine.unlock()
  h.engine.unlock()
  check('unlock makes exactly one context, running', h.contexts.length === 1 && h.engine.state === 'running')
  const ctx = h.ctx
  const limiter = ctx.ofKind('limiter')[0]!
  const buses = ctx.ofKind('gain')
  check('the graph is buses -> master -> limiter -> out',
    limiter.out[0] === ctx.destination && buses.length === 4 && buses.slice(1).every((bus) => bus.out[0] === buses[0]) && buses[0]!.out[0] === limiter)
  check('the first sample is at the stored level (the defaults here)', near((buses[0]!.params.gain!).value, gainFor(DEFAULT_AUDIO_SETTINGS.master)))
}

{
  // Acceptance: what the player set last time is what plays this time.
  const stored = { muted: false, master: 0.5, music: 0.3, sfx: 0.6, ui: 0.2 }
  const h = harness({}, stored)
  h.engine.unlock()
  const [master, music, sfx, ui] = h.ctx.ofKind('gain') as [Node, Node, Node, Node]
  check('stored volumes are the starting volumes: master, music, sfx, ui',
    near(master.params.gain!.value, 0.25) && near(music.params.gain!.value, 0.09) && near(sfx.params.gain!.value, 0.36) && near(ui.params.gain!.value, 0.04),
    `${master.params.gain!.value}, ${music.params.gain!.value}, ${sfx.params.gain!.value}, ${ui.params.gain!.value}`)
  check('and the engine reports them', h.engine.settings.master === 0.5 && h.engine.settings.sfx === 0.6)

  const muted = harness({}, { muted: true })
  muted.ready()
  check('a stored mute starts silent: master at zero, nothing built for a sound', muted.ctx.ofKind('gain')[0]!.params.gain!.value === 0 &&
    muted.engine.settings.muted && !muted.engine.play('chop', NEAR) && muted.ctx.ofKind('osc').length === 0)
}

{
  const h = harness()
  h.ready()
  const seen: AudioSettings[] = []
  const stop = h.engine.onSettings((s) => seen.push(s))
  h.engine.setMuted(true)
  const master = h.ctx.ofKind('gain')[0]!.params.gain!
  const last = master.events.at(-1)!
  check('muting glides the master to zero rather than cutting it', last.kind === 'target' && last.value === 0)
  check('and is saved', JSON.parse(h.storage.data.get(AUDIO_SETTINGS_KEY)!).muted === true)
  check('a muted engine builds no voices', !h.engine.play('chop', NEAR) && !h.engine.play('click'))
  h.engine.toggleMuted()
  check('unmuting restores the master to its volume and sounds again',
    master.events.at(-1)!.value === gainFor(DEFAULT_AUDIO_SETTINGS.master) && h.engine.play('chop', NEAR))
  h.engine.setVolume('master', 0.4)
  h.engine.setVolume('sfx', 1.7)
  check('volumes are clamped, applied and saved', h.engine.settings.master === 0.4 && h.engine.settings.sfx === 1 &&
    JSON.parse(h.storage.data.get(AUDIO_SETTINGS_KEY)!).master === 0.4 && JSON.parse(h.storage.data.get(AUDIO_SETTINGS_KEY)!).sfx === 1)
  check('listeners hear each change; an unchanged value is not one', seen.length === 4)
  h.engine.setVolume('master', 0.4)
  stop()
  h.engine.setMuted(true)
  check('and stop hearing when they unsubscribe', seen.length === 4)

  // A reload: a new engine over the same storage.
  const again = createAudioEngine({ planetRadius: 1, storage: h.storage, createContext: () => new FakeContext() as unknown as AudioContext })
  check('a fresh engine over the same storage comes back muted at that volume', again.settings.muted && again.settings.master === 0.4)

  const unstorable = harness({ storage: null })
  unstorable.engine.setMuted(true)
  check('with no storage the settings still work for the session', unstorable.engine.settings.muted)
}

{
  const h = harness()
  h.ready()
  check('a positional sound plays', h.engine.play('chop', NEAR))
  const panner = h.ctx.ofKind('panner')[0]!
  const sfxBus = h.ctx.ofKind('gain')[2]!
  check('through a panner at its position, equal-power, inverse falloff',
    panner.params.positionZ!.value === 1 && panner.panningModel === 'equalpower' && panner.distanceModel === 'inverse' && panner.refDistance === 1)
  check('which feeds the sfx bus', panner.out[0] === sfxBus)
  check('with nothing muffling a source in view', h.ctx.ofKind('biquad').every((b) => b.type !== 'lowpass' || b.params.frequency!.value !== 700))

  h.wait(1)
  check('a source behind the planet goes through a low-pass and is quieter', h.engine.play('chop', FAR) &&
    h.ctx.nodes.some((n) => n.kind === 'biquad' && n.params.frequency!.value === 700))
  const level = h.ctx.ofKind('gain').filter((g) => g.out[0]?.kind === 'biquad')[0]!
  check('quieter by the occlusion factor', near(level.params.gain!.value, SOUNDS.chop.gain * OCCLUDED_GAIN))

  h.wait(1)
  check('a UI sound is unplaced, on the ui bus', h.engine.play('click') && h.ctx.ofKind('panner').length === 2 &&
    h.ctx.ofKind('gain').some((g) => g.out[0] === h.ctx.ofKind('gain')[3]))
  check('a positional sound with no position is heard unplaced', (h.wait(1), h.engine.play('death', null)) && h.ctx.ofKind('panner').length === 2)
}

{
  const h = harness()
  h.ready()
  check('the first chop plays', h.engine.play('chop', NEAR))
  check('another inside its cooldown does not', !h.engine.play('chop', NEAR))
  h.advance(SOUNDS.chop.cooldownMs + 1)
  check('after the cooldown it does', h.engine.play('chop', NEAR))
  check('but not a different sound\'s cooldown', (h.advance(0), h.engine.play('death', NEAR)))

  for (let i = 0; i < 10; i += 1) {
    h.advance(SOUNDS.chop.cooldownMs + 1)
    h.engine.play('chop', NEAR)
  }
  check('one kind of sound is held to its own voice limit', h.engine.voiceCount <= SOUNDS.chop.maxVoices + 1, `${h.engine.voiceCount} voices`)

  const capped = harness({ maxVoices: 2 })
  capped.ready()
  const started = SOUND_IDS.filter((id) => (capped.advance(500), capped.engine.play(id, NEAR))).length
  check('the whole engine is held to its voice cap', started === 2 && capped.engine.voiceCount === 2, `${started} started`)

  const before = h.ctx.nodes.length
  h.wait(5)
  h.engine.play('click')
  check('finished voices are disconnected and forgotten', h.engine.voiceCount === 1 && h.ctx.nodes.filter((n) => n.disconnected).length > 0, `${before} nodes made`)
}

// Every recipe: valid against the strict stand-in, bounded, and no voice left running.
for (const id of SOUND_IDS) {
  const h = harness()
  h.ready()
  const before = h.ctx.nodes.length
  let error: unknown = null
  try {
    h.engine.play(id, NEAR, { pitch: 1.3 })
  } catch (caught) {
    error = caught
  }
  const made = h.ctx.nodes.slice(before)
  const sources = made.filter((n) => n.kind === 'osc' || n.kind === 'source')
  const when = h.ctx.currentTime
  const longest = Math.max(0, ...sources.map((n) => n.stopped ?? Infinity))
  check(`${id}: its recipe is valid Web Audio (no ramp to zero, no negative time)`, error === null, String(error))
  check(`${id}: every oscillator and noise burst is started and has an end, within two seconds`,
    sources.length > 0 && sources.every((n) => n.started !== null && n.stopped !== null) && longest - when < 2, `${sources.length} sources, ends ${(longest - when).toFixed(2)}s out`)
  check(`${id}: it reaches a bus`, made.some((n) => n.out.some((o) => h.ctx.ofKind('gain').slice(1, 4).includes(o as never))))
}

{
  const h = harness()
  const noise = createNoise(h.ctx ?? (new FakeContext() as unknown as BaseAudioContext), () => 0.75)
  check('the shared noise is a second of samples in range', noise.length === 8000 && noise.getChannelData(0)[0] === 0.5)
}

{
  // Recorded samples replace the synthesised voice.
  const chopFile = new Uint8Array([1, 2, 3, 4]).buffer
  const asked: string[] = []
  const h = harness({
    loadSample: async (id) => { asked.push(id); return id === 'chop' ? chopFile : null },
    loadMusic: async () => new Uint8Array([9, 9]).buffer,
  })
  h.engine.unlock()
  await tick()
  await tick()
  check('on unlock every sound is asked for its recording', SOUND_IDS.every((id) => asked.includes(id)))
  check('a recording is decoded from a copy, so the cached file stays whole', h.ctx.decoded.length === 2 && h.ctx.decoded[0] !== chopFile && chopFile.byteLength === 4)
  h.engine.setListener(LISTENER)
  const sources = h.ctx.ofKind('source')
  const music = sources.find((s) => s.loop === true)
  check('music loops from its buffer on the music bus', !!music && music.started !== null && music.out[0]?.out[0] === h.ctx.ofKind('gain')[1])
  const before = h.ctx.ofKind('osc').length
  h.engine.play('chop', NEAR)
  check('a sound with a recording plays it, not the synthesiser', h.ctx.ofKind('osc').length === before &&
    h.ctx.ofKind('source').some((s) => s !== music && s.buffer !== null && s.started !== null && s.params.playbackRate!.value > 0))
  h.advance(1000)
  h.engine.play('death', NEAR)
  check('and a sound without one still has its synthesised voice', h.ctx.ofKind('osc').length > before)

  const broken = harness({ loadSample: async () => new Uint8Array([1]).buffer })
  broken.engine.unlock()
  broken.contexts[0]!.decodeFails = true
  await tick()
  await tick()
  broken.engine.setListener(LISTENER)
  check('a recording that will not decode is warned about and the synthesised voice plays', broken.warnings.length > 0 && broken.engine.play('chop', NEAR) &&
    broken.ctx.ofKind('osc').length > 0)
}

{
  const h = harness()
  h.ready()
  const l = h.ctx.listener as Record<string, Param>
  h.engine.setListener({ position: [1, 2, 3], forward: [0, 0, -1], up: [0, 1, 0] })
  check('the listener follows the camera', l.positionX!.value === 1 && l.positionY!.value === 2 && l.positionZ!.value === 3 &&
    l.forwardZ!.value === -1 && l.upY!.value === 1)

  const old = harness({}, undefined, true)
  old.engine.unlock()
  old.engine.setListener({ position: [1, 2, 3], forward: [0, 0, -1], up: [0, 1, 0] })
  const calls = (old.ctx.listener as { calls: unknown[][] }).calls
  check('and falls back to setPosition / setOrientation where there are no AudioParams',
    calls.length === 2 && calls[0]![0] === 'pos' && calls[1]![0] === 'ori')

  const early = harness()
  early.engine.setListener(LISTENER)
  early.engine.unlock()
  check('a pose given before unlock is applied once there is a listener', (early.ctx.listener as Record<string, Param>).positionZ!.value === 3)
}

{
  const h = harness()
  h.engine.unlock()
  h.engine.setPageVisible(false)
  check('a hidden page suspends the context', h.ctx.suspends === 1 && h.engine.state === 'suspended' && !h.engine.play('chop', NEAR))
  const resumes = h.ctx.resumes
  h.engine.unlock()
  check('and a click on it does not wake it while it is hidden', h.ctx.resumes === resumes)
  h.engine.setPageVisible(true)
  check('showing the page resumes it', h.engine.state === 'running')

  const none = harness({ createContext: () => null })
  none.engine.unlock()
  check('no web audio: the engine says so and stays quiet', none.engine.state === 'unsupported' && !none.engine.play('chop', NEAR))
  const throws = harness({ createContext: () => { throw new Error('no audio') } })
  throws.engine.unlock()
  check('a constructor that throws is the same', throws.engine.state === 'unsupported' && throws.warnings.length === 1)
  check('and its label says so', audioLabel({ muted: false, master: 1, state: 'unsupported' }) === 'no sound' &&
    audioLabel({ muted: true, master: 1, state: 'running' }) === 'sound off' && audioLabel({ muted: false, master: 1, state: 'locked' }) === 'sound on')
}

{
  // The first press or key unlocks.
  const h = harness()
  const target = new EventTarget()
  const page = Object.assign(new EventTarget(), { hidden: false })
  const detach = h.engine.attach(target, page as unknown as Document)
  target.dispatchEvent(new Event('pointermove'))
  check('only a press or a key unlocks', h.contexts.length === 0)
  target.dispatchEvent(new Event('pointerdown'))
  check('a pointer press unlocks', h.contexts.length === 1)
  page.hidden = true
  page.dispatchEvent(new Event('visibilitychange'))
  check('hiding the page suspends it', h.engine.state === 'suspended')
  detach()
  const second = harness()
  const other = new EventTarget()
  second.engine.attach(other)()
  other.dispatchEvent(new Event('keydown'))
  check('detaching removes the listeners', second.contexts.length === 0)
  const keys = harness()
  const keyTarget = new EventTarget()
  keys.engine.attach(keyTarget)
  keyTarget.dispatchEvent(new Event('keydown'))
  check('a key press unlocks', keys.contexts.length === 1)
}

// --- the events -------------------------------------------------------------------------------------

type Inst = number[]
const T = (x: number, y: number, z: number, progress = 0) => [x, y, z, 0, 0, 1, 0.02, progress]
const H = (x: number, y: number, z: number, tribe = 0, kind = 0) => [x, y, z, 0, 0, 1, tribe, 0, kind]
const F = (x: number, y: number, z: number, tribe = 0) => [x, y, z, 0, 0, 1, tribe, 0]
const flat = (rows: Inst[]) => new Float32Array(rows.flat())

function world() {
  const state = {
    trees: [] as Inst[],
    huts: [] as Inst[],
    followers: [] as Inst[],
    pop: new Map<number, number>([[0, 0], [1, 0]]),
    casting: new Map<number, { spell: Spell; progress: number; target: Vec3; radius: number } | null>([[0, null], [1, null]]),
    end: new Map<number, { count: number; spell: Spell; result: SpellResult }>([
      [0, { count: 0, spell: Spell.blast, result: SpellResult.ok }],
      [1, { count: 0, spell: Spell.blast, result: SpellResult.ok }],
    ]),
  }
  const source: GameEventSource = {
    treeInstances: () => flat(state.trees),
    treeInstanceFloats: 8,
    hutInstances: () => flat(state.huts),
    hutInstanceFloats: 9,
    followerInstances: () => flat(state.followers),
    followerInstanceFloats: 8,
    population: (tribe) => state.pop.get(tribe) ?? 0,
    spellCasting: (tribe) => state.casting.get(tribe) ?? null,
    lastSpellEnd: (tribe) => state.end.get(tribe)!,
  }
  return { state, source }
}

const ofType = (events: GameEvent[], type: GameEvent['type']) => events.filter((e) => e.type === type)

{
  // Looking costs a pass over every tree and follower: only when a step ran.
  const w = world()
  let step = 0
  let looks = 0
  const counting: GameEventSource = {
    ...w.source,
    get stepCount() { return step },
    treeInstances: () => { looks += 1; return w.source.treeInstances() },
  }
  w.state.trees = [T(1, 0, 0)]
  const events = createGameEvents(counting, { tribes: [0, 1], planetRadius: 1 })
  const seeded = looks
  w.state.huts = [H(0, 0, 1)]
  const idle = [events.poll(), events.poll(), events.poll()]
  check('between steps nothing is looked at and nothing is reported', looks === seeded && idle.every((e) => e.length === 0), `${looks - seeded} looks`)
  step = 1
  const built = events.poll()
  check('on the next step the change is seen, once', looks === seeded + 1 && ofType(built, 'hutBuilt').length === 1)
  check('and a poll without a new step is quiet again', events.poll().length === 0 && looks === seeded + 1)
}

{
  const w = world()
  w.state.trees = [T(1, 0, 0), T(0, 1, 0)]
  w.state.huts = [H(0, 0, 1)]
  w.state.followers = [F(0.5, 0.5, 0), F(0.4, 0.6, 0)]
  w.state.pop.set(0, 2)
  const events = createGameEvents(w.source, { tribes: [0, 1], planetRadius: 1 })
  check('the world as it starts is not news', events.poll().length === 0 && events.poll().length === 0)

  // A tree being chopped: blows at each mark, a felling at the end.
  const blows: GameEvent[] = []
  for (let step = 1; step <= 40; step += 1) {
    w.state.trees = [T(1, 0, 0, step / 40), T(0, 1, 0)]
    blows.push(...ofType(events.poll(), 'chop'))
  }
  w.state.trees = [T(0, 1, 0)]
  const felled = ofType(events.poll(), 'treeFelled')
  check(`a chop is ${CHOP_BLOWS} blows over its progress, at the tree`, blows.length === CHOP_BLOWS && blows.every((b) => b.type === 'chop' && b.position[0] === 1), `${blows.length} blows`)
  check('and the felling comes once, when the tree is gone, at the tree', felled.length === 1 && felled[0]!.type === 'treeFelled' && (felled[0] as { position: Vec3 }).position[0] === 1)
  check('and only once', events.poll().length === 0)

  // A tree built over, not chopped: no felling.
  w.state.trees = []
  check('a tree that vanished unchopped (a hut over it, the sea) is not felled', ofType(events.poll(), 'treeFelled').length === 0)

  w.state.huts = [H(0, 0, 1), H(0, 1, 0, 1, 1)]
  const built = ofType(events.poll(), 'hutBuilt')
  check('a hut that appears is built, with its tribe and kind, at its place', built.length === 1 && built[0]!.type === 'hutBuilt' &&
    built[0]!.tribe === 1 && built[0]!.kind === HutKind.training && built[0]!.position[1] === 1)
  check('and is only built once', ofType(events.poll(), 'hutBuilt').length === 0)
}

{
  const w = world()
  const events = createGameEvents(w.source, { tribes: [0, 1], planetRadius: 2 })
  w.state.casting.set(0, { spell: Spell.blast, progress: 0.2, target: [0, 0, 1], radius: 0.1 })
  let got = events.poll()
  check('a cast beginning is heard at its target, on the planet\'s surface', ofType(got, 'spellCast').length === 1 &&
    (got[0] as { position: Vec3 }).position[2] === 2)
  w.state.casting.set(0, { spell: Spell.blast, progress: 0.7, target: [0, 0, 1], radius: 0.1 })
  check('and not again while it goes on', ofType(events.poll(), 'spellCast').length === 0)
  w.state.casting.set(0, null)
  w.state.end.set(0, { count: 1, spell: Spell.blast, result: SpellResult.ok })
  got = events.poll()
  check('the landing comes through the spell channel, with the cast\'s place', ofType(got, 'spellLanded').length === 1 &&
    (got.find((e) => e.type === 'spellLanded') as { position: Vec3 }).position[2] === 2)
  w.state.casting.set(1, { spell: Spell.swamp, progress: 0, target: [1, 0, 0], radius: 0.1 })
  w.state.end.set(1, { count: 1, spell: Spell.swamp, result: SpellResult.noMana })
  got = events.poll()
  check('a cast that failed is a cast, but no landing', ofType(got, 'spellCast').length === 1 && ofType(got, 'spellLanded').length === 0)
}

{
  // Deaths, placed by who is missing from the line.
  const w = world()
  w.state.followers = [F(1, 0, 0, 0), F(0, 1, 0, 0), F(0, 0, 1, 0), F(-1, 0, 0, 1), F(0, -1, 0, 1)]
  w.state.pop.set(0, 3)
  w.state.pop.set(1, 2)
  const events = createGameEvents(w.source, { tribes: [0, 1], planetRadius: 1 })

  w.state.followers = [F(1, 0, 0, 0), F(0, 0, 1, 0), F(-1, 0, 0, 1), F(0, -1, 0, 1)]
  w.state.pop.set(0, 2)
  let deaths = ofType(events.poll(), 'death') as Extract<GameEvent, { type: 'death' }>[]
  check('a death is placed where the missing follower stood', deaths.length === 1 && deaths[0]!.tribe === 0 && deaths[0]!.position![1] === 1, JSON.stringify(deaths))

  // Walking into a hut takes someone out of the list but not out of the tribe.
  w.state.followers = [F(1, 0, 0, 0), F(-1, 0, 0, 1), F(0, -1, 0, 1)]
  check('going into a hut is not a death: the tribe is the same size', ofType(events.poll(), 'death').length === 0)

  // Someone thrown a long way is still themselves.
  w.state.followers = [F(0.6, 0.8, 0, 0), F(-1, 0, 0, 1), F(0, -1, 0, 1)]
  check('someone thrown across the map is not a death', ofType(events.poll(), 'death').length === 0)

  w.state.followers = [F(0.6, 0.8, 0, 0), F(0, -1, 0, 1)]
  w.state.pop.set(1, 1)
  deaths = ofType(events.poll(), 'death') as typeof deaths
  check('and the other tribe\'s dead are placed too', deaths.length === 1 && deaths[0]!.tribe === 1 && deaths[0]!.position![0] === -1)

  w.state.pop.set(0, 1)
  w.state.followers = [F(0, -1, 0, 1)]
  deaths = ofType(events.poll(), 'death') as typeof deaths
  check('the last of a tribe\'s walkers going is a death at its place', deaths.length === 1 && deaths[0]!.tribe === 0 && near(deaths[0]!.position![0], 0.6, 1e-6))

  // The tribe grows (a birth: no event), then loses more than the line can show:
  // some of the dead were indoors. Each is still a death, placed where it can be.
  w.state.pop.set(1, 4)
  check('a birth is not an event', events.poll().length === 0)
  w.state.followers = []
  w.state.pop.set(1, 0)
  deaths = ofType(events.poll(), 'death') as typeof deaths
  check('a tribe that shrinks by more than the line shows still reports each death, placed or not',
    deaths.length === 4 && deaths.filter((d) => d.position === null).length === 3 && deaths.every((d) => d.tribe === 1),
    `${deaths.length} deaths, ${deaths.filter((d) => d.position === null).length} unplaced`)
}

{
  const p = (x: number, y: number, z: number, tribe = 0) => ({ x, y, z, tribe })
  check('removedFollowers: nothing gone is nothing', removedFollowers([p(1, 0, 0)], [p(1, 0, 0)]).length === 0)
  check('newcomers at the end are not removals', removedFollowers([p(1, 0, 0)], [p(1, 0, 0), p(0, 1, 0)]).length === 0)
  check('the last one going is found at the end', removedFollowers([p(1, 0, 0), p(0, 1, 0)], [p(1, 0, 0)]).length === 1)
  const two = removedFollowers([p(1, 0, 0), p(0, 1, 0), p(0, 0, 1), p(-1, 0, 0)], [p(0, 1, 0), p(-1, 0, 0)])
  check('two gone from the front and the middle are both found', two.length === 2 && two[0]!.x === 1 && two[1]!.z === 1)
  check('a lone walker who moved far is not removed', removedFollowers([p(1, 0, 0)], [p(0, 1, 0)]).length === 0)
}

{
  const at: Vec3 = [0.1, 0.2, 0.3]
  const cases: [GameEvent, string][] = [
    [{ type: 'chop', position: at }, 'chop'],
    [{ type: 'treeFelled', position: at }, 'chop'],
    [{ type: 'hutBuilt', position: at, tribe: 0, kind: HutKind.dwelling }, 'buildComplete'],
    [{ type: 'spellCast', position: at, tribe: 0, spell: Spell.blast }, 'spellCast'],
    [{ type: 'spellLanded', position: at, tribe: 0, spell: Spell.blast }, 'spellImpact'],
    [{ type: 'death', position: at, tribe: 0 }, 'death'],
  ]
  for (const [event, sound] of cases) {
    const request = soundForEvent(event)
    check(`${event.type} sounds as ${sound}, where it happened`, request?.sound === sound && request.at === at)
  }
  check('the felling is a lower, heavier chop than the blows', soundForEvent(cases[1]![0])!.options!.pitch! < 1 && soundForEvent(cases[1]![0])!.options!.gain! > 1)
  check('an unplaced death is still a sound', soundForEvent({ type: 'death', position: null, tribe: 0 })?.at === null)
  check('every sound in the manifest has a place, and every sound a manifest entry',
    SOUND_IDS.every((id) => SOUND_SAMPLE_KEYS[id] in MANIFEST) && Object.keys(MANIFEST).filter((k) => k.startsWith('audio.') && k !== 'audio.music').length === SOUND_IDS.length)
}

// --- wiring ----------------------------------------------------------------------------------------------------

{
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const main = read('src/main.ts')
  const game = read('src/game/game.ts')
  const hud = read('src/ui/hud.ts')
  check('main unlocks audio on a gesture, follows the camera, and plays what the world did',
    /audio\.attach\(window, document\)/.test(main) && /setListener\(listenerPoseFromView/.test(main) && /game\.takeEvents\(\)/.test(main) && /soundForEvent/.test(main))
  check('K toggles mute', /pressed\.has\('KeyK'\)[\s\S]{0,80}toggleMuted/.test(main))
  check('the HUD has the mute button and the volume slider, bound to the engine',
    /id="hud-audio-mute"/.test(hud) && /id="hud-audio-volume"/.test(hud) && /hud\.bindAudio/.test(main))
  check('the game hands out events on a drain of its own, apart from the particles\' landings',
    /takeEvents\(\)/.test(game) && /takeSpellLandings\(\)/.test(game))
}

if (failures.length > 0) {
  console.error(`\n${failures.length} audio check(s) failed`)
  process.exit(1)
}
console.log('\nall audio checks passed')
