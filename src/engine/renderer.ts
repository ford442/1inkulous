import type { Game } from '../game/game'
import {
  FOLLOWER_HEIGHT_FRACTION,
  FOLLOWER_RADIUS_FRACTION,
} from '../game/followers'
import type { PlanetMesh } from './mesh/cubeSphere'
import { consumeDirtyRange, VERTEX_BYTES, VERTEX_FLOATS } from './mesh/cubeSphere'
import { createFollowerMesh, FOLLOWER_VERTEX_BYTES } from './mesh/followerMesh'
import { createHutMesh, HUT_VERTEX_BYTES } from './mesh/hutMesh'
import { HUT_HEIGHT_RATIO } from '../game/huts'
import { HutSite } from '../sim/hutSite'
import { LandBridge } from '../sim/landBridge'
import {
  mat4Identity,
  mat4Multiply,
  mat4Perspective,
  normalize,
  type Vec3,
} from './math'
import followerShader from './shaders/follower.wgsl?raw'
import hutShader from './shaders/hut.wgsl?raw'
import planetShader from './shaders/planet.wgsl?raw'
import { type DeviceLoss, initWebGpu } from './webgpu'
import { CANVAS_ASPECT, drawingBufferSize, effectivePixelRatio } from '../viewport'

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus'

/**
 * 4x is the one multisample count WebGPU guarantees for every renderable
 * format, so there is nothing to probe for. The planet's limb and the instanced
 * pawns are what shimmer as the camera orbits; the shading inside them does not
 * need it.
 */
const SAMPLE_COUNT = 4

/**
 * Near plane is close enough for the tightest zoom, far plane loose enough for
 * the widest, while keeping the depth range tight for precision.
 */
const NEAR_PLANE = 0.05
const FAR_PLANE = 100

/** viewProj(64) + model(64) + lightDir(16) + cameraPos(16) + params(16) + brush(16) */
const UNIFORM_BYTES = 192

/** Mirrors kMaxFollowers in cpp/include/1inkulous/followers.hpp. */
const MAX_FOLLOWER_INSTANCES = 1024

/** Mirrors kMaxHuts in cpp/include/1inkulous/huts.hpp; one more slot holds the build ghost. */
const MAX_HUT_INSTANCES = 256


/**
 * The sun follows the camera as a three-quarter key light (up and to the right of
 * the viewer) rather than sitting fixed in world space. A fixed sun would leave
 * the half of the planet the player orbits round to in unplayable darkness.
 */
function sunDirection(eye: Vec3): Vec3 {
  const forward = normalize([-eye[0], -eye[1], -eye[2]])
  // Camera right, from the world up axis. Falls back near the poles, where the
  // orbit pitch is clamped short of straight down anyway.
  const right = normalize([forward[2], 0, -forward[0]])
  const up: Vec3 = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ]

  // Negated forward, so the light points from the viewer towards the planet.
  return normalize([
    -forward[0] * 0.6 + right[0] * 0.55 + up[0] * 0.5,
    -forward[1] * 0.6 + right[1] * 0.55 + up[1] * 0.5,
    -forward[2] * 0.6 + right[2] * 0.55 + up[2] * 0.5,
  ])
}

export type Renderer = {
  statusMessage: string
  render: (game: Game) => void
  /**
   * Settles once, when the GPU device is lost. After that every call to
   * `render` is wasted work, so the caller should stop its frame loop.
   */
  lost: Promise<DeviceLoss>
}

type PlanetBuffers = {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  indexCount: number
}

