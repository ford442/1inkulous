import type { AssetKey } from '../assets/manifest'

/**
 * The game's sounds, and a voice for each that needs no file.
 *
 * Every sound is *synthesised* here from oscillators and noise — a few lines of
 * Web Audio each, original to this repository — and is played unless a recorded
 * sample is present: the manifest lists `audio/<name>.ogg` for each, and when
 * the file is there and decodes, it is played instead (src/audio/engine.ts).
 * So the game has sound from the first commit, and recorded sound is a matter
 * of dropping files in.
 *
 * A recipe schedules its nodes against `when` on the audio clock, connects the
 * last of them to `out` and says how long it lasts; the engine owns everything
 * downstream (bus, position, limiter) and disconnects the voice afterwards.
 */

export const SOUND_IDS = [
  'chop',
  'buildComplete',
  'spellCast',
  'spellImpact',
  'death',
  'click',
] as const
export type SoundId = (typeof SOUND_IDS)[number]

/** Which bus a sound plays on. Music has its own path (`engine.ts`). */
export type SoundBus = 'sfx' | 'ui'

/** The manifest entry a recorded version of each sound is loaded from. */
export const SOUND_SAMPLE_KEYS = {
  chop: 'audio.chop',
  buildComplete: 'audio.buildComplete',
  spellCast: 'audio.spellCast',
  spellImpact: 'audio.spellImpact',
  death: 'audio.death',
  click: 'audio.click',
} as const satisfies Record<SoundId, AssetKey>

export type SynthVoice = {
  readonly ctx: BaseAudioContext
  /** Where the recipe's last node connects. */
  readonly out: AudioNode
  /** Start time on the audio clock, seconds. */
  readonly when: number
  /** A second of white noise to read from. */
  readonly noise: AudioBuffer
  /** Playback-rate-style pitch multiplier: 1 is as written. */
  readonly pitch: number
}

/** A recipe's length in seconds, from `when`. */
export type Synth = (voice: SynthVoice) => number

export type SoundSpec = {
  readonly bus: SoundBus
  /** Placed in the world (panned, faded with distance) or heard as-is. */
  readonly positional: boolean
  /** Level within its bus, 0..1. */
  readonly gain: number
  /** At most this many of it at once. */
  readonly maxVoices: number
  /** No two starts closer than this, in ms: a crowd chopping is one rhythm, not a buzz. */
  readonly cooldownMs: number
  /** Random pitch spread, ± this fraction, so repeats are not identical. */
  readonly jitter: number
  readonly synth: Synth
}

const FLOOR = 0.0001

/** A gain that rises to `peak` and falls away, on `param`. */
function pluck(param: AudioParam, when: number, attack: number, peak: number, decay: number): void {
  param.setValueAtTime(FLOOR, when)
  param.linearRampToValueAtTime(peak, when + attack)
  param.exponentialRampToValueAtTime(FLOOR, when + attack + decay)
}

/** An oscillator gliding from `from` to `to` Hz under its own envelope. */
function tone(
  { ctx, out, when, pitch }: SynthVoice,
  type: OscillatorType,
  from: number,
  to: number,
  start: number,
  attack: number,
  decay: number,
  peak: number,
  filter?: { type: BiquadFilterType; frequency: number; to?: number; q?: number },
): void {
  const at = when + start
  const osc = ctx.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(from * pitch, at)
  osc.frequency.exponentialRampToValueAtTime(to * pitch, at + attack + decay)
  const level = ctx.createGain()
  pluck(level.gain, at, attack, peak, decay)
  let tail: AudioNode = osc
  if (filter) {
    const biquad = ctx.createBiquadFilter()
    biquad.type = filter.type
    biquad.Q.value = filter.q ?? 1
    biquad.frequency.setValueAtTime(filter.frequency, at)
    if (filter.to !== undefined) {
      biquad.frequency.exponentialRampToValueAtTime(filter.to, at + attack + decay)
    }
    osc.connect(biquad)
    tail = biquad
  }
  tail.connect(level)
  level.connect(out)
  osc.start(at)
  osc.stop(at + attack + decay + 0.05)
}

