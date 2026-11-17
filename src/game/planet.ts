import {
  applyHeightField,
  createPlanetMesh,
  sampleHeight,
  type PlanetMesh,
} from '../engine/mesh/cubeSphere'
import { intersectSphere, pointOnRay, type Ray } from '../engine/picking'
import { normalize, type Vec3 } from '../engine/math'

/**
 * The playable world as the player sees it: the mesh, and the picking and
 * height queries that go with it.
 *
 * The planet generates the starting height field and nothing more. Once the
 * simulation core takes the terrain (see `createTerrain` in ./terrain), the
 * core's height per nav node is the ground: every edit happens there, the mesh
 * is redrawn from it, and `heightAt` reads it on the same triangle a walker
 * stands on — so a click lands where a path would.
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

/** Answers "how high is the ground here" for a direction. */
export type HeightSource = (direction: Vec3) => number

export type Planet = {
  readonly mesh: PlanetMesh
  readonly radius: number
  readonly maxHeight: number
  /**
   * Height above sea level at a direction. Before a core owns the terrain this
   * is the generated field on the mesh; after, it is the core's.
   */
  heightAt: (direction: Vec3) => number
  /** World-space point on the terrain surface along a direction. */
  surfacePointAt: (direction: Vec3) => Vec3
  /** True where the terrain sits at or below sea level. */
  isWaterAt: (direction: Vec3) => boolean
  /** Direction of the terrain point under a ray, or null if it misses. */
  pickDirection: (ray: Ray) => Vec3 | null
  /**
   * Hands height queries to whoever now owns the terrain. Called once, when the
   * core takes it; the mesh stops being the source of truth from then on.
   */
  readHeightsFrom: (source: HeightSource) => void
}

/** Refinement passes for ray → surface picking. */
const PICK_REFINEMENTS = 4

export function createPlanet(options: PlanetOptions = {}): Planet {
  const radius = options.radius ?? 1
  const maxHeight = options.maxHeight ?? radius * 0.06
  const mesh = createPlanetMesh({ resolution: options.resolution ?? 24, radius })

  // Deterministic for a given kind and seed.
  const seed = options.seed ?? 1
  if ((options.terrain ?? 'placeholder') === 'flat') {
    applyHeightField(mesh, () => 0)
  } else {
    applyHeightField(mesh, (x, y, z) => landHeight(x, y, z, seed, maxHeight))
  }

  let source: HeightSource = (direction) =>
    sampleHeight(mesh, direction[0], direction[1], direction[2])
  const heightAt = (direction: Vec3) => source(direction)

  return {
    mesh,
    radius,
    maxHeight,
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

    readHeightsFrom(next: HeightSource) {
      source = next
    },
  }
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
