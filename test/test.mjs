/**
 * dsh-selftest unit + end-to-end tests.
 *
 * Run: node test/test.mjs
 *
 * Fixtures live under the OS temp directory, never in a real workspace, so a
 * run cannot "pass" by inspecting the machine instead of the code. The
 * PowerShell cases are skipped (not failed) when pwsh is absent, because the
 * plugin is still correct on a machine without it.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectChanges, parsePorcelain, unquote } from '../lib/collect.js'
import { buildPlan, deriveTestSteps, jsModuleKind, listTestFiles, parseJsonFile, pluginPolicySteps } from '../lib/plan.js'
import { expandStep, formatResult, runSelftest } from '../lib/core.js'
import { prune, persistReport, readLatest } from '../lib/report.js'
import { findOnPath, pickGit, pickParseScript, pickPwsh, resolveConfig } from '../lib/config.js'
import { proveSelf } from '../lib/prove.js'
import { apply, argumentList } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(HERE, '..')
const NODE = process.execPath
// Discovered, not hard-coded: the suite must work on any machine, and the
// PowerShell cases skip (not fail) when no parser is available.
const PWSH = pickPwsh('')
const PARSE_PS1 = pickParseScript()
const GIT = pickGit('')
const HAVE_PS1 = existsSync(PWSH) && existsSync(PARSE_PS1)

process.env.DSH_SELFTEST_PWSH = PWSH
process.env.DSH_SELFTEST_PARSE_PS1 = PARSE_PS1
process.env.DSH_SELFTEST_GIT = GIT
delete process.env.DSH_SELFTEST_TSC
delete process.env.DSH_SELFTEST_RUFF
// The suite asserts Chinese text, so pin the language instead of depending on
// the host locale (CI runners are usually English).
process.env.DSH_SELFTEST_LANG = 'zh'

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

/** @typedef {{ dir: string, cleanup: () => void }} Fixture */

/**
 * @param {Record<string, string>} files relative path -> content
 * @returns {Fixture}
 */
function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-selftest-fixture-'))
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}

/* ------------------------------------------------------------------ tests */

await test('parsePorcelain keeps edits, drops deletions, follows renames', () => {
  const text = [
    ' M src/app.js',
    '?? new file.json',
    'R  old/name.js -> new/name.js',
    ' D gone.js',
    'A  added.ps1',
    '',
  ].join('\n')
  const files = parsePorcelain(text, 'C:\\work')
  assert.equal(files.length, 4, 'four surviving entries')
  assert.ok(files.some(f => f.endsWith('app.js')))
  assert.ok(files.some(f => f.endsWith('new file.json')), 'spaces in the path survive')
  assert.ok(files.some(f => f.endsWith('new\\name.js') || f.endsWith('new/name.js')), 'renamed path wins')
  assert.ok(files.some(f => f.endsWith('added.ps1')))
  assert.ok(!files.some(f => f.endsWith('gone.js')), 'deleted file dropped')
})

await test('unquote removes git C-style quoting', () => {
  assert.equal(unquote('"a\\"b.js"'), 'a"b.js')
  assert.equal(unquote('plain.js'), 'plain.js')
})

await test('listTestFiles prefers test.* over helpers', () => {
  const fixture = makeFixture({
    'test/helper.mjs': 'export const x = 1',
    'test/test.mjs': 'console.log(1)',
  })
  try {
    const files = listTestFiles(join(fixture.dir, 'test'))
    assert.equal(files.length, 1)
    assert.ok(files[0].endsWith('test.mjs'))
  } finally { fixture.cleanup() }
})

await test('parseJsonFile accepts valid JSON and rejects broken JSON', () => {
  const fixture = makeFixture({ 'ok.json': '{"a":1}', 'bad.json': '{"a":' })
  try {
    assert.equal(parseJsonFile(join(fixture.dir, 'ok.json')).ok, true)
    assert.equal(parseJsonFile(join(fixture.dir, 'bad.json')).ok, false)
  } finally { fixture.cleanup() }
})

