/**
 * Minimal column-major 4x4 / 3-component math helpers.
 *
 * Matrices are stored the way WGSL expects them (column-major, 16 floats), so a
 * Float32Array produced here can be copied straight into a uniform buffer.
 */

export type Mat4 = Float32Array
export type Vec3 = [number, number, number]

export function mat4Identity(out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0)
  out[0] = 1
  out[5] = 1
  out[10] = 1
  out[15] = 1
  return out
}

/** Right-handed perspective projection mapping depth to WebGPU's [0, 1] range. */
export function mat4Perspective(
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2)
  const range = 1 / (near - far)

  out.fill(0)
  out[0] = f / aspect
  out[5] = f
  out[10] = far * range
  out[11] = -1
  out[14] = far * near * range
  return out
}

export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3, out: Mat4 = new Float32Array(16)): Mat4 {
  // Forward points from the target back towards the eye (right-handed view basis).
  let zx = eye[0] - target[0]
  let zy = eye[1] - target[1]
  let zz = eye[2] - target[2]
  const zLen = Math.hypot(zx, zy, zz) || 1
  zx /= zLen
  zy /= zLen
  zz /= zLen

  let xx = up[1] * zz - up[2] * zy
  let xy = up[2] * zx - up[0] * zz
  let xz = up[0] * zy - up[1] * zx
  const xLen = Math.hypot(xx, xy, xz) || 1
  xx /= xLen
  xy /= xLen
  xz /= xLen

  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx

  out[0] = xx
  out[1] = yx
  out[2] = zx
  out[3] = 0
  out[4] = xy
  out[5] = yy
  out[6] = zy
  out[7] = 0
  out[8] = xz
  out[9] = yz
  out[10] = zz
  out[11] = 0
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2])
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2])
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2])
  out[15] = 1
  return out
}

/** out = a * b (apply b first, then a). */
export function mat4Multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  for (let col = 0; col < 4; col += 1) {
    const b0 = b[col * 4 + 0]
    const b1 = b[col * 4 + 1]
    const b2 = b[col * 4 + 2]
    const b3 = b[col * 4 + 3]

    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[row] * b0 + a[4 + row] * b1 + a[8 + row] * b2 + a[12 + row] * b3
    }
  }
  return out
}

export function mat4RotationY(radians: number, out: Mat4 = new Float32Array(16)): Mat4 {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  mat4Identity(out)
  out[0] = c
  out[2] = -s
  out[8] = s
  out[10] = c
  return out
}

export function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}
