/**
 * Evidence persistence.
 *
 * Mirrors dsh-claimcheck's layout so the two plugins agree on where proof
 * lives: `<root>/.dsh/selftest/latest.json` plus a bounded run history under
 * `runs/`. Writing is best-effort — a read-only root must not turn a passing
 * check into a failure, it only loses the artifact.
 *
 * @module dsh-selftest/report
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * @param {string} root
 * @param {any} result
 * @param {number} keepRuns
 * @param {string} [evidenceDir] absolute directory to write into; empty means
 *   `<root>/.dsh/selftest` (desktop). Phones default to `$DSH_HOME/cache/selftest`
 *   because the inspected workspace may be read-only or a mount.
 * @returns {{ artifactPath: string|null, runPath: string|null, error: string|null }}
 */
export function persistReport(root, result, keepRuns, evidenceDir = '') {
  const base = evidenceDir !== '' ? evidenceDir : join(root, '.dsh', 'selftest')
  const runsDir = join(base, 'runs')
  try {
    mkdirSync(runsDir, { recursive: true })
    const text = `${JSON.stringify(result, null, 2)}\n`
    const runPath = join(runsDir, `${result.runId}.json`)
    writeFileSync(runPath, text, 'utf8')
    const artifactPath = join(base, 'latest.json')
    writeFileSync(artifactPath, text, 'utf8')
    prune(runsDir, keepRuns)
    return { artifactPath, runPath, error: null }
  } catch (error) {
    return { artifactPath: null, runPath: null, error: messageOf(error) }
  }
}

/**
 * Keep the newest `keep` run files, delete the rest.
 * @param {string} dir
 * @param {number} keep
 */
export function prune(dir, keep) {
  /** @type {Array<{ path: string, mtimeMs: number }>} */
  const files = []
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(dir, entry.name)
    try { files.push({ path, mtimeMs: statSync(path).mtimeMs }) } catch { /* vanished */ }
  }
  if (files.length <= keep) return
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const stale of files.slice(keep)) {
    try { rmSync(stale.path, { force: true }) } catch { /* best effort */ }
  }
}

/**
 * Read the most recent artifact, if any.
 *
 * The evidence directory has to be honored here: on a phone-class platform
 * (Linux) the in-tree `.dsh` may be read-only, so the runner writes evidence
 * under the DSH home instead. Missing this made `--audit` and the whistle see
 * "no evidence" on every Linux host, including CI.
 *
 * @param {string} root
 * @param {string} [evidenceDir] absolute evidence directory; empty means
 *   `<root>/.dsh/selftest`
 * @returns {any|null}
 */
export function readLatest(root, evidenceDir = '') {
  const dir = typeof evidenceDir === 'string' && evidenceDir !== '' ? evidenceDir : join(root, '.dsh', 'selftest')
  const path = join(dir, 'latest.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {unknown} error
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
