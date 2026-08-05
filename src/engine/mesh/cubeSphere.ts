/**
 * Cube-sphere planet mesh.
 *
 * Six square faces, each subdivided into `resolution × resolution` quads, are
 * projected onto a sphere. Compared with a lat/long UV sphere this keeps every
 * quad roughly the same size and gives us six regular grids to hang terrain
 * patches and pathfinding tiles off later.
 *
 * Face coordinates run through a tangent warp before projection. That evens out
 * the quad areas (plain normalisation bunches vertices towards the face corners)
 * and, more importantly here, it inverts in closed form: any direction on the
 * sphere maps back to an exact face and cell, which is what lets terrain heights
 * be sampled at an arbitrary point — see `directionToFaceCoords`.
 *
 * The mesh keeps the undeformed unit directions and a per-vertex height array on
 * the CPU. Deformation is "write heights, refresh the touched vertices,
 * re-upload the touched range" — see `applyHeightField` and `refreshVertices`.
 */

/** position(3) + normal(3) + uv(2) */
export const VERTEX_FLOATS = 8
export const VERTEX_BYTES = VERTEX_FLOATS * 4

export type PlanetMesh = {
  readonly resolution: number
  readonly radius: number
  readonly vertexCount: number
  readonly triangleCount: number
  /** Unit-length surface direction per vertex (3 floats each). Never deformed. */
  readonly directions: Float32Array
  /** Displacement along `directions`, in world units. One entry per vertex. */
  readonly heights: Float32Array
  /** Interleaved vertex buffer contents — this is what gets uploaded. */
  readonly vertexData: Float32Array
  readonly indices: Uint32Array
  /** Maps each vertex to a welded position id, so seam normals can be averaged. */
  readonly weldIds: Uint32Array
  readonly weldCount: number
  /** Triangles incident to each welded position, as CSR offsets into `weldTriangles`. */
  readonly weldTriangleOffsets: Uint32Array
  readonly weldTriangles: Uint32Array
  /** Vertices sharing each welded position, as CSR offsets into `weldVertices`. */
  readonly weldVertexOffsets: Uint32Array
  readonly weldVertices: Uint32Array
  /** Bumped whenever `vertexData` changes, so consumers can detect edits. */
  revision: number
  /** Vertex range of `vertexData` written since the last consumeDirtyRange(). */
  dirtyMin: number
  dirtyMax: number
}

export type HeightField = (
  x: number,
  y: number,
  z: number,
  vertexIndex: number,
) => number

/** A point on the cube-sphere, as a face index and that face's grid coordinates. */
export type FaceCoords = {
  face: number
  /** 0..1 across the face, matching the vertex grid. */
  u: number
  v: number
}

type FaceBasis = {
  up: readonly [number, number, number]
  axisA: readonly [number, number, number]
  axisB: readonly [number, number, number]
}

const FACE_UPS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
]

function faceBasis(up: readonly [number, number, number]): FaceBasis {
  // Rotating the components gives a vector that is never parallel to an
  // axis-aligned `up`, which is all we need for a stable tangent frame.
  const axisA = [up[1], up[2], up[0]] as const
  const axisB = [
    up[1] * axisA[2] - up[2] * axisA[1],
    up[2] * axisA[0] - up[0] * axisA[2],
    up[0] * axisA[1] - up[1] * axisA[0],
  ] as const
  return { up, axisA, axisB }
}

const FACE_BASES = FACE_UPS.map(faceBasis)

/**
 * Tangent warp and its inverse. Face coordinates in [-1, 1] are spread so that
 * equal steps cover equal angles on the sphere.
 */
const WARP = Math.PI / 4
const warp = (a: number) => Math.tan(a * WARP)
const unwarp = (a: number) => Math.atan(a) / WARP

/** Maps a warped face coordinate pair to a unit direction. */
function faceToDirection(
  basis: FaceBasis,
  a: number,
  b: number,
): [number, number, number] {
  const { up, axisA, axisB } = basis
  const x = up[0] + a * axisA[0] + b * axisB[0]
  const y = up[1] + a * axisA[1] + b * axisB[1]
  const z = up[2] + a * axisA[2] + b * axisB[2]
  const length = Math.hypot(x, y, z) || 1
  return [x / length, y / length, z / length]
}

