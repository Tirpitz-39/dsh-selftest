/**
 * Check planning: turn a list of changed files into concrete checks.
 *
 * The derivation is deliberately deterministic — same files in, same steps
 * out. No model judgement, no "probably fine": an extension we do not know
 * becomes a `skip` with the reason attached, never a silent pass.
 *
 * Order matters: files are checked first (cheap, local), then the tests that
 * own them (expensive), then the plugin policy rule.
 *
 * @module dsh-selftest/plan
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { findOnPath } from './config.js'
import { t } from './i18n.js'

const PS1_EXT = new Set(['.ps1', '.psm1', '.psd1'])
const JS_EXT = new Set(['.js', '.mjs', '.cjs'])
const JSON_EXT = new Set(['.json'])
const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts'])
const PY_EXT = new Set(['.py'])
const CODE_EXT = new Set([...JS_EXT, ...TS_EXT, ...PY_EXT])

/** Matches `E:\...\dev\plugins\<name>\` and captures `<name>`. */
const PLUGIN_PATH = /[\\/]dev[\\/]plugins[\\/]([^\\/]+)[\\/]/i

/**
 * @typedef {object} Step
 * @property {string} id
 * @property {'command'|'inline'|'policy'} kind
 * @property {string} title
 * @property {string} [file]
 * @property {string} [exe]
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {boolean} [viaCmd]    Run through cmd.exe (Windows npm/pnpm shims).
 * @property {string[]} [listFiles] Paths written to the temp list file that
 *                                 replaces the `{{LIST_FILE}}` placeholder.
 * @property {() => { ok: boolean, detail?: string, skipped?: boolean }} [run]
 * @property {'ps1'|'test'|'plugin-policy'} [family]
 */

/**
 * @param {{ root: string, files: import('./collect.js').ChangedFile[], cfg: any }} input
 * @returns {{ steps: Step[], skipped: Array<{ file: string, reason: string }>, counts: Record<string, number> }}
 */
export function buildPlan(input) {
  const { root, files, cfg } = input
  /** @type {Record<string, string[]>} */
  const groups = { ps1: [], js: [], json: [], ts: [], py: [], other: [] }

  for (const file of files) {
    const ext = extname(file.path).toLowerCase()
    if (PS1_EXT.has(ext)) groups.ps1.push(file.path)
    else if (JS_EXT.has(ext)) groups.js.push(file.path)
    else if (JSON_EXT.has(ext)) groups.json.push(file.path)
    else if (TS_EXT.has(ext)) groups.ts.push(file.path)
    else if (PY_EXT.has(ext)) groups.py.push(file.path)
    else groups.other.push(file.path)
  }

  /** @type {Step[]} */
  const steps = []

  if (groups.ps1.length > 0) {
    steps.push({
      id: 'ps1:batch',
      kind: 'command',
      family: 'ps1',
      title: t('ps1Title', { n: groups.ps1.length }),
      file: groups.ps1[0],
      exe: cfg.pwsh,
      args: ['-NoProfile', '-File', cfg.parsePs1, '-ListFile', '{{LIST_FILE}}'],
      cwd: root,
      listFiles: groups.ps1,
    })
  }

  for (const file of groups.js) {
    steps.push({
      id: `js:${key(file)}`,
      kind: 'command',
      title: label(root, file),
      file,
      exe: cfg.node,
      args: ['--check', file],
      cwd: root,
    })
  }

  for (const file of groups.json) {
    steps.push({
      id: `json:${key(file)}`,
      kind: 'inline',
      title: label(root, file),
      file,
      run: () => parseJsonFile(file),
    })
  }

  if (groups.ts.length > 0) {
    if (typeof cfg.tsc === 'string' && cfg.tsc.length > 0) {
      for (const file of groups.ts) {
        steps.push({
          id: `ts:${key(file)}`,
          kind: 'command',
          title: label(root, file),
          file,
          exe: cfg.tsc,
          args: ['--noEmit', '--skipLibCheck', file],
          cwd: root,
        })
      }
    } else {
      for (const file of groups.ts) {
        steps.push(skipStep(`ts:${key(file)}`, label(root, file), t('tsNoCompiler')))
      }
    }
  }

  if (groups.py.length > 0) {
    for (const file of groups.py) {
      if (typeof cfg.ruff === 'string' && cfg.ruff.length > 0) {
        steps.push({
          id: `py:${key(file)}`,
          kind: 'command',
          title: label(root, file),
          file,
          exe: cfg.ruff,
          args: ['check', '--no-cache', file],
          cwd: root,
        })
      } else {
        steps.push({
          id: `py:${key(file)}`,
          kind: 'command',
          title: label(root, file),
          file,
          exe: cfg.python || 'python',
          args: ['-m', 'py_compile', file],
          cwd: root,
        })
      }
    }
  }

  steps.push(...deriveTestSteps({ root, files, cfg }))

  /** @type {Step[]} */
  const policy = []
  /** @type {Array<{ file: string, reason: string }>} */
  const skipped = []
  for (const file of groups.other) {
    skipped.push({ file: label(root, file), reason: t('unknownExt', { ext: extname(file) || t('none') }) })
  }

  if (cfg.strictPlugins === true) {
    policy.push(...pluginPolicySteps(files))
  }

  return {
    steps: [...steps, ...policy],
    skipped,
    counts: {
      ps1: groups.ps1.length,
      js: groups.js.length,
      json: groups.json.length,
      ts: groups.ts.length,
      py: groups.py.length,
      other: groups.other.length,
    },
  }
}

