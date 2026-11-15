/**
 * i18n tests: language resolution, message lookup, and an end-to-end check
 * that the CLI really switches its user-facing text (--help / --json text /
 * --quiet / --prove) between Chinese and English.
 *
 * Run: node test/i18n.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLang, setLang, t } from '../lib/i18n.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'lib', 'cli.js')
const NODE = process.execPath

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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-selftest-i18n-'))
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

/**
 * @param {string[]} args
 * @param {string} lang
 * @returns {{ code: number, out: string }}
 */
function runCli(args, lang) {
  try {
    const out = execFileSync(NODE, [CLI, ...args], {
      encoding: 'utf8',
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_SELFTEST_LANG: lang },
    })
    return { code: 0, out }
  } catch (error) {
    const status = /** @type {{ status?: number, stdout?: unknown }} */ (error)
    return { code: typeof status.status === 'number' ? status.status : 1, out: String(status.stdout ?? '') }
  }
}

const CJK = /[\u4e00-\u9fff]/

// ---- unit: language resolution -------------------------------------------
await test('resolveLang: explicit override wins', () => {
  assert.equal(resolveLang({ DSH_SELFTEST_LANG: 'zh' }), 'zh')
  assert.equal(resolveLang({ DSH_SELFTEST_LANG: 'en', LANG: 'zh_CN.UTF-8' }), 'en')
})
await test('resolveLang: zh / en prefixes are recognized', () => {
  assert.equal(resolveLang({ DSH_SELFTEST_LANG: 'zh-Hans' }), 'zh')
  assert.equal(resolveLang({ DSH_SELFTEST_LANG: 'en-US' }), 'en')
  assert.equal(resolveLang({ DSH_SELFTEST_LANG: 'ja-JP' }), 'en')
})
await test('resolveLang: LC_ALL / LANG / LANGUAGE decide when no override', () => {
  assert.equal(resolveLang({ LC_ALL: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveLang({ LANG: 'en_US.UTF-8' }), 'en')
  assert.equal(resolveLang({ LANGUAGE: 'zh_CN:zh' }), 'zh')
})
await test('resolveLang: falls back to the runtime locale', () => {
  const runtime = resolveLang({})
  assert.ok(runtime === 'zh' || runtime === 'en')
})

// ---- unit: message lookup ------------------------------------------------
await test('t: Chinese message is Chinese, English message is not', () => {
  setLang('zh')
  assert.match(t('unknownExt', { ext: '.xyz' }), /不认识的扩展名/)
  setLang('en')
  assert.match(t('unknownExt', { ext: '.xyz' }), /Unknown extension/)
  assert.doesNotMatch(t('unknownExt', { ext: '.xyz' }), CJK)
})
await test('t: unknown key returns the key itself', () => {
  setLang('en')
  assert.equal(t('no_such_key_xyz'), 'no_such_key_xyz')
})
await test('t: missing params stay visible instead of rendering empty', () => {
  setLang('en')
  assert.match(t('unknownExt'), /\{ext\}/)
})

// ---- end-to-end: the CLI switches its text -------------------------------
await test('CLI --help: English and Chinese usage', () => {
  const en = runCli(['--help'], 'en')
  assert.equal(en.code, 0)
  assert.match(en.out, /Usage:/)
  assert.match(en.out, /--root <dir>/)
  const zh = runCli(['--help'], 'zh')
  assert.equal(zh.code, 0)
  assert.match(zh.out, /用法：/)
})

await test('CLI --json text: skip reason is localized', () => {
  const f = fixture({ 'a.xyz': 'hello\n' })
  try {
    const en = runCli(['--root', f.dir, '--files', 'a.xyz', '--json', '--no-persist'], 'en')
    assert.equal(en.code, 0)
    const enJson = JSON.parse(en.out)
    assert.match(enJson.text, /Skipped|Unknown extension/)
    assert.doesNotMatch(enJson.text, CJK)
    const zh = runCli(['--root', f.dir, '--files', 'a.xyz', '--json', '--no-persist'], 'zh')
    const zhJson = JSON.parse(zh.out)
    assert.match(zhJson.text, /跳过/)
    assert.match(zhJson.skipped[0].reason, /不认识的扩展名/)
  } finally { f.cleanup() }
})

await test('CLI --quiet: verdict line is localized', () => {
  const f = fixture({ 'ok.js': 'export const ok = 1\n' })
  try {
    const en = runCli(['--root', f.dir, '--files', 'ok.js', '--quiet', '--no-persist'], 'en')
    assert.equal(en.code, 0)
    assert.match(en.out, /passed/)
    const zh = runCli(['--root', f.dir, '--files', 'ok.js', '--quiet', '--no-persist'], 'zh')
    assert.equal(zh.code, 0)
    assert.match(zh.out, /通过/)
  } finally { f.cleanup() }
})

await test('CLI --prove: health-check text is localized', () => {
  const f = fixture({})
  try {
    const en = runCli(['--root', f.dir, '--prove', '--json', '--no-persist'], 'en')
    assert.equal(en.code, 0)
    const enJson = JSON.parse(en.out)
    assert.match(enJson.text, /health check/)
    assert.ok(enJson.cases.every(entry => !CJK.test(String(entry.what))))
    const zh = runCli(['--root', f.dir, '--prove', '--json', '--no-persist'], 'zh')
    const zhJson = JSON.parse(zh.out)
    assert.match(zhJson.text, /检查器体检/)
  } finally { f.cleanup() }
})

// Leave the process in the suite default for any imports that run later.
setLang('zh')

console.log(`\ni18n: passed=${passed} failed=${failed}`)
if (failed > 0) {
  for (const failure of failures) console.log(`\nFAIL ${failure.name}\n${failure.message}`)
  process.exit(1)
}
