import type { Vec3 } from '../engine/math'

/**
 * Where a sound is, relative to the orbit camera — the geometry only, so it can
 * be checked without an audio device.
 *
 * The listener is the camera: at its eye, facing the way it looks, with its
 * view's up. Sound sources are points on or just above the planet. The web
 * audio panner does distance and left/right; the one thing it cannot know is
 * that the planet is in the way, which is `hiddenByPlanet`.
 */

export type ListenerPose = {
  readonly position: Vec3
  readonly forward: Vec3
  readonly up: Vec3
}

/**
 * The pose of the camera whose view matrix is `view` (column-major, as
 * `mat4LookAt` makes it) at `eye`. A view matrix's rows are the camera's axes
 * in world space: right, up, and back — so forward is the third row, negated.
 */
export function listenerPoseFromView(view: ArrayLike<number>, eye: Vec3): ListenerPose {
  return {
    position: [eye[0], eye[1], eye[2]],
    forward: [-view[2]!, -view[6]!, -view[10]!],
    up: [view[1]!, view[5]!, view[9]!],
  }
}

/**
 * Whether the planet lies between `eye` and `source`: the segment between them
 * passes through a ball of `radius`. Used with a radius a little under the
 * surface's, so a source standing on the ground right at the horizon is not
 * called hidden by the very ground it stands on.
 */
export function hiddenByPlanet(eye: Vec3, source: Vec3, radius: number): boolean {
  const dx = source[0] - eye[0]
  const dy = source[1] - eye[1]
  const dz = source[2] - eye[2]
  const lengthSquared = dx * dx + dy * dy + dz * dz
  if (lengthSquared < 1e-12) {
    return false
  }
  // The point on the segment closest to the planet's centre (the origin).
  const along = Math.min(1, Math.max(0, -(eye[0] * dx + eye[1] * dy + eye[2] * dz) / lengthSquared))
  const cx = eye[0] + dx * along
  const cy = eye[1] + dy * along
  const cz = eye[2] + dz * along
  return cx * cx + cy * cy + cz * cz < radius * radius
}

/** How much of the planet's radius counts as "in the way": see `hiddenByPlanet`. */
export const OCCLUDER_FRACTION = 0.985

/**
 * Distance falloff, in planet radii (the world's unit). Inside `REF_DISTANCE`
 * a sound is at full volume; past it the web audio "inverse" model gives
 * ref / (ref + rolloff * (d - ref)): half volume at three radii out, a third
 * at five. The camera orbits between 1.9 and 8 radii from the centre, so the
 * ground nearest it is between 0.9 and 7 radii away: zoomed in, everything
 * near is at full volume; zoomed right out, the near side is still a quarter
 * as loud, and the far side is the planet's to muffle (`hiddenByPlanet`).
 */
export const REF_DISTANCE = 1
export const ROLLOFF = 0.5

/** What reaches the listener from behind the planet. */
export const OCCLUDED_GAIN = 0.45
export const OCCLUDED_CUTOFF_HZ = 700
export const OPEN_CUTOFF_HZ = 20000

export type SourcePlan = {
  /** Straight-line distance from the listener, in world units. */
  readonly distance: number
  readonly hidden: boolean
  /** Gain on top of the panner's own falloff. */
  readonly gain: number
  /** Where a low-pass starts to close: the planet muffles what it hides. */
  readonly cutoffHz: number
}

/** What the engine does about a source at `at`, heard from `listener`. */
export function planSource(listener: ListenerPose, at: Vec3, planetRadius: number): SourcePlan {
  const hidden = hiddenByPlanet(listener.position, at, planetRadius * OCCLUDER_FRACTION)
  return {
    distance: Math.hypot(
      at[0] - listener.position[0],
      at[1] - listener.position[1],
      at[2] - listener.position[2],
    ),
    hidden,
    gain: hidden ? OCCLUDED_GAIN : 1,
    cutoffHz: hidden ? OCCLUDED_CUTOFF_HZ : OPEN_CUTOFF_HZ,
  }
}
