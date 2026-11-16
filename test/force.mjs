/**
 * Enforcement-layer tests: the audit exit contract, the strict whistle, and
 * the hard gate decision. No Harness is needed for any of them.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditFreshness, formatAudit } from '../lib/audit.js'
import { safeRealpath } from '../lib/collect.js'
import { resolveConfig } from '../lib/config.js'
import { decideCall, installHardGate } from '../lib/hardgate.js'
import { fileSignature } from '../lib/signature.js'
import { attachToAgent } from '../lib/whistle.js'
import { isEperm } from './support/sandbox.mjs'

process.env.DSH_SELFTEST_LANG = 'zh'
// The suite writes evidence next to each fixture (writeEvidence), so the
// config must point there too — on Linux the default is the phone cache
// directory (~/.dsh/cache/selftest), which would otherwise shadow the fixture.
const CFG = { ...resolveConfig({ git: '' }), evidenceDir: '' }
// `import.meta.dirname` is Node >= 20.11 only; the plugin supports Node 18.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'cli.js')

let passed = 0
let failed = 0
/** @type {Array<{ name: string, error: Error }>} */
const failures = []

/**
 * @param {string} name
 * @param {() => void|Promise<void>} fn
 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`✗ ${name}`)
  }
}

/** @param {string} [prefix] */
function tempDir(prefix = 'selftest-force-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}

/**
 * @param {string} dir
 * @param {any} artifact
 */
function writeEvidence(dir, artifact) {
  const base = join(dir, '.dsh', 'selftest')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'latest.json'), JSON.stringify(artifact, null, 2), 'utf8')
}

/* ------------------------------------------------------------------- audit */

await test('audit: changed files without evidence are unverified', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const audit = auditFreshness({ root: safeRealpath(fixture.dir), cfg: CFG })
    assert.equal(audit.verdict, 'unverified')
    assert.equal(audit.unverified.length, 1)
  } finally { fixture.cleanup() }
})

await test('audit: matching signatures + pass is fresh', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const signature = fileSignature(join(safeRealpath(fixture.dir), 'a.js'))
    writeEvidence(fixture.dir, {
      verdict: 'pass',
      files: [{ path: join(safeRealpath(fixture.dir), 'a.js'), rel: 'a.js', signature }],
    })
    const audit = auditFreshness({ root: safeRealpath(fixture.dir), cfg: CFG })
    assert.equal(audit.verdict, 'fresh')
    assert.equal(audit.verified, 1)
  } finally { fixture.cleanup() }
})

await test('audit: matching signatures + partial passes as partial', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const signature = fileSignature(join(safeRealpath(fixture.dir), 'a.js'))
    writeEvidence(fixture.dir, {
      verdict: 'partial',
      files: [{ path: join(safeRealpath(fixture.dir), 'a.js'), rel: 'a.js', signature }],
    })
    const audit = auditFreshness({ root: safeRealpath(fixture.dir), cfg: CFG })
    assert.equal(audit.verdict, 'partial')
  } finally { fixture.cleanup() }
})

await test('audit: matching signatures + fail is stale', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const signature = fileSignature(join(safeRealpath(fixture.dir), 'a.js'))
    writeEvidence(fixture.dir, {
      verdict: 'fail',
      files: [{ path: join(safeRealpath(fixture.dir), 'a.js'), rel: 'a.js', signature }],
    })
    const audit = auditFreshness({ root: safeRealpath(fixture.dir), cfg: CFG })
    assert.equal(audit.verdict, 'stale')
  } finally { fixture.cleanup() }
})

await test('audit: editing after the run re-opens the gate', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const before = fileSignature(join(safeRealpath(fixture.dir), 'a.js'))
    writeEvidence(fixture.dir, {
      verdict: 'pass',
      files: [{ path: join(safeRealpath(fixture.dir), 'a.js'), rel: 'a.js', signature: before }],
    })
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 2;', 'utf8')
    const audit = auditFreshness({ root: safeRealpath(fixture.dir), cfg: CFG })
    assert.equal(audit.verdict, 'unverified')
  } finally { fixture.cleanup() }
})

await test('audit: an unchanged tree is nothing', () => {
  const fixture = tempDir()
  try {
    const audit = auditFreshness({ root: safeRealpath(fixture.dir), cfg: CFG })
    assert.equal(audit.verdict, 'nothing')
  } finally { fixture.cleanup() }
})

await test('audit: formatAudit names the unverified files', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const audit = auditFreshness({ root: safeRealpath(fixture.dir), cfg: CFG })
    const text = formatAudit(audit)
    assert.ok(text.includes('a.js'))
    assert.ok(text.includes('selftest'))
  } finally { fixture.cleanup() }
})

await test('audit CLI: exit 0 when fresh, 1 when changed', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const signature = fileSignature(join(safeRealpath(fixture.dir), 'a.js'))
    writeEvidence(fixture.dir, {
      verdict: 'pass',
      files: [{ path: join(safeRealpath(fixture.dir), 'a.js'), rel: 'a.js', signature }],
    })
    const run = () => {
      try {
        // The child re-resolves config from its own env: on Linux that would
        // point evidence at the phone cache, so pin it to the fixture.
        execFileSync(process.execPath, [CLI, '--root', fixture.dir, '--audit'], {
          stdio: 'pipe',
          timeout: 30_000,
          env: { ...process.env, DSH_SELFTEST_EVIDENCE_DIR: join(fixture.dir, '.dsh', 'selftest') },
        })
        return 0
      } catch (error) {
        // Restricted sandboxes deny piped child processes; the CLI contract
        // itself is still covered by unit tests, so skip explicitly here.
        if (isEperm(error)) return 'EPERM'
        return typeof error.status === 'number' ? error.status : 1
      }
    }
    const first = run()
    if (first === 'EPERM') {
      console.log('  - skip: spawn EPERM (restricted sandbox)')
      return
    }
    assert.equal(first, 0)
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 2;', 'utf8')
    assert.equal(run(), 1)
  } finally { fixture.cleanup() }
})

