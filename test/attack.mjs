/**
 * Attack tests: try to trick selftest, and record what actually holds.
 *
 * These are not "the plugin has a bug" tests — some are known, documented
 * boundaries (local evidence is a plain JSON file, so it can be forged), and
 * some are real bypasses that were fixed (mtime rollback, empty-root selftest
 * clearing the hard gate). Each case states which one it is.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { auditFreshness } from '../lib/audit.js'
import { collectChanges, safeRealpath } from '../lib/collect.js'
import { resolveConfig } from '../lib/config.js'
import { runSelftest } from '../lib/core.js'
import { decideCall } from '../lib/hardgate.js'
import { fileSignature } from '../lib/signature.js'
import { attachToAgent } from '../lib/whistle.js'
import { isEperm } from './support/sandbox.mjs'

process.env.DSH_SELFTEST_LANG = 'zh'
const CFG = resolveConfig({ git: '' })

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
function tempDir(prefix = 'selftest-attack-') {
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

/**
 * @param {string} dir
 * @param {string} rel
 * @param {string} content
 */
function file(dir, rel, content) {
  const path = join(dir, rel)
  writeFileSync(path, content, 'utf8')
  return path
}

/* ------------------------------------------------------------------ audit */

await test('attack: mtime rollback cannot hide a tampered file from audit', async () => {
  const fixture = tempDir()
  try {
    const path = file(fixture.dir, 'a.js', 'export const a = 1;\n')
    const run = await runSelftest({ root: fixture.dir, config: { git: '' } })
    assert.equal(run.files.length, 1, `selftest must record the fresh file (verdict=${run.verdict})`)
    // Tamper, then hide the change outside the 10-minute mtime window.
    writeFileSync(path, 'export const a = 666;\n', 'utf8')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(path, old, old)

    const audit = auditFreshness({ root: fixture.dir, cfg: CFG })
    assert.equal(audit.verdict, 'unverified', 'a rolled-back mtime must not hide the change')
    assert.equal(audit.unverified.length, 1)
  } finally { fixture.cleanup() }
})

await test('attack: forged evidence with a wrong signature is rejected', () => {
  const fixture = tempDir()
  try {
    const path = file(fixture.dir, 'a.js', 'export const a = 1;\n')
    writeEvidence(fixture.dir, {
      verdict: 'pass',
      files: [{ path, signature: { size: 1, mtimeMs: 1, sha: 'deadbeefdeadbeef' } }],
    })
    const audit = auditFreshness({ root: fixture.dir, cfg: CFG })
    assert.equal(audit.verdict, 'unverified')
  } finally { fixture.cleanup() }
})

await test('attack: deleting a verified file is caught', async () => {
  const fixture = tempDir()
  try {
    const path = file(fixture.dir, 'a.js', 'export const a = 1;\n')
    const run = await runSelftest({ root: fixture.dir, config: { git: '' } })
    assert.equal(run.files.length, 1, `selftest must record the fresh file (verdict=${run.verdict})`)
    rmSync(path)
    const audit = auditFreshness({ root: fixture.dir, cfg: CFG })
    assert.equal(audit.verdict, 'unverified')
    assert.ok(audit.unverified.some(entry => /删除|deleted/i.test(entry.reason)))
  } finally { fixture.cleanup() }
})

await test('attack: corrupted evidence JSON is treated as no evidence', () => {
  const fixture = tempDir()
  try {
    file(fixture.dir, 'a.js', 'export const a = 1;\n')
    const base = join(fixture.dir, '.dsh', 'selftest')
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, 'latest.json'), '{ this is not json', 'utf8')
    const audit = auditFreshness({ root: fixture.dir, cfg: CFG })
    assert.equal(audit.verdict, 'unverified')
  } finally { fixture.cleanup() }
})

await test('attack: evidence without signatures is not trusted', () => {
  const fixture = tempDir()
  try {
    const path = file(fixture.dir, 'a.js', 'export const a = 1;\n')
    writeEvidence(fixture.dir, { verdict: 'pass', files: [{ path }] })
    const audit = auditFreshness({ root: fixture.dir, cfg: CFG })
    assert.equal(audit.verdict, 'unverified')
  } finally { fixture.cleanup() }
})

await test('attack: a failing recorded verdict is rejected', () => {
  const fixture = tempDir()
  try {
    const real = safeRealpath(fixture.dir)
    const path = file(real, 'a.js', 'export const a = 1;\n')
    writeEvidence(fixture.dir, {
      verdict: 'fail',
      files: [{ path, signature: fileSignature(path) }],
    })
    const audit = auditFreshness({ root: fixture.dir, cfg: CFG })
    assert.equal(audit.verdict, 'stale')
  } finally { fixture.cleanup() }
})

await test('known boundary: correctly-forged local evidence is accepted', () => {
  const fixture = tempDir()
  try {
    const real = safeRealpath(fixture.dir)
    const path = file(real, 'a.js', 'export const a = 1;\n')
    // The attacker can read the file and compute the same signature. Local
    // evidence is a plain JSON file with no secret, so this is accepted by
    // design — documented in README ("not a cryptographic guarantee").
    writeEvidence(fixture.dir, {
      verdict: 'pass',
      files: [{ path, signature: fileSignature(path) }],
    })
    const audit = auditFreshness({ root: fixture.dir, cfg: CFG })
    assert.equal(audit.verdict, 'fresh')
  } finally { fixture.cleanup() }
})

