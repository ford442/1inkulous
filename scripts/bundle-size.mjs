#!/usr/bin/env node
//
// What a build weighs: `npm run report:bundle` (after `npm run build`).
//
//   node scripts/bundle-size.mjs [dist] [--json report.json] [--budget bundle-budget.json]
//
// Walks the build, measures every file raw, gzipped and brotlied, sorts them
// into what the player pays for and when, prints a Markdown table, and checks
// the totals against the budgets in bundle-budget.json. Over a budget, it
// exits 1 — which is what makes the table a gate and not just a number nobody
// reads. In CI it also appends the table to the job summary
// ($GITHUB_STEP_SUMMARY), so the sizes are on the pull request's checks page.
//
// Categories:
//   entry   index.html and what it loads: the app's script and stylesheet
//   worker  the simulation worker's script
//   wasm    the simulation core
//   lazy    other scripts, fetched when first needed (the meshopt decoder,
//           the world editor)
//   media   public/models, public/audio and public/worlds: the art, the
//           sound and the world files, fetched as a visit needs them
//   other   icons and the rest
//
// The budget for a category is on its *transfer* size: gzip for what compresses
// (text, scripts, wasm), raw for what does not (models are meshopt-compressed,
// audio is already coded). A budget of 0 would mean "none allowed".

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

export const CATEGORIES = ['entry', 'worker', 'wasm', 'lazy', 'media', 'other']

/** Formats that gzip helps with; the rest are measured as they are. */
const COMPRESSIBLE = /\.(html|js|mjs|css|wasm|json|svg|md|txt|map|gltf)$/i

/** Every file under `dir`, as paths relative to it with forward slashes. */
export function listFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      // `.gitkeep` and the like ship, but they are not what the player downloads.
      if (name.startsWith('.')) {
        continue
      }
      const path = join(current, name)
      if (statSync(path).isDirectory()) {
        walk(path)
      } else {
        out.push(relative(dir, path).split(sep).join('/'))
      }
    }
  }
  walk(dir)
  return out
}

/**
 * The scripts and stylesheets index.html loads at once, as paths relative to
 * the build. Reads `src=` and `href=` of module scripts, stylesheets and
 * modulepreloads; anything else it links is not on the first-load path.
 */
export function entryFiles(indexHtml) {
  const found = new Set()
  const tag = /<(script|link)\b([^>]*)>/gi
  for (const [, name, attributes] of indexHtml.matchAll(tag)) {
    const rel = /\brel\s*=\s*["']?(stylesheet|modulepreload)/i.test(attributes)
    if (name.toLowerCase() === 'link' && !rel) {
      continue
    }
    const url = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1]
    if (url && !/^([a-z]+:)?\/\//i.test(url)) {
      found.add(url.replace(/^\.\//, '').replace(/^\//, ''))
    }
  }
  return found
}

/** Which category a built file belongs to. */
export function categorize(path, entries) {
  if (path === 'index.html' || entries.has(path)) {
    return 'entry'
  }
  if (path.endsWith('.wasm')) {
    return 'wasm'
  }
  if (/^assets\/worker-[^/]*\.js$/.test(path)) {
    return 'worker'
  }
  if (path.endsWith('.js')) {
    // Vite's stub for a Node module the core's glue mentions is not a download
    // anyone waits on, but it is a file: count it with what loads at once.
    return /^assets\/__vite-browser-external/.test(path) ? 'entry' : 'lazy'
  }
  if (/^(models|audio|worlds)\//.test(path)) {
    return 'media'
  }
  return 'other'
}

/** Measures one file's contents. */
export function measure(path, bytes) {
  const raw = bytes.length
  if (!COMPRESSIBLE.test(path) || raw === 0) {
    return { raw, gzip: raw, brotli: raw, transfer: raw }
  }
  const gzip = gzipSync(bytes, { level: 9 }).length
  const brotli = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw },
  }).length
  // Compression never makes a response bigger on the wire: a server would not use it.
  return { raw, gzip: Math.min(gzip, raw), brotli: Math.min(brotli, raw), transfer: Math.min(gzip, raw) }
}

