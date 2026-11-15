/**
 * Configuration resolution.
 *
 * Every tunable has a working default so the tool runs with zero setup; the
 * environment variables exist so unit tests can point the plugin at fixtures
 * instead of the real machine. Overrides passed to the tool (`since`,
 * `timeoutMs`, `strictPlugins`) win over both.
 *
 * External binaries are *discovered*, never hard-coded:
 *   env override -> configured value -> PATH -> well-known install locations.
 * A DSH installation is only one possible source, so `DSH_HOME` is treated as
 * an optional hint rather than a requirement. When nothing is found, the bare
 * command name is kept so PATH resolution at spawn time still has a chance.
 *
 * @module dsh-selftest/config
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const IS_WIN = process.platform === 'win32'
const HOME = process.env.DSH_HOME ?? ''

export const DEFAULTS = Object.freeze({
  /** How far back the mtime scan looks. */
  sinceMinutes: 10,
  /** Per-command timeout. */
  timeoutMs: 120_000,
  /** Hard cap on collected files, so a huge tree cannot stall a check. */
  maxFiles: 500,
  /** Evidence files kept under .dsh/selftest/runs. */
  keepRuns: 50,
  /** Changed plugin without any test => FAIL instead of a warning. */
  strictPlugins: true,
  /** Directory depth for the mtime scan. */
  maxDepth: 4,
  /** PowerShell 7 (or 5.1 as a fallback) used to parse .ps1 files. Resolved at runtime. */
  pwsh: '',
  /** Helper script that parses a list of .ps1 files; ships inside this package. */
  parsePs1: '',
  /** Node used to syntax-check JS and to run test files. Resolved at runtime. */
  node: '',
  /** Optional TypeScript compiler; empty disables .ts checking. */
  tsc: '',
  /** Optional Python linter; empty falls back to `python -m py_compile`. */
  ruff: '',
  /** Optional Python interpreter used when ruff is unavailable. */
  python: '',
  /** Optional git executable; empty means "git on PATH". */
  git: '',
})

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

  // DSH ships its own runtime; use it when DSH_HOME points at one.
  if (HOME !== '') {
    const runtimeRoot = join(HOME, 'dsh-runtimes')
    for (const dir of safeList(runtimeRoot)) {
      const candidate = join(runtimeRoot, dir, 'dependencies', 'node', 'bin', 'node.exe')
      if (isFile(candidate)) return candidate
    }
  }
  return 'node'
}

/**
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

  const fromPath = findOnPath(IS_WIN ? ['pwsh', 'powershell'] : ['pwsh'])
  return fromPath !== '' ? fromPath : IS_WIN ? 'pwsh' : 'pwsh'
}

/**
 * The list-parser lives inside this package, so an installed copy never needs
 * a file from somewhere else on the machine.
 */
export function pickParseScript() {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'parse-ps1.ps1')
  return existsSync(bundled) ? bundled : bundled
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
  const env = process.env

  if (env.DSH_SELFTEST_PARSE_PS1) cfg.parsePs1 = env.DSH_SELFTEST_PARSE_PS1
  if (env.DSH_SELFTEST_TSC) cfg.tsc = env.DSH_SELFTEST_TSC
  if (env.DSH_SELFTEST_RUFF) cfg.ruff = env.DSH_SELFTEST_RUFF
  if (env.DSH_SELFTEST_PYTHON) cfg.python = env.DSH_SELFTEST_PYTHON
  if (env.DSH_SELFTEST_STRICT_PLUGINS === '0') cfg.strictPlugins = false
  if (env.DSH_SELFTEST_STRICT_PLUGINS === '1') cfg.strictPlugins = true

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
  cfg.node = pickNode(String(cfg.node ?? ''))
  cfg.pwsh = pickPwsh(String(cfg.pwsh ?? ''))
  cfg.git = pickGit(String(cfg.git ?? ''))
  cfg.parsePs1 = String(cfg.parsePs1 ?? '') !== '' ? String(cfg.parsePs1) : pickParseScript()

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
