/**
 * The bundle-size report (scripts/bundle-size.mjs): that it sorts a build into
 * the right categories, measures what a player would download, enforces the
 * budgets with an exit code CI can fail on, and that the repo's own budget file
 * and workflow are what they should be.
 *
 * Run: npm run test:bundle
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  analyze,
  CATEGORIES,
  categorize,
  entryFiles,
  formatBytes,
  measure,
  overBudget,
  renderMarkdown,
  runCli,
} from './bundle-size.mjs'

const failures = []
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok  ${name}${detail ? `  — ${detail}` : ''}`)
    return
  }
  failures.push(detail ? `${name} — ${detail}` : name)
  console.error(`FAIL ${detail ? `${name} — ${detail}` : name}`)
}

const html = `<!doctype html><html><head>
  <link rel="icon" type="image/svg+xml" href="./favicon.svg" />
  <script type="module" crossorigin src="./assets/index-AAAA.js"></script>
  <link rel="modulepreload" crossorigin href="./assets/chunk-BBBB.js">
  <link rel="stylesheet" crossorigin href="./assets/index-CCCC.css">
  <script src="https://cdn.example.com/x.js"></script>
</head><body></body></html>`
const entries = entryFiles(html)
check('index.html\'s script, modulepreload and stylesheet are the entry; icons and other hosts are not',
  entries.size === 3 && entries.has('assets/index-AAAA.js') && entries.has('assets/chunk-BBBB.js') && entries.has('assets/index-CCCC.css'), [...entries].join(', '))

check('files are sorted into what the player waits for',
  categorize('index.html', entries) === 'entry' && categorize('assets/index-AAAA.js', entries) === 'entry' &&
  categorize('assets/worker-xyz.js', entries) === 'worker' && categorize('assets/core-1.wasm', entries) === 'wasm' &&
  categorize('assets/meshopt_decoder-1.js', entries) === 'lazy' && categorize('models/follower.glb', entries) === 'media' &&
  categorize('audio/chop.ogg', entries) === 'media' && categorize('favicon.svg', entries) === 'other')

{
  const text = Buffer.from('const answer = 42\n'.repeat(500))
  const m = measure('a.js', text)
  check('a script is measured gzipped, as a server would send it', m.raw === text.length && m.gzip === gzipSync(text, { level: 9 }).length && m.transfer === m.gzip && m.gzip < m.raw / 5)
  check('brotli is no worse than gzip on text', m.brotli <= m.gzip)
  const noise = Buffer.alloc(4000)
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24
  const audio = measure('chop.ogg', noise)
  check('audio and models are already compressed: transferred as they are', audio.transfer === audio.raw && audio.gzip === audio.raw)
  const incompressible = measure('x.js', noise)
  check('and compression never makes a response bigger', incompressible.gzip <= incompressible.raw && incompressible.transfer <= incompressible.raw)
  check('an empty file is empty', measure('e.js', Buffer.alloc(0)).transfer === 0)
}

const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
const sides = []
try {
  const put = (path, content) => {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  put('index.html', html)
  put('assets/index-AAAA.js', 'x'.repeat(30000))
  put('assets/chunk-BBBB.js', 'y'.repeat(1000))
  put('assets/index-CCCC.css', 'z'.repeat(2000))
  put('assets/worker-W.js', 'w'.repeat(5000))
  put('assets/core-1.wasm', Buffer.alloc(20000, 3))
  put('assets/meshopt_decoder-D.js', 'd'.repeat(8000))
  put('models/follower.glb', Buffer.alloc(6000, 9))
  put('audio/chop.ogg', Buffer.alloc(4000, 7))
  put('audio/.gitkeep', '')
  put('favicon.svg', '<svg/>')

  const report = analyze(dir)
  const t = report.totals
  check('every category is counted, dot-files left out', report.files.length === 10 && t.total.files === 10 && !report.files.some((f) => f.path.includes('.gitkeep')))
  check('entry is the page and what it loads', t.entry.files === 4 && t.entry.raw === html.length + 30000 + 1000 + 2000, `${t.entry.files} files, ${t.entry.raw} raw`)
  check('worker, wasm and lazy are one file each', t.worker.files === 1 && t.wasm.files === 1 && t.lazy.files === 1 && t.worker.raw === 5000 && t.lazy.raw === 8000)
  check('media is counted raw: the two files', t.media.files === 2 && t.media.transfer === 10000)
  check('the total is the sum of the categories', CATEGORIES.every((c) => t.total.raw >= t[c].raw) &&
    t.total.transfer === CATEGORIES.reduce((sum, c) => sum + t[c].transfer, 0) && t.total.raw === CATEGORIES.reduce((sum, c) => sum + t[c].raw, 0))

  check('nothing is over a generous budget', overBudget(report, { entry: 1e6, total: 1e6 }).length === 0)
  const over = overBudget(report, { entry: 100, wasm: 1e6, bogus: 5 })
  check('a category over budget is named with its numbers', over.length === 2 && over[0].name === 'entry' && over[0].limit === 100 && over[0].actual === t.entry.transfer)
  check('and a budget for a category that does not exist is flagged rather than ignored', over[1].name === 'bogus' && over[1].unknown === true)

  const markdown = renderMarkdown(report, { entry: 100, wasm: 1e6 }, over.slice(0, 1))
  check('the table has a row per category with sizes, and the total', ['| entry |', '| wasm |', '| **total** |', 'Gzip', 'Brotli'].every((part) => markdown.includes(part)))
  check('and says plainly what is over, by how much', markdown.includes('### Over budget') && markdown.includes('**over**') && markdown.includes('over)'))
  check('and lists every file, largest first', markdown.indexOf('assets/index-AAAA.js') < markdown.indexOf('favicon.svg'))
  const summaryTable = (md) => md.slice(0, md.indexOf('<details>'))
  const emptied = { ...report, totals: { ...t, other: { files: 0, raw: 0, gzip: 0, brotli: 0, transfer: 0 } } }
  check('an unbudgeted, empty category is left out of the table', !summaryTable(renderMarkdown(emptied, {}, [])).includes('| other |') &&
    summaryTable(renderMarkdown(emptied, { other: 5 }, [])).includes('| other |'))

  // The CLI is what CI runs: its exit code is the gate. Its inputs and outputs
  // live beside the build, not in it, or they would be measured too.
  const side = mkdtempSync(join(tmpdir(), 'bundle-side-'))
  sides.push(side)
  const budgetOk = join(side, 'ok.json')
  const budgetBad = join(side, 'bad.json')
  writeFileSync(budgetOk, JSON.stringify({ entry: 1e6, total: 1e7 }))
  writeFileSync(budgetBad, JSON.stringify({ entry: 10 }))
  const summary = join(side, 'summary.md')
  const jsonOut = join(side, 'report.json')
  const pass = runCli(dir, ['--budget', budgetOk, '--json', jsonOut])
  check('under budget it exits 0 and prints the table', pass.status === 0 && pass.stdout.includes('## Bundle size'), `exit ${pass.status}`)
  check('and writes the report as JSON', JSON.parse(readFileSync(jsonOut, 'utf8')).totals.total.files === 10)
  const fail = spawnWithSummary(dir, budgetBad, summary)
  check('over budget it exits 1 and says so', fail.status === 1 && fail.stderr.includes('budget(s) exceeded'), `exit ${fail.status}`)
  check('in CI the table also goes to the job summary', readFileSync(summary, 'utf8').includes('### Over budget'))
  const missing = runCli(join(dir, 'nope'))
  check('a build that is not there is a clear error, not a pass', missing.status === 2 && missing.stderr.includes('npm run build'), `exit ${missing.status}`)
  const none = runCli(dir, ['--budget', join(side, 'absent.json')])
  check('with no budget file it reports and passes', none.status === 0)
} finally {
  for (const path of [dir, ...sides]) rmSync(path, { recursive: true, force: true })
}

function spawnWithSummary(dist, budget, summary) {
  const previous = process.env.GITHUB_STEP_SUMMARY
  process.env.GITHUB_STEP_SUMMARY = summary
  try {
    return runCli(dist, ['--budget', budget])
  } finally {
    if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY
    else process.env.GITHUB_STEP_SUMMARY = previous
  }
}

// The repo's own: a budget that names real categories, and CI that runs the report.
{
  const budgets = JSON.parse(readFileSync(new URL('../bundle-budget.json', import.meta.url), 'utf8'))
  const known = new Set([...CATEGORIES, 'total'])
  check('bundle-budget.json budgets known categories, in positive bytes',
    Object.entries(budgets).every(([name, limit]) => known.has(name) && Number.isFinite(limit) && limit > 0), JSON.stringify(budgets))
  check('and budgets every category, so none can grow unwatched', [...known].every((name) => name in budgets))
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const build = ci.indexOf('run: npm run build\n')
  const report = ci.indexOf('npm run report:bundle')
  check('CI reports bundle size after the production build', build > 0 && report > build)
  check('and keeps the report even when the budget fails', /if: always\(\)[\s\S]{0,120}upload-artifact/.test(ci))
}

check('sizes read as people say them', formatBytes(512) === '512 B' && formatBytes(2048) === '2.00 kB' && formatBytes(51200) === '50.0 kB' && formatBytes(NaN) === '—')

if (failures.length > 0) {
  console.error(`\n${failures.length} bundle check(s) failed`)
  process.exit(1)
}
console.log('\nall bundle checks passed')
