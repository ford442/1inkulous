/**
 * Writes a `.glb`: the other half of src/assets/gltf.ts, for the tests that need
 * a model to read and for `npm run assets:follower`, which writes the
 * procedural pawn out as a starting point for an artist.
 *
 * Just enough glTF — one mesh, one primitive per part, positions, normals and
 * indices, a named material each — and nothing that needs the DOM.
 */

export type GlbPart = {
  /** The material's name: what says which part of a follower this is. */
  material: string
  baseColor?: readonly [number, number, number, number]
  positions: Float32Array
  normals?: Float32Array
  indices?: Uint16Array | Uint32Array
}

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

const pad4 = (length: number) => (length + 3) & ~3

/** Wraps a JSON document and its binary buffer in a GLB container. */
export function buildGlb(json: object, bin: Uint8Array | null): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = pad4(text.length)
  const binLength = bin ? pad4(bin.length) : 0
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0)

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, GLB_MAGIC, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, CHUNK_JSON, true)
  out.set(text, 20)
  // glTF pads JSON with spaces, so the tail parses as whitespace.
  out.fill(0x20, 20 + text.length, 20 + jsonLength)
  if (bin) {
    const at = 20 + jsonLength
    view.setUint32(at, binLength, true)
    view.setUint32(at + 4, CHUNK_BIN, true)
    out.set(bin, at + 8)
  }
  return out
}

export function writeGlb(parts: readonly GlbPart[], options: { generator?: string } = {}): Uint8Array {
  const chunks: Uint8Array[] = []
  let size = 0
  const bufferViews: object[] = []
  const accessors: object[] = []

  const add = (data: Uint8Array, target: number): number => {
    const start = size
    chunks.push(data, new Uint8Array(pad4(data.length) - data.length))
    size += pad4(data.length)
    bufferViews.push({ buffer: 0, byteOffset: start, byteLength: data.length, target })
    return bufferViews.length - 1
  }
  const bytesOf = (array: Float32Array | Uint16Array | Uint32Array) =>
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength)

  const materials: { name: string; pbrMetallicRoughness: { baseColorFactor: number[] } }[] = []
  const primitives = parts.map((part) => {
    const attributes: Record<string, number> = {}

    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < part.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, part.positions[i + axis]!)
        max[axis] = Math.max(max[axis]!, part.positions[i + axis]!)
      }
    }
    accessors.push({
      bufferView: add(bytesOf(part.positions), 34962),
      componentType: 5126,
      count: part.positions.length / 3,
      type: 'VEC3',
      min,
      max,
    })
    attributes.POSITION = accessors.length - 1

    if (part.normals) {
      accessors.push({
        bufferView: add(bytesOf(part.normals), 34962),
        componentType: 5126,
        count: part.normals.length / 3,
        type: 'VEC3',
      })
      attributes.NORMAL = accessors.length - 1
    }

    let indices: number | undefined
    if (part.indices) {
      accessors.push({
        bufferView: add(bytesOf(part.indices), 34963),
        componentType: part.indices instanceof Uint16Array ? 5123 : 5125,
        count: part.indices.length,
        type: 'SCALAR',
      })
      indices = accessors.length - 1
    }

    let material = materials.findIndex((m) => m.name === part.material)
    if (material < 0) {
      materials.push({
        name: part.material,
        pbrMetallicRoughness: { baseColorFactor: [...(part.baseColor ?? [1, 1, 1, 1])] },
      })
      material = materials.length - 1
    }
    return { attributes, ...(indices === undefined ? {} : { indices }), material, mode: 4 }
  })

  const bin = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bin.set(chunk, at)
    at += chunk.length
  }

  return buildGlb(
    {
      asset: { version: '2.0', generator: options.generator ?? '1inkulous scripts/glb-writer' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'follower', mesh: 0 }],
      meshes: [{ name: 'follower', primitives }],
      materials,
      accessors,
      bufferViews,
      buffers: [{ byteLength: bin.length }],
    },
    bin,
  )
}
