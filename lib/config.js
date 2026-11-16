/**
 * Configuration resolution.
 *
 * Every tunable has a working default so the tool runs with zero setup; the
 * environment variables exist so unit tests can point the plugin at fixtures
 * instead of the real machine. Overrides passed to the tool (`since`,
 * `timeoutMs`, `strictPlugins`, `quick`) win over both.
 *
 * External binaries are *discovered*, never hard-coded:
 *   env override -> configured value -> PATH -> well-known install locations.
 * A DSH installation is only one possible source, so `DSH_HOME` is treated as
 * an optional hint rather than a requirement. When nothing is found the probe
 * returns an empty string; the planner turns that into an explicit skip with a
 * reason instead of spawning a command that will fail with ENOENT.
 *
 * Platform defaults differ because a phone under proot runs each node process
 * at a real cost: Linux gets a wider mtime window, deeper scan, shorter
 * timeout, smaller file cap and out-of-tree evidence directory.
 *
 * @module dsh-selftest/config
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const IS_WIN = process.platform === 'win32'
const IS_MOBILE = process.platform === 'linux'
const HOME = process.env.DSH_HOME ?? ''

export const DEFAULTS = Object.freeze({
  /** How far back the mtime scan looks. */
  sinceMinutes: 10,
  /** Per-command timeout. */
  timeoutMs: 120_000,
  /** Hard cap on collected files, so a huge tree cannot stall a check. */
  maxFiles: 500,
  /** Evidence files kept under the evidence directory. */
  keepRuns: 50,
  /** Changed plugin without any test => FAIL instead of a warning. */
  strictPlugins: true,
  /** Directory depth for the mtime scan. */
  maxDepth: 4,
  /** Syntax/JSON checks only; skip test suites and the plugin policy rule. */
  quick: false,
  /** Empty means "inside the inspected root" (`<root>/.dsh/selftest`). */
  evidenceDir: '',
  /** Extra plugin roots; comma separated absolute paths. */
  pluginRoots: '',
  /** PowerShell 7 (or 5.1 as a fallback) used to parse .ps1 files. Resolved at runtime. */
  pwsh: '',
  /** Helper script that parses a list of .ps1 files; ships inside this package. */
  parsePs1: '',
  /** Helper script that batch-checks JavaScript files; ships inside this package. */
  parseJs: '',
  /** Node used to syntax-check JS and to run test files. Resolved at runtime. */
  node: '',
  /** Optional TypeScript compiler; empty disables .ts checking. */
  tsc: '',
  /** Optional Python linter; empty falls back to `python -m py_compile`. */
  ruff: '',
  /** Optional Python interpreter used when ruff is unavailable. */
  python: '',
  /** Optional bash used for `bash -n` on .sh files; empty means no bash. */
  bash: '',
  /** Optional YAML validator command (e.g. python3 with PyYAML); empty = skip. */
  yaml: '',
  /** Optional git executable; empty means "git on PATH". */
  git: '',
  /** Whistle (turn-end reminder about unverified changes): warn | strict | off. */
  whistleMode: 'warn',
  /** Hard cap on whistle messages per session. */
  maxWhistlesPerSession: 2,
  /** When true, turns that wrote nothing are never whistled at. */
  requireWhistleAfterWrite: true,
  /** Hard gate: after a write, the next non-whitelisted call is denied once. nag | off. */
  hardGate: 'nag',
})

/** Phone-class defaults: wider window, deeper scan, cheaper commands. */
export const MOBILE_DEFAULTS = Object.freeze({
  sinceMinutes: 30,
  timeoutMs: 30_000,
  maxFiles: 200,
  maxDepth: 6,
})

/** @returns {boolean} */
export function isMobilePlatform() {
  return IS_MOBILE
}

/**
 * Default evidence directory. On a phone the workspace may be read-only or on
 * a mount, so evidence goes under the DSH home instead of the inspected tree.
 *
 * @returns {string}
 */
export function defaultEvidenceDir() {
  if (!IS_MOBILE) return ''
  // Linux CI runners are not phones: the inspected tree is writable there, and
  // putting evidence under the runner's home would make every in-tree
  // assertion (and `--audit` on a checked-out repo) look at the wrong place.
  if (process.env.CI === 'true') return ''
  const home = HOME !== '' ? HOME : join(homedir(), '.dsh')
  return join(home, 'cache', 'selftest')
}

/**
 * The Harness host is an Electron binary, so `process.execPath` is
 * `DSH NEXT.exe`, not node — feeding it `--check` fails. Probe for a real node
 * before falling back to PATH.
 *
 * @param {string} configured
 */
