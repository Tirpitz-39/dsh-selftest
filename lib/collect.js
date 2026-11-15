/**
 * Change collection.
 *
 * Two independent sources, merged by normalized path:
 *   1. `git status --porcelain` inside the root (tracked + untracked edits);
 *   2. an mtime scan of the root, for files written too recently for git and
 *      for roots that are not repositories at all.
 *
 * Everything here is read-only. Deleted paths are dropped because there is
 * nothing left to check.
 *
 * @module dsh-selftest/collect
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, join, normalize, resolve } from 'node:path'

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
 * @typedef {{ files: ChangedFile[], missing: string[], gitAvailable: boolean, gitError: string|null, scanned: number, truncated: boolean }} Collection
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

  /** @param {string} absolute @param {ChangedFile['source']} source */
  const add = (absolute, source) => {
    if (!absolute) return
    // Skip generated trees no matter which source produced the path: `git
    // status` surfaces them too (and will keep doing so if .gitignore changes).
    if (hasSkippedSegment(absolute)) return
    if (!existsSync(absolute)) return
    const key = absolute.toLowerCase()
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
    }
  }

  const gitResult = gitChangedFiles(root, cfg)
  for (const path of gitResult.files) add(path, 'git')

  const cutoff = now - sinceMinutes * 60_000
  let scanned = 0
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    if (map.size >= maxFiles) { truncated = true; return }
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
  }
}

/**
 * True when any path segment is a directory this plugin never checks.
 * @param {string} absolute
 */
export function hasSkippedSegment(absolute) {
  for (const segment of absolute.split(/[\\/]/)) {
    if (SKIP_DIRS.has(segment.toLowerCase())) return true
  }
  return false
}

/**
 * @param {string} root
 * @param {any} cfg
 * @returns {{ files: string[], available: boolean, error: string|null }}
 */
export function gitChangedFiles(root, cfg) {
  if (!existsSync(join(root, '.git'))) return { files: [], available: false, error: null }
  const git = pickGit(cfg)
  let text
  try {
    text = execFileSync(
      git,
      ['-C', root, '-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    )
  } catch (error) {
    return { files: [], available: false, error: messageOf(error) }
  }
  return { files: parsePorcelain(text, root), available: true, error: null }
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
 * @param {unknown} error
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
