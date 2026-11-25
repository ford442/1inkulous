/** A `.wgsl` import is the shader's composed source: see scripts/wgsl.mjs. */
declare module '*.wgsl' {
  const code: string
  export default code
}
