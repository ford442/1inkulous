import type { Vec3 } from '../engine/math'
import {
  clampVolume,
  gainFor,
  loadAudioSettings,
  saveAudioSettings,
  type AudioSettings,
  type SettingsStorage,
  type VolumeKey,
  browserStorage,
} from './settings'
import { createNoise, SOUND_IDS, SOUNDS, type SoundId } from './sounds'
import { planSource, REF_DISTANCE, ROLLOFF, type ListenerPose } from './spatial'

/**
 * The game's sound: a Web Audio graph, a mixer, and voices placed in the world.
 *
 *     voice ─ [low-pass if hidden] ─ [panner] ─┐
 *                                              ├─ sfx ─┐
 *     voice (a UI sound) ──────────────────────┴─ ui ──┤
 *     music ───────────────────────────────────────────┴─ master ─ limiter ─ out
 *
 * - **Locked until the player acts.** Browsers will not start audio before a
 *   click or a key, so no `AudioContext` exists until `unlock()` — which
 *   `attachUnlock` wires to the first pointer or key press. A sound asked for
 *   before then is dropped, not queued: a chop that happened a minute ago is
 *   not worth hearing late.
 * - **Positional.** A sound given a world position goes through a `PannerNode`
 *   against the listener, which `setListener` keeps on the orbit camera, so it
 *   pans with the view and fades with distance; one on the far side of the
 *   planet is quieter and duller (`planSource`).
 * - **A voice is a few short-lived nodes.** The engine caps how many sound at
 *   once, and how often one kind may start (a crowd chopping is a rhythm, not a
 *   buzz), then disconnects each voice's nodes once its time is up.
 * - **Settings.** Mute and four volumes (master, music, sfx, ui), restored from
 *   and saved to `localStorage` (src/audio/settings.ts). Muting fades the
 *   master over a few milliseconds rather than cutting it, and stops new voices
 *   from being built at all.
 * - **Samples over synthesis.** Each sound has a synthesised voice
 *   (src/audio/sounds.ts); a recorded sample, once loaded and decoded, plays
 *   in its place. Music has no synthesised stand-in: no file, quiet bus.
 *
 * It takes its `AudioContext`, storage, clock and sample loader as options, so
 * the whole graph can be built and driven against a stand-in in Node.
 */

export type AudioEngineOptions = {
  /** World radius of the planet: what the planet is assumed to block. */
  planetRadius: number
  /** Where settings are kept. Defaults to `localStorage`; null keeps them in memory only. */
  storage?: SettingsStorage | null
  /** Makes the context on unlock. Null (or a throw) means this browser has no web audio. */
  createContext?: () => AudioContext | null
  /** A recorded sample's file, or null when there is none. */
  loadSample?: (id: SoundId) => Promise<ArrayBuffer | null>
  loadMusic?: () => Promise<ArrayBuffer | null>
  random?: () => number
  /** Milliseconds, monotonic; for the per-sound cooldown. */
  now?: () => number
  /** Voices at once, over every sound. */
  maxVoices?: number
  log?: { warn: (message: string) => void }
}

export type PlayOptions = {
  /** Multiplies the sound's own level. */
  gain?: number
  /** Multiplies its pitch (and speed, for a sample). */
  pitch?: number
}

export type AudioState = 'locked' | 'running' | 'suspended' | 'unsupported'

export type AudioEngine = {
  readonly settings: AudioSettings
  readonly state: AudioState
  /** Voices sounding or fading right now. */
  readonly voiceCount: number
  /** Starts the audio context. Call it from a user gesture; safe to call again. */
  unlock: () => void
  /**
   * Unlocks on the first pointer press or key press on `target`, and pauses the
   * context while the page is hidden. Returns a function that detaches both.
   */
  attach: (target: EventTarget, page?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'hidden'>) => () => void
  setMuted: (muted: boolean) => void
  toggleMuted: () => void
  setVolume: (key: VolumeKey, value: number) => void
  /** Called after every settings change, once it is applied and saved. */
  onSettings: (listener: (settings: AudioSettings) => void) => () => void
  /** Points the listener where the camera is; call once a frame. */
  setListener: (pose: ListenerPose) => void
  /**
   * Plays a sound, at a world position if it has one. True if a voice started;
   * false when it was refused (locked, muted, over the voice cap or inside its
   * cooldown) — which is normal and not a fault.
   */
  play: (id: SoundId, at?: Vec3 | null, options?: PlayOptions) => boolean
  /** Pause the context while the page is hidden. */
  setPageVisible: (visible: boolean) => void
}

type Graph = {
  ctx: AudioContext
  master: GainNode
  music: GainNode
  sfx: GainNode
  ui: GainNode
  noise: AudioBuffer
}

type Voice = { id: SoundId; endsAt: number; nodes: AudioNode[] }

/** Master and bus level changes glide over this long (time constant, seconds). */
const SMOOTHING = 0.015
/** How far ahead of the clock a voice starts, so its first samples are not clipped. */
const LEAD = 0.005
const DEFAULT_MAX_VOICES = 24
const MUSIC_FADE_IN_SECONDS = 2.5
/** Exponential ramps cannot start from zero. */
const FLOOR_GAIN = 0.0001

