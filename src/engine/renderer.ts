import type { Game } from '../game/game'
import {
  FOLLOWER_HEIGHT_FRACTION,
  FOLLOWER_PREVIOUS_OFFSET,
  FOLLOWER_RADIUS_FRACTION,
} from '../game/followers'
import { HUT_HEIGHT_RATIO } from '../game/huts'
import { MAX_TREES } from '../game/trees'
import { HutSite } from '../sim/hutSite'
import { SpellResult } from '../sim/spell'
import { CANVAS_ASPECT, drawingBufferSize, effectivePixelRatio } from '../viewport'
import { createGpuTimer, type GpuTimings } from './gpuTimer'
import {
  createInstancedMesh,
  createPipelineFactory,
  DEPTH_FORMAT,
  FRAME,
  FRAME_BYTES,
  FRAME_FLOATS,
  SAMPLE_COUNT,
  SCENE_DEPTH_CLEAR,
  SCENE_FORMAT,
  SHADOW_FORMAT,
  type ShaderDiagnostic,
} from './materials'
import {
  mat4LookAt,
  mat4Multiply,
  mat4Orthographic,
  mat4PerspectiveReversedZ,
  type Mat4,
  type Vec3,
} from './math'
import { consumeDirtyRange, VERTEX_BYTES, VERTEX_FLOATS } from './mesh/cubeSphere'
import { createFollowerMesh, FOLLOWER_VERTEX_BYTES, type FollowerMesh } from './mesh/followerMesh'
import { createHutMesh, HUT_VERTEX_BYTES } from './mesh/hutMesh'
import { createTreeMesh, TREE_VERTEX_BYTES } from './mesh/treeMesh'
import { burstsForLanding, createParticles, STEP_FLOATS } from './particles'
import atmosphereShader from './shaders/atmosphere.wgsl'
import compositeShader from './shaders/composite.wgsl'
import followerShader from './shaders/follower.wgsl'
import hutShader from './shaders/hut.wgsl'
import planetShader from './shaders/planet.wgsl'
import treeShader from './shaders/tree.wgsl'
import waterShader from './shaders/water.wgsl'
import { createTerrainNormals } from './terrainNormals'
import { type DeviceLoss, type GpuFeatures, initWebGpu } from './webgpu'

/**
 * Near plane is close enough for the tightest zoom, far plane loose enough for
 * the widest. With reversed Z into a float depth buffer the ratio between them
 * hardly matters for precision any more.
 */
const NEAR_PLANE = 0.05
const FAR_PLANE = 100

/** Mirrors kMaxFollowers in cpp/include/1inkulous/followers.hpp. */
const MAX_FOLLOWER_INSTANCES = 1024

/** Mirrors kMaxHuts in cpp/include/1inkulous/huts.hpp; one more slot holds the build ghost. */
const MAX_HUT_INSTANCES = 256

/** Mirrors kMaxTrees in cpp/include/1inkulous/trees.hpp. */
const MAX_TREE_INSTANCES = MAX_TREES

/** One cascade over the whole planet: at 2048 a follower is ~20 texels tall. */
const SHADOW_SIZE = 2048
/** How much of the sun a shadow takes away; the sky still lights the rest. */
const SHADOW_STRENGTH = 0.85
/** The air's outer edge, in planet radii. */
const AIR_RADIUS = 1.12
/**
 * The sea's surface above the sea bed, in max land heights. Generated land
 * starts above it (kShore in cpp/src/worldgen.cpp), so dry ground is never
 * drawn under water.
 */
const WATER_LIFT = 0.04
/** Noon sunlight. The same warm white the shaders used before the sun moved. */
const SUN_COLOR: Vec3 = [1.0, 0.97, 0.9]

/** The passes the GPU timer reports, in frame order. */
const TIMED_PASSES = ['compute', 'shadow', 'scene', 'post'] as const

/**
 * The colour to clear the linear scene to so that, after the exposure curve,
 * the background is `display`: the inverse of 1 - exp(-1.35 x).
 */
