/**
 * Orchestration: collect -> plan -> run -> summarise.
 *
 * `mode: 'plan'` stops after planning, which is the cheap way to answer
 * "what would you check, and why" without spawning anything.
 *
 * @module dsh-selftest/core
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from './config.js'
import { collectChanges, safeRealpath } from './collect.js'
import { buildPlan, label } from './plan.js'
import { t } from './i18n.js'
import { executeStep } from './run.js'
import { persistReport } from './report.js'

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_PATH = join(PACKAGE_DIR, 'lib', 'cli.js')

/**
 * @typedef {object} CheckResult
 * @property {string} id
 * @property {string} title
 * @property {string} [file]
 * @property {string} [family]
 * @property {'pass'|'fail'|'skip'} status
 * @property {number|null} exitCode
 * @property {number} ms
 * @property {string} detail
 * @property {string} output
 * @property {boolean} [timedOut]
 */

/**
 * @param {{
 *   root?: string,
 *   files?: string[]|null,
 *   mode?: 'check'|'plan',
 *   sinceMinutes?: number,
 *   timeoutMs?: number,
 *   strictPlugins?: boolean,
 *   persist?: boolean,
 *   quiet?: boolean,
 *   signal?: AbortSignal,
 *   config?: Record<string, unknown>,
 * }} options
 */