/**
 * Tests that belong to the changed files: walk up to three levels from each
 * file, stop at the first directory that owns a test suite, and run it once.
 *
 * @param {{ root: string, files: import('./collect.js').ChangedFile[], cfg: any }} input
 * @returns {Step[]}
 */
export function deriveTestSteps(input) {
  const { root, files, cfg } = input
  /** @type {Step[]} */
  const steps = []
  /** @type {Set<string>} */
  const visited = new Set()

  for (const file of files) {
    let dir = dirname(file.path)
    for (let level = 0; level < 3; level += 1) {
      // `dirKey`, not `key`: the module-level `key(file)` helper is in scope
      // here and a shadowing `const key = ...` would turn it into a string.
      const dirKey = dir.toLowerCase()
      if (visited.has(dirKey)) break
      visited.add(dirKey)

      // Directly runnable test files win over `npm test`: they need no npm on
      // PATH, no shell shim and no package-manager flags, so the check stays
      // deterministic on machines that only have node.
      const testDir = join(dir, 'test')
      const testFiles = listTestFiles(testDir)
      if (testFiles.length > 0) {
        for (const testFile of testFiles) {
          steps.push({
            id: `test:${key(testFile)}`,
            kind: 'command',
            family: 'test',
            title: `${basename(dir)}: ${basename(testFile)}`,
            exe: cfg.node,
            args: [testFile],
            cwd: dir,
          })
        }
        break
      }

      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const scripts = readScripts(pkgPath)
        const testScript = typeof scripts.test === 'string' ? scripts.test.trim() : ''
        if (testScript.length > 0) {
          if (findOnPath(['npm']) === '') {
            steps.push({
              id: `test:${dirKey}`,
              kind: 'inline',
              family: 'test',
              title: `${basename(dir)}: scripts.test`,
              run: () => ({
                ok: false,
                detail: t('npmMissing'),
              }),
            })
          } else {
            steps.push({
              id: `test:${dirKey}`,
              kind: 'command',
              family: 'test',
              title: t('npmTestTitle', { name: basename(dir) }),
              exe: 'npm',
              args: ['test', '--silent'],
              cwd: dir,
              viaCmd: true,
            })
          }
          break
        }
      }

      if (dir.toLowerCase() === root.toLowerCase()) break
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  return steps
}

/**
 * Hard rule: a changed plugin source file must come with a runnable test.
 *
 * Without this, "I changed the guard" and "I ran the guard's 80 cases" drift
 * apart silently, which is exactly the failure mode this plugin exists for.
 *
 * @param {import('./collect.js').ChangedFile[]} files
 * @returns {Step[]}
 */
export function pluginPolicySteps(files) {
  /** @type {Step[]} */
  const steps = []
  /** @type {Set<string>} */
  const seen = new Set()

  for (const file of files) {
    const ext = extname(file.path).toLowerCase()
    if (!CODE_EXT.has(ext)) continue
    const match = PLUGIN_PATH.exec(file.path)
    if (match === null) continue
    const name = match[1]
    if (seen.has(name)) continue
    seen.add(name)
    const pluginDir = file.path.slice(0, match.index + match[0].length - 1)
    if (!existsSync(pluginDir)) continue

    const hasTests = listTestFiles(join(pluginDir, 'test')).length > 0
      || hasTestScript(join(pluginDir, 'package.json'))
    if (hasTests) continue

    steps.push({
      id: `policy:${name}`,
      kind: 'policy',
      family: 'plugin-policy',
      title: t('pluginNoTestsTitle', { name }),
      file: file.path,
      run: () => ({
        ok: false,
        detail: t('pluginNoTestsDetail', { dir: pluginDir }),
      }),
    })
  }

  return steps
}

/**
 * @param {string} testDir
 * @returns {string[]}
 */
export function listTestFiles(testDir) {
  if (!existsSync(testDir)) return []
  let entries
  try { entries = readdirSync(testDir, { withFileTypes: true }) } catch { return [] }
  const all = entries
    .filter(entry => entry.isFile() && JS_EXT.has(extname(entry.name).toLowerCase()))
    .map(entry => join(testDir, entry.name))
  if (all.length === 0) return []
  const preferred = all.filter(path => /(^test\.|\.test\.|[-.]spec\.)/i.test(basename(path)))
  return (preferred.length > 0 ? preferred : all).sort()
}

/**
 * @param {string} pkgPath
 * @returns {Record<string, unknown>}
 */
export function readScripts(pkgPath) {
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''))
    if (parsed !== null && typeof parsed === 'object' && parsed.scripts !== null && typeof parsed.scripts === 'object') {
      return /** @type {Record<string, unknown>} */ (parsed.scripts)
    }
  } catch { /* unreadable package.json is reported by the caller's own checks */ }
  return {}
}

