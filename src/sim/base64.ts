/**
 * Typed arrays as base64 text, little-endian as wasm and every browser are:
 * how a replay carries the graph upload and a scenario carries a height
 * field. `btoa`/`atob` are in every browser and in Node.
 */

export function toBase64(array: Float32Array | Int32Array): string {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
  let binary = ''
  // In chunks: spreading a whole graph into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** The bytes `text` encodes. Throws on text that is not base64. */
export function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
