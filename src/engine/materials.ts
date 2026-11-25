/**
 * Pipelines from materials. Every render pipeline in the frame shares one
 * convention, so a new kind of mesh is a shader and a short description, not
 * a page of descriptor boilerplate:
 *
 * - `@group(0)`: the frame — camera, sun, shadow map (shaders/lib/frame.wgsl).
 *   One bind group per pass, set once, shared by every material.
 * - `@group(1)`: the material's own resources, if it has any (the particle
 *   buffer, say). Set with the material.
 * - `@group(2)`: per-draw resources, if a material declares them.
 *
 * The layouts are explicit rather than `layout: 'auto'`, which would give
 * every pipeline a private group 0 and need one frame bind group per pipeline.
 *
 * Every pipeline here draws into the scene's multisampled float target over a
 * reversed-Z depth buffer. A material that casts shadows gets a second,
 * depth-only pipeline over the same vertex shader for the shadow pass, which
 * swaps the frame's viewProj for the sun's.
 */
import { specializeWgsl, type WgslDefines } from './wgsl'

/** The scene's colour target: linear and unbounded, tone mapped at the end. */
export const SCENE_FORMAT: GPUTextureFormat = 'rgba16float'
/** Reversed Z: near is 1, far is 0, so the test is `greater` and the clear 0. */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float'
export const SCENE_DEPTH_COMPARE: GPUCompareFunction = 'greater'
export const SCENE_DEPTH_CLEAR = 0
/** The sun's shadow map: ordinary Z, cleared to 1. */
export const SHADOW_FORMAT: GPUTextureFormat = 'depth32float'

/**
 * 4x is the one multisample count WebGPU guarantees for every renderable
 * format, so there is nothing to probe for. The planet's limb and the instanced
 * pawns are what shimmer as the camera orbits; the shading inside them does not
 * need it.
 */
export const SAMPLE_COUNT = 4

/**
 * The frame uniform block, in floats; mirrors `struct Frame` in
 * shaders/lib/frame.wgsl: viewProj(16) lightViewProj(16) sunDir(4)
 * cameraPos(4) params(4) brush(4) sunColor(4) world(4).
 */
export const FRAME_FLOATS = 56
export const FRAME_BYTES = FRAME_FLOATS * 4
/** Float offsets of each field in the frame block. */
export const FRAME = {
  viewProj: 0,
  lightViewProj: 16,
  sunDir: 32,
  cameraPos: 36,
  params: 40,
  brush: 44,
  sunColor: 48,
  world: 52,
} as const

/** Premultiplied alpha "over": every blended material writes (rgb * a, a). */
const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

export type MaterialOptions = {
  label: string
  /** Composed WGSL (a `.wgsl` import); `#ifdef`s are resolved here. */
  code: string
  vertexBuffers?: GPUVertexBufferLayout[]
  /** Opaque by default; `premultiplied` blends (rgb * a, a) over the scene. */
  blend?: 'opaque' | 'premultiplied'
  /** Defaults to true for opaque materials and false for blended ones. */
  depthWrite?: boolean
  /** Defaults to the scene's reversed-Z `greater`. */
  depthCompare?: GPUCompareFunction
  cullMode?: GPUCullMode
  /** Builds the depth-only pipeline the shadow pass draws this with. */
  castsShadow?: boolean
  /** `@group(1)` bindings. */
  materialEntries?: GPUBindGroupLayoutEntry[]
  /** `@group(2)` bindings. */
  drawEntries?: GPUBindGroupLayoutEntry[]
}

export type Material = {
  readonly label: string
  readonly pipeline: GPURenderPipeline
  readonly shadowPipeline: GPURenderPipeline | null
  readonly materialLayout: GPUBindGroupLayout | null
  readonly drawLayout: GPUBindGroupLayout | null
}

export type ShaderDiagnostic = {
  readonly label: string
  readonly messages: readonly { type: string; message: string; line: number }[]
}

export type PipelineFactory = {
  readonly device: GPUDevice
  /** `@group(0)`, for building the frame's bind groups. */
  readonly frameLayout: GPUBindGroupLayout
  readonly defines: WgslDefines
  /** A shader module, with the factory's defines applied. */
  module: (label: string, code: string) => GPUShaderModule
  material: (options: MaterialOptions) => Material
  /** A compute pipeline over an explicit layout, one bind group per entry list. */
  compute: (
    label: string,
    code: string,
    entryPoint: string,
    groups: GPUBindGroupLayoutEntry[][],
  ) => { pipeline: GPUComputePipeline; layouts: GPUBindGroupLayout[] }
  /** Every module's compilation messages: what the headless check asserts on. */
  diagnostics: () => Promise<ShaderDiagnostic[]>
}