/* ----------------------------------------------------------------- hard gate */

await test('attack: empty-root selftest cannot clear the hard gate', () => {
  const fixture = tempDir()
  const empty = tempDir()
  try {
    file(fixture.dir, 'a.js', 'export const a = 1;\n')
    const sessions = new Map()
    decideCall({ sessionId: 's', root: fixture.dir, toolName: 'write', arguments: {}, sessions, cfg: CFG })

    const selftest = decideCall({
      sessionId: 's', root: fixture.dir, toolName: 'selftest', arguments: { root: empty.dir }, sessions, cfg: CFG,
    })
    assert.equal(selftest.action, 'allow', 'selftest itself is always allowed')

    const after = decideCall({ sessionId: 's', root: fixture.dir, toolName: 'pwsh', arguments: {}, sessions, cfg: CFG })
    assert.equal(after.action, 'deny', 'a selftest aimed elsewhere must not disarm the gate')
  } finally { fixture.cleanup(); empty.cleanup() }
})

await test('attack: a selftest aimed at the session root does clear the gate', () => {
  const fixture = tempDir()
  try {
    file(fixture.dir, 'a.js', 'export const a = 1;\n')
    const sessions = new Map()
    decideCall({ sessionId: 's', root: fixture.dir, toolName: 'write', arguments: {}, sessions, cfg: CFG })
    decideCall({
      sessionId: 's', root: fixture.dir, toolName: 'selftest', arguments: { root: fixture.dir }, sessions, cfg: CFG,
    })
    const after = decideCall({ sessionId: 's', root: fixture.dir, toolName: 'pwsh', arguments: {}, sessions, cfg: CFG })
    assert.equal(after.action, 'allow')
  } finally { fixture.cleanup() }
})

await test('attack: continuing to write keeps the gate armed', () => {
  const fixture = tempDir()
  try {
    file(fixture.dir, 'a.js', 'export const a = 1;\n')
    const sessions = new Map()
    decideCall({ sessionId: 's', root: fixture.dir, toolName: 'write', arguments: {}, sessions, cfg: CFG })
    // File writes stay allowed (fix loops), but the gate stays armed.
    decideCall({ sessionId: 's', root: fixture.dir, toolName: 'edit', arguments: {}, sessions, cfg: CFG })
    const shell = decideCall({ sessionId: 's', root: fixture.dir, toolName: 'pwsh', arguments: {}, sessions, cfg: CFG })
    assert.equal(shell.action, 'deny')
  } finally { fixture.cleanup() }
})

/* ------------------------------------------------------------- whistle/strict */

await test('attack: strict whistle has a hard budget ceiling', async () => {
  const fixture = tempDir()
  try {
    file(fixture.dir, 'a.js', 'export const a = 1;\n')
    const handlers = new Map()
    const followups = []
    const agent = {
      id: 's',
      session: { id: 's', header: { cwd: fixture.dir } },
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
    const settings = { mode: 'strict', maxWhistlesPerSession: 1, requireWhistleAfterWrite: true, evidenceDir: '', cfg: CFG }
    attachToAgent({ on() { return () => {} }, effect() { return () => {} } }, agent, settings, state)
    const emit = async (event, payload) => {
      for (const fn of handlers.get(event) ?? []) await fn(payload)
    }
    await emit('tools/result', { name: 'write', arguments: { path: 'a.js' } })
    await emit('agent/turn-stopping')
    await emit('tools/result', { name: 'write', arguments: { path: 'a.js' } })
    await emit('agent/turn-stopping')
    assert.equal(followups.length, 1, 'the budget ceiling stops the loop')
  } finally { fixture.cleanup() }
})

/* --------------------------------------------------------------- collection */

await test('attack: symlinks are not followed into other files', () => {
  const fixture = tempDir()
  const outside = tempDir()
  try {
    file(outside.dir, 'secret.js', 'export const secret = 1;\n')
    try {
      symlinkSync(join(outside.dir, 'secret.js'), join(fixture.dir, 'link.js'))
    } catch (error) {
      // Creating symlinks needs a privilege the test environment may not have.
      if (isEperm(error)) {
        console.log('  - skip: symlink creation denied (EPERM)')
        return
      }
      throw error
    }
    const collection = collectChanges({
      root: fixture.dir, files: null, sinceMinutes: 10, maxFiles: 500, maxDepth: 4, cfg: CFG,
    })
    assert.ok(
      !collection.files.some(entry => entry.path.endsWith('link.js')),
      'a symlink must not be collected as a changed file',
    )
  } finally { fixture.cleanup(); outside.cleanup() }
})

/* --------------------------------------------------------------- summary */

console.log('')
console.log(`attack: passed=${passed} failed=${failed}`)
if (failed > 0) {
  console.log('')
  for (const failure of failures) {
    console.log(`FAIL ${failure.name}`)
    console.log(failure.error?.stack ?? String(failure.error))
  }
  process.exit(1)
}
