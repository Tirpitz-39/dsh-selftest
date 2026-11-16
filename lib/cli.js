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
import { auditFreshness, formatAudit } from './audit.js'
import { resolveConfig } from './config.js'
import { formatResult, runSelftest } from './core.js'
import { proveSelf } from './prove.js'
import { t } from './i18n.js'

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ root: string, mode: 'check'|'plan', json: boolean, quiet: boolean, verbose: boolean, summary: boolean, quick: boolean, persist: boolean, prove: boolean, audit: boolean, since: number|undefined, files: string[]|null, strictPlugins: boolean|undefined }} */
  const options = {
    root: process.cwd(),
    mode: 'check',
    json: false,
    quiet: false,
    verbose: false,
    summary: false,
    quick: false,
    persist: true,
    prove: false,
    audit: false,
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
      case '--audit': options.audit = true; break
      case '--json': options.json = true; break
      case '--summary': options.summary = true; break
      case '--quick': options.quick = true; break
      case '--quiet':
      case '-q': options.quiet = true; break
      case '--verbose':
      case '-v': options.verbose = true; break
      case '--no-persist': options.persist = false; break
      case '--strict-plugins': options.strictPlugins = true; break
      case '--no-strict-plugins': options.strictPlugins = false; break
      case '--help':
      case '-h':
        process.stdout.write(t('usage'))
        process.exit(0)
        break
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`${t('unknownOption', { arg })}\n\n${t('usage')}`)
          process.exit(2)
        }
        options.root = arg
    }
  }

  if (typeof options.since === 'number' && !Number.isFinite(options.since)) {
    process.stderr.write(`${t('sinceNeedsNumber')}\n`)
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
    process.stderr.write(`${t('needsValue', { flag })}\n`)
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

  // --audit: evidence-only gate for data consumers (CI, hooks, schedulers).
  // Exit code: 0 fresh / nothing; 1 stale / unverified; 2 bad arguments.
  if (options.audit) {
    const cfg = resolveConfig({})
    const result = auditFreshness({ root: options.root, cfg })
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      process.stdout.write(`${formatAudit(result)}\n`)
    }
    process.exit(result.verdict === 'fresh' || result.verdict === 'partial' || result.verdict === 'nothing' ? 0 : 1)
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
    quick: options.quick,
    persist: options.persist && options.mode !== 'plan',
    signal: controller.signal,
  })

  if (options.json) {
    // `text` lets the tool layer render without loading this module itself,
    // which is what keeps plugin edits live without a Harness restart.
    const payload = { ...result, text: formatResult(result, { verbose: options.verbose, summary: options.summary }) }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else if (options.quiet && result.verdict !== 'fail') {
    const counts = result.counts
    // Files that were skipped before any check ran (unknown extension, missing
    // tool) never reach `result.results`, so counting only `counts.skip` would
    // print "0 skipped" while a file was in fact skipped. Report the honest
    // total: a quiet run must not look fully checked when part of it was not.
    const skipped = counts.skip + result.skipped.length
    process.stdout.write(`${t('quietLine', { verdict: result.verdict, pass: counts.pass, total: counts.total, skipped, ms: result.durationMs })}\n`)
  } else {
    process.stdout.write(`${formatResult(result, { verbose: options.verbose, summary: options.summary })}\n`)
  }

  if (result.verdict === 'fail') process.exit(1)
}

main().catch(error => {
  process.stderr.write(`dsh-selftest crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(3)
})

