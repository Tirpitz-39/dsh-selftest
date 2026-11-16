/**
 * Change collection: what changed, and which changes this plugin deliberately
 * ignores.
 *
 * Two sources, unioned:
 *   1. `git status --porcelain` inside the root (tracked + untracked edits);
 *   2. an mtime scan of the root, for files written too recently for git and
 *      for directories that are not a repository at all.
 *
 * Skip rules are relative to the root: a caller may legitimately point the root
 * INSIDE a directory whose name is noise (`.dsh`, `build`, `dist` — a phone's
 * `$DSH_HOME` is `/root/.dsh`), so the absolute path's ancestors must never
 * cause every collected file to be dropped. Explicitly requested files are
 * never skipped: asking about a file must produce a verdict about that file,
 * not silence.
 *
 * @module dsh-selftest/collect
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/** Directories that never contain author-written source worth checking. */
export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.dsh',
  '__pycache__',
  '.ruff_cache',
  '.pytest_cache',
  '.mypy_cache',
  '.venv',
  'venv',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.cache',
  '.turbo',
])

/** File suffixes that are always generated noise. */
export const SKIP_SUFFIX = ['.log', '.tmp', '.bak', '.orig', '.rej', '.swp', '.map']

/**
 * @typedef {{ path: string, source: 'explicit'|'git'|'mtime' }} ChangedFile
 * @typedef {{ files: ChangedFile[], missing: string[], gitAvailable: boolean, gitError: string|null, scanned: number, truncated: boolean, depthLimited: boolean }} Collection
 */

/**
 * @param {{ root: string, files?: string[]|null, sinceMinutes: number, maxFiles: number, maxDepth: number, cfg: any, now?: number }} input
 * @returns {Collection}
 */
export function collectChanges(input) {
  const { root, files, sinceMinutes, maxFiles, maxDepth, cfg } = input
  const now = input.now ?? Date.now()
  const map = new Map()
  /** Explicitly requested paths that no longer exist; silence here would let a
   * caller "verify" a file that was never checked. */
  /** @type {string[]} */
  const missing = []
  let truncated = false
  let depthLimited = false

  /** @param {string} absolute @param {ChangedFile['source']} source */
  const add = (absolute, source) => {
    if (!absolute) return
    // Generated trees are skipped only when they sit BELOW the root. A root
    // that itself lives under `.dsh`/`build`/`dist` is a normal place to work
    // (a phone's DSH home is `/root/.dsh`). Explicit files are always checked:
    // the caller named them, so a verdict is owed for them.
    if (source !== 'explicit' && hasSkippedSegment(root, absolute)) return
    if (!existsSync(absolute)) return
    const key = dedupeKey(absolute)
    const previous = map.get(key)
    if (previous !== undefined) {
      if (previous.source === 'mtime' && source !== 'mtime') previous.source = source
      return
    }
    if (map.size >= maxFiles) { truncated = true; return }
    map.set(key, { path: absolute, source })
  }

  if (Array.isArray(files) && files.length > 0) {
    for (const raw of files) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      const absolute = isAbsolute(raw) ? normalize(raw) : resolve(root, raw)
      if (!existsSync(absolute)) { missing.push(absolute); continue }
      add(absolute, 'explicit')
    }
    return {
      files: [...map.values()],
      missing,
      gitAvailable: false,
      gitError: null,
      scanned: map.size,
      truncated,
      depthLimited,
    }
  }

  const gitResult = gitChangedFiles(root, cfg)
  for (const path of gitResult.files) add(path, 'git')

  const cutoff = now - sinceMinutes * 60_000
  let scanned = 0
  const walk = (dir, depth) => {
    if (map.size >= maxFiles) { truncated = true; return }
    if (depth > maxDepth) { depthLimited = true; return }
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (map.size >= maxFiles) { truncated = true; return }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (SKIP_SUFFIX.some(suffix => lower.endsWith(suffix))) continue
      try {
        const stat = statSync(full)
        scanned++
        if (stat.mtimeMs >= cutoff) add(full, 'mtime')
      } catch { /* file vanished between readdir and stat */ }
    }
  }
  walk(root, 0)

  return {
    files: [...map.values()].sort((a, b) => a.path.localeCompare(b.path)),
    missing,
    gitAvailable: gitResult.available,
    gitError: gitResult.error,
    scanned,
    truncated,
    depthLimited,
  }
}

/**
 * True when a path BELOW `root` has a directory segment this plugin never
 * checks. Ancestors of the root do not count: the root was chosen by the
 * caller and is outside the plugin's jurisdiction.
 *
 * @param {string} root
 * @param {string} absolute
 */