/**
 * Inverse of the mesh's face → sphere mapping: finds which face a direction
 * belongs to and where on that face's grid it lands. Exact, not iterative.
 */
export function directionToFaceCoords(x: number, y: number, z: number): FaceCoords {
  let face = 0
  let best = -Infinity

  for (let f = 0; f < 6; f += 1) {
    const up = FACE_UPS[f]
    const dot = up[0] * x + up[1] * y + up[2] * z
    if (dot > best) {
      best = dot
      face = f
    }
  }

  const { axisA, axisB } = FACE_BASES[face]
  // Dividing by the face-axis component projects onto the cube face; unwarping
  // then undoes the tangent spread applied at generation time.
  const scale = best !== 0 ? 1 / best : 0
  const a = unwarp((axisA[0] * x + axisA[1] * y + axisA[2] * z) * scale)
  const b = unwarp((axisB[0] * x + axisB[1] * y + axisB[2] * z) * scale)

  return { face, u: (a + 1) / 2, v: (b + 1) / 2 }
}

export type CubeSphereOptions = {
  /** Quads per face edge. 8 → 768 triangles, 24 → 6912, 64 → 49152. */
  resolution?: number
  radius?: number
}

export function createPlanetMesh(options: CubeSphereOptions = {}): PlanetMesh {
  const resolution = Math.max(1, Math.floor(options.resolution ?? 8))
  const radius = options.radius ?? 1

  const perFaceVerts = (resolution + 1) * (resolution + 1)
  const vertexCount = perFaceVerts * 6
  const triangleCount = resolution * resolution * 2 * 6

  const directions = new Float32Array(vertexCount * 3)
  const heights = new Float32Array(vertexCount)
  const vertexData = new Float32Array(vertexCount * VERTEX_FLOATS)
  const indices = new Uint32Array(triangleCount * 3)
  const weldIds = new Uint32Array(vertexCount)

  const weldLookup = new Map<string, number>()
  let weldCount = 0

  let vertexCursor = 0
  let indexCursor = 0

  for (let face = 0; face < 6; face += 1) {
    const basis = FACE_BASES[face]
    const faceStart = vertexCursor

    for (let iy = 0; iy <= resolution; iy += 1) {
      const v = iy / resolution
      const b = warp(v * 2 - 1)
      for (let ix = 0; ix <= resolution; ix += 1) {
        const u = ix / resolution
        const a = warp(u * 2 - 1)

        const [dx, dy, dz] = faceToDirection(basis, a, b)

        directions[vertexCursor * 3 + 0] = dx
        directions[vertexCursor * 3 + 1] = dy
        directions[vertexCursor * 3 + 2] = dz

        const base = vertexCursor * VERTEX_FLOATS
        vertexData[base + 6] = u
        vertexData[base + 7] = v

        // Vertices duplicated along face seams share a welded id so their
        // normals can be averaged and the seams stay invisible.
        const key = `${quantize(dx)},${quantize(dy)},${quantize(dz)}`
        let weldId = weldLookup.get(key)
        if (weldId === undefined) {
          weldId = weldCount
          weldCount += 1
          weldLookup.set(key, weldId)
        }
        weldIds[vertexCursor] = weldId

        vertexCursor += 1
      }
    }

    const rowStride = resolution + 1
    for (let iy = 0; iy < resolution; iy += 1) {
      for (let ix = 0; ix < resolution; ix += 1) {
        const i0 = faceStart + iy * rowStride + ix
        const i1 = i0 + 1
        const i2 = i0 + rowStride
        const i3 = i2 + 1

        indices[indexCursor + 0] = i0
        indices[indexCursor + 1] = i2
        indices[indexCursor + 2] = i1
        indices[indexCursor + 3] = i1
        indices[indexCursor + 4] = i2
        indices[indexCursor + 5] = i3
        indexCursor += 6
      }
    }

    // Half the cube faces come out of the shared basis wound the other way, so
    // flip the whole face if its first triangle faces inwards.
    const faceIndexStart = indexCursor - resolution * resolution * 6
    if (!isOutwardFacing(directions, indices, faceIndexStart)) {
      for (let i = faceIndexStart; i < indexCursor; i += 3) {
        const swap = indices[i + 1]
        indices[i + 1] = indices[i + 2]
        indices[i + 2] = swap
      }
    }
  }

  const { weldTriangleOffsets, weldTriangles } = buildWeldTriangles(
    indices,
    weldIds,
    weldCount,
  )
  const { weldVertexOffsets, weldVertices } = buildWeldVertices(weldIds, weldCount)

  const mesh: PlanetMesh = {
    resolution,
    radius,
    vertexCount,
    triangleCount,
    directions,
    heights,
    vertexData,
    indices,
    weldIds,
    weldCount,
    weldTriangleOffsets,
    weldTriangles,
    weldVertexOffsets,
    weldVertices,
    revision: 0,
    dirtyMin: 0,
    dirtyMax: vertexCount - 1,
  }

  refreshGeometry(mesh)
  return mesh
}