function createPlanetBuffers(device: GPUDevice, mesh: PlanetMesh): PlanetBuffers {
  const vertexBuffer = device.createBuffer({
    label: 'planet-vertices',
    size: mesh.vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })

  const indexBuffer = device.createBuffer({
    label: 'planet-indices',
    size: mesh.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  })

  device.queue.writeBuffer(indexBuffer, 0, mesh.indices)

  return {
    vertexBuffer,
    indexBuffer,
    indexCount: mesh.indices.length,
  }
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  game: Game,
): Promise<Renderer> {
  // What the frame asks of the device, worked out from the buffers it will
  // make: the planet mesh and the two instance buffers are sized for the cores'
  // ceilings, and one uniform block is shared by every pipeline.
  const hutInstanceStride = game.huts.instanceFloats * 4
  const { device, context, format, lost } = await initWebGpu(canvas, {
    maxBufferSize: Math.max(
      game.planet.mesh.vertexData.byteLength,
      game.planet.mesh.indices.byteLength,
      MAX_FOLLOWER_INSTANCES * game.followers.instanceFloats * 4,
      (MAX_HUT_INSTANCES + 1) * hutInstanceStride,
    ),
    maxUniformBufferBindingSize: UNIFORM_BYTES,
  })

  // The drawing buffer is in device pixels; everything else is in CSS pixels.
  // Checked every frame rather than on a resize event: dragging the window to a
  // second monitor or zooming the page changes devicePixelRatio without
  // resizing the canvas's CSS box, and comparing two integers costs nothing.
  const sizeDrawingBuffer = () => {
    const { width, height } = drawingBufferSize(window.devicePixelRatio)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
  }
  sizeDrawingBuffer()

  const shaderModule = device.createShaderModule({
    label: 'planet-shader',
    code: planetShader,
  })

  const pipeline = device.createRenderPipeline({
    label: 'planet-pipeline',
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: VERTEX_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: {
      topology: 'triangle-list',
      cullMode: 'back',
      frontFace: 'ccw',
    },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
    multisample: { count: SAMPLE_COUNT },
  })

  const uniformBuffer = device.createBuffer({
    label: 'planet-uniforms',
    size: UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })

  const planetBuffers = createPlanetBuffers(device, game.planet.mesh)

  const followerShaderModule = device.createShaderModule({
    label: 'follower-shader',
    code: followerShader,
  })

  const followerPipeline = device.createRenderPipeline({
    label: 'follower-pipeline',
    layout: 'auto',
    vertex: {
      module: followerShaderModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: FOLLOWER_VERTEX_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32' },
          ],
        },
        {
          // Written straight from the core's instance buffer: position(3),
          // heading(3), tribe, flags.
          arrayStride: game.followers.instanceFloats * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 3, offset: 0, format: 'float32x3' },
            { shaderLocation: 4, offset: 12, format: 'float32x3' },
            { shaderLocation: 5, offset: 24, format: 'float32' },
            { shaderLocation: 6, offset: 28, format: 'float32' },
          ],
        },
      ],
    },
    fragment: {
      module: followerShaderModule,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: {
      topology: 'triangle-list',
      cullMode: 'back',
      frontFace: 'ccw',
    },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
    multisample: { count: SAMPLE_COUNT },
  })

  // `layout: 'auto'` gives each pipeline its own bind group layout, so the two
  // passes need two bind groups — over the same uniform buffer.
  const followerBindGroup = device.createBindGroup({
    layout: followerPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })

  const followerMesh = createFollowerMesh({
    height: game.planet.radius * FOLLOWER_HEIGHT_FRACTION,
    radius: game.planet.radius * FOLLOWER_RADIUS_FRACTION,
  })

  const followerVertexBuffer = device.createBuffer({
    label: 'follower-vertices',
    size: followerMesh.vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(followerVertexBuffer, 0, followerMesh.vertexData)

  // Sized once for the core's population ceiling, so growing the tribe never
  // reallocates a GPU buffer mid-match.
  const followerInstanceBuffer = device.createBuffer({
    label: 'follower-instances',
    size: MAX_FOLLOWER_INSTANCES * game.followers.instanceFloats * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })

  const hutShaderModule = device.createShaderModule({
    label: 'hut-shader',
    code: hutShader,
  })

  const hutVertexBuffers: GPUVertexBufferLayout[] = [
    {
      arrayStride: HUT_VERTEX_BYTES,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32' },
      ],
    },
    {
      // Straight from the core's hut buffer: position(3), heading(3), tribe,
      // occupants.
      arrayStride: game.huts.instanceFloats * 4,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 3, offset: 0, format: 'float32x3' },
        { shaderLocation: 4, offset: 12, format: 'float32x3' },
        { shaderLocation: 5, offset: 24, format: 'float32' },
        { shaderLocation: 6, offset: 28, format: 'float32' },
      ],
    },
  ]

  const hutPipeline = device.createRenderPipeline({
    label: 'hut-pipeline',
    layout: 'auto',
    vertex: { module: hutShaderModule, entryPoint: 'vs_main', buffers: hutVertexBuffers },
    fragment: { module: hutShaderModule, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: SAMPLE_COUNT },
  })

  // The ghost is see-through, so it is blended and leaves depth alone: the
  // ground and anyone standing on the site still show through it.
  const ghostPipeline = device.createRenderPipeline({
    label: 'hut-ghost-pipeline',
    layout: 'auto',
    vertex: { module: hutShaderModule, entryPoint: 'vs_main', buffers: hutVertexBuffers },
    fragment: {
      module: hutShaderModule,
      entryPoint: 'fs_main',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
    multisample: { count: SAMPLE_COUNT },
  })

  const hutBindGroup = device.createBindGroup({
    layout: hutPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })
  const ghostBindGroup = device.createBindGroup({
    layout: ghostPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })

  const hutMesh = createHutMesh({
    radius: game.huts.radius,
    height: game.huts.radius * HUT_HEIGHT_RATIO,
  })
  const hutVertexBuffer = device.createBuffer({
    label: 'hut-vertices',
    size: hutMesh.vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(hutVertexBuffer, 0, hutMesh.vertexData)

  const hutInstanceBytes = hutInstanceStride
  const hutInstanceBuffer = device.createBuffer({
    label: 'hut-instances',
    size: (MAX_HUT_INSTANCES + 1) * hutInstanceBytes,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })

  // The frame is drawn into multisampled colour and depth targets and resolved
  // to the canvas, so both follow the drawing buffer. Neither is read after the
  // pass, so neither is kept: `discard` saves writing them back out.
  type Targets = { colorView: GPUTextureView; depthView: GPUTextureView }
  let colorTexture: GPUTexture | null = null
  let depthTexture: GPUTexture | null = null
  let targets: Targets | null = null
  const ensureTargets = (): Targets => {
    const { width, height } = canvas
    if (targets && colorTexture?.width === width && colorTexture.height === height) {
      return targets
    }

    colorTexture?.destroy()
    depthTexture?.destroy()
    colorTexture = device.createTexture({
      label: 'color-msaa',
      size: { width, height },
      format,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    depthTexture = device.createTexture({
      label: 'depth-msaa',
      size: { width, height },
      format: DEPTH_FORMAT,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    targets = { colorView: colorTexture.createView(), depthView: depthTexture.createView() }
    return targets
  }

  const uniformData = new Float32Array(UNIFORM_BYTES / 4)
  const viewProj = uniformData.subarray(0, 16)
  const projection = new Float32Array(16)
  // The planet does not turn on its own; the model matrix is the hook for
  // spinning or tilting it later.
  mat4Identity(uniformData.subarray(16, 32))

  const triangleCount = game.planet.mesh.triangleCount

  return {
    statusMessage:
      `WebGPU ready — cube-sphere planet (${triangleCount} triangles), ` +
      `followers instanced (${followerMesh.triangleCount} triangles each), ` +
      `huts instanced (${hutMesh.triangleCount} each) — ` +
      `${canvas.width}×${canvas.height} at ${effectivePixelRatio(window.devicePixelRatio)}×, ` +
      `${SAMPLE_COUNT}× MSAA`,
    lost,
    render(currentGame: Game) {
      sizeDrawingBuffer()
      const { camera, planet } = currentGame
      const mesh = planet.mesh

      // Terrain edits touch a small patch, so upload only the vertex range that
      // actually changed since the last frame.
      const dirty = consumeDirtyRange(mesh)
      if (dirty) {
        device.queue.writeBuffer(
          planetBuffers.vertexBuffer,
          dirty.min * VERTEX_BYTES,
          mesh.vertexData,
          dirty.min * VERTEX_FLOATS,
          (dirty.max - dirty.min + 1) * VERTEX_FLOATS,
        )
      }

      // The CSS viewport's aspect ratio, the same one picking is given. The
      // drawing buffer rounds to whole pixels, so its own ratio can differ in
      // the fourth decimal place; sharing one value keeps a click on the pixel
      // it was drawn at.
      const aspect = CANVAS_ASPECT
      const eye = camera.eye

      mat4Perspective(camera.fovY, aspect, NEAR_PLANE, FAR_PLANE, projection)
      mat4Multiply(projection, camera.viewMatrix, viewProj)

      const light = sunDirection(eye)
      uniformData[32] = light[0]
      uniformData[33] = light[1]
      uniformData[34] = light[2]
      uniformData[35] = 0
      uniformData[36] = eye[0]
      uniformData[37] = eye[1]
      uniformData[38] = eye[2]
      uniformData[39] = 0
      const { sculptor, huts, shaman } = currentGame
      // The brush cursor while sculpting; otherwise, in build mode, the same
      // disc marks the hut's footprint and says whether it can go there; and
      // while a Land Bridge is aimed, it marks the far end at the strip's
      // width, green where the core would raise it.
      const bridge = sculptor.armed ? null : shaman.preview
      const ghost = huts.ghost
      const hover = sculptor.armed
        ? sculptor.hoverDirection
        : bridge
          ? bridge.to
          : (ghost?.direction ?? null)
      // The disc reaches the furthest footprint node: the patch the core will
      // block, and the patch that has to be level.
      const cursorRadius = sculptor.armed
        ? sculptor.brushRadius
        : bridge
          ? shaman.stripRadius
          : (ghost?.footprint ?? 0) || huts.radius / planet.radius

      uniformData[40] = planet.radius
      uniformData[41] = planet.maxHeight
      uniformData[42] =
        sculptor.mode === 'raise'
          ? 1
          : sculptor.mode === 'lower'
            ? -1
            : sculptor.mode === 'flatten'
              ? 2
              : 0
      uniformData[43] = bridge
        ? bridge.result === LandBridge.ok
          ? 1
          : -1
        : !sculptor.armed && ghost
          ? ghost.site === HutSite.ok
            ? 1
            : -1
          : 0
      uniformData[44] = hover ? hover[0] : 0
      uniformData[45] = hover ? hover[1] : 0
      uniformData[46] = hover ? hover[2] : 0
      // A zero radius switches the cursor off in the shader.
      uniformData[47] = hover ? cursorRadius : 0

      device.queue.writeBuffer(uniformBuffer, 0, uniformData)

      // One copy per frame out of WASM linear memory. The view is re-read each
      // time: the core's buffer moves when the population grows, and growing
      // linear memory replaces the typed-array views over it.
      const instances = currentGame.followers.instances()
      const followerInstanceCount = Math.min(
        instances.length / currentGame.followers.instanceFloats,
        MAX_FOLLOWER_INSTANCES,
      )
      if (followerInstanceCount > 0) {
        device.queue.writeBuffer(
          followerInstanceBuffer,
          0,
          instances,
          0,
          followerInstanceCount * currentGame.followers.instanceFloats,
        )
      }

      const hutInstances = huts.instances()
      const hutCount = Math.min(hutInstances.length / huts.instanceFloats, MAX_HUT_INSTANCES)
      if (hutCount > 0) {
        device.queue.writeBuffer(
          hutInstanceBuffer,
          0,
          hutInstances,
          0,
          hutCount * huts.instanceFloats,
        )
      }
      const ghostInstance = huts.ghostInstance()
      if (ghostInstance) {
        device.queue.writeBuffer(hutInstanceBuffer, hutCount * hutInstanceBytes, ghostInstance)
      }

      const { colorView, depthView } = ensureTargets()
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: colorView,
            resolveTarget: context.getCurrentTexture().createView(),
            clearValue: {
              r: currentGame.clearColor[0],
              g: currentGame.clearColor[1],
              b: currentGame.clearColor[2],
              a: 1,
            },
            loadOp: 'clear',
            storeOp: 'discard',
          },
        ],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
        },
      })

      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.setVertexBuffer(0, planetBuffers.vertexBuffer)
      pass.setIndexBuffer(planetBuffers.indexBuffer, 'uint32')
      pass.drawIndexed(planetBuffers.indexCount)

      if (followerInstanceCount > 0) {
        pass.setPipeline(followerPipeline)
        pass.setBindGroup(0, followerBindGroup)
        pass.setVertexBuffer(0, followerVertexBuffer)
        pass.setVertexBuffer(1, followerInstanceBuffer)
        pass.draw(followerMesh.vertexCount, followerInstanceCount)
      }

      if (hutCount > 0 || ghostInstance) {
        pass.setVertexBuffer(0, hutVertexBuffer)
        pass.setVertexBuffer(1, hutInstanceBuffer)
        if (hutCount > 0) {
          pass.setPipeline(hutPipeline)
          pass.setBindGroup(0, hutBindGroup)
          pass.draw(hutMesh.vertexCount, hutCount)
        }
        // Last, so it blends over everything opaque, the huts included.
        if (ghostInstance) {
          pass.setPipeline(ghostPipeline)
          pass.setBindGroup(0, ghostBindGroup)
          pass.draw(hutMesh.vertexCount, 1, 0, hutCount)
        }
      }

      pass.end()

      device.queue.submit([encoder.finish()])
    },
  }
}
