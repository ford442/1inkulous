/**
 * The loading screen's numbers: what it says and how full its bar is.
 *
 * Starting the game is a few stages in order — the core, the world, the assets,
 * the renderer — and the bar is simply how many are done, with the stage in
 * progress contributing its own fraction (the assets' bytes, say). It is a
 * promise that something is happening, not a forecast: the stages are not equal
 * in cost, and it never claims to be finished before the renderer is up.
 */

export type LoadingReadout = {
  readonly label: string
  /** 0..1. */
  readonly fraction: number
}

/** Clamped to 0..1; anything that is not a number is empty. */
export function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/** The bar as a whole percentage. */
export function loadingPercent(fraction: number): number {
  return Math.round(clampFraction(fraction) * 100)
}

/** What the loading screen's label says: the stage and how far along it is. Pure. */
export function loadingText(loading: LoadingReadout): string {
  return `${loading.label} — ${loadingPercent(loading.fraction)}%`
}

export type StartupProgress = {
  /** Moves to a stage (by its index in `stages`), `within` of the way through it. */
  stage: (index: number, label: string, within?: number) => void
  /** The loading screen is done. */
  finish: () => void
}

/**
 * Reports progress through `stageCount` stages to `show`. Never goes backwards:
 * a late callback for an earlier stage (an asset finishing after the next stage
 * began) is dropped rather than moving the bar.
 */
export function createStartupProgress(
  stageCount: number,
  show: (loading: LoadingReadout | null) => void,
): StartupProgress {
  let reached = 0
  return {
    stage(index, label, within = 0) {
      if (index < reached) {
        return
      }
      reached = index
      show({ label, fraction: (index + clampFraction(within)) / stageCount })
    },
    finish() {
      reached = stageCount
      show(null)
    },
  }
}