/**
 * @param {string} pkgPath
 */
function hasTestScript(pkgPath) {
  if (!existsSync(pkgPath)) return false
  const scripts = readScripts(pkgPath)
  return typeof scripts.test === 'string' && scripts.test.trim().length > 0
}

/**
 * @param {string} file
 * @returns {{ ok: boolean, detail?: string }}
 */
export function parseJsonFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, detail: t('unreadable', { msg: messageOf(error) }) }
  }
  try {
    JSON.parse(text.replace(/^\uFEFF/, ''))
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: messageOf(error) }
  }
}

/**
 * @param {string} id
 * @param {string} title
 * @param {string} reason
 * @returns {Step}
 */
function skipStep(id, title, reason) {
  return { id, kind: 'inline', title, run: () => ({ ok: true, detail: reason, skipped: true }) }
}

/**
 * Path relative to the root, for humans; falls back to the absolute path when
 * the file lives outside the root (a changed shared tool is normal).
 * @param {string} root
 * @param {string} file
 */
export function label(root, file) {
  const rel = relative(root, file)
  if (rel.length === 0) return file
  if (rel.startsWith('..')) return file
  return rel.split(sep).join('/')
}

/**
 * @param {string} file
 */
function key(file) {
  return file.toLowerCase()
}

/**
 * @param {unknown} error
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export { CODE_EXT, JS_EXT, PS1_EXT, PY_EXT, TS_EXT, JSON_EXT }