export function hasSkippedSegment(root, absolute) {
  const rel = relative(root, absolute)
  if (rel.length === 0) return false
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../')) return false
  for (const segment of rel.split(/[\\/]/)) {
    if (SKIP_DIRS.has(segment.toLowerCase())) return true
  }
  return false
}

/**
 * Case-folding is a filesystem property, not a universal one: on Linux
 * `Foo.js` and `foo.js` are two files and must both be checked.
 *
 * @param {string} path
 */
export function dedupeKey(path) {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path
}

/**
 * Files changed according to git, rooted at `root`. Works when `root` is a
 * subdirectory of a repository: git is asked whether it is inside a work tree
 * instead of looking for `<root>/.git`.
 *
 * @param {string} root
 * @param {any} cfg
 * @returns {{ files: string[], available: boolean, error: string|null }}
 */
export function gitChangedFiles(root, cfg) {
  const git = pickGit(cfg)
  try {
    const inside = execFileSync(git, ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (inside.trim() !== 'true') return { files: [], available: false, error: null }
  } catch (error) {
    const message = messageOf(error)
    // No git binary, or not a repository: the mtime scan is the intended
    // fallback and saying so on every run would be noise. A `.git` that exists
    // but is broken IS reported — that is a real problem worth seeing.
    if (!existsSync(join(root, '.git')) || /ENOENT|not found/i.test(message)) {
      return { files: [], available: false, error: null }
    }
    return { files: [], available: false, error: message }
  }

  let text
  let top
  let untrackedText = ''
  try {
    // `git status` reports paths relative to the repository top level, which
    // is not `root` when root is a subdirectory. Ask for the top level and
    // resolve against it, then keep only changes below the requested root.
    top = execFileSync(git, ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    text = execFileSync(
      git,
      ['-C', root, '-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    )
    // Untracked paths are the ones that can be ancient: a scratch file created
    // weeks ago and never committed stays in `git status` forever. This plugin
    // answers "what changed THIS turn", so an untracked file only counts when
    // its mtime is inside the scan window. (A tracked file whose content
    // differs from HEAD is real work regardless of age; git already proved it.)
    try {
      untrackedText = execFileSync(
        git,
        ['-C', root, '-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'],
        { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      )
    } catch { untrackedText = '' }
  } catch (error) {
    return { files: [], available: false, error: messageOf(error) }
  }
  // Windows may hand back short (8.3) names for the root while git reports the
  // long form (or vice versa); compare canonical paths.
  const rootReal = safeRealpath(root)
  const cutoff = Date.now() - (Number(cfg.sinceMinutes) > 0 ? Number(cfg.sinceMinutes) : 10) * 60_000
  const untracked = new Set(
    untrackedText.split(/\r?\n/).filter(Boolean).map(line => resolve(top, unquote(line.trim()))),
  )
  const files = parsePorcelain(text, top).filter(path => {
    const rel = relative(rootReal, safeRealpath(path))
    if (!(rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../'))) return false
    if (untracked.has(resolve(path))) {
      try {
        if (statSync(path).mtimeMs < cutoff) return false
      } catch {
        return false
      }
    }
    return true
  })
  return { files, available: true, error: null }
}

/**
 * @param {string} text
 * @param {string} root
 * @returns {string[]}
 */
export function parsePorcelain(text, root) {
  /** @type {string[]} */
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length < 4) continue
    const index = raw[0]
    const worktree = raw[1]
    // A deletion leaves no file behind; there is nothing to parse or test.
    if (index === 'D' || worktree === 'D') continue
    if (raw[2] !== ' ') continue
    let rest = raw.slice(3)
    const arrow = rest.indexOf(' -> ')
    if (arrow >= 0) rest = rest.slice(arrow + 4)
    rest = unquote(rest.trim())
    if (rest.length === 0) continue
    out.push(isAbsolute(rest) ? normalize(rest) : resolve(root, rest))
  }
  return out
}

/**
 * Undo Git's C-style quoting for paths that contain `"` or `\`.
 * @param {string} value
 */
export function unquote(value) {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  const body = value.slice(1, -1)
  return body.replace(/\\(["\\])/g, '$1')
}

/**
 * Pick the git executable: the configured one when it exists, otherwise the
 * bare name so PATH resolution is tried (a missing binary surfaces as an
 * execFileSync error the caller turns into `gitError`).
 *
 * @param {any} cfg
 * @returns {string}
 */
export function pickGit(cfg) {
  if (typeof cfg.git === 'string' && cfg.git.length > 0 && existsSync(cfg.git)) return cfg.git
  return 'git'
}

/**
 * Canonical path when the path exists; the absolute input otherwise. Used to
 * compare git-reported paths with the caller's root across Windows short/long
 * name forms.
 *
 * @param {string} path
 */
export function safeRealpath(path) {
  try {
    return realpathSync.native ? realpathSync.native(path) : realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * @param {unknown} error
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
