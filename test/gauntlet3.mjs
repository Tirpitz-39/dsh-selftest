/**
 * gauntlet3.mjs — 第三组对抗测试：专打新加的 --prove 体检，以及它和各种参数的组合。
 *
 * 还是那句话：不测"功能存在"，测"它会不会骗人"。每个断言都带可观测值。
 * 跑法：node test/gauntlet3.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE = process.execPath
const CLI = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
const GIT = 'git'

let pass = 0
let fail = 0
const failures = []

function mk() { return mkdtempSync(join(tmpdir(), 'gauntlet3-')) }
function w(dir, rel, content) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}
function rm(dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }

function runCli(args, { timeout = 120_000, json = true } = {}) {
  const argv = json ? [CLI, ...args, '--json'] : [CLI, ...args]
  try {
    const out = execFileSync(NODE, argv, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, json: parse(out), out }
  } catch (err) {
    return { code: err.status ?? -1, json: parse(String(err.stdout ?? '')), out: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}
function parse(s) { try { return JSON.parse(s) } catch { return null } }
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`) } else { fail += 1; failures.push({ name, detail }); console.log(`  FAIL ${name} — ${detail ?? ''}`) }
}
function proveDirs() {
  try { return new Set(readdirSync(tmpdir()).filter(n => n.startsWith('selftest-prove-'))) } catch { return new Set() }
}

// 1. 基本：--prove exit 0 且输出体检结果
{
  const r = runCli(['--prove'])
  check('1. --prove exit 0', r.code === 0, `code=${r.code}`)
  check('2. 文本含「检查器体检」', /检查器体检/.test(String(r.json?.text ?? '')), String(r.json?.text ?? '').slice(0, 80))
  check('3. 报告 9/9 通过', /9\/9 通过/.test(String(r.json?.text ?? '')), String(r.json?.text ?? '').slice(0, 120))
}

// 4-5. JSON 结构完整
{
  const r = runCli(['--prove'])
  const j = r.json
  check('4. JSON 可解析且 ok=true', j !== null && j.ok === true, `ok=${j?.ok}`)
  check('5. total>=9 且 passed=total', (j?.total ?? 0) >= 9 && j?.passed === j?.total, `total=${j?.total} passed=${j?.passed}`)
  const cases = Array.isArray(j?.cases) ? j.cases : []
  check('5b. 每个 case 字段齐全', cases.every(c => c && typeof c.id === 'string' && typeof c.what === 'string'
    && typeof c.expected === 'string' && typeof c.actual === 'string' && typeof c.ok === 'boolean'),
    JSON.stringify(cases.map(c => Object.keys(c ?? {}))))
}

// 6-7. 关键的样本必须真的红/绿
{
  const cases = (runCli(['--prove']).json?.cases ?? [])
  const broken = cases.find(c => c.id === 'broken-js')
  const clean = cases.find(c => c.id === 'clean-code')
  check('6. broken-js 实际判 fail（不是嘴上说）', broken?.actual === 'fail' && broken?.ok === true, JSON.stringify(broken))
  check('7. clean-code 正向对照实际判 pass', clean?.actual === 'pass' && clean?.ok === true, JSON.stringify(clean))
  const ps1 = cases.find(c => c.id === 'ps1-encoding')
  console.log(`    观测：ps1-encoding 实际=${ps1?.actual}（本机有 pwsh，应为 fail）`)
  check('8. 有 pwsh 时编码检查不偷偷 skip', ps1?.actual === 'fail', `actual=${ps1?.actual}`)
}

// 9. --prove 不写 .dsh 证据
{
  const d = mk()
  try {
    runCli(['--prove', d])
    check('9. --prove 不写 .dsh/selftest', !existsSync(join(d, '.dsh', 'selftest')))
  } finally { rm(d) }
}

// 10. root 不存在也不影响体检
{
  const d = mk()
  try {
    const r = runCli(['--prove', join(d, 'no-such')])
    check('10. root 不存在时 --prove 仍健康', r.code === 0 && r.json?.ok === true, `code=${r.code} ok=${r.json?.ok}`)
  } finally { rm(d) }
}

// 11. --prove --plan：体检优先，不输出计划
{
  const d = mk()
  try {
    w(d, 'a.js', 'export const a = 1\n')
    const r = runCli(['--prove', '--plan', d])
    check('11. --prove 优先于 --plan', /检查器体检/.test(String(r.json?.text ?? '')) && r.json?.ok === true, String(r.json?.text ?? '').slice(0, 80))
  } finally { rm(d) }
}

// 12. --prove --quiet：不崩，体检内容仍完整
{
  const r = runCli(['--prove', '--quiet'], { json: false })
  check('12. --prove --quiet 正常输出且 exit 0', r.code === 0 && /检查器体检/.test(r.out), `code=${r.code} out=${r.out.slice(0, 60)}`)
}

// 13. --prove 幂等：两次结果规模一致
{
  const a = runCli(['--prove']).json
  const b = runCli(['--prove']).json
  check('13. 两次体检结果一致', a?.total === b?.total && a?.passed === b?.passed && (a?.cases ?? []).length === (b?.cases ?? []).length,
    `a=${a?.passed}/${a?.total} b=${b?.passed}/${b?.total}`)
}

// 14. 临时目录不残留
{
  const before = proveDirs()
  runCli(['--prove'])
  const after = proveDirs()
  const leaked = [...after].filter(n => !before.has(n))
  check('14. prove 的临时目录已清理', leaked.length === 0, `leaked=${leaked.join(',')}`)
}

// 15. 在 git 仓库里跑 --prove 不弄脏仓库
{
  const d = mk()
  try {
    spawnSync(GIT, ['-C', d, 'init', '-q'], { windowsHide: true })
    spawnSync(GIT, ['-C', d, 'config', 'user.email', 'a@b.c'], { windowsHide: true })
    spawnSync(GIT, ['-C', d, 'config', 'user.name', 't'], { windowsHide: true })
    w(d, 'a.js', 'export const a = 1\n')
    spawnSync(GIT, ['-C', d, 'add', '.'], { windowsHide: true })
    spawnSync(GIT, ['-C', d, 'commit', '-qm', 'init'], { windowsHide: true })
    const before = String(spawnSync(GIT, ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '')
    runCli(['--prove', d])
    const after = String(spawnSync(GIT, ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '')
    check('15. 体检不改变 git 工作区', before === after, `before="${before.trim()}" after="${after.trim()}"`)
  } finally { rm(d) }
}

// 16. 体检后普通检查行为不变（无状态污染）
{
  const d = mk()
  try {
    w(d, 'bad.js', 'export const = 1\n')
    runCli(['--prove'])
    const r = runCli([d])
    check('16. 体检后普通检查仍判 fail', r.json?.verdict === 'fail', `verdict=${r.json?.verdict}`)
  } finally { rm(d) }
}

// 17. 中文在 JSON 里没有乱码
{
  const r = runCli(['--prove'])
  const text = String(r.json?.text ?? '')
  check('17. JSON 内中文正常', text.includes('检查器体检') && text.includes('通过'), text.slice(0, 60))
}

// 18. --prove 与 --files 组合：不因 files 不存在而失败
{
  const d = mk()
  try {
    const r = runCli(['--prove', '--files', join(d, 'ghost.js'), d])
    check('18. --prove 忽略 --files（不误报）', r.code === 0 && r.json?.ok === true, `code=${r.code} ok=${r.json?.ok}`)
  } finally { rm(d) }
}

// 19. 回归：prove 未改变普通检查的结论（好代码 pass）
{
  const d = mk()
  try {
    w(d, 'ok.js', 'export const ok = 1\n')
    const r = runCli([d])
    check('19. 普通检查好代码仍 pass', r.json?.verdict === 'pass', `verdict=${r.json?.verdict}`)
  } finally { rm(d) }
}

// 20. 体检的 9 个 case 里没有"被跳过还标 ok"的假阳性
{
  const r = runCli(['--prove'])
  const cases = r.json?.cases ?? []
  const skipped = cases.filter(c => c.actual === 'skip')
  console.log(`    观测：跳过项=${skipped.map(c => c.id).join(',') || '无'}`)
  check('20. 本机有 pwsh，体检不应出现 skip 项', skipped.length === 0, skipped.map(c => c.id).join(','))
}

console.log('')
console.log(`gauntlet3: passed=${pass} failed=${fail}`)
if (fail > 0) { for (const f of failures) console.log(` - ${f.name}: ${f.detail ?? ''}`) }
process.exit(fail > 0 ? 1 : 0)
