import {
  addSelectionRing,
  createBuilder,
  finishFollowerMesh,
  FOLLOWER_PART_BAND,
  FOLLOWER_PART_BODY,
  FOLLOWER_PART_CLUB,
  type FollowerMesh,
} from '../engine/mesh/followerMesh'
import type { GltfModel, GltfPrimitive } from './gltf'

/**
 * A loaded glTF as the follower the renderer draws.
 *
 * The renderer takes a `FollowerMesh` — flat triangles with a part tag per
 * vertex — and does not care where it came from. This is the other way to make
 * one: the procedural pawn (`createFollowerMesh`) and a model off disk are
 * interchangeable, and nothing in the simulation knows which is on screen.
 *
 * The conventions an artist follows, which `npm run assets:follower` writes out
 * as a working example:
 *
 * - **Orientation.** glTF's own: +Y up, and the follower faces +Z.
 * - **Parts by material name.** A primitive whose material is named `band` or
 *   `club` is the warrior's headband or club, drawn only on a warrior. Any
 *   other material is the body, tinted in the tribe's colour (the file's base
 *   colour is not used: a tribe's colour is the point of the model).
 * - **Scale and origin.** Whatever the units, the body is scaled to the
 *   follower's height, stood with its feet on y = 0 and centred on x/z. The
 *   band and club keep their place relative to it.
 * - **Selection ring.** Added here, not authored: it is UI, sized to the
 *   follower's radius.
 */

/**
 * What a model may cost. A thousand followers go through the scene pass and
 * the shadow pass every frame, so the triangle count is the budget; the
 * procedural pawn is 152 without its ring.
 */
export const MAX_FOLLOWER_MODEL_TRIANGLES = 2000

export class FollowerModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FollowerModelError'
  }
}

export type FollowerModelOptions = {
  /** The follower's height in world units: the body is scaled to it. */
  height: number
  /** Its radius in world units: only the selection ring is sized by it. */
  radius: number
}

/** Which part a material name says a primitive is. */
export function followerPartOfMaterial(name: string): number {
  switch (name.trim().toLowerCase()) {
    case 'band':
      return FOLLOWER_PART_BAND
    case 'club':
      return FOLLOWER_PART_CLUB
    default:
      return FOLLOWER_PART_BODY
  }
}

type Corner = { px: number; py: number; pz: number }

export function followerMeshFromModel(
  model: GltfModel,
  options: FollowerModelOptions,
): FollowerMesh {
  if (model.primitives.length === 0) {
    throw new FollowerModelError('the model has no geometry')
  }
  if (model.triangleCount > MAX_FOLLOWER_MODEL_TRIANGLES) {
    throw new FollowerModelError(
      `the model has ${model.triangleCount} triangles; a follower may have ` +
        `${MAX_FOLLOWER_MODEL_TRIANGLES} (a thousand are drawn twice every frame)`,
    )
  }

  const bodies = model.primitives.filter(
    (primitive) => followerPartOfMaterial(primitive.material.name) === FOLLOWER_PART_BODY,
  )
  if (bodies.length === 0) {
    throw new FollowerModelError(
      'the model has no body: every material is named "band" or "club"; the body is any other',
    )
  }

  // The body fixes the scale and the origin.
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const { positions } of bodies) {
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[i + axis]!
        min[axis] = Math.min(min[axis]!, value)
        max[axis] = Math.max(max[axis]!, value)
      }
    }
  }
  const bodyHeight = max[1]! - min[1]!
  if (!(bodyHeight > 1e-9) || !Number.isFinite(bodyHeight)) {
    throw new FollowerModelError('the model\'s body has no height: it is flat or empty')
  }
  const scale = options.height / bodyHeight
  const originX = (min[0]! + max[0]!) / 2
  const originY = min[1]!
  const originZ = (min[2]! + max[2]!) / 2

  const builder = createBuilder()
  const at = (primitive: GltfPrimitive, vertex: number): Corner => ({
    px: (primitive.positions[vertex * 3]! - originX) * scale,
    py: (primitive.positions[vertex * 3 + 1]! - originY) * scale,
    pz: (primitive.positions[vertex * 3 + 2]! - originZ) * scale,
  })

  for (const primitive of model.primitives) {
    const kind = followerPartOfMaterial(primitive.material.name)
    const { indices, normals } = primitive
    for (let triangle = 0; triangle < primitive.triangleCount; triangle += 1) {
      const corner = (n: number) => (indices ? indices[triangle * 3 + n]! : triangle * 3 + n)
      const [a, b, c] = [corner(0), corner(1), corner(2)]
      const pa = at(primitive, a)
      const pb = at(primitive, b)
      const pc = at(primitive, c)
      const tri = (p: Corner): [number, number, number] => [p.px, p.py, p.pz]

      if (!normals) {
        // No normals in the file: face normals, like the procedural pawn.
        builder.push(tri(pa), tri(pb), tri(pc), kind)
        continue
      }
      for (const [p, vertex] of [[pa, a], [pb, b], [pc, c]] as const) {
        builder.data.push(
          p.px,
          p.py,
          p.pz,
          normals[vertex * 3]!,
          normals[vertex * 3 + 1]!,
          normals[vertex * 3 + 2]!,
          kind,
        )
      }
    }
  }

  addSelectionRing(builder, options.radius)
  return finishFollowerMesh(builder)
}
