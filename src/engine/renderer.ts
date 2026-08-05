import type { Game } from '../game/game'
import type { PlanetMesh } from './mesh/cubeSphere'
import { consumeDirtyRange, VERTEX_BYTES, VERTEX_FLOATS } from './mesh/cubeSphere'
import {
  mat4Identity,
  mat4Multiply,
  mat4Perspective,
  normalize,
  type Vec3,
} from './math'
import { initWebGpu } from './webgpu'

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus'

/**
 * Near plane is close enough for the tightest zoom, far plane loose enough for
 * the widest, while keeping the depth range tight for precision.
 */
const NEAR_PLANE = 0.05
const FAR_PLANE = 100

/** viewProj(64) + model(64) + lightDir(16) + cameraPos(16) + params(16) + brush(16) */
const UNIFORM_BYTES = 192

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

const planetShader = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  model: mat4x4f,
  lightDir: vec4f,
  cameraPos: vec4f,
  // x: planet radius, y: max land height
  params: vec4f,
  // xyz: unit direction under the cursor, w: brush angular radius (0 = hidden)
  brush: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) elevation: f32,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOutput {
  let world = uniforms.model * vec4f(position, 1.0);
  // The model matrix is a pure rotation, so its upper 3x3 also rotates normals.
  let rotation = mat3x3f(
    uniforms.model[0].xyz,
    uniforms.model[1].xyz,
    uniforms.model[2].xyz,
  );

  var output: VertexOutput;
  output.clipPosition = uniforms.viewProj * world;
  output.worldPosition = world.xyz;
  output.worldNormal = normalize(rotation * normal);
  // 0 at sea level, 1 at the highest peaks. uv is unused for now, but stays in
  // the vertex layout for terrain patch texturing later.
  let height = length(position) - uniforms.params.x;
  output.elevation = clamp(height / max(uniforms.params.y, 1e-5), 0.0, 1.0);
  return output;
}

