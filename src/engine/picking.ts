import type { Mat4, Vec3 } from './math'

/**
 * Screen-to-world picking. Enough to put a brush or a spell where the cursor is.
 */

export type Ray = {
  origin: Vec3
  /** Unit length. */
  direction: Vec3
}

/** The part of the camera picking needs, kept structural so engine stays below game. */
export type RayCamera = {
  readonly eye: Vec3
  readonly viewMatrix: Mat4
  readonly fovY: number
}

/**
 * Builds a world-space ray through a point in normalised device coordinates
 * (-1..1, y up). `aspect` is width / height of the viewport.
 */
export function screenRay(
  camera: RayCamera,
  ndcX: number,
  ndcY: number,
  aspect: number,
): Ray {
  const tanHalf = Math.tan(camera.fovY / 2)
  const cx = ndcX * tanHalf * aspect
  const cy = ndcY * tanHalf

  // The view matrix' rows are the camera axes in world space, so reading them
  // back out transforms a camera-space direction into world space.
  const m = camera.viewMatrix
  const x = cx * m[0] + cy * m[1] - m[2]
  const y = cx * m[4] + cy * m[5] - m[6]
  const z = cx * m[8] + cy * m[9] - m[10]

  const length = Math.hypot(x, y, z) || 1
  return {
    origin: [camera.eye[0], camera.eye[1], camera.eye[2]],
    direction: [x / length, y / length, z / length],
  }
}

/**
 * Projects a world point to normalised device coordinates (-1..1, y up).
 * Null when the point is behind the camera. Inverse of `screenRay` for the
 * same view: a follower's instance position can be tested against a drag
 * rectangle without a second pick buffer.
 */
export function worldToNdc(
  camera: RayCamera,
  point: Vec3,
  aspect: number,
): { x: number; y: number } | null {
  if (!(aspect > 0)) {
    return null
  }

  const m = camera.viewMatrix
  const px = point[0]
  const py = point[1]
  const pz = point[2]
  const cx = m[0] * px + m[4] * py + m[8] * pz + m[12]
  const cy = m[1] * px + m[5] * py + m[9] * pz + m[13]
  const cz = m[2] * px + m[6] * py + m[10] * pz + m[14]

  // The view looks down camera -Z, so a point in front has negative cz.
  if (cz >= 0) {
    return null
  }

  const tanHalf = Math.tan(camera.fovY / 2)
  const depth = -cz
  return {
    x: cx / (depth * tanHalf * aspect),
    y: cy / (depth * tanHalf),
  }
}

/**
 * Distance along `ray` to the nearest intersection with a sphere centred on
 * `centre`, or null if it misses. Only hits in front of the origin count.
 */
export function intersectSphere(
  ray: Ray,
  radius: number,
  centre: Vec3 = [0, 0, 0],
): number | null {
  const ox = ray.origin[0] - centre[0]
  const oy = ray.origin[1] - centre[1]
  const oz = ray.origin[2] - centre[2]

  // Direction is unit length, so the quadratic's leading coefficient is 1.
  const b = ox * ray.direction[0] + oy * ray.direction[1] + oz * ray.direction[2]
  const c = ox * ox + oy * oy + oz * oz - radius * radius
  const discriminant = b * b - c
  if (discriminant < 0) {
    return null
  }

  const root = Math.sqrt(discriminant)
  const near = -b - root
  if (near >= 0) {
    return near
  }

  const far = -b + root
  return far >= 0 ? far : null
}

export function pointOnRay(ray: Ray, t: number): Vec3 {
  return [
    ray.origin[0] + ray.direction[0] * t,
    ray.origin[1] + ray.direction[1] * t,
    ray.origin[2] + ray.direction[2] * t,
  ]
}
