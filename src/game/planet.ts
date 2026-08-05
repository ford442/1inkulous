import {
  applyHeightField,
  createPlanetMesh,
  refreshVertices,
  sampleHeight,
  type PlanetMesh,
} from '../engine/mesh/cubeSphere'
import { intersectSphere, pointOnRay, type Ray } from '../engine/picking'
import { normalize, type Vec3 } from '../engine/math'

/**
 * The playable world. Terrain is a per-vertex height above sea level, stored on
 * the mesh and edited in place — `sculpt` is the primitive that the player's
 * brush and, later, raise/lower spells both go through.
 */

export type TerrainKind = 'placeholder' | 'flat'

export type PlanetOptions = {
  /** Quads per cube face edge. Default 24 → 6912 triangles. */
  resolution?: number
  radius?: number
  /** Peak land elevation above sea level, in world units. */
  maxHeight?: number
  terrain?: TerrainKind
  seed?: number
}

export type Planet = {
  readonly mesh: PlanetMesh
  readonly radius: number
  readonly maxHeight: number
  /** Rebuilds the height field. Deterministic for a given kind and seed. */
  generateTerrain: (kind: TerrainKind, seed?: number) => void
  /** Height above sea level at a direction, interpolated across the cell. */
  heightAt: (direction: Vec3) => number
  /** World-space point on the terrain surface along a direction. */
  surfacePointAt: (direction: Vec3) => Vec3
  /** True where the terrain sits at or below sea level. */
  isWaterAt: (direction: Vec3) => boolean
  /** Direction of the terrain point under a ray, or null if it misses. */
  pickDirection: (ray: Ray) => Vec3 | null
  /**
   * Raises (positive delta) or lowers (negative) the terrain inside an angular
   * radius, with a smooth falloff to the edge. Returns true if anything moved.
   */
  sculpt: (centre: Vec3, angularRadius: number, delta: number) => boolean
}

/** Refinement passes for ray → surface picking. */
const PICK_REFINEMENTS = 4

/**
 * Steps smaller than this fraction of the height range are skipped: at the very
 * rim of the brush the falloff goes to nothing, and a step that cannot survive
 * being rounded into the float32 height array would only dirty the buffer.
 */
const MIN_STEP_FRACTION = 1e-9

export function createPlanet(options: PlanetOptions = {}): Planet {
  const radius = options.radius ?? 1
  const maxHeight = options.maxHeight ?? radius * 0.06
  const mesh = createPlanetMesh({ resolution: options.resolution ?? 24, radius })

  const heightAt = (direction: Vec3) =>
    sampleHeight(mesh, direction[0], direction[1], direction[2])

  const planet: Planet = {
    mesh,
    radius,
    maxHeight,

    generateTerrain(kind: TerrainKind, seed = 0) {
      if (kind === 'flat') {
        applyHeightField(mesh, () => 0)
        return
      }
      applyHeightField(mesh, (x, y, z) => landHeight(x, y, z, seed, maxHeight))
    },

    heightAt,

    surfacePointAt(direction: Vec3) {
      const unit = normalize(direction)
      const r = radius + heightAt(unit)
      return [unit[0] * r, unit[1] * r, unit[2] * r]
    },

    isWaterAt(direction: Vec3) {
      return heightAt(direction) <= 0
    },

    pickDirection(ray: Ray) {
      // Start against the shell that encloses the tallest terrain, so mountains
      // on the limb are not missed, then walk the hit down to the real surface.
      const first = intersectSphere(ray, radius + maxHeight)
      if (first === null) {
        return null
      }

      let direction = normalize(pointOnRay(ray, first))
      for (let i = 0; i < PICK_REFINEMENTS; i += 1) {
        const t = intersectSphere(ray, radius + heightAt(direction))
        if (t === null) {
          // Grazing hit: the lower shell is out of reach, so keep what we have.
          break
        }
        direction = normalize(pointOnRay(ray, t))
      }

      return direction
    },

    sculpt(centre: Vec3, angularRadius: number, delta: number) {
      if (delta === 0 || angularRadius <= 0) {
        return false
      }

      const unit = normalize(centre)
      const cosRadius = Math.cos(angularRadius)
      const { directions, heights, vertexCount } = mesh
      const touched: number[] = []
      // Heights live in a float32 array, so cap at the representable value —
      // otherwise a saturated vertex compares unequal to its own stored height
      // every frame and never stops re-uploading.
      const cap = Math.fround(maxHeight)
      const minStep = MIN_STEP_FRACTION * maxHeight

      for (let i = 0; i < vertexCount; i += 1) {
        const dot =
          directions[i * 3] * unit[0] +
          directions[i * 3 + 1] * unit[1] +
          directions[i * 3 + 2] * unit[2]
        if (dot <= cosRadius) {
          continue
        }

        // Smooth falloff from full strength at the centre to nothing at the rim,
        // so strokes blend instead of leaving stepped craters.
        const angle = Math.acos(Math.min(1, dot))
        const t = 1 - angle / angularRadius
        const falloff = t * t * (3 - 2 * t)

        const step = delta * falloff
        if (Math.abs(step) < minStep) {
          continue
        }

        const before = heights[i]
        // Snap hard at both ends rather than approaching them: game logic reads
        // water as `height <= 0`, so a stroke meant to flood a valley has to
        // land on exactly zero.
        let after = before + step
        if (after <= 0) after = 0
        else if (after >= cap) after = cap

        if (after !== before) {
          heights[i] = after
          touched.push(i)
        }
      }

      if (touched.length === 0) {
        return false
      }

      refreshVertices(mesh, touched)
      return true
    },
  }

  planet.generateTerrain(options.terrain ?? 'placeholder', options.seed ?? 1)
  return planet
}

/**
 * Placeholder continents. Smooth, seamless over the whole sphere (it is a
 * function of the 3D direction, not of face UVs) and cheap — good enough to
 * prove the deformation pipeline until real terrain generation lands.
 */
function landHeight(
  x: number,
  y: number,
  z: number,
  seed: number,
  maxHeight: number,
): number {
  let value = 0
  let amplitude = 1
  let frequency = 1.7
  let normalizer = 0

  for (let octave = 0; octave < 4; octave += 1) {
    value +=
      amplitude *
      Math.sin(frequency * x + seed * 1.31 + octave) *
      Math.cos(frequency * y * 1.13 - seed * 0.77 + octave * 2.1) *
      Math.sin(frequency * z * 0.97 + seed * 0.41 + octave * 3.7)
    normalizer += amplitude
    amplitude *= 0.5
    frequency *= 2.03
  }

  // Sea level sits slightly above the field's mean, so oceans win a little more
  // than half the surface — enough open water to read as a world of islands.
  const land = value / normalizer - 0.04
  // Water stays perfectly flat at sea level, the way Populous oceans read.
  return land > 0 ? Math.min(1, land * 1.3) * maxHeight : 0
}
