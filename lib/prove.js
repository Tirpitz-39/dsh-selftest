/**
 * prove.js — 检查器的体检（「有本事你证明给我看」）。
 *
 * 每个检查器都先拿已知的坏样本试一次：它必须报红；再拿已知的好样本试一次：
 * 它必须放行。检查器自己没被验证过，就没资格检查别的代码。
 *
 * @module dsh-selftest/prove
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveConfig } from './config.js'
import { runSelftest } from './core.js'
import { t } from './i18n.js'

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'selftest-prove-'))
}
function write(dir, rel, content) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

/**
 * @typedef {{ id: string, what: string, expected: string, actual: string, ok: boolean, detail?: string, inconclusive?: boolean }} ProveCaseResult
 */

/**
 * 体检项。每个 `run()` 建立独立 fixture，返回实际观测值；`ok` 为 false 表示
 * 检查器在这个样本上骗了人。
 *
 * @returns {Promise<ProveCaseResult[]>}
 */
async function cases() {
  const out = []
  const cfg = resolveConfig({})

  /** @param {string} root @param {Record<string, unknown>} extra */
  const run = (root, extra = {}) => runSelftest({ root, persist: false, ...extra })

  const add = (id, what, expected, actual, ok, detail = '', inconclusive = false) => {
    out.push({ id, what, expected, actual, ok, detail, inconclusive })
  }

  // 1. 语法错误的 JS 必须红
  {
    const d = makeDir()
    try {
      write(d, 'broken.js', 'export const = 1\n')
      const r = await run(d)
      const why = r.results.map(x => `${x.id}:${x.status}:${String(x.output).slice(0, 120)}`).join(' | ')
      add('broken-js', t('proveBrokenJs'), 'fail', r.verdict, r.verdict === 'fail', why)
    } finally { cleanup(d) }
  }

  // 2. 坏 JSON 必须红
  {
    const d = makeDir()
    try {
      write(d, 'broken.json', '{ "a": 1, }\n')
      const r = await run(d)
      add('broken-json', t('proveBrokenJson'), 'fail', r.verdict, r.verdict === 'fail')
    } finally { cleanup(d) }
  }

  // 3. 编码缺陷的 .ps1 必须红（没有 PowerShell 就如实记 skip）
  {
    if (cfg.pwsh === '' || cfg.pwsh === 'pwsh' || !cfg.parsePs1) {
      add('ps1-encoding', t('provePs1Encoding'), 'skip', 'skip', true, t('provePs1Skipped'), true)
    } else {
      const d = makeDir()
      try {
        write(d, 'cn.ps1', "Write-Host '你好'\n")
        const r = await run(d)
        add('ps1-encoding', t('provePs1Encoding'), 'fail', r.verdict, r.verdict === 'fail')
      } finally { cleanup(d) }
    }
  }

  // 4. 会失败的测试必须红
  {
    const d = makeDir()
    try {
      write(d, 'dev/plugins/prove-fail/lib/x.js', 'export const x = 1\n')
      write(d, 'dev/plugins/prove-fail/test/test.mjs', 'process.exit(1)\n')
      const r = await run(d)
      add('failing-test', t('proveFailingTest'), 'fail', r.verdict, r.verdict === 'fail')
    } finally { cleanup(d) }
  }

  // 5. 显式指定不存在的文件必须红
  {
    const d = makeDir()
    try {
      write(d, 'ok.js', 'export const ok = 1\n')
      const r = await run(d, { files: [join(d, 'ghost.js')] })
      add('missing-file', t('proveMissingFile'), 'fail', r.verdict, r.verdict === 'fail')
    } finally { cleanup(d) }
  }

  // 6. 不存在的 root 必须红
  {
    const d = makeDir()
    try {
      const r = await run(join(d, 'no-such-dir'))
      add('missing-root', t('proveMissingRoot'), 'fail', r.verdict, r.verdict === 'fail')
    } finally { cleanup(d) }
  }

  // 7. 未知扩展名必须被记录，不能静默算通过
  {
    const d = makeDir()
    try {
      write(d, 'a.xyz', 'hello\n')
      const r = await run(d)
      const recorded = Array.isArray(r.skipped) && r.skipped.some(s => String(s.file).endsWith('a.xyz'))
      add('unknown-ext', t('proveUnknownExt'), 'recorded', recorded ? 'recorded' : 'lost', recorded && r.verdict !== 'fail')
    } finally { cleanup(d) }
  }

  // 8. 正向对照：干净的代码必须放行（检查器不能只会骂人）
  {
    const d = makeDir()
    try {
      // A package.json keeps the .js module kind deterministic. Without it,
      // `node --check` reads `export` as CommonJS syntax on Node 18/20/22 and
      // fails the clean sample — CI caught this, local Node 24's syntax
      // detection hid it.
      write(d, 'package.json', '{ "type": "module" }\n')
      write(d, 'clean.js', 'export const clean = 1\n')
      write(d, 'clean.json', '{ "ok": true }\n')
      const r = await run(d)
      add('clean-code', t('proveCleanCode'), 'pass', r.verdict, r.verdict === 'pass')
    } finally { cleanup(d) }
  }

  // 9. 空目录：明确 nothing
  {
    const d = makeDir()
    try {
      const r = await run(d)
      add('empty-dir', t('proveEmptyDir'), 'nothing', r.verdict, r.verdict === 'nothing')
    } finally { cleanup(d) }
  }

  return out
}

/**
 * @returns {Promise<{ ok: boolean, passed: number, total: number, cases: ProveCaseResult[], text: string }>}
 */
export async function proveSelf() {
  const results = await cases()
  const verified = results.filter(r => r.ok && r.inconclusive !== true).length
  const inconclusive = results.filter(r => r.inconclusive === true).length
  const total = results.length
  const ok = results.every(r => r.ok)
  const title = inconclusive > 0
    ? t('proveTitleWithInconclusive', { verified, total, inconclusive })
    : t('proveTitle', { verified, total })
  const lines = [title]
  for (const r of results) {
    const mark = r.ok ? (r.inconclusive === true ? '~' : '✓') : '✗'
    const extra = r.detail ? t('proveExtra', { detail: r.detail }) : ''
    lines.push(t('proveLine', { mark, id: r.id, what: r.what, expected: r.expected, actual: r.actual, extra }))
  }
  return { ok, verified, inconclusive, passed: verified, total, cases: results, text: lines.join('\n') }
}