await test('buildPlan groups files by extension and marks unknown ones skipped', () => {
  const fixture = makeFixture({
    'a.ps1': 'function f { 1 }',
    'b.mjs': 'export const x = 1',
    'c.json': '{}',
    'd.txt': 'nothing to check',
  })
  try {
    const cfg = resolveConfig({})
    const files = collectChanges({
      root: fixture.dir,
      files: ['a.ps1', 'b.mjs', 'c.json', 'd.txt'],
      sinceMinutes: 10,
      maxFiles: 100,
      maxDepth: 4,
      cfg,
    }).files
    const plan = buildPlan({ root: fixture.dir, files, cfg })
    assert.equal(plan.counts.ps1, 1)
    assert.equal(plan.counts.js, 1)
    assert.equal(plan.counts.json, 1)
    assert.equal(plan.counts.other, 1)
    assert.equal(plan.skipped.length, 1)
    assert.equal(plan.skipped[0].file, 'd.txt')
    const ps1Step = plan.steps.find(step => step.id === 'ps1:batch')
    assert.ok(ps1Step !== undefined, 'ps1 files are batched into one step')
    assert.equal(ps1Step.listFiles.length, 1)
  } finally { fixture.cleanup() }
})

await test('deriveTestSteps finds a sibling test/ directory', () => {
  const fixture = makeFixture({
    'plugins/demo/lib/index.js': 'export const a = 1',
    'plugins/demo/test/test.mjs': 'console.log("ran")',
  })
  try {
    const cfg = resolveConfig({})
    const files = collectChanges({
      root: fixture.dir,
      files: [join(fixture.dir, 'plugins/demo/lib/index.js')],
      sinceMinutes: 10,
      maxFiles: 100,
      maxDepth: 4,
      cfg,
    }).files
    const steps = deriveTestSteps({ root: fixture.dir, files, cfg })
    assert.equal(steps.length, 1)
    assert.ok(steps[0].args[0].endsWith('test.mjs'))
  } finally { fixture.cleanup() }
})

await test('deriveTestSteps respects package.json scripts.test', () => {
  const fixture = makeFixture({
    'pkg/src/a.js': 'export const a = 1',
    'pkg/package.json': JSON.stringify({ name: 'pkg', scripts: { test: 'node run-tests.js' } }),
  })
  try {
    const cfg = resolveConfig({})
    const files = collectChanges({
      root: fixture.dir,
      files: [join(fixture.dir, 'pkg/src/a.js')],
      sinceMinutes: 10,
      maxFiles: 100,
      maxDepth: 4,
      cfg,
    }).files
    const steps = deriveTestSteps({ root: fixture.dir, files, cfg })
    assert.equal(steps.length, 1)
    if (findOnPath(['npm']) === '') {
      // No npm on this machine: the plan must say so explicitly instead of
      // spawning a command that cannot exist.
      assert.equal(steps[0].kind, 'inline')
      assert.equal(steps[0].run().ok, false)
      assert.match(steps[0].run().detail, /npm/)
    } else {
      assert.equal(steps[0].viaCmd, true, 'npm shims go through cmd.exe on Windows')
      assert.ok(steps[0].args.includes('test'))
    }
  } finally { fixture.cleanup() }
})

await test('deriveTestSteps prefers runnable test files over npm test', () => {
  const fixture = makeFixture({
    'pkg/src/a.js': 'export const a = 1',
    'pkg/package.json': JSON.stringify({ name: 'pkg', scripts: { test: 'npm-run-something' } }),
    'pkg/test/test.mjs': 'console.log("ok")\n',
  })
  try {
    const cfg = resolveConfig({})
    const files = collectChanges({
      root: fixture.dir,
      files: [join(fixture.dir, 'pkg/src/a.js')],
      sinceMinutes: 10,
      maxFiles: 100,
      maxDepth: 4,
      cfg,
    }).files
    const steps = deriveTestSteps({ root: fixture.dir, files, cfg })
    assert.equal(steps.length, 1)
    assert.equal(steps[0].exe, cfg.node)
    assert.ok(steps[0].args[0].endsWith('test.mjs'))
    assert.notEqual(steps[0].viaCmd, true)
  } finally { fixture.cleanup() }
})