export function linearClear(display: readonly [number, number, number]): [number, number, number] {
  const inverse = (c: number) => -Math.log(1 - Math.min(Math.max(c, 0), 0.999)) / 1.35
  return [inverse(display[0]), inverse(display[1]), inverse(display[2])]
}

/**
 * The sun's view of the planet for the shadow map: an orthographic box that
 * just holds the planet and its highest peaks, looking along the sunlight.
 * Ordinary Z (near 0, far 1).
 */
export function sunShadowMatrix(
  sun: Vec3,
  radius: number,
  maxHeight: number,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const extent = (radius + maxHeight) * 1.05
  const distance = radius * 4
  const eye: Vec3 = [sun[0] * distance, sun[1] * distance, sun[2] * distance]
  const up: Vec3 = Math.abs(sun[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0]
  const view = mat4LookAt(eye, [0, 0, 0], up)
  const projection = mat4Orthographic(extent, extent, distance - extent * 1.2, distance + extent * 1.2)
  return mat4Multiply(projection, view, out)
}

export type RendererOptions = {
  /** Optional device features to leave off even where the adapter has them. */
  withholdFeatures?: readonly string[]
  /**
   * Draws the final frame into a texture of its own instead of the canvas, so
   * `capture` can read it back. For the headless check, where presenting to a
   * canvas is not always possible.
   */
  offscreen?: boolean
  /** Rebuilds sculpted normals on the GPU (the default) or leaves them to the CPU. */
  gpuNormals?: boolean
  /**
   * The follower to draw, in place of the procedural pawn — a loaded glTF made
   * into a mesh (src/assets/followerModel.ts). The renderer neither knows nor
   * cares where it came from; the simulation never does.
   */
  followerMesh?: FollowerMesh
}

export type Renderer = {
  statusMessage: string
  features: GpuFeatures
  render: (game: Game) => void
  /**
   * Settles once, when the GPU device is lost. After that every call to
   * `render` is wasted work, so the caller should stop its frame loop.
   */
  lost: Promise<DeviceLoss>
  /** GPU time per pass since the last call, or null without timestamp-query. */
  takeGpuTimings: () => GpuTimings | null
  readonly gpuTimingSupported: boolean
  /** Every shader's compilation messages. */
  diagnostics: () => Promise<ShaderDiagnostic[]>
  /** The last frame as RGBA8 rows, top first. Offscreen renderers only. */
  capture: () => Promise<{ width: number; height: number; pixels: Uint8Array }>
  /** The planet's vertex buffer as the GPU has it, for checking GPU normals. */
  readPlanetVertices: () => Promise<Float32Array>
}

export async function createRenderer(
  canvas: HTMLCanvasElement,
  game: Game,
  options: RendererOptions = {},
): Promise<Renderer> {
  // What the frame asks of the device, worked out from the buffers it will
  // make: the planet mesh and the instance buffers are sized for the core's
  // ceilings; the largest uniform block is the particle step's.
  const hutInstanceStride = game.huts.instanceFloats * 4
  const treeInstanceStride = game.trees.instanceFloats * 4
  const followerInstanceStride = game.followers.instanceFloats * 4
  const { device, context, format, features, lost } = await initWebGpu(
    canvas,
    {
      maxBufferSize: Math.max(
        game.planet.mesh.vertexData.byteLength,
        game.planet.mesh.indices.byteLength,
        MAX_FOLLOWER_INSTANCES * followerInstanceStride,
        (MAX_HUT_INSTANCES + 1) * hutInstanceStride,
        MAX_TREE_INSTANCES * treeInstanceStride,
      ),
      maxUniformBufferBindingSize: Math.max(FRAME_BYTES, STEP_FLOATS * 4),
    },
    options.withholdFeatures ? { withhold: options.withholdFeatures } : {},
  )
  const outputFormat: GPUTextureFormat = options.offscreen ? 'rgba8unorm' : format

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

  const factory = createPipelineFactory(device, { SHADER_F16: features.shaderF16 })
  const timer = createGpuTimer(device, features.timestampQuery, TIMED_PASSES)

  // --- the planet, and the two shells drawn from its buffers ----------------

  const { planet } = game
  const mesh = planet.mesh
  const gpuNormals = options.gpuNormals ?? true
  mesh.normalsOnGpu = gpuNormals
  const planetVertices = device.createBuffer({
    label: 'planet-vertices',
    size: mesh.vertexData.byteLength,
    usage:
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const planetIndices = device.createBuffer({
    label: 'planet-indices',
    size: mesh.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
  })
  device.queue.writeBuffer(planetIndices, 0, mesh.indices)
  const normals = gpuNormals
    ? createTerrainNormals(factory, mesh, { vertices: planetVertices, indices: planetIndices })
    : null

  const planetLayout: GPUVertexBufferLayout[] = [
    {
      arrayStride: VERTEX_BYTES,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' },
      ],
    },
  ]
  const planetMaterial = factory.material({
    label: 'planet',
    code: planetShader,
    vertexBuffers: planetLayout,
    castsShadow: true,
  })
  const waterMaterial = factory.material({
    label: 'water',
    code: waterShader,
    vertexBuffers: planetLayout,
    blend: 'premultiplied',
  })
  // Inside out, and over everything: see atmosphere.wgsl.
  const airMaterial = factory.material({
    label: 'atmosphere',
    code: atmosphereShader,
    vertexBuffers: planetLayout,
    blend: 'premultiplied',
    cullMode: 'front',
    depthCompare: 'always',
  })
  const drawPlanetMesh = (pass: GPURenderPassEncoder, pipeline: GPURenderPipeline) => {
    pass.setPipeline(pipeline)
    pass.setVertexBuffer(0, planetVertices)
    pass.setIndexBuffer(planetIndices, 'uint32')
    pass.drawIndexed(mesh.indices.length)
  }

  // --- the instanced meshes --------------------------------------------------

  const meshAttributes: GPUVertexAttribute[] = [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32' },
  ]

  const followerMesh =
    options.followerMesh ??
    createFollowerMesh({
      height: planet.radius * FOLLOWER_HEIGHT_FRACTION,
      radius: planet.radius * FOLLOWER_RADIUS_FRACTION,
    })
  const followers = createInstancedMesh(factory, {
    label: 'followers',
    code: followerShader,
    mesh: followerMesh,
    vertexStride: FOLLOWER_VERTEX_BYTES,
    vertexAttributes: meshAttributes,
    // Straight from the core's instance buffer: position(3), heading(3),
    // tribe, flags, then the position(3) and heading(3) the last step began
    // from, which the shader draws between.
    instanceStride: followerInstanceStride,
    instanceAttributes: [
      { shaderLocation: 3, offset: 0, format: 'float32x3' },
      { shaderLocation: 4, offset: 12, format: 'float32x3' },
      { shaderLocation: 5, offset: 24, format: 'float32' },
      { shaderLocation: 6, offset: 28, format: 'float32' },
      { shaderLocation: 7, offset: FOLLOWER_PREVIOUS_OFFSET * 4, format: 'float32x3' },
      { shaderLocation: 8, offset: FOLLOWER_PREVIOUS_OFFSET * 4 + 12, format: 'float32x3' },
    ],
    maxInstances: MAX_FOLLOWER_INSTANCES,
  })

  const hutMesh = createHutMesh({
    radius: game.huts.radius,
    height: game.huts.radius * HUT_HEIGHT_RATIO,
  })
  const huts = createInstancedMesh(factory, {
    label: 'huts',
    code: hutShader,
    mesh: hutMesh,
    vertexStride: HUT_VERTEX_BYTES,
    vertexAttributes: meshAttributes,
    // Straight from the core's hut buffer: position(3), heading(3), tribe,
    // occupants, kind.
    instanceStride: hutInstanceStride,
    instanceAttributes: [
      { shaderLocation: 3, offset: 0, format: 'float32x3' },
      { shaderLocation: 4, offset: 12, format: 'float32x3' },
      { shaderLocation: 5, offset: 24, format: 'float32' },
      { shaderLocation: 6, offset: 28, format: 'float32' },
      { shaderLocation: 7, offset: 32, format: 'float32' },
    ],
    maxInstances: MAX_HUT_INSTANCES + 1,
  })
  // The ghost is see-through, so it is blended and leaves depth alone: the
  // ground and anyone standing on the site still show through it.
  const ghostMaterial = factory.material({
    label: 'hut-ghost',
    code: hutShader,
    vertexBuffers: huts.vertexBuffers,
    blend: 'premultiplied',
  })

  const treeMesh = createTreeMesh({ height: game.trees.height, radius: game.trees.radius })
  const trees = createInstancedMesh(factory, {
    label: 'trees',
    code: treeShader,
    mesh: treeMesh,
    vertexStride: TREE_VERTEX_BYTES,
    vertexAttributes: meshAttributes,
    // Straight from the core's tree buffer: position(3), heading(3), size,
    // chop progress. Sized once for the core's ceiling; the forest only shrinks.
    instanceStride: treeInstanceStride,
    instanceAttributes: [
      { shaderLocation: 3, offset: 0, format: 'float32x3' },
      { shaderLocation: 4, offset: 12, format: 'float32x3' },
      { shaderLocation: 5, offset: 24, format: 'float32' },
      { shaderLocation: 6, offset: 28, format: 'float32' },
    ],
    maxInstances: MAX_TREE_INSTANCES,
  })

  const particles = createParticles(factory, { f16: features.shaderF16, planetRadius: planet.radius })

  // --- the frame's bind groups -------------------------------------------------

  const frameData = new Float32Array(FRAME_FLOATS)
  const frameBuffer = device.createBuffer({
    label: 'frame',
    size: FRAME_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // The shadow pass's copy: the same block with the sun's viewProj.
  const shadowFrameBuffer = device.createBuffer({
    label: 'frame-shadow',
    size: FRAME_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const shadowMap = device.createTexture({
    label: 'shadow-map',
    size: { width: SHADOW_SIZE, height: SHADOW_SIZE },
    format: SHADOW_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })
  const shadowView = shadowMap.createView()
  // What the shadow pass binds where the shadow map goes: a texture cannot be
  // drawn into and read in the same pass.
  const shadowStandIn = device.createTexture({
    label: 'shadow-map-stand-in',
    size: { width: 1, height: 1 },
    format: SHADOW_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING,
  })
  const shadowSampler = device.createSampler({
    label: 'shadow',
    compare: 'less-equal',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  })
  const frameGroup = (buffer: GPUBuffer, shadow: GPUTextureView) =>
    device.createBindGroup({
      layout: factory.frameLayout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: shadow },
        { binding: 2, resource: shadowSampler },
      ],
    })
  const sceneFrameGroup = frameGroup(frameBuffer, shadowView)
  const shadowFrameGroup = frameGroup(shadowFrameBuffer, shadowStandIn.createView())

  // --- the composite: linear scene to the screen ---------------------------

  const compositeModule = factory.module('composite', compositeShader)
  const compositeLayout = device.createBindGroupLayout({
    label: 'composite',
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }],
  })
  const compositePipeline = device.createRenderPipeline({
    label: 'composite',
    layout: device.createPipelineLayout({ bindGroupLayouts: [compositeLayout] }),
    vertex: { module: compositeModule, entryPoint: 'vs_main' },
    fragment: { module: compositeModule, entryPoint: 'fs_main', targets: [{ format: outputFormat }] },
    primitive: { topology: 'triangle-list' },
  })

  // The scene is drawn into multisampled float colour and depth, resolved to
  // a single-sample float texture the composite reads. The multisampled
  // targets are not read after the pass, so neither is kept: `discard` saves
  // writing them back out.
  type Targets = {
    width: number
    height: number
    textures: GPUTexture[]
    colorView: GPUTextureView
    depthView: GPUTextureView
    resolveView: GPUTextureView
    composite: GPUBindGroup
    output: GPUTexture | null
  }
  let targets: Targets | null = null
  const ensureTargets = (): Targets => {
    const { width, height } = canvas
    if (targets && targets.width === width && targets.height === height) {
      return targets
    }
    for (const texture of targets?.textures ?? []) {
      texture.destroy()
    }
    const size = { width, height }
    const color = device.createTexture({
      label: 'scene-msaa',
      size,
      format: SCENE_FORMAT,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const depth = device.createTexture({
      label: 'depth-msaa',
      size,
      format: DEPTH_FORMAT,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const resolve = device.createTexture({
      label: 'scene-resolved',
      size,
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    const output = options.offscreen
      ? device.createTexture({
          label: 'offscreen-output',
          size,
          format: outputFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        })
      : null
    const resolveView = resolve.createView()
    targets = {
      width,
      height,
      textures: [color, depth, resolve, ...(output ? [output] : [])],
      colorView: color.createView(),
      depthView: depth.createView(),
      resolveView,
      composite: device.createBindGroup({
        layout: compositeLayout,
        entries: [{ binding: 0, resource: resolveView }],
      }),
      output,
    }
    return targets
  }

  const projection = new Float32Array(16)
  const lightViewProj = new Float32Array(16)
  const startedAt = performance.now()
  let lastFrameAt = startedAt

  const timed = (name: (typeof TIMED_PASSES)[number]) => {
    const writes = timer.passWrites(name)
    return writes ? { timestampWrites: writes } : {}
  }

  const featureList = [
    features.timestampQuery && 'GPU timing',
    features.shaderF16 && 'f16 particles',
    features.float32Filterable && 'float32-filterable',
  ].filter(Boolean)

  return {
    statusMessage:
      `WebGPU ready — cube-sphere planet (${mesh.triangleCount} triangles) with sea, air and ` +
      `${SHADOW_SIZE}² sun shadows, followers instanced (${followerMesh.triangleCount} triangles each), ` +
      `huts instanced (${hutMesh.triangleCount} each), ` +
      `trees instanced (${treeMesh.triangleCount} each) — ` +
      `${canvas.width}×${canvas.height} at ${effectivePixelRatio(window.devicePixelRatio)}×, ` +
      `${SAMPLE_COUNT}× MSAA, reversed-Z ${DEPTH_FORMAT}` +
      (featureList.length > 0 ? `, ${featureList.join(', ')}` : ', no optional features'),
    features,
    lost,
    gpuTimingSupported: timer.supported,
    takeGpuTimings: () => timer.take(),
    diagnostics: () => factory.diagnostics(),

    render(currentGame: Game) {
      sizeDrawingBuffer()
      const now = performance.now()
      const dt = Math.min((now - lastFrameAt) / 1000, 0.1)
      lastFrameAt = now
      const { camera, sun, sculptor, huts: hutState, shaman } = currentGame

      // Terrain edits touch a small patch, so upload only the vertex range that
      // actually changed since the last frame.
      const dirty = consumeDirtyRange(mesh)
      if (dirty) {
        device.queue.writeBuffer(
          planetVertices,
          dirty.min * VERTEX_BYTES,
          mesh.vertexData,
          dirty.min * VERTEX_FLOATS,
          (dirty.max - dirty.min + 1) * VERTEX_FLOATS,
        )
      }

      // --- the frame block ---

      // The CSS viewport's aspect ratio, the same one picking is given. The
      // drawing buffer rounds to whole pixels, so its own ratio can differ in
      // the fourth decimal place; sharing one value keeps a click on the pixel
      // it was drawn at.
      mat4PerspectiveReversedZ(camera.fovY, CANVAS_ASPECT, NEAR_PLANE, FAR_PLANE, projection)
      mat4Multiply(projection, camera.viewMatrix, frameData.subarray(FRAME.viewProj, FRAME.viewProj + 16))
      const light = sun.direction
      sunShadowMatrix(light, planet.radius, planet.maxHeight, lightViewProj)
      frameData.set(lightViewProj, FRAME.lightViewProj)

      // The brush cursor while sculpting; otherwise, while a spell is aimed,
      // the disc it would write (a bridge's far end, at the strip's width),
      // green where the core would cast it; otherwise, while she casts, that
      // disc pulsing where it will land; otherwise, in build mode, the hut's
      // footprint and whether it can go there.
      const aim = sculptor.armed ? null : shaman.preview
      const cast = sculptor.armed || aim ? null : shaman.casting
      const ghost = hutState.ghost
      const hover = sculptor.armed
        ? sculptor.hoverDirection
        : aim
          ? aim.to
          : cast
            ? cast.target
            : (ghost?.direction ?? null)
      // The hut disc reaches the furthest footprint node: the patch the core
      // will block, and the patch that has to be level.
      const cursorRadius = sculptor.armed
        ? sculptor.brushRadius
        : aim
          ? shaman.radiusOf(aim.spell)
          : cast
            ? cast.radius
            : (ghost?.footprint ?? 0) || hutState.radius / planet.radius

      const eye = camera.eye
      // How far through the cast she is, for the pulse; 0 is a steady disc.
      frameData.set([light[0], light[1], light[2], cast ? Math.max(cast.progress, 1e-3) : 0], FRAME.sunDir)
      // How far between their two poses the followers are drawn this frame.
      frameData.set([eye[0], eye[1], eye[2], currentGame.followers.stepAlpha], FRAME.cameraPos)
      const brushMode =
        sculptor.mode === 'raise' ? 1 : sculptor.mode === 'lower' ? -1 : sculptor.mode === 'flatten' ? 2 : 0
      const site = aim
        ? aim.result === SpellResult.ok
          ? 1
          : -1
        : cast
          ? 2
          : !sculptor.armed && ghost
            ? ghost.site === HutSite.ok
              ? 1
              : -1
            : 0
      frameData.set([planet.radius, planet.maxHeight, brushMode, site], FRAME.params)
      // A zero radius switches the cursor off in the shader.
      frameData.set(hover ? [hover[0], hover[1], hover[2], cursorRadius] : [0, 0, 0, 0], FRAME.brush)
      // Seconds, wrapped every hour so f32 keeps sub-millisecond steps.
      const seconds = ((now - startedAt) / 1000) % 3600
      frameData.set([SUN_COLOR[0], SUN_COLOR[1], SUN_COLOR[2], seconds], FRAME.sunColor)
      frameData.set(
        [
          planet.radius * AIR_RADIUS,
          SHADOW_STRENGTH,
          1 / SHADOW_SIZE,
          planet.radius + planet.maxHeight * WATER_LIFT,
        ],
        FRAME.world,
      )
      device.queue.writeBuffer(frameBuffer, 0, frameData)
      frameData.set(lightViewProj, FRAME.viewProj)
      device.queue.writeBuffer(shadowFrameBuffer, 0, frameData)

      // --- instances, straight out of the core ---

      // One copy each per frame out of WASM linear memory. The views are
      // re-read each time: the core's buffers move when they grow, and growing
      // linear memory replaces the typed-array views over it.
      const followerData = currentGame.followers.instances()
      const followerCount = Math.min(
        followerData.length / currentGame.followers.instanceFloats,
        MAX_FOLLOWER_INSTANCES,
      )
      followers.write(followerData, followerCount)
      const hutData = hutState.instances()
      const hutCount = Math.min(hutData.length / hutState.instanceFloats, MAX_HUT_INSTANCES)
      huts.write(hutData, hutCount)
      const ghostInstance = hutState.ghostInstance()
      if (ghostInstance) {
        huts.write(ghostInstance, 1, hutCount)
      }
      const treeData = currentGame.trees.instances()
      const treeCount = Math.min(treeData.length / currentGame.trees.instanceFloats, MAX_TREE_INSTANCES)
      trees.write(treeData, treeCount)

      for (const landing of currentGame.takeSpellLandings()) {
        particles.emit(burstsForLanding(landing, planet.surfacePointAt(landing.target), planet.radius))
      }

      // --- passes ---

      timer.beginFrame()
      const encoder = device.createCommandEncoder({ label: 'frame' })

      const normalsDirty = normals !== null && dirty !== null
      if (normalsDirty || particles.active) {
        const compute = encoder.beginComputePass({ label: 'compute', ...timed('compute') })
        if (normals && dirty) {
          normals.dispatch(compute, dirty)
        }
        if (particles.active) {
          particles.step(compute, dt)
        }
        compute.end()
      }

      const shadowPass = encoder.beginRenderPass({
        label: 'shadow',
        colorAttachments: [],
        depthStencilAttachment: {
          view: shadowView,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
        ...timed('shadow'),
      })
      shadowPass.setBindGroup(0, shadowFrameGroup)
      drawPlanetMesh(shadowPass, planetMaterial.shadowPipeline!)
      followers.draw(shadowPass, followerCount, { shadow: true })
      trees.draw(shadowPass, treeCount, { shadow: true })
      huts.draw(shadowPass, hutCount, { shadow: true })
      shadowPass.end()

      const frameTargets = ensureTargets()
      const clear = linearClear(currentGame.clearColor)
      const scene = encoder.beginRenderPass({
        label: 'scene',
        colorAttachments: [
          {
            view: frameTargets.colorView,
            resolveTarget: frameTargets.resolveView,
            clearValue: { r: clear[0], g: clear[1], b: clear[2], a: 1 },
            loadOp: 'clear',
            storeOp: 'discard',
          },
        ],
        depthStencilAttachment: {
          view: frameTargets.depthView,
          depthClearValue: SCENE_DEPTH_CLEAR,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
        },
        ...timed('scene'),
      })
      scene.setBindGroup(0, sceneFrameGroup)
      // Opaque first, then everything that blends over it, back to front.
      drawPlanetMesh(scene, planetMaterial.pipeline)
      followers.draw(scene, followerCount)
      trees.draw(scene, treeCount)
      huts.draw(scene, hutCount)
      drawPlanetMesh(scene, waterMaterial.pipeline)
      drawPlanetMesh(scene, airMaterial.pipeline)
      if (ghostInstance) {
        huts.draw(scene, 1, { first: hutCount, material: ghostMaterial })
      }
      if (particles.active) {
        particles.draw(scene)
      }
      scene.end()

      const post = encoder.beginRenderPass({
        label: 'post',
        colorAttachments: [
          {
            view: (frameTargets.output ?? context.getCurrentTexture()).createView(),
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            storeOp: 'store',
          },
        ],
        ...timed('post'),
      })
      post.setPipeline(compositePipeline)
      post.setBindGroup(0, frameTargets.composite)
      post.draw(3)
      post.end()

      timer.resolve(encoder)
      device.queue.submit([encoder.finish()])
      timer.afterSubmit()
    },

    async capture() {
      const output = targets?.output
      if (!output) {
        throw new Error('capture() needs an offscreen renderer that has drawn a frame')
      }
      const { width, height } = output
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256
      const buffer = device.createBuffer({
        label: 'capture',
        size: bytesPerRow * height,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
      const encoder = device.createCommandEncoder()
      encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow }, { width, height })
      device.queue.submit([encoder.finish()])
      await buffer.mapAsync(GPUMapMode.READ)
      const mapped = new Uint8Array(buffer.getMappedRange())
      const pixels = new Uint8Array(width * height * 4)
      for (let y = 0; y < height; y += 1) {
        pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4)
      }
      buffer.unmap()
      buffer.destroy()
      return { width, height, pixels }
    },

    async readPlanetVertices() {
      const buffer = device.createBuffer({
        label: 'planet-readback',
        size: mesh.vertexData.byteLength,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
      const encoder = device.createCommandEncoder()
      encoder.copyBufferToBuffer(planetVertices, 0, buffer, 0, mesh.vertexData.byteLength)
      device.queue.submit([encoder.finish()])
      await buffer.mapAsync(GPUMapMode.READ)
      const data = new Float32Array(buffer.getMappedRange().slice(0))
      buffer.unmap()
      buffer.destroy()
      return data
    },
  }
}
