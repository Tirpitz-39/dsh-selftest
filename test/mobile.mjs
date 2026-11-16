/**
 * Mobile / portability regression tests.
 *
 * These cover the failure modes a phone under proot hits: roots that live
 * under a skipped directory name (`.dsh`), git roots that are subdirectories,
 * missing PowerShell/Python, depth-limited scans, and the quick mode used for
 * "check what I just changed" on a narrow chat pane.
 *
 * Run: node test/mobile.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectChanges, hasSkippedSegment } from '../lib/collect.js'
import { canSpawnPiped } from './support/sandbox.mjs'
import { buildPlan, deriveTestSteps, findPluginDir, pluginPolicySteps } from '../lib/plan.js'
import {
  MOBILE_DEFAULTS,
  defaultEvidenceDir,
  isMobilePlatform,
  resolveConfig,
} from '../lib/config.js'
import { runSelftest, formatResult } from '../lib/core.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const GIT = ['git', '-C']

let passed = 0
let failed = 0
const failures = []

/**
 * @param {string} name
 * @param {() => void|Promise<void>} fn
 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`\u2713 ${name}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    failures.push({ name, message })
    console.log(`\u2717 ${name}`)
    console.log(message.split('\n').map(line => `    ${line}`).join('\n'))
  }
}

/**
 * @param {Record<string, string>} files
 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-selftest-mobile-'))
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return {
    dir,
    path: relative => join(dir, relative),
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}

const cfg = resolveConfig({})

// ---- collect: root under a skipped directory name -------------------------
await test('.dsh root does not drop collected files', () => {
  const f = fixture({ '.dsh/plug/lib/index.js': 'export const x = 1\n' })
  try {
    const root = f.path('.dsh/plug')
    const collection = collectChanges({ root, files: null, sinceMinutes: 10, maxFiles: 500, maxDepth: 4, cfg })
    assert.equal(collection.files.length, 1, `collected=${collection.files.length}`)
  } finally { f.cleanup() }
})

await test('explicit --files under a skipped segment is never dropped', () => {
  const f = fixture({ 'build/src/a.js': 'export const a = 1\n' })
  try {
    const target = f.path('build/src/a.js')
    const collection = collectChanges({ root: f.path('build'), files: [target], sinceMinutes: 10, maxFiles: 500, maxDepth: 4, cfg })
    assert.equal(collection.files.length, 1)
    assert.equal(collection.missing.length, 0)
  } finally { f.cleanup() }
})

await test('hasSkippedSegment only judges paths below the root', () => {
  assert.equal(hasSkippedSegment('/root/.dsh/plug', '/root/.dsh/plug/src/a.js'), false)
  assert.equal(hasSkippedSegment('/root/plug', '/root/plug/node_modules/a.js'), true)
})

await test('root inside a git subdirectory still uses git', () => {
  const f = fixture({ 'packages/x/foo.js': 'export const x = 1\n' })
  try {
    // A restricted sandbox denies piped child processes (EPERM): git cannot
    // answer there, and collect falls back to mtime by design. Probe once and
    // skip explicitly instead of reporting an environmental failure.
    if (!canSpawnPiped('git')) {
      console.log('  - skip: sandbox denies piped child processes (EPERM)')
      return
    }
    execFileSync('git', ['init', f.dir], { stdio: 'ignore' })
    execFileSync('git', ['-C', f.dir, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', f.dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], { stdio: 'ignore' })
    writeFileSync(f.path('packages/x/foo.js'), 'export const x = ;\n', 'utf8')
    // Age the file so the mtime fallback cannot be what finds it.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(f.path('packages/x/foo.js'), old, old)
    const root = f.path('packages/x')
    const collection = collectChanges({ root, files: null, sinceMinutes: 10, maxFiles: 500, maxDepth: 4, cfg })
    assert.equal(collection.gitAvailable, true, `gitAvailable=${collection.gitAvailable}`)
    assert.equal(collection.files.length, 1, `files=${collection.files.length}`)
  } finally { f.cleanup() }
})

// ---- plan: missing tools become explicit skips ----------------------------
await test('no PowerShell turns .ps1 into a skip step, not a spawn failure', () => {
  const f = fixture({ 'a.ps1': 'Write-Host 1\n' })
  try {
    const planCfg = { ...cfg, pwsh: '', parsePs1: '/nonexistent/parse-ps1.ps1' }
    const plan = buildPlan({ root: f.dir, files: [{ path: f.path('a.ps1'), source: 'mtime' }], cfg: planCfg })
    const step = plan.steps.find(candidate => candidate.id === 'ps1:unavailable')
    assert.ok(step, `steps=${plan.steps.map(candidate => candidate.id).join(',')}`)
    assert.equal(step.run().skipped, true)
  } finally { f.cleanup() }
})

await test('no Python turns .py into a skip step', () => {
  const f = fixture({ 'a.py': 'print(1)\n' })
  try {
    const planCfg = { ...cfg, ruff: '', python: '' }
    const plan = buildPlan({ root: f.dir, files: [{ path: f.path('a.py'), source: 'mtime' }], cfg: planCfg })
    const step = plan.steps.find(candidate => candidate.id === 'py:unavailable')
    assert.ok(step, `steps=${plan.steps.map(candidate => candidate.id).join(',')}`)
  } finally { f.cleanup() }
})

// ---- collect: depth limit is reported -------------------------------------
await test('depth limit is recorded instead of silently dropping files', () => {
  const f = fixture({ 'a/b/c/d/e/deep.js': 'export const deep = 1\n' })
  try {
    // Explicit depth so the test is platform-independent (mobile defaults are deeper).
    const collection = collectChanges({ root: f.dir, files: null, sinceMinutes: 10, maxFiles: 500, maxDepth: 4, cfg })
    assert.equal(collection.depthLimited, true, `depthLimited=${collection.depthLimited}`)
    const result = {
      verdict: 'pass',
      files: [],
      plannedSteps: [],
      results: [],
      counts: { total: 0, pass: 0, fail: 0, skip: 0 },
      skipped: [],
      sources: { depthLimited: true, truncated: false },
      artifactPath: null,
    }
    assert.match(formatResult(result), /深度|depth/i)
  } finally { f.cleanup() }
})

// ---- quick mode -----------------------------------------------------------
await test('quick mode plans no test steps and no plugin policy', () => {
  const f = fixture({
    'plug/lib/index.js': 'export const a = 1\n',
    'plug/package.json': JSON.stringify({ name: 'plug', scripts: { test: 'node -e "process.exit(0)"' } }),
    'plug/cordis.patch.yml': '- insert: []\n',
    'plug/test/test.mjs': 'console.log("ok")\n',
  })
  try {
    const planCfg = { ...cfg, quick: true, strictPlugins: true }
    const plan = buildPlan({
      root: f.dir,
      files: [{ path: f.path('plug/lib/index.js'), source: 'mtime' }],
      cfg: planCfg,
    })
    assert.equal(plan.steps.filter(step => step.family === 'test').length, 0)
    assert.equal(plan.steps.filter(step => step.family === 'plugin-policy').length, 0)
  } finally { f.cleanup() }
})

// ---- test discovery: tests/ and __tests__/ --------------------------------
await test('deriveTestSteps finds tests/ and __tests__/', () => {
  const f = fixture({
    'lib/index.js': 'export const a = 1\n',
    'tests/alpha.mjs': 'console.log("a")\n',
    '__tests__/beta.mjs': 'console.log("b")\n',
  })
  try {
    const steps = deriveTestSteps({ root: f.dir, files: [{ path: f.path('lib/index.js'), source: 'mtime' }], cfg })
    const names = steps.map(step => (step.args ?? []).join(' ')).join('|')
    assert.match(names, /alpha\.mjs/)
    assert.match(names, /beta\.mjs/)
  } finally { f.cleanup() }
})

// ---- plugin identification by manifest, not by directory name -------------
await test('plugin identified by dsh.bundle manifest', () => {
  const f = fixture({
    'plug/package.json': JSON.stringify({ name: 'plug', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'plug/lib/index.js': 'export const a = 1\n',
    'plug/cordis.patch.yml': '- insert: []\n',
  })
  try {
    const found = findPluginDir(f.path('plug/lib/index.js'), {})
    assert.ok(found && found.toLowerCase().endsWith('plug'), `found=${found}`)
    const steps = pluginPolicySteps([{ path: f.path('plug/lib/index.js'), source: 'git' }], {})
    assert.equal(steps.length, 1)
  } finally { f.cleanup() }
})

await test('pluginRoots env treats direct children as plugins', () => {
  const f = fixture({ 'dsh-go/plugins/foo/lib/index.js': 'export const a = 1\n' })
  try {
    const roots = join(f.dir, 'dsh-go', 'plugins')
    const found = findPluginDir(f.path('dsh-go/plugins/foo/lib/index.js'), { pluginRoots: roots })
    assert.ok(found && found.toLowerCase().endsWith(join('dsh-go', 'plugins', 'foo').toLowerCase()), `found=${found}`)
  } finally { f.cleanup() }
})

// ---- platform defaults ----------------------------------------------------
await test('mobile defaults are wider and cheaper than desktop defaults', () => {
  assert.equal(typeof isMobilePlatform(), 'boolean')
  assert.equal(MOBILE_DEFAULTS.maxDepth, 6)
  assert.equal(MOBILE_DEFAULTS.sinceMinutes, 30)
  assert.ok(MOBILE_DEFAULTS.timeoutMs < 120_000)
  assert.equal(typeof defaultEvidenceDir(), 'string')
})

console.log(`\nmobile: passed=${passed} failed=${failed}`)
if (failed > 0) {
  for (const failure of failures) console.log(`\nFAIL ${failure.name}\n${failure.message}`)
  process.exit(1)
}
