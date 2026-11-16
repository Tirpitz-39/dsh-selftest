/**
 * Per-file signatures: the "which files did I verify" half of the whistle.
 *
 * A signature is `size + mtime + sha256-prefix` of the file content. It is
 * deliberately cheap (every changed file is read once per run) and
 * deliberately not a security boundary: it answers "is this still the file
 * the check saw", not "is this file trustworthy".
 *
 * The whistle compares these signatures against the ones recorded by the last
 * selftest run, so "changed and never verified" becomes a concrete file list
 * instead of a vague "remember to test".
 *
 * @module dsh-selftest/signature
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/** Files above this size record size+mtime only; hashing must not stall a turn. */
export const MAX_HASH_BYTES = 8 * 1024 * 1024

/**
 * @param {string} path
 * @returns {{ size: number, mtimeMs: number, sha: string|null, truncated?: boolean }|null}
 */
export function fileSignature(path) {
  try {
    const info = statSync(path)
    if (!info.isFile()) return null
    const base = { size: info.size, mtimeMs: Math.trunc(info.mtimeMs) }
    if (info.size > MAX_HASH_BYTES) return { ...base, sha: null, truncated: true }
    const sha = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
    return { ...base, sha }
  } catch {
    return null
  }
}

/**
 * Two signatures describe the same content.
 *
 * When either side has no hash (missing file, oversized file) fall back to
 * size + mtime; a mismatch there is still a real signal, a match is the
 * best available answer.
 *
 * @param {{ size?: number, mtimeMs?: number, sha?: string|null }|null|undefined} left
 * @param {{ size?: number, mtimeMs?: number, sha?: string|null }|null|undefined} right
 * @returns {boolean}
 */
export function sameSignature(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false
  if (left.sha !== null && right.sha !== null) return left.sha === right.sha
  return left.size === right.size && left.mtimeMs === right.mtimeMs
}
