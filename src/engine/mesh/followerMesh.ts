/**
 * The placeholder follower model: a chunky low-poly pawn, plus a flat ring at
 * its feet that only shows while it is selected, and a headband and a club
 * that only show on a warrior. One mesh for every role, so braves and
 * warriors stay one instanced draw.
 *
 * Built flat-shaded — every triangle carries its own vertices and its own face
 * normal — because at this size faceting reads as deliberate low-poly styling
 * rather than as error, and it keeps the mesh a single unindexed buffer.
 *
 * The model is authored in a local frame: y is up out of the planet, z is the
 * direction the follower is facing, and the mesh is already at world scale, so
 * the shader only has to rotate it onto the surface.
 */

/** position(3) + normal(3) + kind(1) */
export const FOLLOWER_VERTEX_FLOATS = 7
export const FOLLOWER_VERTEX_BYTES = FOLLOWER_VERTEX_FLOATS * 4

/**
 * `kind` values. The ring collapses to nothing unless the follower is
 * selected; the band and the club, unless it is a warrior.
 */
export const FOLLOWER_PART_BODY = 0
export const FOLLOWER_PART_RING = 1
export const FOLLOWER_PART_BAND = 2
export const FOLLOWER_PART_CLUB = 3

export type FollowerMesh = {
  /** Interleaved, unindexed triangles. */
  readonly vertexData: Float32Array
  readonly vertexCount: number
  readonly triangleCount: number
}

export type FollowerMeshOptions = {
  /** Overall height in world units. */
  height: number
  /** Radius at the base, in world units. */
  radius: number
  /** Sides around the body. 8 keeps the silhouette chunky and the count low. */
  segments?: number
}

/**
 * Body profile as (height, radius) fractions: a wide foot, a tapering torso, a
 * pinched neck and a rounded head.
 */
const PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0.0, 1.0],
  [0.13, 0.95],
  [0.5, 0.52],
  [0.62, 0.42],
  [0.7, 0.72],
  [0.86, 0.68],
  [1.0, 0.18],
]

/** The warrior's headband: round the brow, standing proud of the head. */
const BAND_BOTTOM = 0.72
const BAND_TOP = 0.8
const BAND_RADIUS = 0.8

/**
 * The warrior's club, held at the right side: a box from hip to above the
 * head, as (x, y) of its centre line in radius and height fractions, and its
 * thickness in radius fractions.
 */
const CLUB_X = 1.05
const CLUB_BOTTOM = 0.18
const CLUB_TOP = 0.95
const CLUB_HALF = 0.13
/** The head of the club, thicker than its handle. */
const CLUB_HEAD = 0.72

const RING_SEGMENTS = 20
const RING_INNER = 1.5
const RING_OUTER = 1.95
/**
 * Ground clearance, as a fraction of the ring's own outer radius.
 *
 * The ring is flat and the ground is not, so the lift has to beat the terrain
 * rise across the ring's width — which scales with the ring, not with the
 * follower's height. Tying it to the model height instead left the uphill half
 * buried on any slope past about 1.5 degrees, which is almost all terrain.
 *
 * 0.25 keeps it clear up to roughly 14 degrees while floating only a fifth of a
 * follower's height. That covers the generated world outright: measured over
 * the default planet's walkable land, the steepest local slope anywhere is 9.8
 * degrees and the median is 3.7. Navigation permits up to 29 degrees, but only
 * the terrain brush can build ground that steep.
 *
 * Clearing the full 29 degrees would mean floating the ring at nearly half a
 * follower's height everywhere, all the time, to fix ground the player has to
 * sculpt deliberately — a worse trade than clipping on it. A flat annulus
 * cannot have both; a ground-projected decal is the real fix, later.
 */
const RING_LIFT = 0.25

/** Collects flat-shaded triangles; shared with the other placeholder meshes. */
export type Builder = {
  push: (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    kind: number,
  ) => void
  data: number[]
}

export function createBuilder(): Builder {
  const data: number[] = []
  return {
    data,
    push(a, b, c, kind) {
      const e1x = b[0] - a[0]
      const e1y = b[1] - a[1]
      const e1z = b[2] - a[2]
      const e2x = c[0] - a[0]
      const e2y = c[1] - a[1]
      const e2z = c[2] - a[2]

      let nx = e1y * e2z - e1z * e2y
      let ny = e1z * e2x - e1x * e2z
      let nz = e1x * e2y - e1y * e2x
      const length = Math.hypot(nx, ny, nz)
      if (length > 1e-12) {
        nx /= length
        ny /= length
        nz /= length
      } else {
        ny = 1
      }

      for (const vertex of [a, b, c]) {
        data.push(vertex[0], vertex[1], vertex[2], nx, ny, nz, kind)
      }
    },
  }
}