export function pickNode(configured) {
  const env = process.env.DSH_SELFTEST_NODE
  if (isFile(env)) return /** @type {string} */ (env)
  if (isFile(configured)) return configured

  const self = process.execPath
  if (typeof self === 'string' && self.length > 0 && /^node(\.exe)?$/i.test(basename(self))) return self

  const fromPath = findOnPath(['node'])
  if (fromPath !== '') return fromPath

  // DSH ships its own runtime; use it when DSH_HOME points at one. Windows
  // builds carry node.exe, Linux/mobile builds carry a bare `node`.
  if (HOME !== '') {
    const runtimeRoot = join(HOME, 'dsh-runtimes')
    for (const dir of safeList(runtimeRoot)) {
      for (const name of ['node', 'node.exe']) {
        const candidate = join(runtimeRoot, dir, 'dependencies', 'node', 'bin', name)
        if (isFile(candidate)) return candidate
      }
    }
  }
  return 'node'
}

/**
 * PowerShell used to parse `.ps1`. Empty string when the platform has no
 * usable PowerShell — the planner then skips `.ps1` checks with a reason
 * instead of spawning a missing binary.
 *
 * @param {string} configured
 */
export function pickPwsh(configured) {
  const env = process.env.DSH_SELFTEST_PWSH
  if (isFile(env)) return /** @type {string} */ (env)
  if (isFile(configured)) return configured

  const candidates = IS_WIN
    ? [
        HOME !== '' ? join(HOME, 'dev', 'pwsh7', 'pwsh.exe') : '',
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
      ]
    : ['/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/microsoft/powershell/7/pwsh']
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate
  }

  return findOnPath(IS_WIN ? ['pwsh', 'powershell'] : ['pwsh'])
}

/**
 * Python fallback for `.py` files. Mobile distributions commonly ship only
 * `python3`, so both names are probed. Empty string => skip `.py` checks.
 *
 * @param {string} configured
 * @param {string} [dshHome] DSH home to probe for a bundled interpreter;
 *   defaults to `$DSH_HOME` (the parameter exists so tests can fake the tree).
 */
export function pickPython(configured, dshHome = HOME) {
  const env = process.env.DSH_SELFTEST_PYTHON
  if (isFile(env)) return /** @type {string} */ (env)
  if (isFile(configured)) return configured

  // DSH ships its own Python beside the runtime (desktop builds). Probe it
  // before PATH: on Windows, PATH often resolves to a Microsoft Store
  // execution alias, which PowerShell can spawn but node's fs.stat cannot see
  // as a regular file, so findOnPath returns '' for a working interpreter.
  if (typeof dshHome === 'string' && dshHome !== '') {
    const runtimeRoot = join(dshHome, 'dsh-runtimes')
    for (const dir of safeList(runtimeRoot)) {
      for (const name of ['python.exe', 'python3', 'python']) {
        const candidate = join(runtimeRoot, dir, 'dependencies', 'python', name)
        if (isFile(candidate)) return candidate
      }
    }
  }

  const fromPath = findOnPath(['python3', 'python'])
  return fromPath
}

/**
 * bash used for `bash -n` on `.sh` files. Empty when there is no bash; the
 * planner then skips shell checks with a reason.
 *
 * @param {string} configured
 * @returns {string}
 */
export function pickBash(configured) {
  const env = process.env.DSH_SELFTEST_BASH
  if (isFile(env)) return /** @type {string} */ (env)
  if (isFile(configured)) return configured
  return findOnPath(['bash'])
}

/**
 * The list-parser lives inside this package, so an installed copy never needs
 * a file from somewhere else.
 */
export function pickParseScript() {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'parse-ps1.ps1')
  return existsSync(bundled) ? bundled : ''
}

/**
 * The batch JS checker ships inside this package too.
 * @returns {string}
 */
export function pickParseJs() {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'parse-js.mjs')
  return existsSync(bundled) ? bundled : ''
}

/**
 * @param {string} configured
 */
