/**
 * Reads `assets-index.json`, the list of what `public/models` and
 * `public/audio` hold (scripts/assets-index.mjs writes it; the dev server
 * serves it). Null when it cannot be had — the file is missing, or is not what
 * it should be — in which case the asset manager asks for each asset instead.
 */

export type AssetIndex = Readonly<Record<string, number>>

export async function fetchAssetIndex(
  fetchFn: typeof fetch = (...args) => fetch(...args),
  baseUrl: string = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/',
): Promise<AssetIndex | null> {
  try {
    const response = await fetchFn(new URL('assets-index.json', baseUrl).href)
    if (!response.ok) {
      return null
    }
    return parseAssetIndex(await response.json())
  } catch {
    return null
  }
}

/** The index if `value` is one — an object of file sizes — and null if not. */
export function parseAssetIndex(value: unknown): AssetIndex | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const index: Record<string, number> = {}
  for (const [url, size] of Object.entries(value)) {
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      return null
    }
    index[url] = size
  }
  return index
}
