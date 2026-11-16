/**
 * Whistle tests.
 *
 * The whistle is our own mechanism: a per-file signature comparison between
 * "what changed" and "what selftest verified". These tests exercise it against
 * a fake agent — no real Harness, no real session — plus the neutral `checks`
 * contract that any consumer can read.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { safeRealpath } from '../lib/collect.js'
import { runSelftest } from '../lib/core.js'
import { fileSignature, sameSignature } from '../lib/signature.js'
import {
  evaluateWhistle,
  installWhistle,
  isWriteTool,
  whistleKey,
  whistleText,
} from '../lib/whistle.js'

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
function tempDir(prefix = 'selftest-whistle-') {
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
 * @param {string} cwd
 */
function fakeHarness(cwd) {
  /** @type {Map<string, Array<(payload?: any) => any>>} */
  const handlers = new Map()
  const ctx = {
    /** @param {string} event @param {(payload?: any) => any} fn */
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {}
    },
    effect() {
      return () => {}
    },
  }
  /** @type {any[]} */
  const followups = []
  const agent = {
    id: 'agent-1',
    session: { id: 'agent-1', header: { cwd } },
    ctx,
    async followup(message) {
      followups.push(message)
    },
  }
  /** @param {string} event @param {any} [payload] */
  const emit = async (event, payload) => {
    for (const fn of handlers.get(event) ?? []) await fn(payload)
  }
  return { ctx, agent, followups, emit }
}

/* --------------------------------------------------- write classification */

await test('isWriteTool: write/edit always count', () => {
  assert.equal(isWriteTool('write', {}), true)
  assert.equal(isWriteTool('edit', {}), true)
  assert.equal(isWriteTool('str_replace_editor', {}), true)
})

await test('isWriteTool: shell writes count, reads do not', () => {
  assert.equal(isWriteTool('pwsh', { arguments: { command: 'Set-Content a.txt "x"' } }), true)
  assert.equal(isWriteTool('bash', { arguments: { command: 'rm -rf build' } }), true)
  assert.equal(isWriteTool('pwsh', { arguments: { command: 'git status --porcelain' } }), false)
  assert.equal(isWriteTool('bash', { arguments: { command: 'node --check lib/x.js' } }), false)
  assert.equal(isWriteTool('read', { arguments: { path: 'a.txt' } }), false)
})

/* ------------------------------------------------------------ signatures */

await test('sameSignature: identical content is equal, changed content is not', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(fixture.dir, 'a.txt'), 'one', 'utf8')
    const first = fileSignature(join(fixture.dir, 'a.txt'))
    writeFileSync(join(fixture.dir, 'a.txt'), 'one-two', 'utf8')
    const second = fileSignature(join(fixture.dir, 'a.txt'))
    assert.notEqual(second.sha, first.sha)
    assert.equal(sameSignature(first, first), true)
    assert.equal(sameSignature(first, second), false)
    assert.equal(sameSignature(null, first), false)
  } finally { fixture.cleanup() }
})

await test('whistleKey: the same file at the same content has the same key', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(fixture.dir, 'a.txt'), 'abc', 'utf8')
    const signature = fileSignature(join(fixture.dir, 'a.txt'))
    const key = whistleKey({ path: 'a.txt', signature })
    assert.equal(key, whistleKey({ path: 'a.txt', signature }))
    assert.notEqual(key, whistleKey({ path: 'a.txt', signature: { ...signature, sha: 'other' } }))
  } finally { fixture.cleanup() }
})

/* ----------------------------------------------------------- evaluation */

await test('evaluateWhistle: no evidence means every changed file is unverified', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const decision = evaluateWhistle({ root: safeRealpath(fixture.dir), cfg: CFG, artifact: null })
    assert.equal(decision.shouldWhistle, true)
    assert.equal(decision.unchecked.length, 1)
    assert.equal(decision.checked, 0)
  } finally { fixture.cleanup() }
})

await test('evaluateWhistle: matching evidence means silence', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const signature = fileSignature(join(safeRealpath(fixture.dir), 'a.js'))
    writeEvidence(fixture.dir, {
      verdict: 'pass',
      files: [{ path: join(safeRealpath(fixture.dir), 'a.js'), rel: 'a.js', source: 'mtime', signature }],
    })
    const decision = evaluateWhistle({ root: safeRealpath(fixture.dir), cfg: CFG, artifact: { verdict: 'pass', files: [{ path: join(safeRealpath(fixture.dir), 'a.js'), rel: 'a.js', signature }] } })
    assert.equal(decision.shouldWhistle, false)
  } finally { fixture.cleanup() }
})

await test('evaluateWhistle: editing a file after verification re-arms the whistle', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const before = fileSignature(join(safeRealpath(fixture.dir), 'a.js'))
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 2;', 'utf8')
    const artifact = { verdict: 'pass', files: [{ path: join(safeRealpath(fixture.dir), 'a.js'), rel: 'a.js', signature: before }] }
    const decision = evaluateWhistle({ root: safeRealpath(fixture.dir), cfg: CFG, artifact })
    assert.equal(decision.shouldWhistle, true)
    assert.equal(decision.unchecked.length, 1)
  } finally { fixture.cleanup() }
})

