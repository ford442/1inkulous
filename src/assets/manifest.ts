import type { GltfModel } from './gltf'

/**
 * Everything the game can load from `public/`, in one typed list.
 *
 * The game draws and sounds fine with none of it: the pawn is procedural
 * (`createFollowerMesh`) and every sound has a synthesised voice
 * (`src/audio/sounds.ts`). A file here *replaces* one of those, so each entry
 * is `optional`: absent, the built-in stands in, and the game says so once in
 * the console instead of failing. Drop a file at its URL and it is picked up;
 * nothing else changes.
 *
 * `group` says when it is wanted. `boot` assets are loaded before the first
 * frame, behind the loading screen. `deferred` ones — sound, which cannot even
 * be decoded until the browser lets the page play — load in the background
 * afterwards.
 *
 * URLs are relative to the page (Vite's `base` is `./`), so the build works
 * under a sub-path. `bytes` is a rough size, optional: it only lets the
 * loading bar move before a response says how long it is.
 */

export type AssetKind = 'model' | 'audio' | 'binary'
export type AssetGroup = 'boot' | 'deferred'

export type AssetSpec = {
  readonly kind: AssetKind
  readonly url: string
  /** Absent is not an error: the built-in stands in. Defaults to required. */
  readonly optional?: boolean
  readonly bytes?: number
  /** Defaults to `boot`. */
  readonly group?: AssetGroup
}

export type AssetManifest = Readonly<Record<string, AssetSpec>>

/** What loading each kind of asset gives back. */
export type AssetKindValue = {
  /** Geometry and materials, ready to be made into a mesh. */
  model: GltfModel
  /** The encoded file. Decoding sound needs an AudioContext, so it waits for one. */
  audio: ArrayBuffer
  binary: ArrayBuffer
}

export const MANIFEST = {
  // The follower pawn. See src/assets/followerModel.ts for how to author one.
  'model.follower': { kind: 'model', url: 'models/follower.glb', optional: true },

  // One short sample per sound the core can cause; see src/audio/sounds.ts.
  'audio.chop': { kind: 'audio', url: 'audio/chop.ogg', optional: true, group: 'deferred' },
  'audio.buildComplete': {
    kind: 'audio',
    url: 'audio/build-complete.ogg',
    optional: true,
    group: 'deferred',
  },
  'audio.spellCast': { kind: 'audio', url: 'audio/spell-cast.ogg', optional: true, group: 'deferred' },
  'audio.spellImpact': {
    kind: 'audio',
    url: 'audio/spell-impact.ogg',
    optional: true,
    group: 'deferred',
  },
  'audio.death': { kind: 'audio', url: 'audio/death.ogg', optional: true, group: 'deferred' },
  'audio.click': { kind: 'audio', url: 'audio/click.ogg', optional: true, group: 'deferred' },

  // A looping bed on the music bus. There is no synthesised stand-in: without
  // the file the music bus is simply quiet.
  'audio.music': { kind: 'audio', url: 'audio/music.ogg', optional: true, group: 'deferred' },
} as const satisfies AssetManifest

export type AssetKey = keyof typeof MANIFEST
