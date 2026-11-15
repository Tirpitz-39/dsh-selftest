#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 * Same logic as the `selftest` tool, so `claim_verify` can run it as a check
 * and CI can run it without a Harness. Exit code is the contract:
 *   0  everything passed, nothing to check, or --explain
 *   1  at least one check failed
 *   2  bad arguments
 *
 * @module dsh-selftest/cli
 */

import process from 'node:process'
import { formatResult, runSelftest } from './core.js'
import { proveSelf } from './prove.js'

const USAGE = `dsh-selftest - check every changed file with the tool that fits it

Usage:
  node lib/cli.js [root] [options]

Options:
  --root <dir>            Working directory (default: cwd)
  --since <minutes>       mtime lookback (default: 10)
  --files <a,b,...>       Check exactly these files instead of collecting
  --timeout <ms>          Per-command timeout (default: 120000)
  --explain, --plan       Print the plan; run nothing
  --prove                 Health-check the checkers themselves with known-bad samples
  --json                  Print the full JSON result
  --quiet, -q             One-line verdict on success, full detail on failure
  --verbose, -v           Include command output for passing checks too
  --no-persist            Do not write .dsh/selftest/ (read-only or sandboxed callers)
  --strict-plugins        Changed plugin with no test is a failure (default)
  --no-strict-plugins     Downgrade that rule to a note
  -h, --help              This text
`

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ root: string, mode: 'check'|'plan', json: boolean, quiet: boolean, verbose: boolean, persist: boolean, prove: boolean, since: number|undefined, files: string[]|null, strictPlugins: boolean|undefined }} */
  const options = {
    root: process.cwd(),
    mode: 'check',
    json: false,
    quiet: false,
    verbose: false,
    persist: true,
    prove: false,
    since: undefined,
    timeoutMs: undefined,
    files: null,
    strictPlugins: undefined,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--root': options.root = requireValue(argv, ++index, arg); break
      case '--since': options.since = Number(requireValue(argv, ++index, arg)); break
      case '--timeout': options.timeoutMs = Number(requireValue(argv, ++index, arg)); break
      case '--files': options.files = requireValue(argv, ++index, arg).split(',').map(s => s.trim()).filter(Boolean); break
      case '--explain':
      case '--plan': options.mode = 'plan'; break
      case '--prove': options.prove = true; break
      case '--json': options.json = true; break
      case '--quiet':
      case '-q': options.quiet = true; break
      case '--verbose':
      case '-v': options.verbose = true; break
      case '--no-persist': options.persist = false; break
      case '--strict-plugins': options.strictPlugins = true; break
      case '--no-strict-plugins': options.strictPlugins = false; break
      case '--help':
      case '-h':
        process.stdout.write(USAGE)
        process.exit(0)
        break
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`unknown option: ${arg}\n\n${USAGE}`)
          process.exit(2)
        }
        options.root = arg
    }
  }

  if (typeof options.since === 'number' && !Number.isFinite(options.since)) {
    process.stderr.write('--since needs a number of minutes\n')
    process.exit(2)
  }
  return options
}

/**
 * @param {string[]} argv
 * @param {number} index
 * @param {string} flag
 */
function requireValue(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('-')) {
    process.stderr.write(`${flag} needs a value\n`)
    process.exit(2)
  }
  return value
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.prove) {
    const result = await proveSelf()
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      process.stdout.write(`${result.text}\n`)
    }
    process.exit(result.ok ? 0 : 1)
  }

  /** @type {AbortController|undefined} */
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const result = await runSelftest({
    root: options.root,
    mode: options.mode,
    sinceMinutes: options.since,
    timeoutMs: options.timeoutMs,
    files: options.files,
    strictPlugins: options.strictPlugins,
    persist: options.persist && options.mode !== 'plan',
    signal: controller.signal,
  })

  if (options.json) {
    // `text` lets the tool layer render without loading this module itself,
    // which is what keeps plugin edits live without a Harness restart.
    const payload = { ...result, text: formatResult(result, { verbose: options.verbose }) }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else if (options.quiet && result.verdict !== 'fail') {
    const counts = result.counts
    process.stdout.write(`selftest ${result.verdict}: ${counts.pass}/${counts.total} passed, ${counts.skip} skipped (${result.durationMs}ms)\n`)
  } else {
    process.stdout.write(`${formatResult(result, { verbose: options.verbose })}\n`)
  }

  if (result.verdict === 'fail') process.exit(1)
}

main().catch(error => {
  process.stderr.write(`dsh-selftest crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(3)
})

