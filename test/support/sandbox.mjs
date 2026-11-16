/**
 * Shared helpers for test suites that spawn child processes.
 *
 * Some environments (a restricted DSH sandbox, for example) deny piped child
 * processes with `spawn EPERM`, while `stdio: 'ignore'` and `'inherit'` still
 * work. A test that needs to *capture* a child's output cannot run there; the
 * right answer is an explicit skip with a reason, never a false failure.
 *
 * Note: this helper file lives under `test/support/` and is intentionally not
 * listed in package.json `files` — the published package ships `test/*.mjs`
 * only, and these helpers are development-time only.
 */

import { execFileSync } from 'node:child_process'

/**
 * Does this error mean "this environment forbids piped child processes"?
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isEperm(error) {
  const code = /** @type {{ code?: string }} */ (error)?.code
  return String(code ?? '') === 'EPERM'
}

/**
 * Probe whether piped child processes work in this environment.
 *
 * Returns `true` when they do, `false` on `EPERM`. Any other failure (a missing
 * binary, a non-zero exit) is rethrown: that is a real problem, not a sandbox
 * limitation.
 *
 * @param {string} exe
 * @param {string[]} [args]
 * @returns {boolean}
 */
export function canSpawnPiped(exe, args = ['--version']) {
  try {
    execFileSync(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 })
    return true
  } catch (error) {
    if (isEperm(error)) return false
    throw error
  }
}