function quantize(value: number): number {
  return Math.round(value * 100000)
}

/** CSR map from welded position id to the triangles touching it. */
function buildWeldTriangles(
  indices: Uint32Array,
  weldIds: Uint32Array,
  weldCount: number,
) {
  const counts = new Uint32Array(weldCount)
  for (let i = 0; i < indices.length; i += 1) {
    counts[weldIds[indices[i]]] += 1
  }

  const weldTriangleOffsets = new Uint32Array(weldCount + 1)
  for (let w = 0; w < weldCount; w += 1) {
    weldTriangleOffsets[w + 1] = weldTriangleOffsets[w] + counts[w]
  }

  const cursor = weldTriangleOffsets.slice(0, weldCount)
  const weldTriangles = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i += 1) {
    const weld = weldIds[indices[i]]
    weldTriangles[cursor[weld]] = (i / 3) | 0
    cursor[weld] += 1
  }

  return { weldTriangleOffsets, weldTriangles }
}

/** CSR map from welded position id back to the duplicate vertices sharing it. */
function buildWeldVertices(weldIds: Uint32Array, weldCount: number) {
  const counts = new Uint32Array(weldCount)
  for (let i = 0; i < weldIds.length; i += 1) {
    counts[weldIds[i]] += 1
  }

  const weldVertexOffsets = new Uint32Array(weldCount + 1)
  for (let w = 0; w < weldCount; w += 1) {
    weldVertexOffsets[w + 1] = weldVertexOffsets[w] + counts[w]
  }

  const cursor = weldVertexOffsets.slice(0, weldCount)
  const weldVertices = new Uint32Array(weldIds.length)
  for (let i = 0; i < weldIds.length; i += 1) {
    const weld = weldIds[i]
    weldVertices[cursor[weld]] = i
    cursor[weld] += 1
  }

  return { weldVertexOffsets, weldVertices }
}

function isOutwardFacing(directions: Float32Array, indices: Uint32Array, at: number): boolean {
  const a = indices[at] * 3
  const b = indices[at + 1] * 3
  const c = indices[at + 2] * 3

  const e1x = directions[b] - directions[a]
  const e1y = directions[b + 1] - directions[a + 1]
  const e1z = directions[b + 2] - directions[a + 2]
  const e2x = directions[c] - directions[a]
  const e2y = directions[c + 1] - directions[a + 1]
  const e2z = directions[c + 2] - directions[a + 2]

  const nx = e1y * e2z - e1z * e2y
  const ny = e1z * e2x - e1x * e2z
  const nz = e1x * e2y - e1y * e2x

  return nx * directions[a] + ny * directions[a + 1] + nz * directions[a + 2] > 0
}

/** Index of the vertex at a face grid cell corner. */
export function vertexIndexAt(
  mesh: PlanetMesh,
  face: number,
  ix: number,
  iy: number,
): number {
  const stride = mesh.resolution + 1
  return face * stride * stride + iy * stride + ix
}

