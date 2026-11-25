/**
 * What the player has chosen about sound — muted or not, and four volumes — and
 * how it is kept between visits.
 *
 * It lives in `localStorage`, which a page cannot count on: it throws in some
 * private windows and when site data is blocked, and it can hold anything
 * (another version's format, a hand edit). So every read and write is guarded,
 * and what comes back is *sanitised* field by field: a bad value falls back to
 * its default, a number is clamped, and the rest of the settings still apply.
 * Sound that fails to remember a setting is an annoyance; sound that fails to
 * start is a bug.
 */

export type AudioSettings = {
  readonly muted: boolean
  /** Each 0..1 as the player sets it (a slider); see `gainFor` for what plays. */
  readonly master: number
  readonly music: number
  readonly sfx: number
  readonly ui: number
}

export type VolumeKey = 'master' | 'music' | 'sfx' | 'ui'
export const VOLUME_KEYS: readonly VolumeKey[] = ['master', 'music', 'sfx', 'ui']

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  muted: false,
  master: 0.8,
  music: 0.6,
  sfx: 0.9,
  ui: 0.8,
}

/** Versioned: a changed shape gets a new key rather than a migration. */
export const AUDIO_SETTINGS_KEY = '1inkulous.audio.v1'

/** The part of `Storage` this uses, so a test can hand in a stand-in. */
export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>

export function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/**
 * Volume as the ear hears it. A slider position of 0.5 should sound about half
 * as loud, and gain is amplitude, so the position is squared: the usual cheap
 * approximation to a perceptual curve.
 */
export function gainFor(volume: number): number {
  const v = clampVolume(volume)
  return v * v
}

/** Anything at all, made into settings: bad fields become their defaults. */
export function sanitizeAudioSettings(value: unknown): AudioSettings {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const volume = (key: VolumeKey): number => {
    const raw = source[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? clampVolume(raw) : DEFAULT_AUDIO_SETTINGS[key]
  }
  return {
    muted: typeof source.muted === 'boolean' ? source.muted : DEFAULT_AUDIO_SETTINGS.muted,
    master: volume('master'),
    music: volume('music'),
    sfx: volume('sfx'),
    ui: volume('ui'),
  }
}

/** `localStorage`, or null where touching it throws. */
export function browserStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadAudioSettings(storage: SettingsStorage | null = browserStorage()): AudioSettings {
  if (!storage) {
    return DEFAULT_AUDIO_SETTINGS
  }
  try {
    const text = storage.getItem(AUDIO_SETTINGS_KEY)
    return text === null ? DEFAULT_AUDIO_SETTINGS : sanitizeAudioSettings(JSON.parse(text))
  } catch {
    // Unreadable storage or text that is not JSON: start from the defaults.
    return DEFAULT_AUDIO_SETTINGS
  }
}

/** True when it was stored. A refusal (quota, blocked storage) is not an error. */
export function saveAudioSettings(
  settings: AudioSettings,
  storage: SettingsStorage | null = browserStorage(),
): boolean {
  if (!storage) {
    return false
  }
  try {
    storage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}
