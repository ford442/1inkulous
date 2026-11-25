/**
 * The asset path, without a browser or a GPU: the glTF reader (plain, quantised
 * and meshopt-compressed files, node transforms, the errors it must give), what
 * becomes of a loaded model as a follower, and the manager that fetches it all
 * (progress, caching, optional versus required, cancelling).
 *
 * The round trip is the one that matters most: the procedural pawn written to a
 * .glb and read back through the same path an artist's model takes must be the
 * pawn it started as. If that holds, the swap is only about the file.
 *
 * Run: npm run test:assets
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeshoptEncoder } from 'meshoptimizer/encoder'
import {
  followerMeshFromModel,
  FollowerModelError,
  followerPartOfMaterial,
  MAX_FOLLOWER_MODEL_TRIANGLES,
} from '../src/assets/followerModel.ts'
import { GltfError, parseGltf, type MeshoptDecoderLike } from '../src/assets/gltf.ts'
import { fetchAssetIndex, parseAssetIndex } from '../src/assets/index.ts'
import { followerMeshFromAssets } from '../src/assets/models.ts'
import {
  AssetError,
  createAssetManager,
  type AssetProgress,
} from '../src/assets/manager.ts'
import { MANIFEST, type AssetManifest } from '../src/assets/manifest.ts'
import {
  createFollowerMesh,
  FOLLOWER_PART_BAND,
  FOLLOWER_PART_BODY,
  FOLLOWER_PART_CLUB,
  FOLLOWER_PART_RING,
  FOLLOWER_VERTEX_FLOATS,
} from '../src/engine/mesh/followerMesh.ts'
import { followerGlb, followerParts } from './follower-glb.ts'
import { buildGlb, writeGlb, type GlbPart } from './glb-writer.ts'
import { INDEXED_FOLDERS, scanAssets } from './assets-index.mjs'
import { clampFraction, createStartupProgress, loadingPercent, loadingText, type LoadingReadout } from '../src/ui/loading.ts'

const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`ok  ${name}${detail ? `  — ${detail}` : ''}`)
    return
  }
  const message = detail ? `${name} — ${detail}` : name
  failures.push(message)
  console.error(`FAIL ${message}`)
}

async function rejects(promise: Promise<unknown>, type: abstract new (...args: never[]) => Error, match: RegExp) {
  try {
    await promise
  } catch (error) {
    return error instanceof type && match.test((error as Error).message)
      ? null
      : `${(error as Error).name}: ${(error as Error).message}`
  }
  return 'it resolved'
}

const near = (a: number, b: number, tolerance = 1e-5) => Math.abs(a - b) <= tolerance

// --- a pawn, as a file ---------------------------------------------------------

const HEIGHT = 0.02
const RADIUS = 0.008
const pawn = createFollowerMesh({ height: HEIGHT, radius: RADIUS })

const partCount = (mesh: { vertexData: Float32Array; vertexCount: number }, kind: number) => {
  let n = 0
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    n += mesh.vertexData[v * FOLLOWER_VERTEX_FLOATS + 6] === kind ? 1 : 0
  }
  return n / 3
}

// --- the reader --------------------------------------------------------------------

const glb = followerGlb(pawn)
const model = await parseGltf(glb)
check('a .glb is read: three primitives, the pawn without its ring', model.primitives.length === 3 &&
  model.triangleCount === pawn.triangleCount - partCount(pawn, FOLLOWER_PART_RING),
  `${model.primitives.length} primitives, ${model.triangleCount} triangles`)
check('materials come through by name', model.primitives.map((p) => p.material.name).join() === 'body,band,club')
check('the generator is recorded', model.generator === '1inkulous assets:follower')
check('bounds cover every vertex', model.bounds !== null && near(model.bounds.min[1], 0) && near(model.bounds.max[1], HEIGHT))

const swapped = followerMeshFromModel(model, { height: HEIGHT, radius: RADIUS })
let worst = 0
for (let i = 0; i < pawn.vertexData.length; i += 1) {
  worst = Math.max(worst, Math.abs(pawn.vertexData[i]! - swapped.vertexData[i]!))
}
check('the pawn written out and read back is the pawn', swapped.vertexData.length === pawn.vertexData.length && worst < 1e-6,
  `${swapped.triangleCount} triangles, largest difference ${worst.toExponential(1)}`)
check('and keeps its selection ring', partCount(swapped, FOLLOWER_PART_RING) === partCount(pawn, FOLLOWER_PART_RING))

// Files come from everywhere: another unit, an offset, a different handedness of
// author. The follower is still the follower's size, on the ground, centred.
{
  const scale = 37.5
  const moved = followerParts(pawn).map((part) => ({
    ...part,
    positions: part.positions.map((value, i) => value * scale + [4, -9, 2][i % 3]!),
  }))
  const big = await parseGltf(writeGlb(moved))
  const mesh = followerMeshFromModel(big, { height: HEIGHT, radius: RADIUS })
  let lo = Infinity
  let hi = -Infinity
  let sx = 0
  let sz = 0
  let n = 0
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    const base = v * FOLLOWER_VERTEX_FLOATS
    if (mesh.vertexData[base + 6] === FOLLOWER_PART_BODY) {
      lo = Math.min(lo, mesh.vertexData[base + 1]!)
      hi = Math.max(hi, mesh.vertexData[base + 1]!)
      sx += mesh.vertexData[base]!
      sz += mesh.vertexData[base + 2]!
      n += 1
    }
  }
  check('a model in other units and elsewhere is scaled to the follower, feet on the ground',
    near(lo, 0, 1e-6) && near(hi, HEIGHT, 1e-6), `y from ${lo.toExponential(1)} to ${hi.toFixed(4)}`)
  check('and centred on its own axis', near(sx / n, 0, 1e-5) && near(sz / n, 0, 1e-5))
}

check('material names pick parts', followerPartOfMaterial('Band') === FOLLOWER_PART_BAND &&
  followerPartOfMaterial(' club ') === FOLLOWER_PART_CLUB && followerPartOfMaterial('Skin') === FOLLOWER_PART_BODY &&
  followerPartOfMaterial('') === FOLLOWER_PART_BODY)

// No normals in the file: face normals, so the model still lights.
{
  const bare = followerParts(pawn).map(({ material, positions }) => ({ material, positions }))
  const mesh = followerMeshFromModel(await parseGltf(writeGlb(bare)), { height: HEIGHT, radius: RADIUS })
  let worstNormal = 0
  for (let i = 0; i < pawn.vertexData.length; i += 1) {
    worstNormal = Math.max(worstNormal, Math.abs(pawn.vertexData[i]! - mesh.vertexData[i]!))
  }
  check('a model without normals gets face normals — here, the same pawn', worstNormal < 1e-6)
}

// Indexed geometry, 16-bit and 32-bit, comes out as the same triangles.
{
  const quad = (indices: Uint16Array | Uint32Array): GlbPart => ({
    material: 'body',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices,
  })
  const a = await parseGltf(writeGlb([quad(new Uint16Array([0, 1, 2, 0, 2, 3]))]))
  const b = await parseGltf(writeGlb([quad(new Uint32Array([0, 1, 2, 0, 2, 3]))]))
  check('indices read as 16-bit and 32-bit', a.triangleCount === 2 && b.triangleCount === 2 &&
    a.primitives[0]!.indices!.join() === '0,1,2,0,2,3' && b.primitives[0]!.indices!.join() === '0,1,2,0,2,3')
}

// --- node transforms, quantisation, meshopt ------------------------------------------

const TRIANGLE_POSITIONS = [0, 0, 0, 1, 0, 0, 0, 1, 0]
const TRIANGLE_NORMALS = [0, 0, 1, 0, 0, 1, 0, 0, 1]

/** One triangle, with `extra` merged into the document, over a hand-built buffer. */
function triangleGlb(
  node: object,
  extra: object = {},
  accessorOverride: object = {},
  positionBytes: Uint8Array = new Uint8Array(new Float32Array(TRIANGLE_POSITIONS).buffer),
  normalBytes: Uint8Array = new Uint8Array(new Float32Array(TRIANGLE_NORMALS).buffer),
) {
  const bin = new Uint8Array(positionBytes.length + normalBytes.length)
  bin.set(positionBytes, 0)
  bin.set(normalBytes, positionBytes.length)
  return buildGlb(
    {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [node],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', ...accessorOverride },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positionBytes.length },
        { buffer: 0, byteOffset: positionBytes.length, byteLength: normalBytes.length },
      ],
      buffers: [{ byteLength: bin.length }],
      ...extra,
    },
    bin,
  )
}

