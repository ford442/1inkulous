/**
 * The game viewport in CSS pixels. The canvas is laid out at this size
 * (src/style.css), and pointer input, picking and the selection band all work
 * in it — see src/input/input.ts. None of them ever sees a device pixel.
 */
export const CANVAS_WIDTH = 1024
export const CANVAS_HEIGHT = 768
export const CANVAS_ASPECT = CANVAS_WIDTH / CANVAS_HEIGHT

/**
 * The drawing buffer is sized separately, in device pixels: a 2x display gets
 * twice the pixels across the same CSS box, so the planet is not drawn at half
 * resolution and stretched. Past 2x the extra pixels cost fill rate and are not
 * visible at this viewport size, so the ratio is capped.
 */
export const MAX_PIXEL_RATIO = 2

/** The ratio the drawing buffer is scaled by for a given devicePixelRatio. */
export function effectivePixelRatio(devicePixelRatio: number): number {
  // A zoomed-out page can report below 1, and 1:1 with the device pixels is
  // right there. Anything that is not a positive number says nothing at all.
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    return 1
  }
  return Math.min(devicePixelRatio, MAX_PIXEL_RATIO)
}

/** Drawing-buffer size in device pixels for the fixed CSS viewport. */
export function drawingBufferSize(devicePixelRatio: number): { width: number; height: number } {
  const ratio = effectivePixelRatio(devicePixelRatio)
  return {
    width: Math.max(1, Math.round(CANVAS_WIDTH * ratio)),
    height: Math.max(1, Math.round(CANVAS_HEIGHT * ratio)),
  }
}