/**
 * Bilinear height at an arbitrary direction, in world units above sea level.
 * The direction need not be normalised.
 */
export function sampleHeight(mesh: PlanetMesh, x: number, y: number, z: number): number {
  const length = Math.hypot(x, y, z) || 1
  const { face, u, v } = directionToFaceCoords(x / length, y / length, z / length)
  const { resolution, heights } = mesh

  const fx = Math.min(Math.max(u, 0), 1) * resolution
  const fy = Math.min(Math.max(v, 0), 1) * resolution
  const ix = Math.min(resolution - 1, Math.floor(fx))
  const iy = Math.min(resolution - 1, Math.floor(fy))
  const tx = fx - ix
  const ty = fy - iy

  const h00 = heights[vertexIndexAt(mesh, face, ix, iy)]
  const h10 = heights[vertexIndexAt(mesh, face, ix + 1, iy)]
  const h01 = heights[vertexIndexAt(mesh, face, ix, iy + 1)]
  const h11 = heights[vertexIndexAt(mesh, face, ix + 1, iy + 1)]

  return (
    h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty
  )
}

/** Rewrites every height from `field`, then rebuilds positions and normals. */
export function applyHeightField(mesh: PlanetMesh, field: HeightField): void {
  const { directions, heights, vertexCount } = mesh
  for (let i = 0; i < vertexCount; i += 1) {
    heights[i] = field(directions[i * 3], directions[i * 3 + 1], directions[i * 3 + 2], i)
  }
  refreshGeometry(mesh)
}

function markDirty(mesh: PlanetMesh, from: number, to: number): void {
  if (from < mesh.dirtyMin) mesh.dirtyMin = from
  if (to > mesh.dirtyMax) mesh.dirtyMax = to
}

/**
 * Takes the vertex range written since the last call, and clears it. The
 * renderer uses this to upload only what changed.
 */
export function consumeDirtyRange(
  mesh: PlanetMesh,
): { min: number; max: number } | null {
  if (mesh.dirtyMin > mesh.dirtyMax) {
    return null
  }
  const range = { min: mesh.dirtyMin, max: mesh.dirtyMax }
  mesh.dirtyMin = mesh.vertexCount
  mesh.dirtyMax = -1
  return range
}

/**
 * Re-derives every interleaved position and smooth normal from `directions` and
 * `heights`. Use after a wholesale height change; prefer `refreshVertices` for
 * a brush stroke.
 */
export function refreshGeometry(mesh: PlanetMesh): void {
  const { directions, heights, vertexData, vertexCount, radius } = mesh

  for (let i = 0; i < vertexCount; i += 1) {
    const r = radius + heights[i]
    const base = i * VERTEX_FLOATS
    vertexData[base + 0] = directions[i * 3 + 0] * r
    vertexData[base + 1] = directions[i * 3 + 1] * r
    vertexData[base + 2] = directions[i * 3 + 2] * r
  }

  recomputeAllNormals(mesh)
  markDirty(mesh, 0, vertexCount - 1)
  mesh.revision += 1
}

/**
 * Patch update for a brush stroke: re-derives positions for the given vertices,
 * then normals for every welded position whose triangles moved — which reaches
 * one ring beyond the stroke, since a moved vertex tilts its neighbours' faces.
 */
