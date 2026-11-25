/**
 * The runtime half of WGSL composition. Includes are resolved at build time
 * (scripts/wgsl.mjs); what is left is choosing branches by what this device
 * turned out to support:
 *
 *   #ifdef SHADER_F16
 *   enable f16;
 *   #endif
 *
 * `#ifdef NAME`, `#ifndef NAME`, `#else` and `#endif`, nestable, one per line.
 * A directive line, and every line in a branch not taken, becomes an empty
 * line, so line numbers in a compilation error still match the composed file.
 */
export type WgslDefines = Readonly<Record<string, boolean>>

const DIRECTIVE = /^[ \t]*#(ifdef|ifndef|else|endif)\b[ \t]*([A-Za-z_][A-Za-z0-9_]*)?[ \t]*$/

export function specializeWgsl(code: string, defines: WgslDefines = {}): string {
  // One entry per open block: whether its lines are kept, and whether the
  // block it sits in is.
  const stack: { keep: boolean; parentKeeps: boolean; sawElse: boolean }[] = []
  const keeping = () => stack.every((frame) => frame.keep)
  const out: string[] = []
  const lines = code.split('\n')

  lines.forEach((line, index) => {
    const match = DIRECTIVE.exec(line)
    if (!match) {
      out.push(keeping() ? line : '')
      return
    }
    const [, directive, name] = match
    const where = `line ${index + 1}`
    if (directive === 'ifdef' || directive === 'ifndef') {
      if (!name) {
        throw new Error(`WGSL #${directive} without a name at ${where}`)
      }
      const defined = defines[name] === true
      stack.push({
        keep: directive === 'ifdef' ? defined : !defined,
        parentKeeps: keeping(),
        sawElse: false,
      })
    } else if (directive === 'else') {
      const top = stack[stack.length - 1]
      if (!top || top.sawElse) {
        throw new Error(`WGSL #else without a matching #ifdef at ${where}`)
      }
      top.keep = !top.keep
      top.sawElse = true
    } else {
      if (!stack.pop()) {
        throw new Error(`WGSL #endif without a matching #ifdef at ${where}`)
      }
    }
    out.push('')
  })

  if (stack.length > 0) {
    throw new Error(`WGSL #ifdef left open at the end of the shader`)
  }
  return out.join('\n')
}
