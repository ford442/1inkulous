/**
 * A small glTF 2.0 reader: geometry and materials, nothing else.
 *
 * Takes a `.glb` (or a `.gltf` whose buffers are data URIs) and gives back what
 * a mesh needs — positions, normals and indices with the node hierarchy already
 * applied, and each primitive's material name and base colour. Textures, skins,
 * animation, morph targets and cameras are skipped: the file's bind pose is the
 * model. Anything that would change the geometry and cannot be honoured
 * (Draco, GPU instancing) is refused by name rather than drawn wrong.
 *
 * What the build-time optimiser leaves in a file is handled here:
 *
 * - `KHR_mesh_quantization`: normalised 8/16-bit positions and normals, with
 *   the scale riding on a node, are read back to floats.
 * - `EXT_meshopt_compression`: buffer views are decoded with meshoptimizer's
 *   wasm decoder, loaded only when a file asks for it so a game with no
 *   compressed model never downloads it.
 *
 * No GPU and no DOM: it runs in Node, which is how it is tested.
 */

export type Vec3Tuple = readonly [number, number, number]

export type GltfMaterial = {
  /** The material's name; how a model says which part of a mesh a primitive is. */
  readonly name: string
  /** `pbrMetallicRoughness.baseColorFactor`, linear RGBA; white when absent. */
  readonly baseColor: readonly [number, number, number, number]
  readonly doubleSided: boolean
}

export type GltfPrimitive = {
  /** The mesh's name, or its index when it has none. */
  readonly name: string
  readonly material: GltfMaterial
  /** xyz per vertex, in model space with every node transform applied. */
  readonly positions: Float32Array
  /** Unit normals to match, or null when the file has none. */
  readonly normals: Float32Array | null
  /** Triangle corners into the vertices; null means they are already in order. */
  readonly indices: Uint32Array | null
  readonly triangleCount: number
}

export type GltfModel = {
  readonly primitives: readonly GltfPrimitive[]
  readonly generator: string | null
  readonly triangleCount: number
  /** Over every vertex of every primitive. Null for a model with no geometry. */
  readonly bounds: { readonly min: Vec3Tuple; readonly max: Vec3Tuple } | null
}

/** The part of meshoptimizer's decoder this reads. */
export type MeshoptDecoderLike = {
  readonly ready: Promise<void>
  decodeGltfBuffer: (
    target: Uint8Array,
    count: number,
    size: number,
    source: Uint8Array,
    mode: string,
    filter?: string,
  ) => void
}

export type GltfOptions = {
  /**
   * The meshopt decoder, when the caller has one. Left out, it is imported on
   * the first file that needs it.
   */
  meshopt?: MeshoptDecoderLike
}

export class GltfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GltfError'
  }
}

/** Extensions this reader acts on. */
const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  'KHR_mesh_quantization',
  'EXT_meshopt_compression',
])
/** Extensions about shading or textures, which a geometry-only reader can ignore. */
const IGNORABLE_PREFIXES = ['KHR_materials_', 'KHR_texture_', 'EXT_texture_']

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

const TRIANGLES = 4

const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
}
const TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
}

// --- the document ----------------------------------------------------------

type Json = {
  asset?: { version?: string; generator?: string }
  extensionsUsed?: string[]
  extensionsRequired?: string[]
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: {
    children?: number[]
    mesh?: number
    matrix?: number[]
    translation?: number[]
    rotation?: number[]
    scale?: number[]
  }[]
  meshes?: {
    name?: string
    primitives?: {
      attributes?: Record<string, number>
      indices?: number
      material?: number
      mode?: number
    }[]
  }[]
  materials?: {
    name?: string
    doubleSided?: boolean
    pbrMetallicRoughness?: { baseColorFactor?: number[] }
  }[]
  accessors?: {
    bufferView?: number
    byteOffset?: number
    componentType: number
    normalized?: boolean
    count: number
    type: string
    sparse?: unknown
  }[]
  bufferViews?: {
    buffer: number
    byteOffset?: number
    byteLength: number
    byteStride?: number
    extensions?: {
      EXT_meshopt_compression?: {
        buffer: number
        byteOffset?: number
        byteLength: number
        byteStride: number
        mode: string
        filter?: string
        count: number
      }
    }
  }[]
  buffers?: { uri?: string; byteLength: number }[]
}

type Container = { json: Json; bin: Uint8Array | null }