{
  // 90 degrees about Y, scaled by 2, moved to x=10: (1,0,0) -> (0,0,-1)*2 + (10,0,0).
  const s = Math.SQRT1_2
  const placed = await parseGltf(
    triangleGlb({ mesh: 0, translation: [10, 0, 0], rotation: [0, s, 0, s], scale: [2, 2, 2] }),
  )
  const p = placed.primitives[0]!.positions
  const n = placed.primitives[0]!.normals!
  check('a node\'s translation, rotation and scale are applied to positions',
    near(p[3]!, 10, 1e-5) && near(p[5]!, -2, 1e-5) && near(p[7]!, 2, 1e-5),
    `(1,0,0) -> (${p[3]!.toFixed(2)}, ${p[4]!.toFixed(2)}, ${p[5]!.toFixed(2)})`)
  check('and, as a rotation, to normals: (0,0,1) -> (1,0,0), still unit',
    near(n[0]!, 1, 1e-5) && near(Math.hypot(n[0]!, n[1]!, n[2]!), 1, 1e-5))

  const matrix = await parseGltf(
    triangleGlb({ mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1] }),
  )
  check('a node matrix works as well as TRS', near(matrix.primitives[0]!.positions[0]!, 5) &&
    near(matrix.primitives[0]!.positions[1]!, 6))

  // Squashing y by 0.1 leaves a normal along (0,1,1) tilted towards y, not along the surface.
  const squashed = await parseGltf(
    triangleGlb({ mesh: 0, scale: [1, 0.1, 1] }, {}, {}, undefined, new Uint8Array(new Float32Array([0, 1, 1, 0, 1, 1, 0, 1, 1]).buffer)),
  )
  const sn = squashed.primitives[0]!.normals!
  check('normals follow the inverse transpose under non-uniform scale',
    near(Math.hypot(sn[0]!, sn[1]!, sn[2]!), 1, 1e-5) && sn[1]! > sn[2]! * 5,
    `(${sn[1]!.toFixed(3)}, ${sn[2]!.toFixed(3)})`)

  const mirrored = await parseGltf(triangleGlb({ mesh: 0, scale: [-1, 1, 1] }))
  // Unindexed: the mirror swaps vertices 1 and 2, so the triangle still faces its normal.
  const mp = mirrored.primitives[0]!.positions
  const winding = (mp[3]! - mp[0]!) * (mp[7]! - mp[1]!) - (mp[4]! - mp[1]!) * (mp[6]! - mp[0]!)
  check('a mirroring node does not turn the triangle inside out', winding > 0, `signed area ${winding}`)

  const nested = await parseGltf(
    buildGlb(
      {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [{ children: [1], translation: [1, 0, 0] }, { mesh: 0, translation: [0, 2, 0] }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
        bufferViews: [{ buffer: 0, byteLength: 36 }],
        buffers: [{ byteLength: 36 }],
      },
      new Uint8Array(new Float32Array(TRIANGLE_POSITIONS).buffer),
    ),
  )
  check('a parent\'s transform carries its children', near(nested.primitives[0]!.positions[0]!, 1) &&
    near(nested.primitives[0]!.positions[1]!, 2))
}