/* ----------------------------------------------------------------- whistle */

await test('strict whistle: speaks again on the same content every turn', async () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const handlers = new Map()
    const followups = []
    const agent = {
      id: 's-strict',
      session: { id: 's-strict', header: { cwd: fixture.dir } },
      ctx: {
        on(event, fn) {
          const list = handlers.get(event) ?? []
          list.push(fn)
          handlers.set(event, list)
          return () => {}
        },
        effect() { return () => {} },
      },
      async followup(message) { followups.push(message) },
    }
    const state = { sessions: new Map(), agents: new WeakSet() }
    const settings = {
      mode: 'strict',
      maxWhistlesPerSession: 10,
      requireWhistleAfterWrite: true,
      evidenceDir: '',
      cfg: CFG,
    }
    const fakeCtx = { on() { return () => {} }, effect() { return () => {} } }
    attachToAgent(fakeCtx, agent, settings, state)
    const emit = async (event, payload) => {
      for (const fn of handlers.get(event) ?? []) await fn(payload)
    }
    await emit('tools/result', { name: 'write', arguments: { path: 'a.js' } })
    await emit('agent/turn-stopping')
    await emit('tools/result', { name: 'write', arguments: { path: 'a.js' } })
    await emit('agent/turn-stopping')
    assert.equal(followups.length, 2)
    assert.ok(followups[1].content[0].text.includes('打回'))
  } finally { fixture.cleanup() }
})

/* ---------------------------------------------------------------- hard gate */

await test('hard gate: write marks pending, the next shell call is denied once', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const sessions = new Map()
    const write = decideCall({ sessionId: 's1', root: safeRealpath(fixture.dir), toolName: 'write', sessions, cfg: CFG })
    assert.equal(write.action, 'allow')
    const shell = decideCall({ sessionId: 's1', root: safeRealpath(fixture.dir), toolName: 'pwsh', sessions, cfg: CFG })
    assert.equal(shell.action, 'deny')
    assert.ok(String(shell.reason).includes('selftest'))
    const again = decideCall({ sessionId: 's1', root: safeRealpath(fixture.dir), toolName: 'pwsh', sessions, cfg: CFG })
    assert.equal(again.action, 'allow', 'only one nag per pending cycle')
  } finally { fixture.cleanup() }
})

await test('hard gate: selftest clears pending', () => {
  const fixture = tempDir()
  try {
    const sessions = new Map()
    decideCall({ sessionId: 's1', root: safeRealpath(fixture.dir), toolName: 'write', sessions, cfg: CFG })
    const selftest = decideCall({ sessionId: 's1', root: safeRealpath(fixture.dir), toolName: 'selftest', sessions, cfg: CFG })
    assert.equal(selftest.action, 'allow')
    const shell = decideCall({ sessionId: 's1', root: safeRealpath(fixture.dir), toolName: 'pwsh', sessions, cfg: CFG })
    assert.equal(shell.action, 'allow')
  } finally { fixture.cleanup() }
})

await test('hard gate: read-only tools and file writes always pass', () => {
  const fixture = tempDir()
  try {
    const sessions = new Map()
    decideCall({ sessionId: 's1', root: safeRealpath(fixture.dir), toolName: 'write', sessions, cfg: CFG })
    for (const tool of ['read', 'grep', 'glob', 'edit']) {
      const decision = decideCall({ sessionId: 's1', root: safeRealpath(fixture.dir), toolName: tool, sessions, cfg: CFG })
      assert.equal(decision.action, 'allow', `${tool} must pass`)
    }
  } finally { fixture.cleanup() }
})

await test('hard gate: fresh evidence lets the flow continue', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const signature = fileSignature(join(safeRealpath(fixture.dir), 'a.js'))
    writeEvidence(fixture.dir, {
      verdict: 'pass',
      files: [{ path: join(safeRealpath(fixture.dir), 'a.js'), rel: 'a.js', signature }],
    })
    const sessions = new Map()
    decideCall({ sessionId: 's1', root: safeRealpath(fixture.dir), toolName: 'write', sessions, cfg: CFG })
    const shell = decideCall({ sessionId: 's1', root: safeRealpath(fixture.dir), toolName: 'pwsh', sessions, cfg: CFG })
    assert.equal(shell.action, 'allow')
  } finally { fixture.cleanup() }
})

await test('hard gate: mode off installs nothing', () => {
  const ctx = { on() { return () => {} }, effect() { return () => {} } }
  assert.equal(installHardGate(ctx, { hardGate: 'off' }), null)
})

/* --------------------------------------------------------------- summary */

console.log('')
console.log(`force: passed=${passed} failed=${failed}`)
if (failed > 0) {
  console.log('')
  for (const failure of failures) {
    console.log(`FAIL ${failure.name}`)
    console.log(failure.error?.stack ?? String(failure.error))
  }
  process.exit(1)
}
