import type { Game } from '../game/game'
import {
  FOLLOWER_HEIGHT_FRACTION,
  FOLLOWER_RADIUS_FRACTION,
} from '../game/followers'
import type { PlanetMesh } from './mesh/cubeSphere'
import { consumeDirtyRange, VERTEX_BYTES, VERTEX_FLOATS } from './mesh/cubeSphere'
import { createFollowerMesh, FOLLOWER_VERTEX_BYTES } from './mesh/followerMesh'
import {
  mat4Identity,
  mat4Multiply,
  mat4Perspective,
  normalize,
  type Vec3,
} from './math'
import { initWebGpu } from './webgpu'
import { CANVAS_ASPECT, CANVAS_HEIGHT, CANVAS_WIDTH } from '../viewport'

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus'

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

/**
 * Followers are drawn with one instanced call: the core keeps a packed instance
 * buffer in linear memory, this uploads it whole and the vertex shader turns
 * each instance into a frame on the sphere. Whether there are five units or a
 * thousand, it stays one draw.
 */
const followerShader = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4f,
  model: mat4x4f,
  lightDir: vec4f,
  cameraPos: vec4f,
  params: vec4f,
  brush: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

const FLAG_SELECTED: u32 = 1u;
const PART_RING: f32 = 1.0;

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  // Per-instance, so interpolating them would only risk rounding an exact
  // comparison in the fragment stage.
  @location(2) @interpolate(flat) tint: vec3f,
  @location(3) @interpolate(flat) selected: f32,
  @location(4) @interpolate(flat) part: f32,
}

// Placeholder tribe colours, in the spirit of the four warring tribes. Real art
// replaces these later.
fn tribeColor(tribe: f32) -> vec3f {
  let index = i32(round(tribe)) % 4;
  if (index == 1) { return vec3f(0.78, 0.20, 0.18); }
  if (index == 2) { return vec3f(0.86, 0.74, 0.20); }
  if (index == 3) { return vec3f(0.24, 0.62, 0.28); }
  return vec3f(0.24, 0.44, 0.82);
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) part: f32,
  @location(3) instancePosition: vec3f,
  @location(4) instanceHeading: vec3f,
  @location(5) instanceTribe: f32,
  @location(6) instanceFlags: f32,
) -> VertexOutput {
  var output: VertexOutput;

  let flags = u32(instanceFlags);
  let selected = f32((flags & FLAG_SELECTED) != 0u);

  // The selection ring only exists while the follower is selected. Collapsing
  // its triangles to a point costs one vertex shader invocation and rasterises
  // nothing — cheaper than a second pipeline or a discard in the fragment stage.
  if (part == PART_RING && selected < 0.5) {
    output.clipPosition = uniforms.viewProj * vec4f(instancePosition, 1.0);
    output.worldPosition = instancePosition;
    output.worldNormal = vec3f(0.0, 1.0, 0.0);
    output.tint = vec3f(0.0);
    output.selected = 0.0;
    output.part = part;
    return output;
  }

  // Stand the model up on the sphere: y out of the surface, z along the heading.
  let up = normalize(instancePosition);
  var forward = instanceHeading - up * dot(up, instanceHeading);
  if (length(forward) < 1e-5) {
    // Heading parallel to up should not happen, but a degenerate frame would
    // collapse the model, so fall back to any tangent.
    forward = normalize(cross(up, vec3f(0.0, 0.0, 1.0)) + vec3f(1e-4, 0.0, 0.0));
  }
  forward = normalize(forward);
  let right = cross(up, forward);

  let world = instancePosition + right * position.x + up * position.y + forward * position.z;
  let worldNormal = right * normal.x + up * normal.y + forward * normal.z;

  output.clipPosition = uniforms.viewProj * vec4f(world, 1.0);
  output.worldPosition = world;
  output.worldNormal = worldNormal;
  output.tint = tribeColor(instanceTribe);
  output.selected = selected;
  output.part = part;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);
  let lightDir = normalize(uniforms.lightDir.xyz);
  let viewDir = normalize(uniforms.cameraPos.xyz - input.worldPosition);

  if (input.part == PART_RING) {
    // Flat, bright and unlit, so a selection reads at a glance against any
    // terrain colour underneath it.
    return vec4f(mix(input.tint, vec3f(1.0), 0.65), 1.0);
  }

  let diffuse = max(dot(normal, lightDir), 0.0);
  let skyMix = normal.y * 0.5 + 0.5;
  let ambient = mix(vec3f(0.12, 0.13, 0.18), vec3f(0.30, 0.34, 0.42), skyMix);

  // Selected followers are lifted towards white so they stand out from their
  // tribe-mates without changing the tribe colour's meaning.
  let albedo = mix(input.tint, mix(input.tint, vec3f(1.0), 0.45), input.selected);

  let halfway = normalize(lightDir + viewDir);
  let specular = pow(max(dot(normal, halfway), 0.0), 32.0) * 0.12 * step(0.0, diffuse);

  // A rim keeps a follower legible against terrain of a similar tone when the
  // camera is pulled back and the unit is only a few pixels across.
  let rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.5) * (0.18 + 0.5 * input.selected);

  var color = albedo * (ambient + vec3f(1.0, 0.97, 0.90) * diffuse);
  color += vec3f(specular) + albedo * rim;
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
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT

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
    statusMessage:
      `WebGPU ready — cube-sphere planet (${triangleCount} triangles), ` +
      `followers instanced (${followerMesh.triangleCount} triangles each)`,
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

      // Projection uses the fixed viewport aspect ratio.
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

      if (followerInstanceCount > 0) {
        pass.setPipeline(followerPipeline)
        pass.setBindGroup(0, followerBindGroup)
        pass.setVertexBuffer(0, followerVertexBuffer)
        pass.setVertexBuffer(1, followerInstanceBuffer)
        pass.draw(followerMesh.vertexCount, followerInstanceCount)
      }

      pass.end()

      device.queue.submit([encoder.finish()])
    },
  }
}
