/**
 * gauntlet.mjs — "去酒吧点蛋炒饭"式刁钻测试。
 *
 * 目标不是验证功能，而是验证「它会不会骗人」：
 * 不认识的输入是否静默通过、无法验证的东西是否假装 OK、出错时结论是否还正确。
 *
 * 跑法：node <本文件路径>
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickPwsh } from '../lib/config.js'
import { canSpawnPiped } from './support/sandbox.mjs'

// Assertions below match Chinese text; pin the language instead of relying on
// the host locale (CI runners are usually English).
process.env.DSH_SELFTEST_LANG = 'zh'

// Every case here drives the CLI through piped child processes. A restricted
// sandbox denies those (EPERM); skip the whole suite explicitly there instead
// of reporting a wall of false failures.
if (!canSpawnPiped(process.execPath)) {
  console.log('gauntlet: skipped (restricted sandbox: piped child processes are denied)')
  process.exit(0)
}

const NODE = process.execPath
const CLI = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
const PWSH = pickPwsh('')

let pass = 0
let fail = 0
const failures = []

function mk() { return mkdtempSync(join(tmpdir(), 'gauntlet-')) }
function w(dir, rel, content) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}
function rm(dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }

function runCli(args, { timeout = 90_000, noJson = false } = {}) {
  const argv = [CLI, ...args]
  if (!noJson) argv.push('--json')
  try {
    const out = execFileSync(NODE, argv, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, json: parse(out), out }
  } catch (err) {
    const out = String(err.stdout ?? '')
    return { code: err.status ?? -1, json: parse(out), out, stderr: String(err.stderr ?? '') }
  }
}
function parse(s) { try { return JSON.parse(s) } catch { return null } }

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`) }
  else { fail += 1; failures.push({ name, detail }); console.log(`  FAIL ${name} — ${detail ?? ''}`) }
}

// ---------------------------------------------------------------------------
console.log('# 1. 不认识的扩展名：必须是 skip，不能静默算通过')
{
  const d = mk()
  try {
    w(d, 'a.xyz', 'hello')
    const r = runCli([d])
    const skipped = r.json?.skipped ?? []
    check('未知扩展名记录在 skipped', skipped.some(s => String(s.file).endsWith('a.xyz')))
    check('skip 原因写明扩展名', skipped.some(s => /不认识的扩展名/.test(String(s.reason))))
    check('verdict 不是 fail（没有可查项）', r.json?.verdict !== 'fail', `verdict=${r.json?.verdict}`)
  } finally { rm(d) }
}

console.log('# 2. 二进制文件：不崩、不误判')
{
  const d = mk()
  try {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x00, 0x13])
    w(d, 'blob.bin', bytes)
    const r = runCli([d])
    check('二进制文件不导致崩溃（有 JSON 输出）', r.json !== null)
    check('二进制文件被 skip 而不是 pass 进检查', (r.json?.skipped ?? []).some(s => String(s.file).endsWith('blob.bin')))
  } finally { rm(d) }
}

console.log('# 3. 空文件：空 JS 合法、空 JSON 不合法')
{
  const d = mk()
  try {
    w(d, 'empty.js', '')
    const r1 = runCli([d])
    check('空 .js 通过（node --check 合法）', r1.json?.verdict === 'pass', `verdict=${r1.json?.verdict}`)
  } finally { rm(d) }
  const d2 = mk()
  try {
    w(d2, 'empty.json', '')
    const r2 = runCli([d2])
    check('空 .json 失败', r2.json?.verdict === 'fail', `verdict=${r2.json?.verdict}`)
  } finally { rm(d2) }
}

console.log('# 4. 语法错误的 JS：必须 fail')
{
  const d = mk()
  try {
    w(d, 'broken.js', 'export const x = {')
    const r = runCli([d])
    check('语法错误 JS 判 fail', r.json?.verdict === 'fail', `verdict=${r.json?.verdict}`)
  } finally { rm(d) }
}

console.log('# 5. 语法正确但逻辑荒谬的 JS：当前设计下只能 pass（已知边界）')
{
  const d = mk()
  try {
    w(d, 'silly.js', 'export const div = 1 / 0\n')
    const r = runCli([d])
    check('语法对但逻辑错 → pass（插件不验证行为，这是文档承认的边界）', r.json?.verdict === 'pass', `verdict=${r.json?.verdict}`)
  } finally { rm(d) }
}

console.log('# 6. 非 ASCII 无 BOM 的 .ps1：Windows PowerShell 5.1 会乱码，必须 fail')
{
  if (!existsSync(PWSH)) { console.log('  skip：无 pwsh') } else {
    const d = mk()
    try {
      w(d, 'cn.ps1', "Write-Host '你好世界'\n")
      const r = runCli([d])
      check('非 ASCII 无 BOM 的 .ps1 判 fail', r.json?.verdict === 'fail', `verdict=${r.json?.verdict}`)
    } finally { rm(d) }
  }
}

console.log('# 7. 插件改了源码但没有测试：必须 FAIL')
{
  const d = mk()
  try {
    w(d, 'dev/plugins/no-tests/lib/index.js', 'export const a = 1\n')
    w(d, 'dev/plugins/no-tests/cordis.patch.yml', '- insert: []\n')
    const r = runCli([d])
    check('无测试插件判 fail', r.json?.verdict === 'fail', `verdict=${r.json?.verdict}`)
    check('失败原因提到没有测试', JSON.stringify(r.json).includes('没有自带测试') || JSON.stringify(r.json).includes('既没有'))
  } finally { rm(d) }
}

console.log('# 8. 插件有测试：跑测试并通过')
{
  const d = mk()
  try {
    w(d, 'dev/plugins/has-tests/lib/index.js', 'export const a = 1\n')
    w(d, 'dev/plugins/has-tests/cordis.patch.yml', '- insert: []\n')
    w(d, 'dev/plugins/has-tests/test/test.mjs', 'console.log("ok")\n')
    const r = runCli([d])
    // cordis.patch.yml is an unchecked extension, so the honest verdict is
    // partial; the point of this case is that the plugin policy does not fire.
    check('有测试插件不判 fail', r.json?.verdict !== 'fail', `verdict=${r.json?.verdict}`)
    check('插件政策没有误报', !(r.json?.results ?? []).some(row => String(row.family) === 'plugin-policy'))
  } finally { rm(d) }
}

console.log('# 9. --files 指定一个不存在的文件：不能静默通过')
{
  const d = mk()
  try {
    w(d, 'real.js', 'export const ok = 1\n')
    const r = runCli([d, '--files', join(d, 'ghost.js')])
    const verdict = r.json?.verdict
    const skipped = (r.json?.skipped ?? []).map(s => String(s.file) + '|' + String(s.reason)).join('; ')
    console.log(`    verdict=${verdict} files=${(r.json?.files ?? []).length} skipped=[${skipped}]`)
    check('不存在的显式文件没有被当成"检查过了"', !(r.json?.files ?? []).some(f => String(f.path).endsWith('ghost.js')))
    check('显式文件不存在时结果至少不是悄悄 pass 且零记录', verdict === 'fail' || /ghost|不存在|not found/i.test(skipped), `verdict=${verdict} skipped=${skipped}`)
  } finally { rm(d) }
}

console.log('# 10. 中文 + 空格路径')
{
  const d = mk()
  try {
    w(d, '有 空格 的目录/中文 文件.js', 'export const ok = 1\n')
    const r = runCli([d])
    check('中文空格路径能正常检查并 pass', r.json?.verdict === 'pass', `verdict=${r.json?.verdict}`)
  } finally { rm(d) }
}

console.log('# 11. 500+ 文件：截断必须显式标记')
{
  const d = mk()
  try {
    for (let i = 0; i < 600; i += 1) w(d, `f${i}.js`, `export const x${i} = ${i}\n`)
    const r = runCli([d])
    check('超过 maxFiles 时 truncated=true', r.json?.sources?.truncated === true, `truncated=${r.json?.sources?.truncated}`)
  } finally { rm(d) }
}

console.log('# 12. --explain 只计划、不执行')
{
  const d = mk()
  try {
    w(d, 'broken.js', 'export const x = {')
    const r = runCli([d, '--explain'])
    check('explain 模式 exit 0', r.code === 0, `code=${r.code}`)
    check('explain 模式没有执行结果', (r.json?.results ?? []).length === 0, `results=${(r.json?.results ?? []).length}`)
  } finally { rm(d) }
}

console.log('# 13. 卡死的测试：超时必须判 fail，不能挂起')
{
  const d = mk()
  try {
    w(d, 'dev/plugins/slow/lib/index.js', 'export const a = 1\n')
    w(d, 'dev/plugins/slow/test/test.mjs', 'setTimeout(() => process.exit(0), 30000)\n')
    const r = runCli([d, '--timeout', '1500'], { timeout: 30_000 })
    const timedOut = JSON.stringify(r.json ?? {}).includes('timedOut')
    check('超时导致 fail', r.json?.verdict === 'fail', `verdict=${r.json?.verdict}`)
    check('结果里标记了超时', timedOut, JSON.stringify(r.json ?? {}).slice(0, 200))
  } finally { rm(d) }
}

console.log('# 14. 只改 .md：没有可查项，但 skip 有记录')
{
  const d = mk()
  try {
    w(d, 'notes.md', '# hi\n')
    const r = runCli([d])
    check('只有 .md 时 verdict 不是 fail', r.json?.verdict !== 'fail', `verdict=${r.json?.verdict}`)
    check('.md 被 skip 记录', (r.json?.skipped ?? []).some(s => String(s.file).endsWith('notes.md')))
  } finally { rm(d) }
}

console.log('# 15. 目录当文件传：不崩、给明确原因')
{
  const d = mk()
  try {
    w(d, 'dir/file.js', 'export const ok = 1\n')
    const r = runCli([d, '--files', join(d, 'dir')])
    check('目录入参不崩（有 JSON）', r.json !== null, `code=${r.code}`)
    console.log(`    verdict=${r.json?.verdict} skipped=${JSON.stringify((r.json?.skipped ?? []).map(s => s.reason))}`)
  } finally { rm(d) }
}

console.log('')
console.log(`passed=${pass} failed=${fail}`)
if (fail > 0) {
  console.log('FAILURES:')
  for (const f of failures) console.log(` - ${f.name}: ${f.detail ?? ''}`)
}
process.exit(fail > 0 ? 1 : 0)
