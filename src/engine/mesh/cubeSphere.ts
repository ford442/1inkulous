/**
 * Cube-sphere ("spherified cube") planet mesh.
 *
 * Six square faces, each subdivided into `resolution × resolution` quads, are
 * projected onto a sphere. Compared with a lat/long UV sphere this keeps every
 * quad roughly the same size and gives us six regular grids to hang terrain
 * patches and pathfinding tiles off later.
 *
 * The mesh keeps the undeformed unit directions and a per-vertex height array on
 * the CPU. Terrain deformation is therefore just "write heights, re-derive
 * positions and normals, re-upload" — see `applyHeightField`.
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
  /** Bumped whenever `vertexData` changes, so the renderer knows to re-upload. */
  revision: number
}

export type HeightField = (
  x: number,
  y: number,
  z: number,
  vertexIndex: number,
) => number

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

/**
 * Maps a point on the [-1, 1] cube to the unit sphere. Slightly more uniform
 * than plain normalisation, which bunches vertices up at the face corners.
 */
function cubeToSphere(x: number, y: number, z: number): [number, number, number] {
  const x2 = x * x
  const y2 = y * y
  const z2 = z * z
  const sx = x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3)
  const sy = y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3)
  const sz = z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3)
  const length = Math.hypot(sx, sy, sz) || 1
  return [sx / length, sy / length, sz / length]
}

export type CubeSphereOptions = {
  /** Quads per face edge. 6 → 432 triangles, 8 → 768, 13 → 2028. */
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

  for (const up of FACE_UPS) {
    const { axisA, axisB } = faceBasis(up)
    const faceStart = vertexCursor

    for (let iy = 0; iy <= resolution; iy += 1) {
      const v = iy / resolution
      for (let ix = 0; ix <= resolution; ix += 1) {
        const u = ix / resolution
        const a = u * 2 - 1
        const b = v * 2 - 1

        const [dx, dy, dz] = cubeToSphere(
          up[0] + a * axisA[0] + b * axisB[0],
          up[1] + a * axisA[1] + b * axisB[1],
          up[2] + a * axisA[2] + b * axisB[2],
        )

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
    revision: 0,
  }

  refreshGeometry(mesh)
  return mesh
}

function quantize(value: number): number {
  return Math.round(value * 100000)
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

/** Rewrites every height from `field`, then rebuilds positions and normals. */
export function applyHeightField(mesh: PlanetMesh, field: HeightField): void {
  const { directions, heights, vertexCount } = mesh
  for (let i = 0; i < vertexCount; i += 1) {
    heights[i] = field(directions[i * 3], directions[i * 3 + 1], directions[i * 3 + 2], i)
  }
  refreshGeometry(mesh)
}

/**
 * Re-derives interleaved positions and smooth normals from `directions` and
 * `heights`. Call after mutating `mesh.heights` directly (e.g. a raise/lower
 * spell touching a handful of vertices).
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

  recomputeNormals(mesh)
  mesh.revision += 1
}

function recomputeNormals(mesh: PlanetMesh): void {
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

    // Unnormalised cross product, so larger triangles weigh more.
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
