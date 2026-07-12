export type WebGpuContext = {
  device: GPUDevice
  context: GPUCanvasContext
  format: GPUTextureFormat
}

export async function initWebGpu(canvas: HTMLCanvasElement): Promise<WebGpuContext> {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not supported in this browser')
  }

  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) {
    throw new Error('No WebGPU adapter available')
  }

  const device = await adapter.requestDevice()
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (!context) {
    throw new Error('Failed to acquire WebGPU canvas context')
  }

  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  })

  return { device, context, format }
}
