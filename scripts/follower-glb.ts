/**
 * The procedural pawn as a .glb: a working example of the follower model
 * conventions (src/assets/followerModel.ts) for an artist to start from, and the
 * fixture the asset tests round-trip through the loader.
 */
import {
  FOLLOWER_PART_BAND,
  FOLLOWER_PART_BODY,
  FOLLOWER_PART_CLUB,
  FOLLOWER_VERTEX_FLOATS,
  type FollowerMesh,
} from '../src/engine/mesh/followerMesh.ts'
import { writeGlb, type GlbPart } from './glb-writer.ts'

/** The mesh split by part, one primitive each, named by the material that says what it is. */
export function followerParts(mesh: FollowerMesh): GlbPart[] {
  // Colours as the follower shader draws them (follower.wgsl). The renderer
  // reads only the material's *name*; the colours are here because glTF
  // optimisers merge materials with identical settings, which would fold the
  // band and club into the body and lose them. Distinct colours keep them apart.
  const names = new Map<number, { name: string; color: readonly [number, number, number, number] }>([
    [FOLLOWER_PART_BODY, { name: 'body', color: [0.55, 0.55, 0.55, 1] }],
    [FOLLOWER_PART_BAND, { name: 'band', color: [0.95, 0.92, 0.84, 1] }],
    [FOLLOWER_PART_CLUB, { name: 'club', color: [0.3, 0.19, 0.1, 1] }],
  ])
  const parts: GlbPart[] = []
  for (const [kind, { name, color }] of names) {
    const positions: number[] = []
    const normals: number[] = []
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      const base = v * FOLLOWER_VERTEX_FLOATS
      if (mesh.vertexData[base + 6] === kind) {
        positions.push(mesh.vertexData[base]!, mesh.vertexData[base + 1]!, mesh.vertexData[base + 2]!)
        normals.push(mesh.vertexData[base + 3]!, mesh.vertexData[base + 4]!, mesh.vertexData[base + 5]!)
      }
    }
    // The selection ring is not part of a model: the renderer adds it.
    parts.push({
      material: name,
      baseColor: color,
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
    })
  }
  return parts
}

export function followerGlb(mesh: FollowerMesh): Uint8Array {
  return writeGlb(followerParts(mesh), { generator: '1inkulous assets:follower' })
}