{
  // KHR_mesh_quantization, as the optimiser writes it: int16 positions normalised
  // over a unit cube, with the cube's size on the node, int8 normals.
  const extent = 8
  const raw = [-1, -0.5, 0.25, 1, 0, -1, 0.5, 1, 1]
  const positions = new Int16Array(raw.map((v) => Math.round(v * 32767)))
  const normals = new Int8Array([0, 0, 127, 0, 127, 0, 127, 0, 0])
  // 9 int16 = 18 bytes; each view is padded out to 4.
  const posBytes = new Uint8Array(20)
  posBytes.set(new Uint8Array(positions.buffer))
  const normBytes = new Uint8Array(12)
  normBytes.set(new Uint8Array(normals.buffer))
  const quantised = await parseGltf(
    buildGlb(
      {
        asset: { version: '2.0' },
        extensionsUsed: ['KHR_mesh_quantization'],
        extensionsRequired: ['KHR_mesh_quantization'],
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, scale: [extent, extent, extent] }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
        accessors: [
          { bufferView: 0, componentType: 5122, normalized: true, count: 3, type: 'VEC3' },
          { bufferView: 1, componentType: 5120, normalized: true, count: 3, type: 'VEC3' },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 18 },
          { buffer: 0, byteOffset: 20, byteLength: 9 },
        ],
        buffers: [{ byteLength: 32 }],
      },
      (() => {
        const bin = new Uint8Array(32)
        bin.set(posBytes.subarray(0, 18), 0)
        bin.set(normBytes.subarray(0, 9), 20)
        return bin
      })(),
    ),
  )
  const q = quantised.primitives[0]!
  let err = 0
  for (let i = 0; i < raw.length; i += 1) {
    err = Math.max(err, Math.abs(q.positions[i]! - raw[i]! * extent))
  }
  check('quantised 16-bit positions and 8-bit normals are read back to floats', err < extent / 32767 + 1e-6 && near(q.normals![2]!, 1, 1e-6),
    `largest position error ${err.toExponential(1)}`)
}

{
  // EXT_meshopt_compression: positions and indices compressed, the fallback
  // buffer empty of data, the way gltf-transform writes it.
  await MeshoptEncoder.ready
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 4])
  const packedPositions = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(positions.buffer), 5, 12, 'ATTRIBUTES')
  const packedIndices = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(indices.buffer), 9, 4, 'TRIANGLES')
  const bin = new Uint8Array(packedPositions.length + 4 + packedIndices.length)
  bin.set(packedPositions, 0)
  const indexAt = (packedPositions.length + 3) & ~3
  bin.set(packedIndices, indexAt)
  const document = {
    asset: { version: '2.0' },
    extensionsUsed: ['EXT_meshopt_compression'],
    extensionsRequired: ['EXT_meshopt_compression'],
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 5, type: 'VEC3' },
      { bufferView: 1, componentType: 5125, count: 9, type: 'SCALAR' },
    ],
    bufferViews: [
      {
        buffer: 1,
        byteLength: 60,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0, byteOffset: 0, byteLength: packedPositions.length, byteStride: 12, mode: 'ATTRIBUTES', count: 5,
          },
        },
      },
      {
        buffer: 1,
        byteOffset: 60,
        byteLength: 36,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0, byteOffset: indexAt, byteLength: packedIndices.length, byteStride: 4, mode: 'TRIANGLES', count: 9,
          },
        },
      },
    ],
    buffers: [{ byteLength: bin.length }, { byteLength: 96, extensions: { EXT_meshopt_compression: { fallback: true } } }],
  }
  const compressed = await parseGltf(buildGlb(document, bin))
  const c = compressed.primitives[0]!
  check('meshopt-compressed buffers are decoded (through the real wasm decoder)',
    c.positions.join() === positions.join() && c.indices!.join() === indices.join() && compressed.triangleCount === 3,
    `${packedPositions.length + packedIndices.length} bytes packed for ${positions.byteLength + indices.byteLength}`)

  // The decoder is only touched by a file that uses it.
  let touched = 0
  const spy: MeshoptDecoderLike = {
    get ready() {
      touched += 1
      return Promise.resolve()
    },
    decodeGltfBuffer: () => {
      throw new Error('should not be called')
    },
  }
  await parseGltf(glb, { meshopt: spy })
  check('a file with no compression never asks for the decoder', touched === 0)
  check('a decoder that throws is a GltfError, not a crash',
    (await rejects(
      parseGltf(buildGlb(document, bin), {
        meshopt: { ready: Promise.resolve(), decodeGltfBuffer: () => { throw new Error('bad stream') } },
      }),
      GltfError,
      /would not decode \(Error: bad stream\)/,
    )) === null)
}

