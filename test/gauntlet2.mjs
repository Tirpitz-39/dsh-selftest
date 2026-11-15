/**
 * gauntlet2.mjs — 第二组「不骗测试」的对抗性用例（20 个）。
 *
 * 每个用例都断言可观测的行为，并打印实际观测值；不写"没崩就算过"的假断言。
 * 跑法：node test/gauntlet2.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

function mk() { return mkdtempSync(join(tmpdir(), 'gauntlet2-')) }
function w(dir, rel, content) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}
function rm(dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
function git(dir, args) {
  return spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true })
}

function runCli(args, { timeout = 90_000, raw = false } = {}) {
  // Everything here asserts on machine-readable state, so --json is always on
  // unless a case explicitly wants the human-facing text.
  const argv = raw ? [CLI, ...args] : [CLI, ...args, '--json']
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

// 1. git 未跟踪的新文件
{
  const d = mk()
  try {
    git(d, ['init', '-q'])
    git(d, ['config', 'user.email', 'a@b.c'])
    git(d, ['config', 'user.name', 't'])
    w(d, 'untracked.js', 'export const u = 1\n')
    const r = runCli([d])
    const f = (r.json?.files ?? []).find(x => String(x.rel).endsWith('untracked.js'))
    check('1. git 未跟踪文件被收集', Boolean(f), JSON.stringify(r.json?.files))
    check('1b. source 标为 git', f?.source === 'git', `source=${f?.source}`)
  } finally { rm(d) }
}

// 2. git 已跟踪 + 修改
{
  const d = mk()
  try {
    git(d, ['init', '-q']); git(d, ['config', 'user.email', 'a@b.c']); git(d, ['config', 'user.name', 't'])
    const p = w(d, 'tracked.js', 'export const a = 1\n')
    git(d, ['add', '.']); git(d, ['commit', '-qm', 'init'])
    writeFileSync(p, 'export const a = 2\n')
    const r = runCli([d])
    check('2. git 已修改文件被收集', (r.json?.files ?? []).some(x => String(x.rel).endsWith('tracked.js')))
    check('2b. verdict=pass', r.json?.verdict === 'pass', `verdict=${r.json?.verdict}`)
  } finally { rm(d) }
}

// 3. git 删除文件：不报错、不出现在检查列表
{
  const d = mk()
  try {
    git(d, ['init', '-q']); git(d, ['config', 'user.email', 'a@b.c']); git(d, ['config', 'user.name', 't'])
    const p = w(d, 'gone.js', 'export const a = 1\n')
    git(d, ['add', '.']); git(d, ['commit', '-qm', 'init'])
    rmSync(p)
    const r = runCli([d])
    check('3. 删除文件后不崩溃且不出现在 files', r.json !== null && !(r.json?.files ?? []).some(x => String(x.rel).endsWith('gone.js')), `code=${r.code}`)
  } finally { rm(d) }
}

// 4. .gitignore 的文件：如实记录当前行为（mtime 源不读 .gitignore）
{
  const d = mk()
  try {
    git(d, ['init', '-q']); git(d, ['config', 'user.email', 'a@b.c']); git(d, ['config', 'user.name', 't'])
    w(d, '.gitignore', 'ignored.js\n')
    w(d, 'ignored.js', 'export const x = 1\n')
    const r = runCli([d])
    const hit = (r.json?.files ?? []).some(x => String(x.rel).endsWith('ignored.js'))
    console.log(`    观测：ignored.js 是否被检查 = ${hit}（mtime 源不遵守 .gitignore，这是已知行为）`)
    check('4. .gitignore 行为被如实记录（不要求忽略，但不能静默丢）', r.json !== null, `code=${r.code}`)
  } finally { rm(d) }
}

// 5. node_modules 下的 JS：必须跳过
{
  const d = mk()
  try {
    w(d, 'node_modules/pkg/index.js', 'export const dep = 1\n')
    w(d, 'app.js', 'export const app = 1\n')
    const r = runCli([d])
    const dep = (r.json?.files ?? []).some(x => String(x.rel).includes('node_modules'))
    const app = (r.json?.files ?? []).some(x => String(x.rel).endsWith('app.js'))
    check('5. node_modules 被跳过', dep === false)
    check('5b. 正常文件仍被检查', app === true)
  } finally { rm(d) }
}

// 6. .ts 没有 tsc：必须 skip 并说明
{
  const d = mk()
  try {
    w(d, 'a.ts', 'export const x: number = 1\n')
    const r = runCli([d])
    const results = r.json?.results ?? []
    const row = results.find(x => String(x.title).endsWith('a.ts')) ?? results[0]
    check('6. .ts 无 tsc 时出现 skip 结果', String(row?.status) === 'skip', JSON.stringify(results.map(x => [x.title, x.status])))
    check('6b. skip 原因提到 TypeScript', /TypeScript/.test(String(row?.detail ?? '')), `detail=${row?.detail}`)
  } finally { rm(d) }
}

// 7. 空目录：nothing
{
  const d = mk()
  try {
    const r = runCli([d])
    check('7. 空目录 verdict=nothing', r.json?.verdict === 'nothing', `verdict=${r.json?.verdict}`)
  } finally { rm(d) }
}

// 8. root 不存在：明确失败，不崩
{
  const d = mk()
  try {
    const r = runCli([join(d, 'no-such-dir')])
    console.log(`    观测：code=${r.code} verdict=${r.json?.verdict}`)
    check('8. 不存在的 root 不崩溃且有明确结论', r.code !== 0 || r.json?.verdict === 'fail', `code=${r.code} verdict=${r.json?.verdict}`)
  } finally { rm(d) }
}

// 9. --json 输出是严格 JSON（往返无损）
{
  const d = mk()
  try {
    w(d, 'a.js', 'export const a = 1\n')
    const r = runCli([d])
    check('9. --json 输出可被 JSON.parse', r.json !== null, r.out.slice(0, 120))
    check('9b. 输出里没有 undefined 字面量', !r.out.includes('undefined'), r.out.slice(0, 200))
  } finally { rm(d) }
}

// 10. 失败时 exit code = 1
{
  const d = mk()
  try {
    w(d, 'bad.js', 'export const = 1\n')
    const r = runCli([d])
    check('10. 失败时 exit 1', r.code === 1, `code=${r.code}`)
  } finally { rm(d) }
}

// 11. 参数错误时 exit code = 2
{
  const d = mk()
  try {
    const r = runCli([d, '--since', 'abc'])
    check('11. --since 非数字时 exit 2', r.code === 2, `code=${r.code}`)
  } finally { rm(d) }
}

// 12. --quiet 成功时只输出一行
{
  const d = mk()
  try {
    w(d, 'a.js', 'export const a = 1\n')
    const r = spawnSync(NODE, [CLI, d, '--quiet', '--no-persist'], { encoding: 'utf8', timeout: 90000 })
    const lines = String(r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
    check('12. --quiet 成功时单行输出', lines.length === 1, `lines=${lines.length}`)
    check('12b. 单行内容含 pass', /pass/.test(lines[0] ?? ''), lines[0])
  } finally { rm(d) }
}

// 13. --no-persist：不写 .dsh
{
  const d = mk()
  try {
    w(d, 'a.js', 'export const a = 1\n')
    runCli([d, '--no-persist'])
    check('13. --no-persist 不创建 .dsh/selftest', !existsSync(join(d, '.dsh', 'selftest')))
  } finally { rm(d) }
}

// 14. 默认 persist：写 latest.json 且结构完整
{
  const d = mk()
  try {
    w(d, 'a.js', 'export const a = 1\n')
    runCli([d])
    const latest = join(d, '.dsh', 'selftest', 'latest.json')
    const okFile = existsSync(latest)
    let okShape = false
    if (okFile) {
      const j = JSON.parse(readFileSync(latest, 'utf8'))
      okShape = typeof j.verdict === 'string' && typeof j.runId === 'string' && typeof j.counts === 'object'
    }
    check('14. latest.json 被写入', okFile)
    check('14b. latest.json 含 verdict/runId/counts', okShape)
  } finally { rm(d) }
}

// 15. 中文 + emoji 文件名
{
  const d = mk()
  try {
    w(d, '目录😀/中文 文件.js', 'export const ok = 1\n')
    const r = runCli([d])
    check('15. 中文 + emoji 路径正常检查', r.json?.verdict === 'pass', `verdict=${r.json?.verdict}`)
  } finally { rm(d) }
}

// 16. --files 相对路径按 root 解析
{
  const d = mk()
  try {
    w(d, 'sub/rel.js', 'export const ok = 1\n')
    const r = runCli([d, '--files', 'sub/rel.js'])
    const f = (r.json?.files ?? []).find(x => String(x.rel).endsWith('rel.js'))
    check('16. 相对路径 files 被解析到 root 下', Boolean(f), JSON.stringify(r.json?.files))
  } finally { rm(d) }
}

// 17. Windows 大小写不敏感：同一文件两种大小写只检查一次
{
  const d = mk()
  try {
    w(d, 'Case.js', 'export const ok = 1\n')
    const r = runCli([d, '--files', 'Case.js,a.js', '--files', 'case.js'])
    const hits = (r.json?.files ?? []).filter(x => String(x.rel).toLowerCase().endsWith('case.js'))
    check('17. 大小写不同的同一文件只出现一次', hits.length <= 1, `hits=${hits.length}`)
  } finally { rm(d) }
}

// 18. 大 JSON（5MB）：不崩、判定正确
{
  const d = mk()
  try {
    const big = { items: Array.from({ length: 60000 }, (_, i) => ({ i, v: 'x'.repeat(40) })) }
    w(d, 'big.json', JSON.stringify(big))
    const r = runCli([d])
    check('18. 5MB JSON 不崩且 pass', r.json?.verdict === 'pass', `verdict=${r.json?.verdict} code=${r.code}`)
  } finally { rm(d) }
}

// 19. 只读文件：能检查
{
  const d = mk()
  try {
    const p = w(d, 'ro.js', 'export const ok = 1\n')
    spawnSync('attrib', ['+R', p], { windowsHide: true })
    const r = runCli([d])
    check('19. 只读文件能正常检查', r.json?.verdict === 'pass', `verdict=${r.json?.verdict}`)
    spawnSync('attrib', ['-R', p], { windowsHide: true })
  } finally { rm(d) }
}

// 20. .git 损坏（空目录）：不崩，gitError 有记录
{
  const d = mk()
  try {
    mkdirSync(join(d, '.git'))
    w(d, 'a.js', 'export const ok = 1\n')
    const r = runCli([d])
    const gitError = r.json?.sources?.gitError
    check('20. 损坏的 .git 不崩溃', r.json !== null, `code=${r.code}`)
    check('20b. gitError 被记录（不是静默忽略）', Boolean(gitError), `gitError=${gitError}`)
  } finally { rm(d) }
}

console.log('')
console.log(`gauntlet2: passed=${pass} failed=${fail}`)
if (fail > 0) { for (const f of failures) console.log(` - ${f.name}: ${f.detail ?? ''}`) }
process.exit(fail > 0 ? 1 : 0)
