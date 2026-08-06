import type { PlanetMesh } from '../engine/mesh/cubeSphere'

/**
 * The walkable graph the simulation core paths over.
 *
 * Nodes are the planet mesh's *welded* vertices — one per distinct surface
 * position. That choice does all the awkward work for free: the six cube faces
 * meet at seams where duplicate vertices already share a weld id, so linking
 * neighbours through the weld table stitches the faces together without any
 * face-adjacency table, and a path can walk off the edge of one face onto the
 * next without noticing.
 *
 * Links are 8-way within a face grid. The four diagonals are not all mesh edges
 * (each quad is triangulated across one diagonal only), so a diagonal step can
 * cut a corner by a fraction of a cell height. At planet scale that is far below
 * a follower's own size, and it buys visibly straighter paths.
 *
 * This is built once and written straight into the core's linear memory. Only
 * the heights are ever refreshed afterwards, whenever terrain deformation moves
 * the ground.
 */

export type NavGraph = {
  readonly nodeCount: number
  /** Total length of the neighbour list, i.e. the sum of every node's degree. */
  readonly linkCount: number
  /** Unit surface direction per node, 3 floats each. */
  readonly directions: Float32Array
  /** CSR offsets into `neighbors`, length nodeCount + 1. */
  readonly neighborOffsets: Int32Array
  readonly neighbors: Int32Array
  /** A mesh vertex standing for each node — where its height is read from. */
  readonly nodeVertex: Uint32Array
}

/** ix, iy offsets of the eight grid neighbours. */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
]

export function buildNavGraph(mesh: PlanetMesh): NavGraph {
  const { resolution, weldCount, weldIds, weldVertexOffsets, weldVertices, directions } =
    mesh

  const stride = resolution + 1
  const perFace = stride * stride

  const nodeVertex = new Uint32Array(weldCount)
  const nodeDirections = new Float32Array(weldCount * 3)

  for (let node = 0; node < weldCount; node += 1) {
    // Any of the duplicates will do: they share a position by definition.
    const vertex = weldVertices[weldVertexOffsets[node]]
    nodeVertex[node] = vertex
    nodeDirections[node * 3 + 0] = directions[vertex * 3 + 0]
    nodeDirections[node * 3 + 1] = directions[vertex * 3 + 1]
    nodeDirections[node * 3 + 2] = directions[vertex * 3 + 2]
  }

  // A node on a seam owns several vertices, each with its own grid neighbours,
  // and the same neighbour can be reached through more than one of them — hence
  // the dedupe.
  const adjacency: number[][] = new Array(weldCount)
  const seen = new Set<number>()

  for (let node = 0; node < weldCount; node += 1) {
    seen.clear()

    for (let v = weldVertexOffsets[node]; v < weldVertexOffsets[node + 1]; v += 1) {
      const vertex = weldVertices[v]
      const face = Math.floor(vertex / perFace)
      const withinFace = vertex - face * perFace
      const iy = Math.floor(withinFace / stride)
      const ix = withinFace - iy * stride

      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = ix + dx
        const ny = iy + dy
        // Steps that leave the face are not dropped: the same position is also
        // a vertex of the neighbouring face, and that duplicate's own in-face
        // neighbours cover the ground beyond the seam.
        if (nx < 0 || ny < 0 || nx >= stride || ny >= stride) {
          continue
        }

        const neighbor = weldIds[face * perFace + ny * stride + nx]
        if (neighbor !== node) {
          seen.add(neighbor)
        }
      }
    }

    // Sorted so the graph — and therefore every path over it — is deterministic.
    adjacency[node] = [...seen].sort((a, b) => a - b)
  }

  const neighborOffsets = new Int32Array(weldCount + 1)
  for (let node = 0; node < weldCount; node += 1) {
    neighborOffsets[node + 1] = neighborOffsets[node] + adjacency[node].length
  }

  const linkCount = neighborOffsets[weldCount]
  const neighbors = new Int32Array(linkCount)
  for (let node = 0; node < weldCount; node += 1) {
    neighbors.set(adjacency[node], neighborOffsets[node])
  }

  return {
    nodeCount: weldCount,
    linkCount,
    directions: nodeDirections,
    neighborOffsets,
    neighbors,
    nodeVertex,
  }
}
