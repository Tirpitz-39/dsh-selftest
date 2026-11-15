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
import { findOnPath, isMobilePlatform } from './config.js'
import { t } from './i18n.js'

const PS1_EXT = new Set(['.ps1', '.psm1', '.psd1'])
const JS_EXT = new Set(['.js', '.mjs', '.cjs'])
const JSON_EXT = new Set(['.json'])
const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts'])
const PY_EXT = new Set(['.py'])
const CODE_EXT = new Set([...JS_EXT, ...TS_EXT, ...PY_EXT])

/** Extra plugin roots (absolute paths, comma separated) whose direct children are plugins. */
export const PLUGIN_ROOTS_ENV = 'DSH_SELFTEST_PLUGIN_ROOTS'

/** ESM syntax keywords that make a bare `.js` file a module. */
const ESM_SYNTAX = /^\s*(?:import|export)\b/m

/**
 * Decide how a JavaScript file will be parsed. Node's own detection is not
 * trustworthy here: on Node 20/22 `node --check` silently exits 0 for a
 * `export`-based syntax error in a `.js` file that has no package.json
 * (detect-module treats the parse failure as "not a module" and gives up).
 * So `.js` files that look like modules are copied to `.mjs` for the check.
 *
 * @param {string} file
 * @param {string} root
 * @returns {'esm'|'cjs'}
 */