/** A burst of the shared noise through a filter, under its own envelope. */
function burst(
  { ctx, out, when, noise, pitch }: SynthVoice,
  filterType: BiquadFilterType,
  frequency: number,
  q: number,
  start: number,
  attack: number,
  decay: number,
  peak: number,
): void {
  const at = when + start
  const source = ctx.createBufferSource()
  source.buffer = noise
  const biquad = ctx.createBiquadFilter()
  biquad.type = filterType
  biquad.frequency.value = frequency * pitch
  biquad.Q.value = q
  const level = ctx.createGain()
  pluck(level.gain, at, attack, peak, decay)
  source.connect(biquad)
  biquad.connect(level)
  level.connect(out)
  source.start(at)
  source.stop(at + attack + decay + 0.05)
}

/** Wood on wood: a dull knock under a short crack of noise. */
const chop: Synth = (voice) => {
  tone(voice, 'sine', 190, 70, 0, 0.002, 0.11, 0.9)
  burst(voice, 'bandpass', 1300, 1.4, 0, 0.001, 0.07, 0.55)
  burst(voice, 'lowpass', 500, 0.7, 0.012, 0.004, 0.14, 0.25)
  return 0.2
}

/** Something finished: two bell notes, a fifth apart, the second a breath later. */
const buildComplete: Synth = (voice) => {
  for (const [start, hz] of [[0, 523.25], [0.11, 783.99]] as const) {
    tone(voice, 'triangle', hz, hz * 0.995, start, 0.006, 0.55, 0.45)
    tone(voice, 'sine', hz * 2, hz * 2, start, 0.004, 0.3, 0.12)
  }
  return 0.8
}

/** Gathering power: a bright saw opening up as it climbs, with a slow shimmer under. */
const spellCast: Synth = (voice) => {
  tone(voice, 'sawtooth', 180, 720, 0, 0.35, 0.3, 0.22, { type: 'lowpass', frequency: 300, to: 3200, q: 3 })
  tone(voice, 'sine', 360, 1440, 0, 0.3, 0.35, 0.2)
  tone(voice, 'sine', 364, 1452, 0, 0.3, 0.35, 0.16)
  return 0.85
}

/** A heavy landing: a sub thump and a rolling rumble. */
const spellImpact: Synth = (voice) => {
  tone(voice, 'sine', 110, 32, 0, 0.004, 0.45, 1)
  burst(voice, 'lowpass', 420, 0.8, 0, 0.01, 0.6, 0.7)
  burst(voice, 'highpass', 2500, 0.7, 0, 0.001, 0.09, 0.22)
  return 0.8
}

/** A falling groan, muffled. */
const death: Synth = (voice) => {
  tone(voice, 'triangle', 340, 95, 0, 0.012, 0.5, 0.55, { type: 'lowpass', frequency: 1800, to: 300, q: 0.8 })
  tone(voice, 'sine', 170, 48, 0, 0.012, 0.5, 0.3)
  return 0.6
}

/** A small, dry tick. */
const click: Synth = (voice) => {
  tone(voice, 'sine', 920, 640, 0, 0.001, 0.035, 0.5)
  return 0.08
}

export const SOUNDS: Readonly<Record<SoundId, SoundSpec>> = {
  chop: { bus: 'sfx', positional: true, gain: 0.8, maxVoices: 4, cooldownMs: 90, jitter: 0.1, synth: chop },
  buildComplete: { bus: 'sfx', positional: true, gain: 0.7, maxVoices: 3, cooldownMs: 150, jitter: 0.02, synth: buildComplete },
  spellCast: { bus: 'sfx', positional: true, gain: 0.7, maxVoices: 2, cooldownMs: 300, jitter: 0.03, synth: spellCast },
  spellImpact: { bus: 'sfx', positional: true, gain: 0.95, maxVoices: 3, cooldownMs: 200, jitter: 0.06, synth: spellImpact },
  death: { bus: 'sfx', positional: true, gain: 0.7, maxVoices: 3, cooldownMs: 120, jitter: 0.12, synth: death },
  click: { bus: 'ui', positional: false, gain: 0.6, maxVoices: 2, cooldownMs: 40, jitter: 0, synth: click },
}

/** A second of white noise, for the recipes' bursts. */
export function createNoise(ctx: BaseAudioContext, random: () => number = Math.random): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate)), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i += 1) {
    data[i] = random() * 2 - 1
  }
  return buffer
}
