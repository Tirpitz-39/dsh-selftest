/**
 * Evidence audit: the forced gate for data consumers.
 *
 * It answers one question, for anything that reads selftest evidence (CI, a
 * git hook, an in-house scheduler): "does the last selftest still cover the
 * tree as it is now, and did it pass?"
 *
 * It never runs checks. It compares two sets of signatures with the files on
 * disk right now:
 *
 *   - the files the git/mtime scan sees as changed, and
 *   - every file the recorded evidence claims to have verified.
 *
 * The second set matters: without it, rolling a file's mtime back (or
 * deleting a verified file) would make the change invisible to the scan and
 * the audit would happily pass.
 *
 * Exit-code contract (see cli.js):
 *   0  fresh / partial / nothing  → the flow may continue
 *   1  stale / unverified         → the flow is rejected
 *   2  bad arguments
 *
 * @module dsh-selftest/audit
 */

import { join, resolve } from 'node:path'

import { collectChanges, safeRealpath } from './collect.js'
import { t } from './i18n.js'
import { label } from './plan.js'
import { readLatest } from './report.js'
import { fileSignature, sameSignature } from './signature.js'

/**
 * @typedef {{ rel: string, reason: string }} UnverifiedFile
 */

/**
 * The artifact path this audit reads; mirrors report.js's layout.
 * @param {string} root
 * @param {any} cfg
 * @returns {string}
 */
function evidencePathOf(root, cfg) {
  return cfg.evidenceDir !== ''
    ? join(cfg.evidenceDir, 'latest.json')
    : join(root, '.dsh', 'selftest', 'latest.json')
}

/**
 * @param {{ root: string, cfg: any }} options
 * @returns {{ verdict: 'fresh'|'stale'|'unverified'|'nothing', total: number, verified: number, unverified: UnverifiedFile[], artifactPath: string|null }}
 */
export function auditFreshness({ root, cfg }) {
  // Same realpath the runner uses: Windows short names (ADMINI~1) would
  // otherwise fail to match the paths recorded in the artifact.
  const resolvedRoot = safeRealpath(resolve(root))
  const collection = collectChanges({
    root: resolvedRoot,
    files: null,
    sinceMinutes: cfg.sinceMinutes,
    maxFiles: cfg.maxFiles,
    maxDepth: cfg.maxDepth,
    cfg,
  })
  const current = collection.files.map(file => ({
    path: file.path,
    rel: label(resolvedRoot, file.path),
    signature: fileSignature(file.path),
  }))

  const artifact = readLatest(resolvedRoot, cfg.evidenceDir)
  const artifactPath = artifact !== null && artifact !== undefined
    ? evidencePathOf(resolvedRoot, cfg)
    : null

  /** @type {Map<string, any>} */
  const recorded = new Map()
  if (Array.isArray(artifact?.files)) {
    for (const file of artifact.files) {
      if (typeof file?.path === 'string') recorded.set(file.path, file.signature)
    }
  }

  /** @type {UnverifiedFile[]} */
  const unverified = []
  const seen = new Set()
  let verified = 0

  // 1) The files currently seen as changed must be covered by the evidence.
  for (const file of current) {
    seen.add(file.path)
    const previous = recorded.get(file.path)
    if (previous === undefined) {
      unverified.push({ rel: file.rel, reason: t('auditNeverChecked') })
      continue
    }
    if (!sameSignature(file.signature, previous)) {
      unverified.push({ rel: file.rel, reason: t('auditChangedSince') })
      continue
    }
    verified += 1
  }

  // 2) Every file the evidence claims to have verified must still match —
  //    even when the scan no longer sees it (mtime rolled back, file deleted).
  for (const file of Array.isArray(artifact?.files) ? artifact.files : []) {
    if (typeof file?.path !== 'string' || seen.has(file.path)) continue
    const now = fileSignature(file.path)
    const rel = label(resolvedRoot, file.path)
    if (file.signature === undefined || file.signature === null) {
      unverified.push({ rel, reason: t('auditUnverifiable') })
      continue
    }
    if (now === null) {
      unverified.push({ rel, reason: t('auditDeletedSince') })
      continue
    }
    if (!sameSignature(now, file.signature)) {
      unverified.push({ rel, reason: t('auditChangedSince') })
      continue
    }
    verified += 1
  }

  if (unverified.length === 0 && current.length === 0) {
    return { verdict: 'nothing', total: 0, verified: 0, unverified: [], artifactPath }
  }

  let verdict
  if (unverified.length > 0) verdict = 'unverified'
  else if (artifact.verdict === 'pass') verdict = 'fresh'
  else if (artifact.verdict === 'partial') verdict = 'partial'
  else verdict = 'stale'

  return {
    verdict,
    total: current.length,
    verified,
    unverified,
    artifactPath,
  }
}

/**
 * Human-readable rendering for the CLI (non-JSON mode).
 *
 * @param {ReturnType<typeof auditFreshness>} result
 * @returns {string}
 */
export function formatAudit(result) {
  /** @type {string[]} */
  const lines = []
  if (result.verdict === 'fresh') {
    lines.push(t('auditFresh', { n: result.total }))
  } else if (result.verdict === 'partial') {
    lines.push(t('auditPartial', { n: result.total }))
  } else if (result.verdict === 'nothing') {
    lines.push(t('auditNothing'))
  } else if (result.verdict === 'stale') {
    lines.push(t('auditStale'))
  } else {
    lines.push(t('auditUnverifiedHead', { n: result.unverified.length, total: result.total }))
    for (const file of result.unverified.slice(0, 12)) {
      lines.push(t('auditLine', { rel: file.rel, reason: file.reason }))
    }
    if (result.unverified.length > 12) lines.push(t('auditMore', { n: result.unverified.length - 12 }))
    lines.push(t('auditHowTo'))
  }
  if (result.artifactPath) lines.push(t('auditEvidence', { path: result.artifactPath }))
  return lines.join('\n')
}