await test('pluginPolicySteps fails a changed plugin that ships no tests', () => {
  const fixture = makeFixture({
    'dev/plugins/no-tests-here/lib/index.js': 'export const a = 1\n',
  })
  try {
    const steps = pluginPolicySteps([
      { path: join(fixture.dir, 'dev', 'plugins', 'no-tests-here', 'lib', 'index.js'), source: 'git' },
    ])
    assert.equal(steps.length, 1)
    assert.equal(steps[0].kind, 'policy')
    assert.equal(steps[0].run().ok, false)
  } finally { fixture.cleanup() }
})

await test('pluginPolicySteps stays quiet for a plugin that has tests', () => {
  const steps = pluginPolicySteps([
    { path: join(PACKAGE_DIR, 'lib', 'index.js'), source: 'git' },
  ])
  // This package lives under dev\plugins\dsh-selftest and has test/test.mjs,
  // so the policy rule must not fire.
  assert.equal(steps.length, 0)
})

await test('prune keeps only the newest run files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-selftest-prune-'))
  try {
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(dir, `run-${index}.json`), '{}', 'utf8')
    }
    prune(dir, 2)
    const left = readdirSync(dir).filter(name => name.endsWith('.json'))
    assert.equal(left.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('persistReport writes latest.json and the run artifact', () => {
  const fixture = makeFixture({})
  try {
    const saved = persistReport(fixture.dir, { runId: 'selftest-test', verdict: 'pass' }, 5)
    assert.equal(saved.error, null)
    assert.ok(existsSync(join(fixture.dir, '.dsh', 'selftest', 'latest.json')))
    const latest = readLatest(fixture.dir)
    assert.equal(latest.verdict, 'pass')
  } finally { fixture.cleanup() }
})

await test('expandStep splits a ps1 batch payload into per-file rows', () => {
  const step = { id: 'ps1:batch', kind: 'command', title: 'batch', listFiles: ['a.ps1'] }
  const outcome = {
    status: 'fail',
    exitCode: 0,
    ms: 5,
    timedOut: false,
    output: JSON.stringify({
      files: [
        { file: 'C:\\w\\a.ps1', ok: true, errors: [] },
        { file: 'C:\\w\\b.ps1', ok: false, errors: [{ message: 'boom', line: 3 }] },
      ],
    }),
  }
  const rows = expandStep(step, outcome, 'C:\\w')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].status, 'pass')
  assert.equal(rows[1].status, 'fail')
  assert.match(rows[1].detail, /L3: boom/)
})

await test('runSelftest passes on a clean JS/JSON fixture', async () => {
  const fixture = makeFixture({
    'good.mjs': 'export const value = 1\n',
    'config.json': '{\n  "ok": true\n}\n',
  })
  try {
    const result = await runSelftest({
      root: fixture.dir,
      sinceMinutes: 10,
      persist: true,
    })
    assert.equal(result.verdict, 'pass', formatResult(result, { verbose: true }))
    assert.equal(result.counts.fail, 0)
    assert.ok(result.counts.total >= 2)
    assert.ok(existsSync(join(fixture.dir, '.dsh', 'selftest', 'latest.json')))
    assert.equal(result.claimChecks.length, 1, 'a claim_plan-ready check is offered')
  } finally { fixture.cleanup() }
})

await test('runSelftest fails on broken JS and broken JSON', async () => {
  const fixture = makeFixture({
    'broken.mjs': 'export const value = ;\n',
    'broken.json': '{"a":\n',
  })
  try {
    const result = await runSelftest({ root: fixture.dir, sinceMinutes: 10, persist: false })
    assert.equal(result.verdict, 'fail')
    assert.equal(result.counts.fail >= 2, true, 'both broken files fail')
  } finally { fixture.cleanup() }
})

await test('runSelftest only runs the tests that own the changed file', async () => {
  const fixture = makeFixture({
    'plugins/demo/lib/index.js': 'export const a = 1\n',
    'plugins/demo/test/test.mjs': 'process.exitCode = 0\n',
  })
  try {
    const result = await runSelftest({
      root: fixture.dir,
      files: [join(fixture.dir, 'plugins/demo/lib/index.js')],
      persist: false,
    })
    const js = result.results.find(row => row.family === 'check' || row.id.startsWith('js:'))
    const testRow = result.results.find(row => String(row.id).startsWith('test:'))
    assert.ok(js !== undefined, 'the source file is syntax-checked')
    assert.ok(testRow !== undefined, 'the owning test suite runs')
    assert.equal(testRow.status, 'pass')
  } finally { fixture.cleanup() }
})

