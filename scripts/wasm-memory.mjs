/**
 * Reads a module's declared linear memory out of its binary, so what gets
 * printed and tested is what the browser will instantiate rather than what the
 * build was asked for.
 *
 *   node scripts/wasm-memory.mjs src/wasm/core.wasm
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PAGE_BYTES = 64 * 1024
const SECTION_MEMORY = 5

/** Unsigned LEB128 at `offset`: [value, next offset]. */
function leb(bytes, offset) {
  let value = 0
  let scale = 1
  for (;;) {
    const byte = bytes[offset++]
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) return [value, offset]
    scale *= 128
  }
}

/**
 * Initial and maximum size of the module's own memory, in bytes. `maximum` is
 * null when the module declares none, i.e. growth is bounded only by the
 * engine. Null overall when the binary defines no memory (it imports one).
 */
export function readMemoryLimits(wasm) {
  const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm)
  // Magic and version, then sections: id, byte length, payload.
  let at = 8
  while (at < bytes.length) {
    const id = bytes[at++]
    const [size, payload] = leb(bytes, at)
    at = payload + size
    if (id !== SECTION_MEMORY) continue

    let [, cursor] = leb(bytes, payload) // how many memories; there is one
    const flags = bytes[cursor++]
    const [initial, afterMin] = leb(bytes, cursor)
    const maximum = flags & 1 ? leb(bytes, afterMin)[0] : null
    return {
      initialBytes: initial * PAGE_BYTES,
      maximumBytes: maximum === null ? null : maximum * PAGE_BYTES,
      shared: (flags & 2) !== 0,
    }
  }
  return null
}

export const readMemoryLimitsFile = (path) => readMemoryLimits(readFileSync(path))

const megabytes = (bytes) => `${bytes / (1024 * 1024)}MB`

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const limits = process.argv[2] ? readMemoryLimitsFile(process.argv[2]) : null
  console.log(
    limits
      ? `memory ${megabytes(limits.initialBytes)} initial, ` +
          `${limits.maximumBytes === null ? 'no maximum' : `${megabytes(limits.maximumBytes)} maximum`}`
      : 'memory unknown',
  )
}