fn terrainColor(elevation: f32) -> vec3f {
  let shore = vec3f(0.76, 0.70, 0.48);
  let grass = vec3f(0.24, 0.46, 0.20);
  let forest = vec3f(0.16, 0.33, 0.16);
  let rock = vec3f(0.38, 0.35, 0.32);
  let snow = vec3f(0.92, 0.94, 0.96);

  var color = mix(shore, grass, smoothstep(0.0, 0.14, elevation));
  color = mix(color, forest, smoothstep(0.12, 0.45, elevation));
  color = mix(color, rock, smoothstep(0.45, 0.78, elevation));
  color = mix(color, snow, smoothstep(0.82, 1.0, elevation));
  return color;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);
  let lightDir = normalize(uniforms.lightDir.xyz);
  let viewDir = normalize(uniforms.cameraPos.xyz - input.worldPosition);

  let isWater = input.elevation <= 0.0005;
  let albedo = select(terrainColor(input.elevation), vec3f(0.07, 0.20, 0.38), isWater);

  let diffuse = max(dot(normal, lightDir), 0.0);
  // Cheap hemisphere ambient: sky above, ground bounce below.
  let skyMix = normal.y * 0.5 + 0.5;
  let ambient = mix(vec3f(0.10, 0.11, 0.16), vec3f(0.26, 0.30, 0.38), skyMix);

  let specularPower = select(24.0, 96.0, isWater);
  let specularStrength = select(0.06, 0.45, isWater);
  let halfway = normalize(lightDir + viewDir);
  let specular =
    pow(max(dot(normal, halfway), 0.0), specularPower) * specularStrength * step(0.0, diffuse);

  // Brush cursor: a filled disc with a bright rim, drawn in angular distance from
  // the picked direction so it wraps over terrain instead of floating above it.
  var brushTint = vec3f(0.0);
  let brushRadius = uniforms.brush.w;
  if (brushRadius > 0.0) {
    let surface = normalize(input.worldPosition);
    let angle = acos(clamp(dot(surface, uniforms.brush.xyz), -1.0, 1.0));
    // params.z carries the mode: +1 raising, -1 lowering, 0 hovering.
    let mode = uniforms.params.z;
    let cursorColor =
      select(select(vec3f(0.85, 0.90, 1.00), vec3f(0.30, 0.75, 1.00), mode < 0.0),
             vec3f(1.00, 0.80, 0.35), mode > 0.0);
    let fill = 1.0 - smoothstep(brushRadius * 0.75, brushRadius, angle);
    let ring = 1.0 - smoothstep(0.0, brushRadius * 0.18, abs(angle - brushRadius * 0.88));
    brushTint = cursorColor * (fill * 0.22 + ring * 0.55);
  }

  // Rim term: makes the silhouette read as a sphere rather than a flat disc.
  let rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
  let atmosphere = vec3f(0.28, 0.45, 0.72) * rim * 0.6 * (0.25 + 0.75 * diffuse);

  var color = albedo * (ambient + vec3f(1.0, 0.97, 0.90) * diffuse);
  color += vec3f(specular) + atmosphere + brushTint;

  // Exposure curve: lifts the shadowed limb without blowing out the lit side.
  color = vec3f(1.0) - exp(-1.35 * color);

  return vec4f(color, 1.0);
}
`

export type Renderer = {
  statusMessage: string
  render: (game: Game) => void
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
  const resize = (deviceWidth?: number, deviceHeight?: number) => {
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(deviceWidth ?? canvas.clientWidth * dpr))
    const height = Math.max(1, Math.floor(deviceHeight ?? canvas.clientHeight * dpr))
    // Assigning either dimension clears the canvas, so only touch it on a change.
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
  }

  resize()
  window.addEventListener('resize', () => resize())

  // A devicePixelRatio change (moving windows between displays, browser zoom)
  // leaves the CSS size alone, so the resize event above can miss it. Observing
  // the device-pixel content box catches both, and gives exact integer sizes.
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.devicePixelContentBoxSize?.[0]
        if (box) {
          resize(box.inlineSize, box.blockSize)
        } else {
          resize()
        }
      }
    })

    try {
      observer.observe(canvas, { box: 'device-pixel-content-box' })
    } catch {
      observer.observe(canvas)
    }
  }

  const { device, context, format } = await initWebGpu(canvas)

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

  let depthTexture: GPUTexture | null = null
  const ensureDepthTexture = (): GPUTexture => {
    if (
      depthTexture &&
      depthTexture.width === canvas.width &&
      depthTexture.height === canvas.height
    ) {
      return depthTexture
    }

    depthTexture?.destroy()
    depthTexture = device.createTexture({
      label: 'depth',
      size: { width: canvas.width, height: canvas.height },
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    return depthTexture
  }

  const uniformData = new Float32Array(UNIFORM_BYTES / 4)
  const viewProj = uniformData.subarray(0, 16)
  const projection = new Float32Array(16)
  // The planet does not turn on its own; the model matrix is the hook for
  // spinning or tilting it later.
  mat4Identity(uniformData.subarray(16, 32))

  const triangleCount = game.planet.mesh.triangleCount

  return {
    statusMessage: `WebGPU ready — cube-sphere planet (${triangleCount} triangles)`,
    render(currentGame: Game) {
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

      // The projection is rebuilt every frame from the live drawing-buffer size,
      // so window resizes and devicePixelRatio changes need no extra plumbing.
      const aspect = canvas.width / Math.max(1, canvas.height)
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
      const { sculptor } = currentGame
      const hover = sculptor.armed ? sculptor.hoverDirection : null

      uniformData[40] = planet.radius
      uniformData[41] = planet.maxHeight
      uniformData[42] = sculptor.mode === 'raise' ? 1 : sculptor.mode === 'lower' ? -1 : 0
      uniformData[43] = 0
      uniformData[44] = hover ? hover[0] : 0
      uniformData[45] = hover ? hover[1] : 0
      uniformData[46] = hover ? hover[2] : 0
      // A zero radius switches the cursor off in the shader.
      uniformData[47] = hover ? sculptor.brushRadius : 0

      device.queue.writeBuffer(uniformBuffer, 0, uniformData)

      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: {
              r: currentGame.clearColor[0],
              g: currentGame.clearColor[1],
              b: currentGame.clearColor[2],
              a: 1,
            },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: ensureDepthTexture().createView(),
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })

      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.setVertexBuffer(0, planetBuffers.vertexBuffer)
      pass.setIndexBuffer(planetBuffers.indexBuffer, 'uint32')
      pass.drawIndexed(planetBuffers.indexCount)
      pass.end()

      device.queue.submit([encoder.finish()])
    },
  }
}