await test('an explicitly requested missing file fails instead of being ignored', async () => {
  const fixture = makeFixture({ 'a.js': 'export const ok = 1\n' })
  try {
    const result = await runSelftest({
      root: fixture.dir,
      files: [join(fixture.dir, 'ghost.js')],
      persist: false,
    })
    assert.equal(result.verdict, 'fail')
    assert.ok(result.missing.some(path => path.endsWith('ghost.js')))
    assert.ok(result.results.some(row => row.status === 'fail'))
  } finally { fixture.cleanup() }
})

await test('proveSelf turns each checker red on a known-bad sample and green on a clean one', async () => {
  const result = await proveSelf()
  assert.ok(result.total >= 8, `expected at least 8 prove cases, got ${result.total}`)
  assert.equal(result.passed, result.total, JSON.stringify(result.cases.filter(c => !c.ok)))
  assert.ok(result.cases.some(c => c.id === 'broken-js' && c.actual === 'fail'))
  assert.ok(result.cases.some(c => c.id === 'clean-code' && c.actual === 'pass'))
  assert.ok(result.cases.some(c => c.id === 'missing-file' && c.actual === 'fail'))
})

await test('argumentList maps the prove flag', () => {
  const argv = argumentList({ prove: true }, {})
  assert.ok(argv.includes('--prove'))
})

await test('plan mode records steps without executing them', async () => {
  const fixture = makeFixture({ 'broken.mjs': 'export const value = ;\n' })
  try {
    const result = await runSelftest({ root: fixture.dir, mode: 'plan', sinceMinutes: 10 })
    assert.equal(result.verdict, 'plan')
    assert.equal(result.results.length, 0, 'nothing ran')
    assert.ok(result.plannedSteps.length > 0)
    assert.equal(readLatest(fixture.dir), null, 'plan mode writes no evidence')
  } finally { fixture.cleanup() }
})

await test('runSelftest reports "nothing" for an unchanged tree', async () => {
  const fixture = makeFixture({})
  try {
    const result = await runSelftest({ root: fixture.dir, sinceMinutes: 1, persist: false })
    assert.equal(result.verdict, 'nothing')
    assert.equal(result.counts.total, 0)
  } finally { fixture.cleanup() }
})

if (HAVE_PS1) {
  await test('runSelftest parses PowerShell files through the real parser', async () => {
    const fixture = makeFixture({
      'good.ps1': 'function Get-Thing { param([int]$n) return $n * 2 }\n',
      'bad.ps1': 'function Get-Thing { param([int]$n) return $n * \n',
    })
    try {
      const result = await runSelftest({ root: fixture.dir, sinceMinutes: 10, persist: false })
      const rows = result.results.filter(row => row.family === 'ps1')
      if (rows.length === 2) {
        // Normal environment: stdout was captured, so the batch splits per file.
        const good = rows.find(row => row.title === 'good.ps1')
        const bad = rows.find(row => row.title === 'bad.ps1')
        assert.equal(good?.status, 'pass', JSON.stringify(rows))
        assert.equal(bad?.status, 'fail', JSON.stringify(rows))
      } else {
        // Confined sandbox: the child's stdout cannot be piped back, so the
        // batch stays one row and only the exit code is available. A broken
        // file must still fail the batch - parse-ps1.ps1 exits 1 for that.
        assert.equal(rows.length, 1, `expected 1 or 2 ps1 rows, got ${rows.length}: ${JSON.stringify(rows)}`)
        assert.equal(rows[0].status, 'fail', 'a broken .ps1 must fail the collapsed batch')
        assert.equal(result.verdict, 'fail')
      }
    } finally { fixture.cleanup() }
  })
} else {
  console.log('\u25cb skipped: PowerShell parser cases (pwsh or parse-ps1.ps1 not found)')
}

