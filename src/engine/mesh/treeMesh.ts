import { createBuilder } from './followerMesh'

/**
 * The placeholder tree: a short trunk under two stacked cones of pine, one
 * mesh instanced for every tree, so a forest is a single draw.
 *
 * Same conventions as the follower pawn and the hut: flat-shaded and
 * unindexed, authored in a local frame where y is up out of the planet and z
 * is the tree's heading (the way it falls), already at world scale for a
 * tree of size 1.
 */

/** position(3) + normal(3) + part(1) — the follower layout, so it shares a builder. */
export const TREE_VERTEX_FLOATS = 7
export const TREE_VERTEX_BYTES = TREE_VERTEX_FLOATS * 4

export const TREE_PART_TRUNK = 0
export const TREE_PART_CANOPY = 1

export type TreeMesh = {
  readonly vertexData: Float32Array
  readonly vertexCount: number
  readonly triangleCount: number
}

export type TreeMeshOptions = {
  /** Ground to the top of the crown, in world units. */
  height: number
  /** Radius of the widest cone. */
  radius: number
  segments?: number
}

/** Proportions, as fractions of the height (h) or radius (r). */
const TRUNK_RADIUS = 0.2
/** Below ground, so a tree on a slope shows no gap under its downhill side. */
const TRUNK_SINK = 0.06
const TRUNK_TOP = 0.34
/** Each cone as [base height, base radius, apex height]. */
const CONES: ReadonlyArray<readonly [number, number, number]> = [
  [0.22, 1.0, 0.78],
  [0.5, 0.72, 1.0],
]

export function createTreeMesh(options: TreeMeshOptions): TreeMesh {
  const { height, radius } = options
  const segments = Math.max(5, options.segments ?? 7)
  const builder = createBuilder()

  const point = (r: number, y: number, segment: number): [number, number, number] => {
    const angle = (segment / segments) * Math.PI * 2
    return [Math.cos(angle) * r, y, Math.sin(angle) * r]
  }

  const trunkR = TRUNK_RADIUS * radius
  const bottom = -TRUNK_SINK * height
  const top = TRUNK_TOP * height
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments
    const a = point(trunkR, bottom, segment)
    const b = point(trunkR, bottom, next)
    const c = point(trunkR, top, segment)
    const d = point(trunkR, top, next)
    builder.push(a, c, b, TREE_PART_TRUNK)
    builder.push(b, c, d, TREE_PART_TRUNK)
  }

  for (const [base, spread, peak] of CONES) {
    const y = base * height
    const r = spread * radius
    const apex: [number, number, number] = [0, peak * height, 0]
    const centre: [number, number, number] = [0, y, 0]
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments
      const e0 = point(r, y, segment)
      const e1 = point(r, y, next)
      // Counter-clockwise seen from outside, and an underside so the cone is
      // not hollow seen from below the horizon.
      builder.push(e0, apex, e1, TREE_PART_CANOPY)
      builder.push(e0, e1, centre, TREE_PART_CANOPY)
    }
  }

  const vertexData = new Float32Array(builder.data)
  const vertexCount = vertexData.length / TREE_VERTEX_FLOATS
  return { vertexData, vertexCount, triangleCount: vertexCount / 3 }
}