/** Splits a `.glb` into its JSON and binary chunks, or reads a bare `.gltf`. */
function readContainer(bytes: Uint8Array): Container {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
    const version = view.getUint32(4, true)
    if (version !== 2) {
      throw new GltfError(`GLB version ${version}: only glTF 2.0 is supported`)
    }
    const length = Math.min(view.getUint32(8, true), bytes.byteLength)
    let json: Json | null = null
    let bin: Uint8Array | null = null
    let at = 12
    while (at + 8 <= length) {
      const chunkLength = view.getUint32(at, true)
      const chunkType = view.getUint32(at + 4, true)
      const start = at + 8
      if (start + chunkLength > length) {
        throw new GltfError('GLB chunk runs past the end of the file')
      }
      if (chunkType === CHUNK_JSON && json === null) {
        json = parseJson(bytes.subarray(start, start + chunkLength))
      } else if (chunkType === CHUNK_BIN && bin === null) {
        bin = bytes.subarray(start, start + chunkLength)
      }
      // Chunk lengths are padded to four bytes; unknown chunks are skipped.
      at = start + chunkLength
    }
    if (json === null) {
      throw new GltfError('GLB has no JSON chunk')
    }
    return { json, bin }
  }

  // A `.gltf`: JSON text, which starts with `{` after any whitespace or BOM.
  let first = 0
  while (first < bytes.length && (bytes[first] === 0x20 || bytes[first] === 0x0a || bytes[first] === 0x0d || bytes[first] === 0x09 || bytes[first] === 0xef || bytes[first] === 0xbb || bytes[first] === 0xbf)) {
    first += 1
  }
  if (bytes[first] !== 0x7b) {
    throw new GltfError('not a glTF file: no GLB header and not JSON')
  }
  return { json: parseJson(bytes), bin: null }
}

function parseJson(bytes: Uint8Array): Json {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Json
  } catch (cause) {
    throw new GltfError(`glTF JSON does not parse: ${String(cause)}`)
  }
}

function decodeDataUri(uri: string): Uint8Array {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(uri)
  if (!match) {
    throw new GltfError('only base64 data URIs are supported for embedded buffers')
  }
  const raw = atob(match[1]!)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i)
  }
  return out
}

function checkExtensions(json: Json): void {
  for (const name of json.extensionsRequired ?? []) {
    const ignorable = IGNORABLE_PREFIXES.some((prefix) => name.startsWith(prefix))
    if (!SUPPORTED_EXTENSIONS.has(name) && !ignorable) {
      throw new GltfError(
        `the file requires ${name}, which this loader does not support ` +
          `(it reads ${[...SUPPORTED_EXTENSIONS].join(' and ')}; re-export without it)`,
      )
    }
  }
}

// --- buffers and accessors ---------------------------------------------------

type Reader = {
  /** A buffer view's bytes, decompressed if it needed to be. */
  view: (index: number) => { bytes: Uint8Array; stride: number }
  floats: (accessorIndex: number, components: number) => Float32Array
  indices: (accessorIndex: number) => Uint32Array
}