await test('evaluateWhistle: a plan run is not evidence', () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const signature = fileSignature(join(safeRealpath(fixture.dir), 'a.js'))
    const artifact = { verdict: 'plan', files: [{ path: join(safeRealpath(fixture.dir), 'a.js'), rel: 'a.js', signature }] }
    const decision = evaluateWhistle({ root: safeRealpath(fixture.dir), cfg: CFG, artifact })
    assert.equal(decision.shouldWhistle, true)
  } finally { fixture.cleanup() }
})

await test('evaluateWhistle: an unchanged tree never whistles', () => {
  const fixture = tempDir()
  try {
    const decision = evaluateWhistle({ root: safeRealpath(fixture.dir), cfg: CFG, artifact: null })
    assert.equal(decision.shouldWhistle, false)
  } finally { fixture.cleanup() }
})

/* -------------------------------------------------------- agent wiring */

await test('attachToAgent: a write then turn-stopping whistles once', async () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const fake = fakeHarness(fixture.dir)
    const state = { sessions: new Map(), agents: new WeakSet() }
    const settings = { mode: 'warn', maxWhistlesPerSession: 2, requireWhistleAfterWrite: true, evidenceDir: '', cfg: CFG }
    const { attachToAgent } = await import('../lib/whistle.js')
    attachToAgent(fake.ctx, fake.agent, settings, state)

    await fake.emit('tools/result', { name: 'write', arguments: { path: 'a.js' } })
    await fake.emit('agent/turn-stopping')

    assert.equal(fake.followups.length, 1)
    assert.equal(fake.followups[0].role, 'user')
    assert.ok(fake.followups[0].content[0].text.includes('selftest'))
  } finally { fixture.cleanup() }
})

await test('attachToAgent: a read-only turn stays silent', async () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const fake = fakeHarness(fixture.dir)
    const state = { sessions: new Map(), agents: new WeakSet() }
    const settings = { mode: 'warn', maxWhistlesPerSession: 2, requireWhistleAfterWrite: true, evidenceDir: '', cfg: CFG }
    const { attachToAgent } = await import('../lib/whistle.js')
    attachToAgent(fake.ctx, fake.agent, settings, state)

    await fake.emit('tools/result', { name: 'pwsh', arguments: { command: 'git status' } })
    await fake.emit('agent/turn-stopping')

    assert.equal(fake.followups.length, 0)
  } finally { fixture.cleanup() }
})

await test('attachToAgent: the same file at the same content is not whistled twice', async () => {
  const fixture = tempDir()
  try {
    writeFileSync(join(safeRealpath(fixture.dir), 'a.js'), 'export const a = 1;', 'utf8')
    const fake = fakeHarness(fixture.dir)
    const state = { sessions: new Map(), agents: new WeakSet() }
    const settings = { mode: 'warn', maxWhistlesPerSession: 2, requireWhistleAfterWrite: true, evidenceDir: '', cfg: CFG }
    const { attachToAgent } = await import('../lib/whistle.js')
    attachToAgent(fake.ctx, fake.agent, settings, state)

    await fake.emit('tools/result', { name: 'write', arguments: { path: 'a.js' } })
    await fake.emit('agent/turn-stopping')
    await fake.emit('tools/result', { name: 'write', arguments: { path: 'a.js' } })
    await fake.emit('agent/turn-stopping')

    assert.equal(fake.followups.length, 1)
  } finally { fixture.cleanup() }
})

await test('attachToAgent: mode off installs nothing', () => {
  const ctx = { on() { return () => {} }, effect() { return () => {} } }
  assert.equal(installWhistle(ctx, { whistleMode: 'off' }), null)
})

/* --------------------------------------------------- neutral checks field */

await test('runSelftest: checks is neutral and claimChecks mirrors it', async () => {
  const fixture = tempDir()
  try {
    const result = await runSelftest({ root: safeRealpath(fixture.dir), persist: false })
    assert.ok(Array.isArray(result.checks))
    assert.equal(result.checks.length, 1)
    assert.equal(result.claimChecks.length, 1)
    assert.deepEqual(result.checks, result.claimChecks)
    assert.equal(result.checks[0].kind, 'command')
    assert.equal(result.checks[0].required, true)
    assert.ok(String(result.checks[0].command).includes('selftest'))
    assert.ok(!String(result.checks[0].title).includes('claim'), 'the neutral check must not mention claim plugins')
  } finally { fixture.cleanup() }
})

await test('whistleText: names files, budget and evidence path', () => {
  const text = whistleText(
    { total: 5, unchecked: [{ rel: 'src/a.js' }, { rel: 'src/b.py' }] },
    1,
    2,
    '.dsh/selftest/latest.json',
  )
  assert.ok(text.includes('src/a.js'))
  assert.ok(text.includes('src/b.py'))
  assert.ok(text.includes('.dsh/selftest/latest.json'))
  assert.ok(text.includes('1/2'))
})

/* --------------------------------------------------------------- summary */

console.log('')
console.log(`whistle: passed=${passed} failed=${failed}`)
if (failed > 0) {
  console.log('')
  for (const failure of failures) {
    console.log(`FAIL ${failure.name}`)
    console.log(failure.error?.stack ?? String(failure.error))
  }
  process.exit(1)
}
