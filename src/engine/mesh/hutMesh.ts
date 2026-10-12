import { createBuilder } from './followerMesh'

/**
 * The placeholder hut: a round, slightly tapering mud wall under an
 * overhanging conical thatch, with a door on the side the hut faces. One mesh,
 * instanced for every hut, so a village of them is a single draw.
 *
 * Same conventions as the follower pawn: flat-shaded and unindexed, authored
 * in a local frame where y is up out of the planet and z is the way the door
 * faces, already at world scale.
 */

/** position(3) + normal(3) + part(1) — the follower layout, so it shares a builder. */
export const HUT_VERTEX_FLOATS = 7
export const HUT_VERTEX_BYTES = HUT_VERTEX_FLOATS * 4

/** `part` values, which the shader colours separately. */
export const HUT_PART_WALL = 0
export const HUT_PART_DOOR = 1
export const HUT_PART_ROOF = 2

export type HutMesh = {
  readonly vertexData: Float32Array
  readonly vertexCount: number
  readonly triangleCount: number
}

export type HutMeshOptions = {
  /** Footprint radius in world units: the roof's overhang reaches this far. */
  radius: number
  /** Ground to the roof's peak, in world units. */
  height: number
  /** Sides round the wall and roof. */
  segments?: number
}

/** Proportions, as fractions of the radius (r) or height (h). */
const WALL_RADIUS = 0.8
const WALL_TOP_RADIUS = 0.72
const WALL_TOP = 0.42
const EAVES = 0.38
/**
 * The wall starts below ground so a hut on a gentle slope does not show a gap
 * under its downhill side.
 */
const WALL_SINK = 0.08
const DOOR_WIDTH = 0.34
const DOOR_TOP = 0.3
/** How far the door stands proud of the wall, so the two never z-fight. */
const DOOR_PROUD = 0.012

export function createHutMesh(options: HutMeshOptions): HutMesh {
  const { radius, height } = options
  const segments = Math.max(5, options.segments ?? 10)
  const builder = createBuilder()

  // Segment 0 is centred on +z, so the door sits flat on one facet.
  const angleOf = (segment: number) => Math.PI / 2 + ((segment - 0.5) / segments) * Math.PI * 2
  const ring = (r: number, y: number, segment: number): [number, number, number] => {
    const angle = angleOf(segment)
    return [Math.cos(angle) * r, y, Math.sin(angle) * r]
  }

  const wallBottom = -WALL_SINK * height
  const wallTop = WALL_TOP * height
  const eaves = EAVES * height
  const bottomR = WALL_RADIUS * radius
  const topR = WALL_TOP_RADIUS * radius

  for (let segment = 0; segment < segments; segment += 1) {
    const next = segment + 1

    // Wall, counter-clockwise seen from outside.
    const a = ring(bottomR, wallBottom, segment)
    const b = ring(bottomR, wallBottom, next)
    const c = ring(topR, wallTop, segment)
    const d = ring(topR, wallTop, next)
    builder.push(a, c, b, HUT_PART_WALL)
    builder.push(b, c, d, HUT_PART_WALL)

    // Thatch: a cone from the eaves to the peak, and its underside out to the
    // wall so the overhang is not hollow seen from low down.
    const e0 = ring(radius, eaves, segment)
    const e1 = ring(radius, eaves, next)
    const apex: [number, number, number] = [0, height, 0]
    builder.push(e0, apex, e1, HUT_PART_ROOF)
    const u0 = ring(topR * 0.98, wallTop, segment)
    const u1 = ring(topR * 0.98, wallTop, next)
    builder.push(e0, e1, u0, HUT_PART_ROOF)
    builder.push(e1, u1, u0, HUT_PART_ROOF)
  }

  // Door: a quad on the +z facet, leaning with the wall's taper.
  const apothem = (r: number) => r * Math.cos(Math.PI / segments)
  const halfWidth = (DOOR_WIDTH * radius) / 2
  const doorTop = DOOR_TOP * height
  const lean = (y: number) => {
    const t = (y - wallBottom) / (wallTop - wallBottom)
    return apothem(bottomR + (topR - bottomR) * t) + DOOR_PROUD * radius
  }
  const zBottom = lean(0)
  const zTop = lean(doorTop)
  const bl: [number, number, number] = [-halfWidth, 0, zBottom]
  const br: [number, number, number] = [halfWidth, 0, zBottom]
  const tl: [number, number, number] = [-halfWidth * 0.8, doorTop, zTop]
  const tr: [number, number, number] = [halfWidth * 0.8, doorTop, zTop]
  builder.push(bl, br, tl, HUT_PART_DOOR)
  builder.push(br, tr, tl, HUT_PART_DOOR)

  const vertexData = new Float32Array(builder.data)
  const vertexCount = vertexData.length / HUT_VERTEX_FLOATS
  return { vertexData, vertexCount, triangleCount: vertexCount / 3 }
}