async function createReader(
  json: Json,
  bin: Uint8Array | null,
  options: GltfOptions,
): Promise<Reader> {
  const buffers: (Uint8Array | null)[] = (json.buffers ?? []).map((buffer, index) => {
    if (buffer.uri !== undefined) {
      return decodeDataUri(buffer.uri)
    }
    // The one buffer a GLB carries is its binary chunk. Any other without a URI
    // is an optimiser's placeholder for compressed data, never read directly.
    return index === 0 ? bin : null
  })

  const compressed = (json.bufferViews ?? []).some(
    (view) => view.extensions?.EXT_meshopt_compression !== undefined,
  )
  let meshopt: MeshoptDecoderLike | null = null
  if (compressed) {
    meshopt = options.meshopt ?? (await import('meshoptimizer/decoder')).MeshoptDecoder
    await meshopt.ready
  }

  const decoded = new Map<number, { bytes: Uint8Array; stride: number }>()

  const view = (index: number) => {
    const cached = decoded.get(index)
    if (cached) {
      return cached
    }
    const bufferView = json.bufferViews?.[index]
    if (!bufferView) {
      throw new GltfError(`bufferView ${index} does not exist`)
    }
    let result: { bytes: Uint8Array; stride: number }
    const packed = bufferView.extensions?.EXT_meshopt_compression
    if (packed) {
      const source = buffers[packed.buffer]
      if (!source || !meshopt) {
        throw new GltfError(`bufferView ${index}: compressed data points at a buffer with no data`)
      }
      const start = packed.byteOffset ?? 0
      if (start + packed.byteLength > source.byteLength) {
        throw new GltfError(`bufferView ${index}: compressed range runs past its buffer`)
      }
      const bytes = new Uint8Array(packed.count * packed.byteStride)
      try {
        meshopt.decodeGltfBuffer(
          bytes,
          packed.count,
          packed.byteStride,
          source.subarray(start, start + packed.byteLength),
          packed.mode,
          packed.filter ?? 'NONE',
        )
      } catch (cause) {
        throw new GltfError(`bufferView ${index}: meshopt data would not decode (${String(cause)})`)
      }
      result = { bytes, stride: packed.byteStride }
    } else {
      const source = buffers[bufferView.buffer]
      if (!source) {
        throw new GltfError(`bufferView ${index}: buffer ${bufferView.buffer} has no data`)
      }
      const start = bufferView.byteOffset ?? 0
      if (start + bufferView.byteLength > source.byteLength) {
        throw new GltfError(`bufferView ${index} runs past the end of its buffer`)
      }
      result = {
        bytes: source.subarray(start, start + bufferView.byteLength),
        stride: bufferView.byteStride ?? 0,
      }
    }
    decoded.set(index, result)
    return result
  }

  /** Reads an accessor element by element, through `read(view, offset, type)`. */
  const walk = (
    accessorIndex: number,
    expectedComponents: number | null,
    emit: (element: number, component: number, raw: number) => void,
    normalise: boolean,
  ): { count: number; components: number } => {
    const accessor = json.accessors?.[accessorIndex]
    if (!accessor) {
      throw new GltfError(`accessor ${accessorIndex} does not exist`)
    }
    if (accessor.sparse !== undefined) {
      throw new GltfError('sparse accessors are not supported')
    }
    const components = TYPE_COMPONENTS[accessor.type]
    const componentBytes = COMPONENT_BYTES[accessor.componentType]
    if (components === undefined || componentBytes === undefined) {
      throw new GltfError(`accessor ${accessorIndex} has an unsupported type`)
    }
    if (expectedComponents !== null && components !== expectedComponents) {
      throw new GltfError(`accessor ${accessorIndex} is ${accessor.type}, expected ${expectedComponents} components`)
    }
    if (accessor.bufferView === undefined) {
      // No data means zeros, by the spec.
      return { count: accessor.count, components }
    }
    const { bytes, stride } = view(accessor.bufferView)
    const elementBytes = components * componentBytes
    const step = stride > 0 ? stride : elementBytes
    const base = accessor.byteOffset ?? 0
    const last = base + (accessor.count - 1) * step + elementBytes
    if (accessor.count > 0 && last > bytes.byteLength) {
      throw new GltfError(`accessor ${accessorIndex} runs past its buffer view`)
    }
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const shouldNormalise = normalise && accessor.normalized === true
    for (let element = 0; element < accessor.count; element += 1) {
      for (let component = 0; component < components; component += 1) {
        const at = base + element * step + component * componentBytes
        let raw: number
        switch (accessor.componentType) {
          case 5120:
            raw = data.getInt8(at)
            if (shouldNormalise) raw = Math.max(raw / 127, -1)
            break
          case 5121:
            raw = data.getUint8(at)
            if (shouldNormalise) raw /= 255
            break
          case 5122:
            raw = data.getInt16(at, true)
            if (shouldNormalise) raw = Math.max(raw / 32767, -1)
            break
          case 5123:
            raw = data.getUint16(at, true)
            if (shouldNormalise) raw /= 65535
            break
          case 5125:
            raw = data.getUint32(at, true)
            break
          default:
            raw = data.getFloat32(at, true)
        }
        emit(element, component, raw)
      }
    }
    return { count: accessor.count, components }
  }

  return {
    view,
    floats(accessorIndex, components) {
      const accessor = json.accessors?.[accessorIndex]
      const out = new Float32Array((accessor?.count ?? 0) * components)
      walk(accessorIndex, components, (element, component, raw) => {
        out[element * components + component] = raw
      }, true)
      return out
    },
    indices(accessorIndex) {
      const accessor = json.accessors?.[accessorIndex]
      const out = new Uint32Array(accessor?.count ?? 0)
      walk(accessorIndex, 1, (element, _component, raw) => {
        out[element] = raw
      }, false)
      return out
    },
  }
}