export function createPipelineFactory(
  device: GPUDevice,
  defines: WgslDefines,
): PipelineFactory {
  const frameLayout = device.createBindGroupLayout({
    label: 'frame',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: FRAME_BYTES },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
    ],
  })
  const emptyLayout = device.createBindGroupLayout({ label: 'empty', entries: [] })

  const modules = new Map<string, GPUShaderModule>()
  const module = (label: string, code: string) => {
    const key = `${label}\n${code}`
    let found = modules.get(key)
    if (!found) {
      found = device.createShaderModule({ label, code: specializeWgsl(code, defines) })
      modules.set(key, found)
    }
    return found
  }

  const material = (options: MaterialOptions): Material => {
    const shader = module(options.label, options.code)
    const materialLayout = options.materialEntries
      ? device.createBindGroupLayout({ label: `${options.label}-material`, entries: options.materialEntries })
      : null
    const drawLayout = options.drawEntries
      ? device.createBindGroupLayout({ label: `${options.label}-draw`, entries: options.drawEntries })
      : null
    const groups: GPUBindGroupLayout[] = [frameLayout]
    if (materialLayout || drawLayout) {
      groups.push(materialLayout ?? emptyLayout)
    }
    if (drawLayout) {
      groups.push(drawLayout)
    }
    const layout = device.createPipelineLayout({ label: options.label, bindGroupLayouts: groups })
    const blended = options.blend === 'premultiplied'
    const vertex: GPUVertexState = {
      module: shader,
      entryPoint: 'vs_main',
      buffers: options.vertexBuffers ?? [],
    }
    const primitive: GPUPrimitiveState = {
      topology: 'triangle-list',
      cullMode: options.cullMode ?? 'back',
      frontFace: 'ccw',
    }

    const pipeline = device.createRenderPipeline({
      label: options.label,
      layout,
      vertex,
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [blended ? { format: SCENE_FORMAT, blend: PREMULTIPLIED } : { format: SCENE_FORMAT }],
      },
      primitive,
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: options.depthWrite ?? !blended,
        depthCompare: options.depthCompare ?? SCENE_DEPTH_COMPARE,
      },
      multisample: { count: SAMPLE_COUNT },
    })

    const shadowPipeline = options.castsShadow
      ? device.createRenderPipeline({
          label: `${options.label}-shadow`,
          layout,
          vertex,
          primitive,
          depthStencil: {
            format: SHADOW_FORMAT,
            depthWriteEnabled: true,
            depthCompare: 'less',
            // Slope-scaled, so the planet's grazing slopes near the terminator
            // get more than its flat ground.
            depthBias: 2,
            depthBiasSlopeScale: 2.5,
          },
        })
      : null

    return { label: options.label, pipeline, shadowPipeline, materialLayout, drawLayout }
  }

  return {
    device,
    frameLayout,
    defines,
    module,
    material,
    compute(label, code, entryPoint, groups) {
      const layouts = groups.map((entries, i) =>
        device.createBindGroupLayout({ label: `${label}-${i}`, entries }),
      )
      const pipeline = device.createComputePipeline({
        label: `${label}-${entryPoint}`,
        layout: device.createPipelineLayout({ label, bindGroupLayouts: layouts }),
        compute: { module: module(label, code), entryPoint },
      })
      return { pipeline, layouts }
    },
    async diagnostics() {
      return Promise.all(
        [...modules.values()].map(async (shader) => {
          const info = await shader.getCompilationInfo()
          return {
            label: shader.label,
            messages: info.messages.map((m) => ({ type: m.type, message: m.message, line: m.lineNum })),
          }
        }),
      )
    },
  }
}

/**
 * A static mesh drawn once per instance from a buffer the core fills: the
 * shape followers, huts and trees all have. Sized once for the core's
 * ceiling, so a growing tribe never reallocates mid-match.
 */
export type InstancedMesh = {
  readonly material: Material
  readonly vertexBuffers: GPUVertexBufferLayout[]
  readonly vertexCount: number
  /** Writes `count` instances from `data` (floats), starting at instance `at`. */
  write: (data: Float32Array, count: number, at?: number) => void
  /** Draws `count` instances from `first` with `material` (default: its own). */
  draw: (pass: GPURenderPassEncoder, count: number, options?: { first?: number; material?: Material; shadow?: boolean }) => void
}

export function createInstancedMesh(
  factory: PipelineFactory,
  options: {
    label: string
    code: string
    mesh: { vertexData: Float32Array; vertexCount: number }
    /** Bytes per mesh vertex; its attributes start at location 0. */
    vertexStride: number
    vertexAttributes: GPUVertexAttribute[]
    /** Bytes per instance; its attributes follow the vertex's locations. */
    instanceStride: number
    instanceAttributes: GPUVertexAttribute[]
    maxInstances: number
  },
): InstancedMesh {
  const { device } = factory
  const vertexBuffers: GPUVertexBufferLayout[] = [
    { arrayStride: options.vertexStride, attributes: options.vertexAttributes },
    { arrayStride: options.instanceStride, stepMode: 'instance', attributes: options.instanceAttributes },
  ]
  const material = factory.material({
    label: options.label,
    code: options.code,
    vertexBuffers,
    castsShadow: true,
  })
  const vertexBuffer = device.createBuffer({
    label: `${options.label}-vertices`,
    size: options.mesh.vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(vertexBuffer, 0, options.mesh.vertexData)
  const instanceBuffer = device.createBuffer({
    label: `${options.label}-instances`,
    size: options.maxInstances * options.instanceStride,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  const floatsPerInstance = options.instanceStride / 4

  return {
    material,
    vertexBuffers,
    vertexCount: options.mesh.vertexCount,
    write(data, count, at = 0) {
      const n = Math.min(count, options.maxInstances - at)
      if (n > 0) {
        device.queue.writeBuffer(instanceBuffer, at * options.instanceStride, data, 0, n * floatsPerInstance)
      }
    },
    draw(pass, count, { first = 0, material: drawn = material, shadow = false } = {}) {
      const pipeline = shadow ? drawn.shadowPipeline : drawn.pipeline
      if (count <= 0 || !pipeline) {
        return
      }
      pass.setPipeline(pipeline)
      pass.setVertexBuffer(0, vertexBuffer)
      pass.setVertexBuffer(1, instanceBuffer)
      pass.draw(options.mesh.vertexCount, count, 0, first)
    },
  }
}
