import { refreshGeometry, refreshVertices } from '../engine/mesh/cubeSphere'
import type { Vec3 } from '../engine/math'
import type { Deferred, SimulationClient } from '../sim/simulation'
import { buildNavGraph, type NavGraph } from './navGraph'
import type { Planet } from './planet'

/**
 * The terrain, owned by the simulation core.
 *
 * Nav nodes are the mesh's welded vertices, so the core's one float per node
 * is the ground: what followers walk on, what a spell raises, what the brush
 * digs. This module hands it over and keeps the picture in step:
 *
 * - once, at load, it builds the graph from the mesh, seeds the core with the
 *   generated heights and points the planet's height queries at the core;
 * - every edit after that is a core call, from the brush here or from a spell
 *   inside the core — TypeScript never writes walkable height again;
 * - each frame, `syncMesh` copies the nodes the core reports dirty back onto
 *   every mesh vertex sharing their weld id, and the renderer uploads that
 *   vertex range as it always has.
 */

/**
 * Steepest ground a follower will cross, as height over run. Terrain runs from
 * sea level to `planet.maxHeight` over a handful of cells, so this turns a
 * sculpted mound into a wall while leaving rolling country walkable.
 */
export const MAX_WALKABLE_SLOPE = 0.55

export type Terrain = {
  readonly planet: Planet
  /** The walkable graph the core paths over. Node ids are mesh weld ids. */
  readonly graph: NavGraph
  /** Live view of the core's height per node. Re-read it; do not keep it. */
  heights: () => Float32Array
  /** Height under a direction, as a walker standing there would find it. */
  heightAt: (direction: Vec3) => number
  /**
   * Raises (positive delta) or lowers the ground inside an angular radius, with
   * a smooth falloff to the rim. Returns true if anything moved.
   */
  sculpt: (centre: Vec3, angularRadius: number, delta: number) => Deferred<boolean>
  /**
   * Pulls the ground inside an angular radius towards `targetHeight`, by at
   * most `rate` at the centre and less towards the rim. Ground within reach
   * lands on the target exactly, so a few strokes leave a level pad.
   */
  flatten: (centre: Vec3, angularRadius: number, targetHeight: number, rate: number) => Deferred<boolean>
  /**
   * Copies the heights the core changed since the last call onto the mesh.
   * Returns how many vertices moved. Call once a frame, after everything that
   * might edit the ground and before drawing.
   */
  syncMesh: () => number
}

export type TerrainOptions = {
  /** Steepest walkable ground as height over run. */
  maxSlope?: number
}

export function createTerrain(
  planet: Planet,
  simulation: SimulationClient,
  options: TerrainOptions = {},
): Terrain {
  const { mesh } = planet
  const graph = buildNavGraph(mesh)

  // The seed: one height per node out of the generated field. Any of a weld's
  // duplicates will do, and after the write-back below they all agree anyway.
  const seed = new Float32Array(graph.nodeCount)
  for (let node = 0; node < graph.nodeCount; node += 1) {
    seed[node] = mesh.heights[graph.nodeVertex[node]]
  }
  simulation.uploadNavGraph(graph, seed, {
    planetRadius: planet.radius,
    maxSlope: options.maxSlope ?? MAX_WALKABLE_SLOPE,
    maxHeight: planet.maxHeight,
  })

  // From here on the mesh is a view of the core. Duplicates along the face
  // seams were generated separately and can differ in the last bit; make them
  // the core's value now, so the first frame already draws the walkable ground.
  {
    const heights = simulation.navHeights()
    for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
      mesh.heights[vertex] = heights[mesh.weldIds[vertex]]
    }
    refreshGeometry(mesh)
  }

  const heightAt = (direction: Vec3) => simulation.terrainHeightAt(direction)
  planet.readHeightsFrom(heightAt)

  const { weldVertexOffsets, weldVertices } = mesh
  // Kept between frames so a stroke allocates nothing.
  const touched: number[] = []

  return {
    planet,
    graph,
    heights: () => simulation.navHeights(),
    heightAt,
    sculpt: (centre, angularRadius, delta) =>
      simulation.sculptTerrain(centre, angularRadius, delta),
    flatten: (centre, angularRadius, targetHeight, rate) =>
      simulation.flattenTerrain(centre, angularRadius, targetHeight, rate),

    syncMesh() {
      const dirty = simulation.takeTerrainDirty()
      if (!dirty) {
        return 0
      }
      const heights = simulation.navHeights()
      touched.length = 0
      for (let node = dirty.first; node <= dirty.last; node += 1) {
        const height = heights[node]
        for (let v = weldVertexOffsets[node]; v < weldVertexOffsets[node + 1]; v += 1) {
          const vertex = weldVertices[v]
          // A range, not a list: most nodes in it did not move.
          if (mesh.heights[vertex] !== height) {
            mesh.heights[vertex] = height
            touched.push(vertex)
          }
        }
      }
      refreshVertices(mesh, touched)
      return touched.length
    },
  }
}