// --- the node hierarchy --------------------------------------------------------

/** Column-major 4x4, as glTF stores `matrix`. */
type Matrix = Float64Array

const IDENTITY: Matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Float64Array(16)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row]! * b[column * 4 + k]!
      }
      out[column * 4 + row] = sum
    }
  }
  return out
}

function localMatrix(node: NonNullable<Json['nodes']>[number]): Matrix {
  if (node.matrix) {
    if (node.matrix.length !== 16) {
      throw new GltfError('a node matrix needs 16 numbers')
    }
    return new Float64Array(node.matrix)
  }
  const [tx = 0, ty = 0, tz = 0] = node.translation ?? []
  const [qx = 0, qy = 0, qz = 0, qw = 1] = node.rotation ?? []
  const [sx = 1, sy = 1, sz = 1] = node.scale ?? []
  const length = Math.hypot(qx, qy, qz, qw) || 1
  const x = qx / length
  const y = qy / length
  const z = qz / length
  const w = qw / length
  return new Float64Array([
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ])
}

/** Every (mesh, world matrix) pair the default scene draws. */
function meshInstances(json: Json): { mesh: number; world: Matrix }[] {
  const nodes = json.nodes ?? []
  let roots: number[]
  const scene = json.scenes?.[json.scene ?? 0]
  if (scene) {
    roots = scene.nodes ?? []
  } else {
    const children = new Set(nodes.flatMap((node) => node.children ?? []))
    roots = nodes.map((_node, index) => index).filter((index) => !children.has(index))
  }

  const found: { mesh: number; world: Matrix }[] = []
  const walking = new Set<number>()
  const visit = (index: number, parent: Matrix) => {
    const node = nodes[index]
    if (!node) {
      throw new GltfError(`node ${index} does not exist`)
    }
    if (walking.has(index)) {
      throw new GltfError(`node ${index} is its own ancestor`)
    }
    walking.add(index)
    const world = multiply(parent, localMatrix(node))
    if (node.mesh !== undefined) {
      found.push({ mesh: node.mesh, world })
    }
    for (const child of node.children ?? []) {
      visit(child, world)
    }
    walking.delete(index)
  }
  for (const root of roots) {
    visit(root, IDENTITY)
  }
  return found
}

// --- putting it together ---------------------------------------------------------

const DEFAULT_MATERIAL: GltfMaterial = {
  name: '',
  baseColor: [1, 1, 1, 1],
  doubleSided: false,
}

function materialOf(json: Json, index: number | undefined): GltfMaterial {
  const source = index === undefined ? undefined : json.materials?.[index]
  if (!source) {
    return DEFAULT_MATERIAL
  }
  const [r = 1, g = 1, b = 1, a = 1] = source.pbrMetallicRoughness?.baseColorFactor ?? []
  return {
    name: source.name ?? '',
    baseColor: [r, g, b, a],
    doubleSided: source.doubleSided === true,
  }
}

