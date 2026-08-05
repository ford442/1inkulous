import { applyHeightField, createPlanetMesh, type PlanetMesh } from '../engine/mesh/cubeSphere'

/**
 * The playable world. For now this is only geometry: a cube-sphere plus a
 * placeholder height field. Terrain editing, tribes and spells will hang off
 * this module later — the mesh already exposes a per-vertex `heights` array as
 * the single source of truth for deformation.
 */

export type TerrainKind = 'placeholder' | 'flat'

export type PlanetOptions = {
  /** Quads per cube face edge. Default 8 → 768 triangles. */
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
  /** Rebuilds the height field with a new seed / terrain style. */
  generateTerrain: (kind: TerrainKind, seed?: number) => void
}

export function createPlanet(options: PlanetOptions = {}): Planet {
  const radius = options.radius ?? 1
  const maxHeight = options.maxHeight ?? radius * 0.06
  const mesh = createPlanetMesh({ resolution: options.resolution ?? 8, radius })

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
