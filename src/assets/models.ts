import type { FollowerMesh } from '../engine/mesh/followerMesh'
import { followerMeshFromModel, FollowerModelError, type FollowerModelOptions } from './followerModel'
import type { GameAssets } from './manager'

/**
 * The loaded models, made into the meshes the renderer draws. The one place
 * that knows "if `model.follower` came in, use it; otherwise the procedural
 * pawn stands" — so the renderer takes a mesh and the simulation takes nothing.
 */

type Log = { info: (message: string) => void; warn: (message: string) => void }

/**
 * The follower mesh from a loaded `model.follower`, or null when there is none
 * or it is unusable (over the triangle budget, no body…) — the caller then
 * leaves the procedural pawn in place. A model that loaded but cannot be used
 * is worth a warning; one that was never there is not.
 */
export function followerMeshFromAssets(
  assets: Pick<GameAssets, 'get'>,
  size: FollowerModelOptions,
  log: Log = { info: (m) => console.info(m), warn: (m) => console.warn(m) },
): FollowerMesh | null {
  const model = assets.get('model.follower')
  if (!model) {
    return null
  }
  try {
    const mesh = followerMeshFromModel(model, size)
    log.info(`[assets] follower: drawing the loaded model (${model.triangleCount} triangles)`)
    return mesh
  } catch (error) {
    if (error instanceof FollowerModelError) {
      log.warn(`[assets] follower: ${error.message} — using the built-in`)
      return null
    }
    throw error
  }
}
