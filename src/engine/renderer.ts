import type { Game } from '../game/game'
import { initWebGpu } from './webgpu'

const triangleShader = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(0.0, 0.5),
    vec2f(-0.5, -0.5),
    vec2f(0.5, -0.5),
  );

  var colors = array<vec3f, 3>(
    vec3f(0.95, 0.55, 0.15),
    vec3f(0.15, 0.65, 0.85),
    vec3f(0.55, 0.25, 0.75),
  );

  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.color = colors[vertexIndex];
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
`

export type Renderer = {
  statusMessage: string
  render: (game: Game) => void
}

export async function createRenderer(canvas: HTMLCanvasElement): Promise<Renderer> {
  const resize = () => {
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(canvas.clientWidth * dpr)
    canvas.height = Math.floor(canvas.clientHeight * dpr)
  }

  resize()
  window.addEventListener('resize', resize)

  const { device, context, format } = await initWebGpu(canvas)

  const shaderModule = device.createShaderModule({ code: triangleShader })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: {
      topology: 'triangle-list',
    },
  })

  return {
    statusMessage: 'WebGPU ready — rendering starter triangle',
    render(game: Game) {
      const encoder = device.createCommandEncoder()
      const view = context.getCurrentTexture().createView()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: {
              r: game.clearColor[0],
              g: game.clearColor[1],
              b: game.clearColor[2],
              a: 1,
            },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })

      pass.setPipeline(pipeline)
      pass.draw(3)
      pass.end()

      device.queue.submit([encoder.finish()])
    },
  }
}