export function pickGit(configured) {
  const env = process.env.DSH_SELFTEST_GIT
  if (isFile(env)) return /** @type {string} */ (env)
  if (isFile(configured)) return configured
  if (HOME !== '') {
    const candidate = join(HOME, 'dev', 'git', 'cmd', 'git.exe')
    if (isFile(candidate)) return candidate
  }
  const fromPath = findOnPath(['git'])
  return fromPath !== '' ? fromPath : 'git'
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {typeof DEFAULTS & Record<string, unknown>}
 */
export function resolveConfig(overrides = {}) {
  /** @type {Record<string, unknown>} */
  const cfg = { ...DEFAULTS }
  if (IS_MOBILE) Object.assign(cfg, MOBILE_DEFAULTS)
  const env = process.env

  /** @type {Array<[string, string, (value: string) => number|string]>} */
  const fromEnv = [
    ['DSH_SELFTEST_SINCE_MINUTES', 'sinceMinutes', value => Number(value)],
    ['DSH_SELFTEST_TIMEOUT_MS', 'timeoutMs', value => Number(value)],
    ['DSH_SELFTEST_MAX_FILES', 'maxFiles', value => Number(value)],
    ['DSH_SELFTEST_MAX_DEPTH', 'maxDepth', value => Number(value)],
    ['DSH_SELFTEST_KEEP_RUNS', 'keepRuns', value => Number(value)],
    ['DSH_SELFTEST_EVIDENCE_DIR', 'evidenceDir', value => value],
    ['DSH_SELFTEST_PLUGIN_ROOTS', 'pluginRoots', value => value],
    ['DSH_SELFTEST_YAML', 'yaml', value => value],
    ['DSH_SELFTEST_WHISTLE_MODE', 'whistleMode', value => value],
    ['DSH_SELFTEST_MAX_WHISTLES', 'maxWhistlesPerSession', value => Number(value)],
    ['DSH_SELFTEST_HARD_GATE', 'hardGate', value => value],
  ]
  for (const [name, key, parse] of fromEnv) {
    const raw = env[name]
    if (typeof raw === 'string' && raw.length > 0) cfg[key] = parse(raw)
  }

  if (env.DSH_SELFTEST_PARSE_PS1) cfg.parsePs1 = env.DSH_SELFTEST_PARSE_PS1
  if (env.DSH_SELFTEST_TSC) cfg.tsc = env.DSH_SELFTEST_TSC
  if (env.DSH_SELFTEST_RUFF) cfg.ruff = env.DSH_SELFTEST_RUFF
  if (env.DSH_SELFTEST_PYTHON) cfg.python = env.DSH_SELFTEST_PYTHON
  if (env.DSH_SELFTEST_STRICT_PLUGINS === '0') cfg.strictPlugins = false
  if (env.DSH_SELFTEST_STRICT_PLUGINS === '1') cfg.strictPlugins = true
  if (env.DSH_SELFTEST_QUICK === '1') cfg.quick = true

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue
    cfg[key] = value
  }

  cfg.sinceMinutes = clampInt(cfg.sinceMinutes, 1, 24 * 60, DEFAULTS.sinceMinutes)
  cfg.timeoutMs = clampInt(cfg.timeoutMs, 1_000, 900_000, DEFAULTS.timeoutMs)
  cfg.maxFiles = clampInt(cfg.maxFiles, 1, 20_000, DEFAULTS.maxFiles)
  cfg.keepRuns = clampInt(cfg.keepRuns, 1, 5_000, DEFAULTS.keepRuns)
  cfg.maxDepth = clampInt(cfg.maxDepth, 0, 12, DEFAULTS.maxDepth)
  cfg.strictPlugins = cfg.strictPlugins !== false
  cfg.quick = cfg.quick === true
  cfg.whistleMode = ['warn', 'strict', 'off'].includes(String(cfg.whistleMode))
    ? String(cfg.whistleMode)
    : DEFAULTS.whistleMode
  cfg.maxWhistlesPerSession = clampInt(cfg.maxWhistlesPerSession, 0, 20, DEFAULTS.maxWhistlesPerSession)
  cfg.requireWhistleAfterWrite = cfg.requireWhistleAfterWrite !== false
  cfg.hardGate = ['nag', 'off'].includes(String(cfg.hardGate)) ? String(cfg.hardGate) : DEFAULTS.hardGate
  cfg.node = pickNode(String(cfg.node ?? ''))
  cfg.pwsh = pickPwsh(String(cfg.pwsh ?? ''))
  cfg.git = pickGit(String(cfg.git ?? ''))
  cfg.python = pickPython(String(cfg.python ?? ''))
  cfg.bash = pickBash(String(cfg.bash ?? ''))
  cfg.parsePs1 = String(cfg.parsePs1 ?? '') !== '' ? String(cfg.parsePs1) : pickParseScript()
  cfg.parseJs = String(cfg.parseJs ?? '') !== '' ? String(cfg.parseJs) : pickParseJs()
  cfg.evidenceDir = String(cfg.evidenceDir ?? '') !== '' ? String(cfg.evidenceDir) : defaultEvidenceDir()

  return /** @type {any} */ (cfg)
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** @param {unknown} value */
function isFile(value) {
  return typeof value === 'string' && value.length > 0 && existsSync(value)
}

/**
 * First existing executable named `names` on PATH, honouring PATHEXT on Windows.
 * Returns an empty string when nothing matches.
 *
 * @param {string[]} names
 */
export function findOnPath(names) {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const exts = IS_WIN
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext)
        if (isFile(candidate)) return candidate
      }
    }
  }
  return ''
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function safeList(dir) {
  try { return readdirSync(dir) } catch { return [] }
}