export function createFollowerMesh(options: FollowerMeshOptions): FollowerMesh {
  const { height, radius } = options
  const segments = Math.max(3, options.segments ?? 8)
  const builder = createBuilder()

  const ringPoint = (
    level: readonly [number, number],
    segment: number,
  ): [number, number, number] => {
    const angle = (segment / segments) * Math.PI * 2
    const r = level[1] * radius
    return [Math.cos(angle) * r, level[0] * height, Math.sin(angle) * r]
  }

  for (let band = 0; band < PROFILE.length - 1; band += 1) {
    const lower = PROFILE[band]
    const upper = PROFILE[band + 1]

    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments
      const a = ringPoint(lower!, segment)
      const b = ringPoint(lower!, next)
      const c = ringPoint(upper!, segment)
      const d = ringPoint(upper!, next)

      // Counter-clockwise seen from outside, matching the planet's winding.
      builder.push(a, c, b, FOLLOWER_PART_BODY)
      builder.push(b, c, d, FOLLOWER_PART_BODY)
    }
  }

  // Cap the crown, and the underside of the base so the silhouette stays solid
  // when a follower is seen from below the horizon.
  const crown = PROFILE[PROFILE.length - 1]
  const foot = PROFILE[0]
  const apex: [number, number, number] = [0, height, 0]
  const heel: [number, number, number] = [0, 0, 0]

  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments
    builder.push(ringPoint(crown!, next), ringPoint(crown!, segment), apex, FOLLOWER_PART_BODY)
    builder.push(ringPoint(foot!, segment), ringPoint(foot!, next), heel, FOLLOWER_PART_BODY)
  }

  // Headband: a short band of quads round the brow.
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments
    const a = ringPoint([BAND_BOTTOM, BAND_RADIUS], segment)
    const b = ringPoint([BAND_BOTTOM, BAND_RADIUS], next)
    const c = ringPoint([BAND_TOP, BAND_RADIUS], segment)
    const d = ringPoint([BAND_TOP, BAND_RADIUS], next)
    builder.push(a, c, b, FOLLOWER_PART_BAND)
    builder.push(b, c, d, FOLLOWER_PART_BAND)
  }

  // Club: a handle and a heavier head, two boxes stacked at the right hand.
  const box = (x: number, y0: number, y1: number, half: number) => {
    const corner = (sx: number, y: number, sz: number): [number, number, number] => [
      (x + sx * half) * radius,
      y * height,
      sz * half * radius,
    ]
    // Four sides and the two ends, each wound counter-clockwise from outside.
    const lo = [corner(-1, y0, -1), corner(1, y0, -1), corner(1, y0, 1), corner(-1, y0, 1)]
    const hi = [corner(-1, y1, -1), corner(1, y1, -1), corner(1, y1, 1), corner(-1, y1, 1)]
    for (let side = 0; side < 4; side += 1) {
      const n = (side + 1) % 4
      builder.push(lo[side]!, hi[side]!, lo[n]!, FOLLOWER_PART_CLUB)
      builder.push(lo[n]!, hi[side]!, hi[n]!, FOLLOWER_PART_CLUB)
    }
    builder.push(hi[0]!, hi[3]!, hi[2]!, FOLLOWER_PART_CLUB)
    builder.push(hi[0]!, hi[2]!, hi[1]!, FOLLOWER_PART_CLUB)
    builder.push(lo[0]!, lo[1]!, lo[2]!, FOLLOWER_PART_CLUB)
    builder.push(lo[0]!, lo[2]!, lo[3]!, FOLLOWER_PART_CLUB)
  }
  box(CLUB_X, CLUB_BOTTOM, CLUB_HEAD, CLUB_HALF * 0.6)
  box(CLUB_X, CLUB_HEAD, CLUB_TOP, CLUB_HALF)

  // Selection ring: a flat annulus lying on the ground, facing up.
  const ringY = RING_OUTER * radius * RING_LIFT
  for (let segment = 0; segment < RING_SEGMENTS; segment += 1) {
    const a0 = (segment / RING_SEGMENTS) * Math.PI * 2
    const a1 = ((segment + 1) / RING_SEGMENTS) * Math.PI * 2

    const inner0: [number, number, number] = [
      Math.cos(a0) * RING_INNER * radius,
      ringY,
      Math.sin(a0) * RING_INNER * radius,
    ]
    const inner1: [number, number, number] = [
      Math.cos(a1) * RING_INNER * radius,
      ringY,
      Math.sin(a1) * RING_INNER * radius,
    ]
    const outer0: [number, number, number] = [
      Math.cos(a0) * RING_OUTER * radius,
      ringY,
      Math.sin(a0) * RING_OUTER * radius,
    ]
    const outer1: [number, number, number] = [
      Math.cos(a1) * RING_OUTER * radius,
      ringY,
      Math.sin(a1) * RING_OUTER * radius,
    ]

    builder.push(inner0, outer1, outer0, FOLLOWER_PART_RING)
    builder.push(inner0, inner1, outer1, FOLLOWER_PART_RING)
  }

  const vertexData = new Float32Array(builder.data)
  const vertexCount = vertexData.length / FOLLOWER_VERTEX_FLOATS

  return {
    vertexData,
    vertexCount,
    triangleCount: vertexCount / 3,
  }
}