// The real thing: the pawn above, run through `npm run assets:optimize` (glTF
// Transform 4.5.1: welded, quantised, meshopt-compressed — 12.8 KB down to 5.9)
// and kept as a fixture. Every triangle of the procedural pawn must have a twin
// in what comes back, in the right part, to within what 16-bit positions and
// 8-bit normals can hold. Regenerate with:
//   npm run assets:follower -- /tmp/follower.glb
//   node scripts/optimize-models.mjs /tmp /tmp/out && cp /tmp/out/follower.glb scripts/fixtures/follower.optimized.glb
{
  const fixture = readFileSync(new URL('./fixtures/follower.optimized.glb', import.meta.url))
  const optimised = await parseGltf(fixture)
  check('an optimiser\'s output is read: the three parts survive its merging', optimised.primitives.map((p) => p.material.name).join() === 'body,band,club' &&
    optimised.triangleCount === 152, `${fixture.length} bytes, ${optimised.primitives.map((p) => `${p.material.name} ${p.triangleCount}`).join(', ')}`)
  const loaded = followerMeshFromModel(optimised, { height: HEIGHT, radius: RADIUS })

  type Tri = { kind: number; c: number[]; n: number[] }
  const triangles = (m: typeof pawn): Tri[] => {
    const out: Tri[] = []
    for (let t = 0; t < m.vertexCount / 3; t += 1) {
      const c = [0, 0, 0]
      const n = [0, 0, 0]
      for (let k = 0; k < 3; k += 1) {
        const b = (t * 3 + k) * FOLLOWER_VERTEX_FLOATS
        for (let i = 0; i < 3; i += 1) {
          c[i]! += m.vertexData[b + i]! / 3
          n[i]! += m.vertexData[b + 3 + i]! / 3
        }
      }
      out.push({ kind: m.vertexData[t * 3 * FOLLOWER_VERTEX_FLOATS + 6]!, c, n })
    }
    return out
  }
  const have = triangles(loaded)
  let worstPosition = 0
  let worstNormal = 0
  let wrongPart = 0
  for (const wanted of triangles(pawn)) {
    let best = Infinity
    let normal = 0
    let part = false
    for (const candidate of have) {
      const d = Math.hypot(wanted.c[0]! - candidate.c[0]!, wanted.c[1]! - candidate.c[1]!, wanted.c[2]! - candidate.c[2]!)
      if (d < best) {
        best = d
        part = wanted.kind === candidate.kind
        normal = Math.hypot(wanted.n[0]! - candidate.n[0]!, wanted.n[1]! - candidate.n[1]!, wanted.n[2]! - candidate.n[2]!)
      }
    }
    worstPosition = Math.max(worstPosition, best)
    worstNormal = Math.max(worstNormal, normal)
    wrongPart += part ? 0 : 1
  }
  check('quantised and meshopt-compressed, it is still the pawn: positions to a millionth of a unit',
    loaded.triangleCount === pawn.triangleCount && worstPosition < HEIGHT * 1e-4, `worst ${worstPosition.toExponential(1)} on a pawn ${HEIGHT} tall`)
  check('normals to 8-bit precision, every triangle in its part', worstNormal < 0.02 && wrongPart === 0, `worst ${worstNormal.toFixed(4)}, ${wrongPart} in the wrong part`)
}

// --- what it refuses ---------------------------------------------------------------------

{
  const refuse = async (name: string, bytes: Uint8Array, match: RegExp) => {
    const problem = await rejects(parseGltf(bytes), GltfError, match)
    check(`refused: ${name}`, problem === null, problem ?? '')
  }
  await refuse('a file that is neither GLB nor JSON', new TextEncoder().encode('<!doctype html><html>'), /not a glTF file/)
  await refuse('an empty file', new Uint8Array(0), /not a glTF file/)
  const v1 = glb.slice()
  new DataView(v1.buffer).setUint32(4, 1, true)
  await refuse('GLB version 1', v1, /GLB version 1/)
  await refuse('a truncated GLB', glb.slice(0, 40), /runs past the end|no JSON/)
  await refuse('glTF 1.0 JSON', new TextEncoder().encode('{"asset":{"version":"1.0"}}'), /only 2\.0/)
  await refuse('Draco', buildGlb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] }, null), /KHR_draco_mesh_compression/)
  await refuse('a strip', triangleGlb({ mesh: 0 }, { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }] }] }), /triangle lists/)
  await refuse('a buffer view past its buffer', triangleGlb({ mesh: 0 }, { bufferViews: [{ buffer: 0, byteLength: 9999 }, { buffer: 0, byteOffset: 36, byteLength: 36 }] }), /past the end of its buffer/)
  await refuse('an accessor past its view', triangleGlb({ mesh: 0 }, {}, { count: 99 }), /runs past its buffer view/)
  await refuse('an index past the vertices',
    buildGlb(
      {
        asset: { version: '2.0' },
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
          { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
        ],
        bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
        buffers: [{ byteLength: 44 }],
      },
      (() => {
        const bin = new Uint8Array(44)
        bin.set(new Uint8Array(new Float32Array(TRIANGLE_POSITIONS).buffer))
        new DataView(bin.buffer).setUint16(36, 7, true)
        return bin
      })(),
    ),
    /index points past/)
  await refuse('an external buffer', buildGlb({ asset: { version: '2.0' }, buffers: [{ uri: 'model.bin', byteLength: 4 }] }, null), /base64 data URIs/)
  await refuse('a node that is its own ancestor',
    buildGlb({ asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ children: [0] }] }, null), /own ancestor/)
}