export function refreshVertices(mesh: PlanetMesh, vertices: readonly number[]): void {
  if (vertices.length === 0) {
    return
  }

  const {
    directions,
    heights,
    vertexData,
    radius,
    weldIds,
    weldTriangleOffsets,
    weldTriangles,
    weldVertexOffsets,
    weldVertices,
    indices,
  } = mesh

  for (const i of vertices) {
    const r = radius + heights[i]
    const base = i * VERTEX_FLOATS
    vertexData[base + 0] = directions[i * 3 + 0] * r
    vertexData[base + 1] = directions[i * 3 + 1] * r
    vertexData[base + 2] = directions[i * 3 + 2] * r
    markDirty(mesh, i, i)
  }

  // Every welded position that owns a triangle touching a moved vertex needs its
  // normal rebuilt, including the ring of neighbours that did not move.
  const affected = new Set<number>()
  for (const vertex of vertices) {
    const weld = weldIds[vertex]
    for (let t = weldTriangleOffsets[weld]; t < weldTriangleOffsets[weld + 1]; t += 1) {
      const triangle = weldTriangles[t] * 3
      affected.add(weldIds[indices[triangle]])
      affected.add(weldIds[indices[triangle + 1]])
      affected.add(weldIds[indices[triangle + 2]])
    }
  }

  for (const weld of affected) {
    let nx = 0
    let ny = 0
    let nz = 0

    for (let t = weldTriangleOffsets[weld]; t < weldTriangleOffsets[weld + 1]; t += 1) {
      const triangle = weldTriangles[t] * 3
      const ia = indices[triangle] * VERTEX_FLOATS
      const ib = indices[triangle + 1] * VERTEX_FLOATS
      const ic = indices[triangle + 2] * VERTEX_FLOATS

      const e1x = vertexData[ib] - vertexData[ia]
      const e1y = vertexData[ib + 1] - vertexData[ia + 1]
      const e1z = vertexData[ib + 2] - vertexData[ia + 2]
      const e2x = vertexData[ic] - vertexData[ia]
      const e2y = vertexData[ic + 1] - vertexData[ia + 1]
      const e2z = vertexData[ic + 2] - vertexData[ia + 2]

      // Unnormalised cross product, so larger triangles weigh more.
      nx += e1y * e2z - e1z * e2y
      ny += e1z * e2x - e1x * e2z
      nz += e1x * e2y - e1y * e2x
    }

    const length = Math.hypot(nx, ny, nz)
    const first = weldVertices[weldVertexOffsets[weld]]
    if (length > 1e-8) {
      nx /= length
      ny /= length
      nz /= length
    } else {
      nx = directions[first * 3]
      ny = directions[first * 3 + 1]
      nz = directions[first * 3 + 2]
    }

    for (let v = weldVertexOffsets[weld]; v < weldVertexOffsets[weld + 1]; v += 1) {
      const vertex = weldVertices[v]
      const base = vertex * VERTEX_FLOATS
      vertexData[base + 3] = nx
      vertexData[base + 4] = ny
      vertexData[base + 5] = nz
      markDirty(mesh, vertex, vertex)
    }
  }

  mesh.revision += 1
}

function recomputeAllNormals(mesh: PlanetMesh): void {
  const { vertexData, indices, weldIds, weldCount, vertexCount, directions } = mesh
  const accum = new Float32Array(weldCount * 3)

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * VERTEX_FLOATS
    const ib = indices[i + 1] * VERTEX_FLOATS
    const ic = indices[i + 2] * VERTEX_FLOATS

    const e1x = vertexData[ib] - vertexData[ia]
    const e1y = vertexData[ib + 1] - vertexData[ia + 1]
    const e1z = vertexData[ib + 2] - vertexData[ia + 2]
    const e2x = vertexData[ic] - vertexData[ia]
    const e2y = vertexData[ic + 1] - vertexData[ia + 1]
    const e2z = vertexData[ic + 2] - vertexData[ia + 2]

    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x

    for (let k = 0; k < 3; k += 1) {
      const weld = weldIds[indices[i + k]] * 3
      accum[weld] += nx
      accum[weld + 1] += ny
      accum[weld + 2] += nz
    }
  }

  for (let i = 0; i < vertexCount; i += 1) {
    const weld = weldIds[i] * 3
    let nx = accum[weld]
    let ny = accum[weld + 1]
    let nz = accum[weld + 2]
    const length = Math.hypot(nx, ny, nz)

    if (length > 1e-8) {
      nx /= length
      ny /= length
      nz /= length
    } else {
      nx = directions[i * 3]
      ny = directions[i * 3 + 1]
      nz = directions[i * 3 + 2]
    }

    const base = i * VERTEX_FLOATS
    vertexData[base + 3] = nx
    vertexData[base + 4] = ny
    vertexData[base + 5] = nz
  }
}