await test('apply() registers a selftest tool with a JSON-Schema parameter block', () => {
  /** @type {any} */
  let registered = null
  const ctx = {
    tools: { register: (tool) => { registered = tool; return () => {} } },
  }
  apply(ctx)
  assert.ok(registered !== null, 'register was called')
  assert.equal(registered.name, 'selftest')
  assert.equal(registered.parameters.type, 'object')
  assert.ok('action' in registered.parameters.properties)
  assert.ok('root' in registered.parameters.properties)
  assert.equal(typeof registered.execute, 'function')
  assert.equal(typeof registered.output.render, 'function')

  const rendered = registered.output.render({}, { text: '\u2705 selftest pass\uff1a1/1 \u901a\u8fc7' })
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /selftest pass/)

  const empty = registered.output.render({}, {})
  assert.match(empty[0].text, /\u6ca1\u6709\u4ea7\u751f\u53ef\u663e\u793a\u7684\u7ed3\u679c/)
})

await test('argumentList maps tool arguments to CLI flags', () => {
  const argv = argumentList(
    { action: 'plan', root: 'C:\\w', since: 15, files: ['a.ps1', 'b.json'], strictPlugins: false },
    null,
  )
  assert.deepEqual(argv.slice(0, 2), ['--json', '--explain'])
  assert.ok(argv.includes('--root') && argv.includes('C:\\w'))
  assert.ok(argv.includes('--since') && argv.includes('15'))
  assert.ok(argv.includes('--files') && argv.includes('a.ps1,b.json'))
  assert.ok(argv.includes('--no-strict-plugins'))

  const defaults = argumentList({}, { agent: { session: { header: { cwd: 'C:\\w' } } } })
  assert.deepEqual(defaults, ['--json', '--root', 'C:\\w'])
})

await test('jsModuleKind keeps module resolution deterministic across Node versions', () => {
  const fixture = makeFixture({
    'plain/broken.js': 'export const = 1\n',
    'pkg-esm/package.json': '{ "type": "module" }\n',
    'pkg-esm/a.js': 'export const a = 1\n',
    'pkg-cjs/package.json': '{ "type": "commonjs" }\n',
    'pkg-cjs/b.js': 'module.exports = 1\n',
  })
  try {
    assert.equal(jsModuleKind(join(fixture.dir, 'plain/broken.js'), fixture.dir), 'esm')
    assert.equal(jsModuleKind(join(fixture.dir, 'pkg-esm/a.js'), fixture.dir), 'esm')
    assert.equal(jsModuleKind(join(fixture.dir, 'pkg-cjs/b.js'), fixture.dir), 'cjs')
    assert.equal(jsModuleKind(join(fixture.dir, 'pkg-esm/a.mjs'), fixture.dir), 'esm')
    assert.equal(jsModuleKind(join(fixture.dir, 'pkg-esm/a.cjs'), fixture.dir), 'cjs')
  } finally { fixture.cleanup() }
})

await test('buildPlan checks bare ESM .js through an .mjs copy (Node 20/22 --check bug)', () => {
  const fixture = makeFixture({ 'broken.js': 'export const = 1\n', 'ok.json': '{}\n' })
  try {
    const files = [
      { path: join(fixture.dir, 'broken.js'), source: 'mtime' },
      { path: join(fixture.dir, 'ok.json'), source: 'mtime' },
    ]
    const plan = buildPlan({
      root: fixture.dir,
      files,
      cfg: { node: NODE, pwsh: PWSH, parsePs1: PARSE_PS1, ts: '', tsc: '', ruff: '', python: '', strictPlugins: false },
    })
    const jsStep = plan.steps.find(step => step.id.startsWith('js:'))
    assert.ok(jsStep, 'js step exists')
    assert.equal(jsStep.esmCopy, join(fixture.dir, 'broken.js'))
    assert.deepEqual(jsStep.args, ['--check', '{{ESM_COPY}}'])
  } finally { fixture.cleanup() }
})

/* --------------------------------------------------------------- summary */

console.log('')
console.log(`passed=${passed} failed=${failed}`)
if (failed > 0) {
  console.log('')
  for (const failure of failures) {
    console.log(`FAIL ${failure.name}`)
    console.log(failure.message)
  }
  process.exit(1)
}
process.exit(0)