export function jsModuleKind(file, root) {
  const ext = extname(file).toLowerCase()
  if (ext === '.mjs') return 'esm'
  if (ext === '.cjs') return 'cjs'
  let dir = dirname(file)
  for (;;) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''))
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.type === 'string') {
          return parsed.type === 'module' ? 'esm' : 'cjs'
        }
      } catch { /* unreadable package.json: fall through to the content heuristic */ }
      break
    }
    if (dir.toLowerCase() === root.toLowerCase()) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return ESM_SYNTAX.test(text) ? 'esm' : 'cjs'
  } catch {
    return 'cjs'
  }
}

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
 * @property {string} [esmCopy]    Source file copied to a `.mjs` temp file;
 *                                 `{{ESM_COPY}}` is replaced with that path.
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
    if (cfg.pwsh === '' || cfg.parsePs1 === '') {
      steps.push(skipStep('ps1:unavailable', t('ps1Title', { n: groups.ps1.length }), t('ps1Unavailable')))
    } else {
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
  }

  for (const file of groups.js) {
    // A bare `.js` that parses as a module is checked through an `.mjs` copy:
    // `node --check` on the original can pass a syntax error on Node 20/22.
    const esmCopy = jsModuleKind(file, root) === 'esm' && extname(file).toLowerCase() === '.js'
    steps.push({
      id: `js:${key(file)}`,
      kind: 'command',
      title: label(root, file),
      file,
      exe: cfg.node,
      args: ['--check', esmCopy ? '{{ESM_COPY}}' : file],
      cwd: root,
      ...(esmCopy ? { esmCopy: file } : {}),
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
    const hasRuff = typeof cfg.ruff === 'string' && cfg.ruff.length > 0
    const hasPython = typeof cfg.python === 'string' && cfg.python.length > 0
    if (!hasRuff && !hasPython) {
      steps.push(skipStep('py:unavailable', t('pyTitle', { n: groups.py.length }), t('pyUnavailable')))
    }
    for (const file of groups.py) {
      if (hasRuff) {
        steps.push({
          id: `py:${key(file)}`,
          kind: 'command',
          title: label(root, file),
          file,
          exe: cfg.ruff,
          args: ['check', '--no-cache', file],
          cwd: root,
        })
      } else if (hasPython) {
        steps.push({
          id: `py:${key(file)}`,
          kind: 'command',
          title: label(root, file),
          file,
          exe: cfg.python,
          args: ['-m', 'py_compile', file],
          cwd: root,
        })
      }
    }
  }

  if (cfg.quick !== true) steps.push(...deriveTestSteps({ root, files, cfg }))

  /** @type {Step[]} */
  const policy = []
  /** @type {Array<{ file: string, reason: string }>} */
  const skipped = []
  for (const file of groups.other) {
    skipped.push({ file: label(root, file), reason: t('unknownExt', { ext: extname(file) || t('none') }) })
  }

  if (cfg.quick !== true && cfg.strictPlugins === true) {
    policy.push(...pluginPolicySteps(files, cfg))
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
      const testDirs = ['test', 'tests', '__tests__'].map(name => join(dir, name))
      const testFiles = testDirs.flatMap(candidate => listTestFiles(candidate))
      if (testFiles.length > 0) {
        for (const testFile of testFiles) {
          const testExt = extname(testFile).toLowerCase()
          if (testExt === '.ts' || testExt === '.tsx' || testExt === '.mts' || testExt === '.cts') {
            // No TypeScript runner is bundled. Skipping with a reason is honest;
            // silently not running a test the project does have is not.
            steps.push({
              id: `test:${key(testFile)}`,
              kind: 'inline',
              family: 'test',
              title: `${basename(dir)}: ${basename(testFile)}`,
              run: () => ({ ok: true, detail: t('tsTestNeedsRunner'), skipped: true }),
            })
            continue
          }
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
          if (isMobilePlatform()) {
            // A phone pays for every spawned process; npm startup alone can
            // take longer than the whole check. Directly runnable test files
            // are already preferred above, so this only downgrades npm-only
            // suites, and says so instead of pretending they ran.
            steps.push({
              id: `test:${dirKey}`,
              kind: 'inline',
              family: 'test',
              title: `${basename(dir)}: scripts.test`,
              run: () => ({ ok: true, detail: t('npmSkippedMobile'), skipped: true }),
            })
          } else if (findOnPath(['npm']) === '') {
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
export function pluginPolicySteps(files, cfg = {}) {
  /** @type {Step[]} */
  const steps = []
  /** @type {Set<string>} */
  const seen = new Set()

  for (const file of files) {
    const ext = extname(file.path).toLowerCase()
    if (!CODE_EXT.has(ext)) continue
    const pluginDir = findPluginDir(file.path, cfg)
    if (pluginDir === null) continue
    const name = basename(pluginDir)
    if (seen.has(name)) continue
    seen.add(name)

    const hasTests = ['test', 'tests', '__tests__']
      .some(dir => listTestFiles(join(pluginDir, dir)).length > 0)
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
 * Identify the plugin a source file belongs to.
 *
 * A plugin is a directory whose package.json declares `dsh.bundle` (or that
 * ships a `cordis.patch.yml`) — that is what makes it installable by the
 * Harness, and it does not depend on where the directory lives. Extra roots
 * (`DSH_SELFTEST_PLUGIN_ROOTS`, comma separated) treat their direct children
 * as plugins even before the manifest exists, so a layout such as
 * `<home>/.dsh/dsh-go/plugins/<name>/` is covered.
 *
 * @param {string} filePath
 * @param {any} cfg
 * @returns {string|null}
 */
export function findPluginDir(filePath, cfg = {}) {
  const roots = String(cfg.pluginRoots ?? process.env[PLUGIN_ROOTS_ENV] ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  for (const pluginRoot of roots) {
    const rel = relative(pluginRoot, filePath)
    if (rel.length === 0 || rel.startsWith('..')) continue
    const first = rel.split(/[\\/]/)[0]
    const candidate = join(pluginRoot, first)
    if (isSafeDir(candidate)) return candidate
  }

  let dir = dirname(filePath)
  for (let level = 0; level < 5; level += 1) {
    if (declaresBundle(join(dir, 'package.json')) || existsSync(join(dir, 'cordis.patch.yml'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * @param {string} dir
 */
function isSafeDir(dir) {
  try { return statSync(dir).isDirectory() } catch { return false }
}

/**
 * @param {string} pkgPath
 */
function declaresBundle(pkgPath) {
  if (!existsSync(pkgPath)) return false
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''))
    const patch = parsed?.dsh?.bundle?.patch
    return typeof patch === 'string' && patch.length > 0
  } catch {
    return false
  }
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
    .filter(entry => {
      const nameExt = extname(entry.name).toLowerCase()
      return entry.isFile() && (JS_EXT.has(nameExt) || TS_EXT.has(nameExt))
    })
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