export async function runSelftest(options = {}) {
  const cfg = resolveConfig({
    // Tool arguments win over the environment, but only when actually given.
    sinceMinutes: options.sinceMinutes,
    timeoutMs: options.timeoutMs,
    strictPlugins: options.strictPlugins,
    quick: options.quick,
    ...(options.config ?? {}),
  })
  const root = safeRealpath(resolve(options.root && options.root.length > 0 ? options.root : process.cwd()))
  const mode = options.mode === 'plan' ? 'plan' : 'check'
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  const collection = collectChanges({
    root,
    files: options.files ?? null,
    sinceMinutes: cfg.sinceMinutes,
    maxFiles: cfg.maxFiles,
    maxDepth: cfg.maxDepth,
    cfg,
  })

  const plan = buildPlan({ root, files: collection.files, cfg })

  /** Explicitly requested files that no longer exist. Checking them is
   * impossible, so they must fail the run instead of silently shrinking the set
   * of things that were verified — a caller asking about a ghost file must not
   * get a quiet "nothing to do". */
  const missingSteps = collection.missing.map(path => ({
    id: `missing:${path.toLowerCase()}`,
    kind: /** @type {const} */ ('inline'),
    family: 'input',
    title: t('missingFileTitle', { file: label(root, path) }),
    file: path,
    run: () => ({ ok: false, detail: t('missingFileDetail') }),
  }))
  /** A root that does not exist is not "nothing to check" — it is an input
   * error the caller must hear about. */
  const rootSteps = existsSync(root)
    ? []
    : [{
        id: 'root:missing',
        kind: /** @type {const} */ ('inline'),
        family: 'input',
        title: t('missingRootTitle', { root }),
        file: root,
        run: () => ({ ok: false, detail: t('missingRootDetail') }),
      }]
  const steps = [...rootSteps, ...missingSteps, ...plan.steps]

  const runId = `selftest-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  const base = {
    runId,
    root,
    mode,
    startedAt,
    finishedAt: null,
    durationMs: 0,
    sinceMinutes: cfg.sinceMinutes,
    files: collection.files.map(file => ({
      path: file.path,
      rel: label(root, file.path),
      source: file.source,
    })),
    sources: {
      gitAvailable: collection.gitAvailable,
      gitError: collection.gitError,
      scanned: collection.scanned,
      truncated: collection.truncated,
      depthLimited: collection.depthLimited,
    },
    skipped: plan.skipped,
    missing: collection.missing,
    groups: plan.counts,
    plannedSteps: steps.map(step => ({
      id: step.id,
      kind: step.kind,
      title: step.title,
      // `{{LIST_FILE}}` is an internal placeholder for the temp list file the
      // runner creates at execution time; show something readable in a plan.
      command: step.kind === 'command'
        ? [step.exe, ...(step.args ?? []).map(arg => (arg === '{{LIST_FILE}}' ? t('tempListPlaceholder') : arg))].join(' ')
        : null,
    })),
    results: /** @type {CheckResult[]} */ ([]),
    counts: { total: 0, pass: 0, fail: 0, skip: 0 },
    verdict: /** @type {'pass'|'fail'|'nothing'|'plan'} */ ('nothing'),
    claimChecks: /** @type {Array<Record<string, unknown>>} */ ([]),
    artifactPath: null,
    artifactError: null,
  }

  if (mode === 'plan') {
    base.verdict = 'plan'
    base.finishedAt = new Date().toISOString()
    base.durationMs = Date.now() - t0
    base.claimChecks = buildClaimChecks(root, cfg, base.files)
    return toLossless(base)
  }

  /** @type {CheckResult[]} */
  const results = []
  for (const step of steps) {
    const outcome = await executeStep(step, { timeoutMs: cfg.timeoutMs, signal: options.signal })
    results.push(...expandStep(step, outcome, root))
  }

  const counts = { total: results.length, pass: 0, fail: 0, skip: 0 }
  for (const result of results) counts[result.status] += 1

  const skippedTools = results.filter(result => result.status === 'skip').length
  base.results = results
  base.counts = counts
  base.coverage = {
    truncated: collection.truncated,
    depthLimited: collection.depthLimited,
    skippedTools,
  }
  // A green result with an incomplete collection or an unverifiable step is
  // not the same claim as a green result that actually covered everything.
  // Files left in `skipped` were not checked at all, so a tree full of them
  // must not read as a clean pass.
  const partial = collection.truncated || collection.depthLimited || skippedTools > 0 || plan.skipped.length > 0
  base.verdict = counts.fail > 0 ? 'fail' : collection.files.length === 0 ? 'nothing' : partial ? 'partial' : 'pass'
  base.finishedAt = new Date().toISOString()
  base.durationMs = Date.now() - t0
  base.claimChecks = buildClaimChecks(root, cfg, base.files)

  if (options.persist !== false) {
    const saved = persistReport(root, base, cfg.keepRuns, cfg.evidenceDir)
    base.artifactPath = saved.artifactPath
    base.artifactError = saved.error
  }
    return toLossless(base)
}

/**
 * A `ps1:batch` step covers many files at once; split its JSON so every file
 * gets its own row instead of one opaque "passed".
 *
 * @param {import('./plan.js').Step} step
 * @param {Awaited<ReturnType<typeof executeStep>>} outcome
 * @param {string} root
 * @returns {CheckResult[]}
 */
export function expandStep(step, outcome, root) {
  if ((step.id === 'ps1:batch' || step.id === 'js:batch') && outcome.status !== 'skip') {
    const parsed = tryParseJson(outcome.output)
    if (parsed !== null && Array.isArray(parsed.files)) {
      const family = step.id === 'js:batch' ? 'js' : 'ps1'
      return parsed.files.map(file => ({
        id: `${family}:${String(file.file).toLowerCase()}`,
        title: label(root, String(file.file)),
        file: String(file.file),
        family,
        status: file.ok === true ? 'pass' : 'fail',
        exitCode: outcome.exitCode,
        ms: outcome.ms,
        detail: formatParseErrors(file.errors),
        output: '',
      }))
    }
  }

  return [{
    id: step.id,
    title: step.title,
    file: step.file ?? null,
    family: step.family ?? 'check',
    status: outcome.status,
    exitCode: outcome.exitCode,
    ms: outcome.ms,
    // Inline/policy steps carry their reason in `output` (there is no command
    // output); surfacing it as `detail` is what lets a skip explain itself.
    detail: step.kind === 'inline' || step.kind === 'policy' ? String(outcome.output ?? '') : '',
    output: outcome.output.slice(0, 4_000),
    timedOut: outcome.timedOut,
  }]
}

/**
 * Tool results must survive a JSON round trip unchanged. `undefined` values and
 * non-finite numbers do not, and the harness rejects the whole result as
 * "not lossless JSON", so normalise them at the boundary.
 *
 * @param {any} value
 * @returns {any}
 */
export function toLossless(value) {
  if (value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(toLossless)
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {}
    for (const [key, inner] of Object.entries(value)) out[key] = toLossless(inner)
    return out
  }
  return value
}

/**
 * @param {unknown} errors
 * @returns {string}
 */
function formatParseErrors(errors) {
  if (!Array.isArray(errors)) return ''
  return errors
    .map(error => {
      if (error === null || typeof error !== 'object') return String(error)
      const entry = /** @type {{ message?: unknown, line?: unknown }} */ (error)
      const message = String(entry.message ?? '')
      const line = Number(entry.line ?? 0)
      return line > 0 ? `L${line}: ${message}` : message
    })
    .filter(text => text.length > 0)
    .join('\n')
}

/**
 * A ready-to-paste `claim_plan` check: the CLI entry point, so claim_verify
 * executes exactly the same logic the tool just ran.
 *
 * When the run was an explicit `--files` set, the check must replay that same
 * set. Otherwise an unrelated broken file elsewhere under the root turns a
 * green run into a red verification (and the user cannot understand why).
 *
 * @param {string} root
 * @param {any} cfg
 * @param {Array<{ rel: string, source: string }>} [files]
 * @returns {Array<Record<string, unknown>>}
 */
export function buildClaimChecks(root, cfg, files = []) {
  const node = typeof cfg?.node === 'string' && cfg.node.length > 0 ? cfg.node : process.execPath
  const explicit = Array.isArray(files) && files.length > 0 && files.every(file => file?.source === 'explicit')
  const filesArg = explicit ? ` --files "${files.map(file => file.rel).join(',')}"` : ''
  const scope = explicit ? t('claimScopeExplicit', { n: files.length }) : t('claimScopeAll')
  return [{
    id: 'selftest',
    kind: 'command',
    title: t('claimTitle', { root, scope }),
    // --no-persist because claim checks run under the harness sandbox, where
    // writing outside the session workspace is denied; the verdict is what
    // matters here, the artifact is written when the tool runs normally.
    command: `"${node}" "${CLI_PATH}" --root "${root}" --no-persist --quiet${filesArg}`,
    required: true,
  }]
}

/**
 * @param {string} text
 */
function tryParseJson(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/**
 * Human-readable rendering, shared by the tool renderer and the CLI.
 *
 * @param {any} result
 * @param {{ verbose?: boolean }} [options]
 */
export function formatResult(result, options = {}) {
  const verbose = options.verbose === true
  // Phones have a narrow chat pane: summary keeps the verdict line, the
  // failures, the skip count and the evidence path, and drops per-file rows.
  const summary = options.summary === true
  const icon = result.verdict === 'pass' ? '✅'
    : result.verdict === 'fail' ? '❌'
      : result.verdict === 'partial' ? '⚠️' : '○'
  /** @type {string[]} */
  const lines = []

  if (result.verdict === 'plan') {
    lines.push(t('planTitle', { files: result.files.length, steps: result.plannedSteps.length }))
    lines.push('')
    for (const step of result.plannedSteps) {
      lines.push(`• [${step.kind}] ${step.title}`)
      if (step.command) lines.push(`    ${step.command}`)
    }
  } else {
    const head = result.verdict === 'nothing'
      ? t('nothingToCheck')
      : t('passedPart', { pass: result.counts.pass, total: result.counts.total })
    const bad = result.counts.fail > 0 ? t('failedPart', { n: result.counts.fail }) : ''
    const skip = result.counts.skip > 0 ? t('skippedPart', { n: result.counts.skip }) : ''
    lines.push(t('headerLine', { icon, verdict: result.verdict, head, bad, skip, ms: result.durationMs }))
    lines.push('')
    const failures = result.results.filter(item => item.status === 'fail')
    const shown = summary ? failures.slice(0, 8) : result.results
    for (const item of shown) {
      const mark = item.status === 'pass' ? '✓' : item.status === 'fail' ? '✗' : '-'
      lines.push(`${mark} [${item.family}] ${item.title}`)
      if (item.detail) {
        for (const line of item.detail.split('\n').slice(0, summary ? 3 : 8)) lines.push(`    ${line}`)
      }
      if (item.output && (verbose || item.status === 'fail')) {
        for (const line of item.output.split('\n').slice(0, summary ? 3 : 12)) lines.push(`    ${line}`)
      }
    }
    if (summary && failures.length > shown.length) {
      lines.push(t('moreFailures', { n: failures.length - shown.length }))
    }
    if (summary) {
      const skippedCount = result.skipped.length + result.counts.skip
      if (skippedCount > 0) lines.push(t('skipSummary', { n: skippedCount }))
      if (result.skipped.length > 0) {
        const names = result.skipped.slice(0, 3).map(entry => entry.file).join(', ')
        lines.push(t('uncheckedFiles', { n: result.skipped.length, files: names }))
      }
    }
  }

  if (!summary && result.skipped.length > 0) {
    lines.push('')
    lines.push(t('skippedHeader', { n: result.skipped.length }))
    for (const entry of result.skipped.slice(0, 8)) lines.push(t('skippedItem', { file: entry.file, reason: entry.reason }))
  }
  if (result.sources.gitError) lines.push(t('gitUnavailable', { err: result.sources.gitError }))
  if (result.sources.truncated) lines.push(t('truncated'))
  if (result.sources.depthLimited) lines.push(t('depthLimited'))
  if (result.artifactPath) lines.push(t('evidence', { path: result.artifactPath }))
  else if (result.artifactError) lines.push(t('artifactFailed', { err: result.artifactError }))

  return lines.join('\n')
}

export { CLI_PATH, PACKAGE_DIR }