function defaultContext(): AudioContext | null {
  const Ctor =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null
}

export function createAudioEngine(options: AudioEngineOptions): AudioEngine {
  const storage = options.storage === undefined ? browserStorage() : options.storage
  const makeContext = options.createContext ?? defaultContext
  const random = options.random ?? Math.random
  const now = options.now ?? (() => performance.now())
  const maxVoices = options.maxVoices ?? DEFAULT_MAX_VOICES
  const log = options.log ?? { warn: (message: string) => console.warn(message) }

  let settings = loadAudioSettings(storage)
  const listeners = new Set<(settings: AudioSettings) => void>()

  let graph: Graph | null = null
  let unsupported = false
  let pageVisible = true
  let pose: ListenerPose | null = null
  let voices: Voice[] = []
  const lastStart = new Map<SoundId, number>()
  const samples = new Map<SoundId, AudioBuffer>()

  // --- the mixer ---------------------------------------------------------

  const glide = (param: AudioParam, target: number, ctx: BaseAudioContext) => {
    param.setTargetAtTime(target, ctx.currentTime, SMOOTHING)
  }

  const applySettings = () => {
    if (!graph) {
      return
    }
    const { ctx, master, music, sfx, ui } = graph
    glide(master.gain, settings.muted ? 0 : gainFor(settings.master), ctx)
    glide(music.gain, gainFor(settings.music), ctx)
    glide(sfx.gain, gainFor(settings.sfx), ctx)
    glide(ui.gain, gainFor(settings.ui), ctx)
  }

  const change = (next: AudioSettings) => {
    settings = next
    applySettings()
    saveAudioSettings(settings, storage)
    for (const listener of listeners) {
      listener(settings)
    }
  }

  // --- building the graph --------------------------------------------------

  const build = (ctx: AudioContext): Graph => {
    const master = ctx.createGain()
    // A limiter, not for tone: a dozen voices summing must not clip the output.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -10
    limiter.knee.value = 8
    limiter.ratio.value = 12
    limiter.attack.value = 0.003
    limiter.release.value = 0.2
    master.connect(limiter)
    limiter.connect(ctx.destination)

    const bus = (): GainNode => {
      const node = ctx.createGain()
      node.connect(master)
      return node
    }
    const built: Graph = {
      ctx,
      master,
      music: bus(),
      sfx: bus(),
      ui: bus(),
      noise: createNoise(ctx, random),
    }
    // Start from the settings outright; later changes glide.
    master.gain.value = settings.muted ? 0 : gainFor(settings.master)
    built.music.gain.value = gainFor(settings.music)
    built.sfx.gain.value = gainFor(settings.sfx)
    built.ui.gain.value = gainFor(settings.ui)
    return built
  }

  const decode = async (ctx: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> =>
    // decodeAudioData takes the bytes away from the caller: give it a copy, so
    // the asset manager's cached file stays whole.
    ctx.decodeAudioData(bytes.slice(0))

  const startMusic = (built: Graph, buffer: AudioBuffer) => {
    const { ctx } = built
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    const fade = ctx.createGain()
    fade.gain.setValueAtTime(FLOOR_GAIN, ctx.currentTime)
    fade.gain.linearRampToValueAtTime(1, ctx.currentTime + MUSIC_FADE_IN_SECONDS)
    source.connect(fade)
    fade.connect(built.music)
    source.start()
  }

  const loadRecordings = (built: Graph) => {
    for (const id of SOUND_IDS) {
      void options.loadSample?.(id).then(async (bytes) => {
        if (bytes) {
          samples.set(id, await decode(built.ctx, bytes))
        }
      }).catch((error: unknown) => {
        log.warn(`[audio] ${id}: sample would not decode (${String(error)}) — using the built-in`)
      })
    }
    void options.loadMusic?.().then(async (bytes) => {
      if (bytes) {
        startMusic(built, await decode(built.ctx, bytes))
      }
    }).catch((error: unknown) => {
      log.warn(`[audio] music would not decode (${String(error)})`)
    })
  }

  const resume = () => {
    if (graph && pageVisible && graph.ctx.state !== 'running') {
      graph.ctx.resume().catch(() => {})
    }
  }

  const setPageVisible = (visible: boolean) => {
    pageVisible = visible
    if (!graph) {
      return
    }
    if (visible) {
      resume()
    } else if (graph.ctx.state === 'running') {
      graph.ctx.suspend().catch(() => {})
    }
  }

  const unlock = () => {
    if (graph) {
      resume()
      return
    }
    if (unsupported) {
      return
    }
    let ctx: AudioContext | null = null
    try {
      ctx = makeContext()
    } catch (error) {
      log.warn(`[audio] no web audio here (${String(error)}); the game stays silent`)
    }
    if (!ctx) {
      unsupported = true
      return
    }
    graph = build(ctx)
    // The camera may have been reported before there was anything to tell.
    applyListener()
    resume()
    loadRecordings(graph)
  }

  // --- the listener -----------------------------------------------------------

  const applyListener = () => {
    if (!graph || !pose) {
      return
    }
    const l = graph.ctx.listener
    const { position: p, forward: f, up: u } = pose
    if (l.positionX) {
      l.positionX.value = p[0]
      l.positionY.value = p[1]
      l.positionZ.value = p[2]
      l.forwardX.value = f[0]
      l.forwardY.value = f[1]
      l.forwardZ.value = f[2]
      l.upX.value = u[0]
      l.upY.value = u[1]
      l.upZ.value = u[2]
    } else {
      // Older Safari: the pre-AudioParam interface.
      l.setPosition(p[0], p[1], p[2])
      l.setOrientation(f[0], f[1], f[2], u[0], u[1], u[2])
    }
  }

  // --- voices -----------------------------------------------------------------------

  const retire = (built: Graph) => {
    const t = built.ctx.currentTime
    voices = voices.filter((voice) => {
      if (voice.endsAt > t) {
        return true
      }
      for (const node of voice.nodes) {
        node.disconnect()
      }
      return false
    })
  }

  const play = (id: SoundId, at: Vec3 | null = null, extra: PlayOptions = {}): boolean => {
    const built = graph
    if (!built || settings.muted || built.ctx.state !== 'running') {
      return false
    }
    const spec = SOUNDS[id]
    const clock = now()
    if (clock - (lastStart.get(id) ?? -Infinity) < spec.cooldownMs) {
      return false
    }
    retire(built)
    if (voices.length >= maxVoices || voices.filter((voice) => voice.id === id).length >= spec.maxVoices) {
      return false
    }
    lastStart.set(id, clock)

    const { ctx } = built
    const when = ctx.currentTime + LEAD
    const pitch = (extra.pitch ?? 1) * (1 + (random() * 2 - 1) * spec.jitter)
    const nodes: AudioNode[] = []

    const level = ctx.createGain()
    level.gain.value = spec.gain * (extra.gain ?? 1)
    nodes.push(level)
    let tail: AudioNode = level

    const placed = spec.positional && at !== null && pose !== null ? planSource(pose, at, options.planetRadius) : null
    if (placed && at) {
      if (placed.hidden) {
        level.gain.value *= placed.gain
        const muffle = ctx.createBiquadFilter()
        muffle.type = 'lowpass'
        muffle.frequency.value = placed.cutoffHz
        tail.connect(muffle)
        tail = muffle
        nodes.push(muffle)
      }
      const panner = ctx.createPanner()
      panner.panningModel = 'equalpower'
      panner.distanceModel = 'inverse'
      panner.refDistance = REF_DISTANCE
      panner.rolloffFactor = ROLLOFF
      panner.maxDistance = 1e5
      if (panner.positionX) {
        panner.positionX.value = at[0]
        panner.positionY.value = at[1]
        panner.positionZ.value = at[2]
      } else {
        panner.setPosition(at[0], at[1], at[2])
      }
      tail.connect(panner)
      tail = panner
      nodes.push(panner)
    }
    tail.connect(built[spec.bus])

    const recording = samples.get(id)
    let seconds: number
    if (recording) {
      const source = ctx.createBufferSource()
      source.buffer = recording
      source.playbackRate.value = pitch
      source.connect(level)
      source.start(when)
      nodes.push(source)
      seconds = recording.duration / pitch
    } else {
      seconds = spec.synth({ ctx, out: level, when, noise: built.noise, pitch })
    }
    voices.push({ id, endsAt: when + seconds + 0.1, nodes })
    return true
  }

  return {
    get settings() {
      return settings
    },
    get state(): AudioState {
      if (unsupported) {
        return 'unsupported'
      }
      if (!graph) {
        return 'locked'
      }
      return graph.ctx.state === 'running' ? 'running' : 'suspended'
    },
    get voiceCount() {
      return voices.length
    },
    unlock,
    attach(target, page) {
      const onGesture = () => unlock()
      target.addEventListener('pointerdown', onGesture, { capture: true })
      target.addEventListener('keydown', onGesture, { capture: true })
      const onVisibility = () => setPageVisible(!page?.hidden)
      page?.addEventListener('visibilitychange', onVisibility)
      return () => {
        target.removeEventListener('pointerdown', onGesture, { capture: true })
        target.removeEventListener('keydown', onGesture, { capture: true })
        page?.removeEventListener('visibilitychange', onVisibility)
      }
    },
    setMuted(muted) {
      if (muted !== settings.muted) {
        change({ ...settings, muted })
      }
    },
    toggleMuted() {
      change({ ...settings, muted: !settings.muted })
    },
    setVolume(key, value) {
      const volume = clampVolume(value)
      if (volume !== settings[key]) {
        change({ ...settings, [key]: volume })
      }
    },
    onSettings(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setListener(next) {
      pose = next
      applyListener()
    },
    play,
    setPageVisible,
  }
}