/** Reads a glTF 2.0 file. Throws `GltfError` with a sentence for anything it cannot use. */
export async function parseGltf(
  input: ArrayBuffer | Uint8Array,
  options: GltfOptions = {},
): Promise<GltfModel> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const { json, bin } = readContainer(bytes)
  if (json.asset?.version !== '2.0') {
    throw new GltfError(`glTF version ${json.asset?.version ?? '(none)'}: only 2.0 is supported`)
  }
  checkExtensions(json)

  const reader = await createReader(json, bin, options)
  const primitives: GltfPrimitive[] = []
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]

  for (const { mesh: meshIndex, world } of meshInstances(json)) {
    const mesh = json.meshes?.[meshIndex]
    if (!mesh) {
      throw new GltfError(`mesh ${meshIndex} does not exist`)
    }
    // A negative determinant is a mirror: the same triangles wind the other way.
    const m = world
    const cofactor = [
      m[5]! * m[10]! - m[6]! * m[9]!, m[6]! * m[8]! - m[4]! * m[10]!, m[4]! * m[9]! - m[5]! * m[8]!,
      m[9]! * m[2]! - m[10]! * m[1]!, m[10]! * m[0]! - m[8]! * m[2]!, m[8]! * m[1]! - m[9]! * m[0]!,
      m[1]! * m[6]! - m[2]! * m[5]!, m[2]! * m[4]! - m[0]! * m[6]!, m[0]! * m[5]! - m[1]! * m[4]!,
    ]
    const determinant = m[0]! * cofactor[0]! + m[1]! * cofactor[1]! + m[2]! * cofactor[2]!
    const mirrored = determinant < 0

    for (const [slot, primitive] of (mesh.primitives ?? []).entries()) {
      const mode = primitive.mode ?? TRIANGLES
      if (mode !== TRIANGLES) {
        throw new GltfError(`mesh ${meshIndex}: only triangle lists are supported (mode ${mode})`)
      }
      const positionAccessor = primitive.attributes?.POSITION
      if (positionAccessor === undefined) {
        throw new GltfError(`mesh ${meshIndex}: a primitive has no POSITION`)
      }

      const positions = reader.floats(positionAccessor, 3)
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]!
        const y = positions[i + 1]!
        const z = positions[i + 2]!
        const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
        const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
        const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
        positions[i] = wx
        positions[i + 1] = wy
        positions[i + 2] = wz
        min[0] = Math.min(min[0], wx)
        min[1] = Math.min(min[1], wy)
        min[2] = Math.min(min[2], wz)
        max[0] = Math.max(max[0], wx)
        max[1] = Math.max(max[1], wy)
        max[2] = Math.max(max[2], wz)
      }

      let normals: Float32Array | null = null
      const normalAccessor = primitive.attributes?.NORMAL
      if (normalAccessor !== undefined) {
        normals = reader.floats(normalAccessor, 3)
        const sign = mirrored ? -1 : 1
        for (let i = 0; i < normals.length; i += 3) {
          const x = normals[i]!
          const y = normals[i + 1]!
          const z = normals[i + 2]!
          // The cofactor matrix is the inverse transpose, up to the scale that
          // normalising removes — and it stays right under non-uniform scale.
          const nx = (cofactor[0]! * x + cofactor[3]! * y + cofactor[6]! * z) * sign
          const ny = (cofactor[1]! * x + cofactor[4]! * y + cofactor[7]! * z) * sign
          const nz = (cofactor[2]! * x + cofactor[5]! * y + cofactor[8]! * z) * sign
          const length = Math.hypot(nx, ny, nz) || 1
          normals[i] = nx / length
          normals[i + 1] = ny / length
          normals[i + 2] = nz / length
        }
      }

      let indices: Uint32Array | null = null
      if (primitive.indices !== undefined) {
        indices = reader.indices(primitive.indices)
      }
      const vertexCount = positions.length / 3
      const cornerCount = indices ? indices.length : vertexCount
      if (cornerCount % 3 !== 0) {
        throw new GltfError(`mesh ${meshIndex}: ${cornerCount} corners is not a whole number of triangles`)
      }
      if (indices) {
        for (const index of indices) {
          if (index >= vertexCount) {
            throw new GltfError(`mesh ${meshIndex}: an index points past the vertices`)
          }
        }
      }
      if (mirrored) {
        if (indices) {
          for (let i = 0; i < indices.length; i += 3) {
            const swap = indices[i + 1]!
            indices[i + 1] = indices[i + 2]!
            indices[i + 2] = swap
          }
        } else {
          // Unindexed: swap the vertices themselves, normals along with them.
          for (let corner = 0; corner < vertexCount; corner += 3) {
            for (let c = 0; c < 3; c += 1) {
              const a = (corner + 1) * 3 + c
              const b = (corner + 2) * 3 + c
              ;[positions[a], positions[b]] = [positions[b]!, positions[a]!]
              if (normals) {
                ;[normals[a], normals[b]] = [normals[b]!, normals[a]!]
              }
            }
          }
        }
      }

      primitives.push({
        name: mesh.name ?? `mesh ${meshIndex}` + (slot > 0 ? `.${slot}` : ''),
        material: materialOf(json, primitive.material),
        positions,
        normals,
        indices,
        triangleCount: cornerCount / 3,
      })
    }
  }

  return {
    primitives,
    generator: json.asset.generator ?? null,
    triangleCount: primitives.reduce((sum, primitive) => sum + primitive.triangleCount, 0),
    bounds: primitives.length > 0 ? { min, max } : null,
  }
}