{
  // A .gltf with its buffer embedded as a data URI.
  const bytes = new Uint8Array(new Float32Array(TRIANGLE_POSITIONS).buffer)
  const uri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`
  const text = JSON.stringify({
    asset: { version: '2.0' },
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ uri, byteLength: 36 }],
  })
  const embedded = await parseGltf(new TextEncoder().encode(`${String.fromCharCode(0xfeff)} ${text}`))
  check('a .gltf with an embedded buffer is read', embedded.triangleCount === 1)
}

check('material extensions a geometry reader can ignore do not stop it', (await parseGltf(
  buildGlb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_materials_unlit', 'KHR_texture_transform'] }, null),
)).primitives.length === 0)

// --- the follower budget ----------------------------------------------------------------------

{
  const none = await rejects(Promise.resolve().then(() => followerMeshFromModel({ primitives: [], generator: null, triangleCount: 0, bounds: null }, { height: 1, radius: 1 })), FollowerModelError, /no geometry/)
  check('a model with nothing in it is refused, in words', none === null, none ?? '')

  const many = 3 * (MAX_FOLLOWER_MODEL_TRIANGLES + 1)
  const heavy = await parseGltf(writeGlb([{ material: 'body', positions: new Float32Array(many * 3).map((_, i) => (i % 7) * 0.1) }]))
  const tooMany = await rejects(Promise.resolve().then(() => followerMeshFromModel(heavy, { height: 1, radius: 1 })), FollowerModelError, /triangles; a follower may have 2000/)
  check(`more than ${MAX_FOLLOWER_MODEL_TRIANGLES} triangles is refused`, tooMany === null, tooMany ?? '')

  const gearOnly = await parseGltf(writeGlb([{ material: 'club', positions: new Float32Array(TRIANGLE_POSITIONS) }]))
  const noBody = await rejects(Promise.resolve().then(() => followerMeshFromModel(gearOnly, { height: 1, radius: 1 })), FollowerModelError, /no body/)
  check('a model that is all gear is refused', noBody === null, noBody ?? '')

  const flat = await parseGltf(writeGlb([{ material: 'body', positions: new Float32Array([0, 1, 0, 1, 1, 0, 0, 1, 1]) }]))
  const flatProblem = await rejects(Promise.resolve().then(() => followerMeshFromModel(flat, { height: 1, radius: 1 })), FollowerModelError, /no height/)
  check('and one with no height', flatProblem === null, flatProblem ?? '')
}

// --- the manager ------------------------------------------------------------------------------------

type FakeFile = { body: Uint8Array; type?: string; status?: number; chunks?: number; gate?: Promise<void> }

function fakeServer(files: Record<string, FakeFile>) {
  const calls: string[] = []
  let inFlight = 0
  let peak = 0
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    const name = url.replace('http://test/', '')
    const file = files[name]
    inFlight += 1
    peak = Math.max(peak, inFlight)
    const leave = () => {
      inFlight -= 1
    }
    if (init?.signal?.aborted) {
      leave()
      throw new DOMException('aborted', 'AbortError')
    }
    if (!file) {
      leave()
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })
    }
    await file.gate
    if (init?.signal?.aborted) {
      leave()
      throw new DOMException('aborted', 'AbortError')
    }
    const pieces = file.chunks ?? 1
    const size = Math.ceil(file.body.length / pieces)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Promise.resolve()
        if (sent >= file.body.length) {
          controller.close()
          leave()
          return
        }
        controller.enqueue(file.body.subarray(sent, sent + size))
        sent += size
      },
    })
    return new Response(stream, {
      status: file.status ?? 200,
      headers: { 'content-type': file.type ?? 'application/octet-stream', 'content-length': String(file.body.length) },
    })
  }) as typeof fetch
  return { fetch: fetchFn, calls, peak: () => peak }
}

const quiet = { info: () => {}, warn: () => {} }
const bytesOf = (n: number, fill = 7) => new Uint8Array(n).fill(fill)

const MINI = {
  a: { kind: 'binary', url: 'a.bin' },
  b: { kind: 'binary', url: 'b.bin' },
  maybe: { kind: 'binary', url: 'maybe.bin', optional: true },
  later: { kind: 'audio', url: 'later.ogg', optional: true, group: 'deferred' },
} as const satisfies AssetManifest

{
  const server = fakeServer({ 'a.bin': { body: bytesOf(1000), chunks: 4 }, 'b.bin': { body: bytesOf(3000), chunks: 3 } })
  const assets = createAssetManager(MINI, { fetch: server.fetch, baseUrl: 'http://test/', log: quiet })
  const seen: AssetProgress[] = []
  assets.onProgress((p) => seen.push(p))
  check('before anything is asked, there is nothing to wait for', assets.progress.fraction === 1 && assets.progress.requested === 0)
  check('and nothing has a status', assets.status('a') === 'idle' && assets.get('a') === null)

  const [a, b] = await Promise.all([assets.load('a'), assets.load('b')])
  check('assets load to their bytes', a.byteLength === 1000 && b.byteLength === 3000 && new Uint8Array(a)[999] === 7)
  const fractions = seen.map((p) => p.fraction)
  check('progress only ever goes up', fractions.every((f, i) => i === 0 || f >= fractions[i - 1]! - 1e-12), fractions.map((f) => f.toFixed(2)).join(' '))
  check('is strictly between 0 and 1 while bytes arrive', seen.some((p) => p.fraction > 0 && p.fraction < 1))
  check('and ends at exactly 1, with both done', assets.progress.fraction === 1 && assets.progress.done === 2 && assets.progress.active.length === 0)
  check('byte counts add up', assets.progress.loadedBytes === 4000 && assets.progress.expectedBytes === 4000)
  check('status and get follow', assets.status('a') === 'ready' && assets.get('a') === a)

  const again = await assets.load('a')
  check('a loaded asset is cached: the same object, no second request', again === a && server.calls.filter((c) => c.endsWith('a.bin')).length === 1)
}

{
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const server = fakeServer({ 'a.bin': { body: bytesOf(10), gate } })
  const assets = createAssetManager(MINI, { fetch: server.fetch, baseUrl: 'http://test/', log: quiet })
  const first = assets.load('a')
  const second = assets.load('a')
  check('while loading, the status says so', assets.status('a') === 'loading')
  release()
  const [x, y] = await Promise.all([first, second])
  check('two callers asking at once share one request', x === y && server.calls.length === 1)
}

{
  const notes: string[] = []
  const server = fakeServer({ 'index.html': { body: bytesOf(5), type: 'text/html' } })
  const assets = createAssetManager(
    { ...MINI, page: { kind: 'binary', url: 'index.html', optional: true } } as const,
    { fetch: server.fetch, baseUrl: 'http://test/', log: { info: (m) => notes.push(m), warn: (m) => notes.push(m) } },
  )
  const missing = await assets.load('maybe')
  check('an optional asset that 404s is null, not an error', missing === null && assets.status('maybe') === 'missing')
  check('and is said so once', notes.length === 1 && notes[0]!.includes('maybe') && notes[0]!.includes('using the built-in'), notes[0] ?? '')
  await assets.load('maybe')
  check('and is not asked for again', server.calls.length === 1)
  check('a dev server answering a missing file with its page counts as missing', (await assets.load('page')) === null)
  check('a missing optional asset still finishes the loading bar', assets.progress.fraction === 1 && assets.progress.done === 2)
}

{
  const server = fakeServer({})
  const assets = createAssetManager(MINI, { fetch: server.fetch, baseUrl: 'http://test/', log: quiet })
  const problem = await rejects(assets.load('a'), AssetError, /a\.bin is missing \(required asset a\)/)
  check('a required asset that is missing says which', problem === null, problem ?? '')
  await rejects(assets.load('a'), AssetError, /missing/)
  check('and is asked for again next time, so a retry can work', server.calls.length === 2)
  check('a failed required load leaves no half-done bar behind', assets.progress.requested === 0)

  const hurt = createAssetManager(MINI, {
    fetch: (async () => new Response('oops', { status: 503, statusText: 'Service Unavailable' })) as typeof fetch,
    baseUrl: 'http://test/',
    log: quiet,
  })
  const outage = await rejects(hurt.load('b'), AssetError, /503 Service Unavailable/)
  check('a server error names the status', outage === null, outage ?? '')
  check('asking the manifest for a key it lacks is an error too', (await rejects(
    (assets.load as (key: string) => Promise<unknown>)('nope'), AssetError, /no asset "nope"/)) === null)
}

{
  const server = fakeServer({ 'a.bin': { body: bytesOf(8) }, 'maybe.bin': { body: bytesOf(8) } })
  const notes: string[] = []
  const loaders = { binary: () => { throw new Error('not a thing') } }
  const assets = createAssetManager(MINI, { fetch: server.fetch, baseUrl: 'http://test/', loaders, log: { info: () => {}, warn: (m) => notes.push(m) } })
  check('an optional asset that will not parse is null, with a warning', (await assets.load('maybe')) === null &&
    assets.status('maybe') === 'failed' && notes.length === 1 && notes[0]!.includes('not a thing'), notes[0] ?? '')
  const problem = await rejects(assets.load('a'), AssetError, /a\.bin: not a thing/)
  check('a required asset that will not parse is an AssetError naming the file', problem === null, problem ?? '')
}

{
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const server = fakeServer({ 'a.bin': { body: bytesOf(8), gate } })
  const assets = createAssetManager(MINI, { fetch: server.fetch, baseUrl: 'http://test/', log: quiet })
  const controller = new AbortController()
  const pending = assets.load('a', controller.signal)
  controller.abort()
  release()
  let aborted = false
  try {
    await pending
  } catch (error) {
    aborted = error instanceof DOMException && error.name === 'AbortError'
  }
  check('an aborted load rejects with AbortError', aborted)
  check('and leaves no verdict behind', assets.status('a') === 'idle' && assets.progress.requested === 0)
  const fresh = await assets.load('a')
  check('so asking again starts over and works', fresh.byteLength === 8)
}

{
  const files: Record<string, FakeFile> = {}
  const manifest: Record<string, { kind: 'binary'; url: string }> = {}
  const gates: (() => void)[] = []
  for (let i = 0; i < 6; i += 1) {
    manifest[`f${i}`] = { kind: 'binary', url: `f${i}.bin` }
    files[`f${i}.bin`] = {
      body: bytesOf(4),
      gate: new Promise<void>((resolve) => { gates.push(resolve) }),
    }
  }
  const server = fakeServer(files)
  const assets = createAssetManager(manifest, { fetch: server.fetch, baseUrl: 'http://test/', concurrency: 2, log: quiet })
  const all = assets.loadGroup()
  for (let round = 0; round < 12; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates.forEach((release) => release())
  }
  await all
  check('no more requests are in flight than the concurrency allows', server.peak() <= 2 && server.calls.length === 6, `peak ${server.peak()} of 2, ${server.calls.length} requests`)
}

{
  const server = fakeServer({ 'a.bin': { body: bytesOf(4) }, 'b.bin': { body: bytesOf(4) }, 'later.ogg': { body: bytesOf(4) } })
  const assets = createAssetManager(MINI, { fetch: server.fetch, baseUrl: 'http://test/', log: quiet })
  await assets.loadGroup('boot')
  check('the boot group is everything not deferred', assets.status('a') === 'ready' && assets.status('b') === 'ready' &&
    assets.status('maybe') === 'missing' && assets.status('later') === 'idle')
  await assets.loadGroup('deferred')
  check('and the deferred group waits to be asked', assets.status('later') === 'ready')
}

{
  const server = fakeServer({ 'a.bin': { body: bytesOf(10), type: 'application/octet-stream' } })
  const wide = createAssetManager({ a: { kind: 'binary', url: 'a.bin', bytes: 1000 } }, { fetch: server.fetch, baseUrl: 'http://test/', log: quiet })
  const loading = wide.load('a')
  check('a manifest size gives the bar a weight before the first byte', wide.progress.requested === 1 && wide.progress.fraction === 0)
  await loading
  check('and it still ends at 1', wide.progress.fraction === 1)
}

// --- the index of what is there ---------------------------------------------------------------------------

{
  const server = fakeServer({ 'a.bin': { body: bytesOf(1000), chunks: 2 } })
  const notes: string[] = []
  const assets = createAssetManager(MINI, {
    fetch: server.fetch,
    baseUrl: 'http://test/',
    index: { 'a.bin': 1000 },
    log: { info: (m) => notes.push(m), warn: (m) => notes.push(m) },
  })
  const absent = await assets.load('maybe')
  check('with an index, an optional asset it does not list is missing without a request', absent === null && server.calls.length === 0 &&
    assets.status('maybe') === 'missing')
  const loading = assets.load('a')
  check('a listed asset\'s size is known before its first byte, so the bar has a weight', assets.progress.expectedBytes === 1000 && assets.progress.fraction < 0.01, `${assets.progress.expectedBytes} bytes expected`)
  await loading
  check('and a listed asset loads as usual', server.calls.length === 1 && assets.progress.fraction === 1)
  const required = createAssetManager(MINI, { fetch: server.fetch, baseUrl: 'http://test/', index: {}, log: quiet })
  check('a required asset the index lacks is an error, with no request', (await rejects(required.load('b'), AssetError, /b\.bin is missing/)) === null && server.calls.length === 1)
}

{
  check('an index is an object of sizes', JSON.stringify(parseAssetIndex({ 'a/b.glb': 12, 'c.ogg': 0 })) === '{"a/b.glb":12,"c.ogg":0}')
  check('and nothing else is one', [null, [], 'x', 4, { a: '1' }, { a: -1 }, { a: NaN }].every((v) => parseAssetIndex(v) === null))
  const json = (value: unknown, status = 200) => (async () => new Response(JSON.stringify(value), { status })) as typeof fetch
  check('it is fetched from beside the page', (await fetchAssetIndex(json({ 'models/follower.glb': 5 }), 'http://test/game/'))?.['models/follower.glb'] === 5)
  check('and is null when missing, malformed, or the page a dev server answers with',
    (await fetchAssetIndex(json({}, 404), 'http://test/')) === null &&
    (await fetchAssetIndex((async () => new Response('<!doctype html>')) as typeof fetch, 'http://test/')) === null &&
    (await fetchAssetIndex((async () => { throw new TypeError('offline') }) as typeof fetch, 'http://test/')) === null)

  const dir = mkdtempSync(join(tmpdir(), 'assets-index-'))
  try {
    check('an empty public/ indexes to nothing', Object.keys(scanAssets(dir)).length === 0)
    for (const folder of INDEXED_FOLDERS) mkdirSync(join(dir, folder))
    writeFileSync(join(dir, 'models/follower.glb'), new Uint8Array(123))
    writeFileSync(join(dir, 'audio/chop.ogg'), new Uint8Array(45))
    writeFileSync(join(dir, 'audio/.gitkeep'), '')
    mkdirSync(join(dir, 'audio/nested'))
    mkdirSync(join(dir, 'textures'))
    writeFileSync(join(dir, 'textures/ground.png'), new Uint8Array(9))
    const index = scanAssets(dir)
    check('the build indexes files in models/ and audio/ with their sizes, sorted', JSON.stringify(index) === '{"audio/chop.ogg":45,"models/follower.glb":123}', JSON.stringify(index))
    check('and skips dot-files, folders and anything elsewhere', !('audio/.gitkeep' in index) && !('audio/nested' in index) && !('textures/ground.png' in index))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- the loading screen's numbers ----------------------------------------------------------------------------

{
  check('the bar is clamped and whole-numbered', clampFraction(-1) === 0 && clampFraction(2) === 1 && clampFraction(NaN) === 0 && loadingPercent(0.426) === 43)
  check('its label says where it is', loadingText({ label: 'Loading assets', fraction: 0.5 }) === 'Loading assets — 50%')
  const shown: (LoadingReadout | null)[] = []
  const startup = createStartupProgress(4, (loading) => shown.push(loading))
  startup.stage(0, 'core')
  startup.stage(1, 'world')
  startup.stage(2, 'assets', 0.5)
  startup.stage(2, 'assets', 1)
  startup.stage(1, 'world, late')
  startup.stage(3, 'renderer')
  startup.finish()
  const bars = shown.slice(0, -1).map((l) => l!.fraction)
  check('startup progress runs through the stages, a stage\'s own progress inside its quarter', bars.join() === '0,0.25,0.625,0.75,0.75', bars.join())
  check('a late report from an earlier stage is dropped, never moving the bar back', !shown.some((l) => l?.label === 'world, late'))
  check('and finishing takes the screen down', shown.at(-1) === null)
}

// --- falling back to the procedural pawn -------------------------------------------------------------------------

{
  const notes: string[] = []
  const log = { info: (m: string) => notes.push(m), warn: (m: string) => notes.push(m) }
  const size = { height: HEIGHT, radius: RADIUS }
  const none = followerMeshFromAssets({ get: () => null }, size, log)
  check('with no model loaded there is nothing to swap in, and no noise', none === null && notes.length === 0)
  const good = followerMeshFromAssets({ get: () => model } as never, size, log)
  check('a loaded model becomes a follower mesh', good !== null && good.triangleCount === pawn.triangleCount && notes.length === 1)
  const heavy = await parseGltf(writeGlb([{ material: 'body', positions: new Float32Array(3 * 3 * (MAX_FOLLOWER_MODEL_TRIANGLES + 1)).map((_, i) => (i % 7) * 0.1) }]))
  const refused = followerMeshFromAssets({ get: () => heavy } as never, size, log)
  check('one over budget is refused with a warning, and the pawn stays', refused === null && notes.length === 2 && notes[1]!.includes('using the built-in'), notes[1])
}

// --- the manifest and public/ -----------------------------------------------------------------------------

{
  const entries = Object.entries(MANIFEST)
  const urls = entries.map(([, spec]) => spec.url)
  check('every manifest URL is relative and unique', urls.every((u) => !/^([a-z]+:|\/)/i.test(u)) && new Set(urls).size === urls.length)
  const extensionOk = entries.every(([, spec]) =>
    spec.kind === 'model' ? /\.(glb|gltf)$/.test(spec.url) : spec.kind === 'audio' ? /\.(ogg|opus|mp3|m4a|wav|flac)$/.test(spec.url) : true)
  check('and its extension suits its kind', extensionOk)
  check('every manifest entry is optional: the game runs on its built-ins alone', entries.every(([, spec]) => 'optional' in spec && spec.optional === true))

  // A file dropped into public/ that the manifest does not name would be shipped
  // and never loaded: say so here rather than leave someone wondering.
  const publicDir = new URL('../public/', import.meta.url)
  const listed = new Set(urls)
  const strays: string[] = []
  for (const folder of ['models', 'audio']) {
    const dir = new URL(`${folder}/`, publicDir)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || statSync(new URL(name, dir)).isDirectory()) continue
      if (!listed.has(`${folder}/${name}`)) strays.push(`${folder}/${name}`)
    }
  }
  check('every file under public/models and public/audio is in the manifest', strays.length === 0, strays.join(', '))

  // Art and sound must be original or properly licensed, and say so: a file in
  // public/ that CREDITS.md never mentions is one whose licence nobody wrote down.
  const credits = readFileSync(new URL('../public/CREDITS.md', import.meta.url), 'utf8')
  const unattributed: string[] = []
  for (const folder of ['models', 'audio']) {
    const dir = new URL(`${folder}/`, publicDir)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('.') && !credits.includes(`${folder}/${name}`) && !credits.includes(name)) {
        unattributed.push(`${folder}/${name}`)
      }
    }
  }
  check('every file under public/models and public/audio is credited in public/CREDITS.md', unattributed.length === 0, unattributed.join(', '))
  check('CREDITS.md says what each table is for and how to add an asset', ['## Art', '## Sound', '## Music', '## Adding an asset'].every((h) => credits.includes(h)))
}

// --- wiring, as far as it can be seen without a GPU -----------------------------------------------------------

{
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const renderer = read('src/engine/renderer.ts')
  const main = read('src/main.ts')
  check('the renderer takes a ready-made follower mesh and falls back to the procedural pawn',
    /followerMesh\?:\s*FollowerMesh/.test(renderer) && /options\.followerMesh\s*\?\?\s*createFollowerMesh/.test(renderer))
  check('the swap lives in main: the sim and the game modules never import the loader',
    /followerMeshFromAssets/.test(main) &&
    !['src/sim', 'src/game'].some((dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).some((f) => /from '\.\.\/assets\/gltf/.test(read(`${dir}/${f}`)))))
}

if (failures.length > 0) {
  console.error(`\n${failures.length} asset check(s) failed`)
  process.exit(1)
}
console.log('\nall asset checks passed')