/** The whole build: each file measured and categorised, and totals per category. */
export function analyze(dir) {
  const indexPath = join(dir, 'index.html')
  const entries = existsSync(indexPath) ? entryFiles(readFileSync(indexPath, 'utf8')) : new Set()
  const files = listFiles(dir).map((path) => ({
    path,
    category: categorize(path, entries),
    ...measure(path, readFileSync(join(dir, path))),
  }))
  const totals = Object.fromEntries(
    [...CATEGORIES, 'total'].map((name) => [name, { files: 0, raw: 0, gzip: 0, brotli: 0, transfer: 0 }]),
  )
  for (const file of files) {
    for (const bucket of [totals[file.category], totals.total]) {
      bucket.files += 1
      bucket.raw += file.raw
      bucket.gzip += file.gzip
      bucket.brotli += file.brotli
      bucket.transfer += file.transfer
    }
  }
  return { files, totals }
}

/**
 * The budgets a report is over: `{ category: limit }` against each category's
 * transfer size (`total` included). A category with no budget is not checked.
 */
export function overBudget(report, budgets) {
  const over = []
  for (const [name, limit] of Object.entries(budgets)) {
    const bucket = report.totals[name]
    if (!bucket) {
      over.push({ name, limit, actual: NaN, unknown: true })
    } else if (bucket.transfer > limit) {
      over.push({ name, limit, actual: bucket.transfer })
    }
  }
  return over
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '—'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 2 : 1)} kB`
}

export function renderMarkdown(report, budgets = {}, over = []) {
  const lines = ['## Bundle size', '']
  lines.push('| Category | Files | Raw | Gzip | Brotli | Budget (transfer) |')
  lines.push('| --- | ---: | ---: | ---: | ---: | --- |')
  for (const name of [...CATEGORIES, 'total']) {
    const t = report.totals[name]
    if (t.files === 0 && name !== 'total' && !(name in budgets)) {
      continue
    }
    const limit = budgets[name]
    const status =
      limit === undefined
        ? '—'
        : over.some((o) => o.name === name)
          ? `**over** ${formatBytes(limit)}`
          : `${formatBytes(limit)} (${Math.round((t.transfer / limit) * 100)}%)`
    const label = name === 'total' ? '**total**' : name
    lines.push(
      `| ${label} | ${t.files} | ${formatBytes(t.raw)} | ${formatBytes(t.gzip)} | ${formatBytes(t.brotli)} | ${status} |`,
    )
  }
  lines.push('', '<details><summary>Every file</summary>', '')
  lines.push('| File | Category | Raw | Gzip | Brotli |', '| --- | --- | ---: | ---: | ---: |')
  for (const file of [...report.files].sort((a, b) => b.transfer - a.transfer)) {
    lines.push(
      `| \`${file.path}\` | ${file.category} | ${formatBytes(file.raw)} | ${formatBytes(file.gzip)} | ${formatBytes(file.brotli)} |`,
    )
  }
  lines.push('', '</details>', '')
  if (over.length > 0) {
    lines.push('### Over budget', '')
    for (const entry of over) {
      lines.push(
        entry.unknown
          ? `- \`${entry.name}\`: not a category (have ${[...CATEGORIES, 'total'].join(', ')})`
          : `- \`${entry.name}\`: ${formatBytes(entry.actual)} against a budget of ${formatBytes(entry.limit)} ` +
            `(${formatBytes(entry.actual - entry.limit)} over)`,
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

function main(argv) {
  const root = resolve(import.meta.dirname, '..')
  const args = [...argv]
  const take = (flag) => {
    const at = args.indexOf(flag)
    if (at < 0) {
      return null
    }
    const [, value] = args.splice(at, 2)
    return value ?? null
  }
  const jsonOut = take('--json')
  const budgetPath = resolve(take('--budget') ?? join(root, 'bundle-budget.json'))
  const dist = resolve(args[0] ?? join(root, 'dist'))

  if (!existsSync(dist)) {
    console.error(`error: ${dist} does not exist. Run \`npm run build\` first.`)
    process.exit(2)
  }
  const budgets = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, 'utf8')) : {}
  const report = analyze(dist)
  const over = overBudget(report, budgets)
  const markdown = renderMarkdown(report, budgets, over)

  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  }
  if (jsonOut) {
    writeFileSync(resolve(jsonOut), `${JSON.stringify({ totals: report.totals, files: report.files, over }, null, 2)}\n`)
  }
  if (over.length > 0) {
    console.error(`error: ${over.length} budget(s) exceeded (see ${budgetPath})`)
    process.exit(1)
  }
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  main(process.argv.slice(2))
}

// For the tests: run the real CLI against a directory.
export function runCli(dist, extra = []) {
  return spawnSync(process.execPath, [import.meta.filename, dist, ...extra], { encoding: 'utf8' })
}
