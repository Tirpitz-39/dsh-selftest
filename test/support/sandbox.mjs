/**
 * Shared helpers for test suites that spawn child processes.
 *
 * Some environments (a restricted DSH sandbox, for example) deny piped child
 * processes with `spawn EPERM`, while `stdio: 'ignore'` and `'inherit'` still
 * work. A test that needs to *capture* a child's output cannot run there; the
 * right answer is an explicit skip with a reason, never a false failure.
 *
 * Note: this helper lives under `test/support/` and ships with the package
 * (`test/support/*.mjs` in package.json `files`), so `npm test` works on an
 * unpacked tarball as well as in a checkout.
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
