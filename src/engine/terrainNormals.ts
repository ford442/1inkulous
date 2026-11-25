/**
 * Planet normals rebuilt on the GPU after a sculpt (shaders/terrain_normals.wgsl).
 *
 * The mesh's weld tables — which vertices share a position, which triangles
 * touch it — go up once; after that a frame with dirty terrain costs one
 * small uniform write and one dispatch over the dirty vertex range. The CPU
 * still moves the vertices (refreshVertices with `mesh.normalsOnGpu` set), so
 * picking and the core keep agreeing on where the ground is.
 */
import type { PlanetMesh } from './mesh/cubeSphere'
import type { PipelineFactory } from './materials'
import terrainNormals from './shaders/terrain_normals.wgsl'

const WORKGROUP = 64

export type TerrainNormals = {
  /** Recomputes the normals of vertices `min..max` (inclusive). */
  dispatch: (pass: GPUComputePassEncoder, range: { min: number; max: number }) => void
}

export function createTerrainNormals(
  factory: PipelineFactory,
  mesh: PlanetMesh,
  buffers: { vertices: GPUBuffer; indices: GPUBuffer },
): TerrainNormals {
  const { device } = factory
  const upload = (label: string, data: Uint32Array) => {
    const buffer = device.createBuffer({
      label,
      // Storage bindings must be a multiple of 4 bytes and non-empty.
      size: Math.max(4, data.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(buffer, 0, data)
    return buffer
  }
  const weldIds = upload('planet-weld-ids', mesh.weldIds)
  const weldTriangleOffsets = upload('planet-weld-triangle-offsets', mesh.weldTriangleOffsets)
  const weldTriangles = upload('planet-weld-triangles', mesh.weldTriangles)
  const range = device.createBuffer({
    label: 'planet-normal-range',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const storage = (type: GPUBufferBindingType) => ({ visibility: GPUShaderStage.COMPUTE, buffer: { type } })
  const { pipeline, layouts } = factory.compute('terrain-normals', terrainNormals, 'cs_normals', [
    [
      { binding: 0, ...storage('storage') },
      { binding: 1, ...storage('read-only-storage') },
      { binding: 2, ...storage('read-only-storage') },
      { binding: 3, ...storage('read-only-storage') },
      { binding: 4, ...storage('read-only-storage') },
      { binding: 5, ...storage('uniform') },
    ],
  ])
  const bindGroup = device.createBindGroup({
    layout: layouts[0]!,
    entries: [
      { binding: 0, resource: { buffer: buffers.vertices } },
      { binding: 1, resource: { buffer: buffers.indices } },
      { binding: 2, resource: { buffer: weldIds } },
      { binding: 3, resource: { buffer: weldTriangleOffsets } },
      { binding: 4, resource: { buffer: weldTriangles } },
      { binding: 5, resource: { buffer: range } },
    ],
  })
  const rangeData = new Uint32Array(4)

  return {
    dispatch(pass, { min, max }) {
      const count = Math.min(max, mesh.vertexCount - 1) - min + 1
      if (count <= 0) {
        return
      }
      rangeData[0] = min
      rangeData[1] = count
      device.queue.writeBuffer(range, 0, rangeData)
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP))
    },
  }
}
