/**
 * The whistle — a turn-end prompt that names the files selftest has never
 * seen, instead of a vague "remember to test".
 *
 * The mechanism is ours, not borrowed:
 *
 * - the unit of truth is a **per-file signature** (size + mtime + sha256
 *   prefix). The question is "which of the files I changed did I actually
 *   verify", not "is the whole workspace the same tree";
 * - `selftest` records signatures for the files it checked in
 *   `.dsh/selftest/latest.json`; the whistle compares the current changed
 *   files against them at the end of a turn;
 * - a file whose signature differs from the recorded one counts as
 *   "changed since it was verified";
 * - the whistle **only speaks**: it never runs checks, never blocks, and
 *   never edits anything;
 * - the same file at the same content is whistled at most once per session,
 *   so the reminder budget goes to real new work;
 * - every failure path stays silent: a whistle must never break a turn.
 *
 * @module dsh-selftest/whistle
 */

import { label } from './plan.js'
import { collectChanges, safeRealpath } from './collect.js'
import { resolveConfig } from './config.js'
import { readLatest } from './report.js'
import { fileSignature, sameSignature } from './signature.js'
import { t } from './i18n.js'
import { resolve } from 'node:path'

/** Who may whistle, and how often. */
export const WHISTLE_DEFAULTS = Object.freeze({
  mode: 'warn', // warn | strict | off
  maxWhistlesPerSession: 2,
  requireWhistleAfterWrite: true,
})

/**
 * Does this settled tool call write files?
 *
 * Shell calls are matched by their command text; read-only commands are not
 * writes. Unknown tools are not writes.
 *
 * @param {string} toolName
 * @param {any} payload
 * @returns {boolean}
 */
export function isWriteTool(toolName, payload) {
  if (toolName === 'write' || toolName === 'edit' || toolName === 'str_replace_editor') return true
  if (toolName !== 'bash' && toolName !== 'pwsh' && toolName !== 'shell') return false
  const args = payload?.arguments ?? payload?.call?.arguments ?? {}
  const command = typeof args?.command === 'string' ? args.command : ''
  if (command.length === 0) return false
  return /(^|[;&|]\s*|\s)(rm|mv|cp|touch|mkdir|rmdir|del|erase|copy|move|New-Item|Remove-Item|Set-Content|Add-Content|Out-File|tee)\b|>\s*[^\s|]|git\s+(commit|merge|rebase|cherry-pick|reset|checkout|switch|stash\s+pop)|npm\s+(install|uninstall|ci)|pnpm\s+(add|remove|install)|pip\s+install|--write|--fix|-w\b/i.test(command)
}

/**
 * Stable identity of "this file at this content": the same file edited again
 * produces a different key, so it can be whistled again.
 *
 * @param {{ path: string, signature: any }} file
 */
export function whistleKey(file) {
  const signature = file.signature
  if (signature === null || signature === undefined) return `${file.path}\u0000?`
  return `${file.path}\u0000${signature.sha ?? `${signature.size}:${signature.mtimeMs}`}`
}

/**
 * Compare the current changed files against what the last selftest recorded.
 *
 * @param {{ root: string, cfg: any, artifact: any|null }} options
 * @returns {{ shouldWhistle: boolean, unchecked: Array<{ path: string, rel: string }>, total: number, checked: number }}
 */
export function evaluateWhistle({ root, cfg, artifact }) {
  // Same realpath the runner uses, so Windows short names (ADMINI~1) still
  // match the absolute paths recorded in the artifact.
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
  if (current.length === 0) {
    return { shouldWhistle: false, unchecked: [], total: 0, checked: 0 }
  }

  // A `plan` run inspected nothing; its file list is not evidence.
  const usable = artifact !== null && artifact.verdict !== 'plan' && Array.isArray(artifact.files)
  if (!usable) {
    return {
      shouldWhistle: true,
      unchecked: current.map(file => ({ path: file.path, rel: file.rel, signature: file.signature })),
      total: current.length,
      checked: 0,
    }
  }

  /** @type {Map<string, any>} */
  const verified = new Map()
  for (const file of artifact.files) {
    if (typeof file?.path === 'string') verified.set(file.path, file.signature)
  }
  const unchecked = current
    .filter(file => !sameSignature(file.signature, verified.get(file.path)))
    .map(file => ({ path: file.path, rel: file.rel, signature: file.signature }))

  return {
    shouldWhistle: unchecked.length > 0,
    unchecked,
    total: current.length,
    checked: current.length - unchecked.length,
  }
}

/**
 * The message the whistle blows.
 *
 * @param {{ total: number, unchecked: Array<{ rel: string }> }} decision
 * @param {number} n
 * @param {number} max
 * @param {string} [evidencePath]
 * @param {'warn'|'strict'} [mode]
 * @returns {string}
 */
export function whistleText(decision, n, max, evidencePath, mode = 'warn') {
  const shown = decision.unchecked.slice(0, 8).map(file => file.rel)
  const lines = [
    t(mode === 'strict' ? 'whistleStrictHead' : 'whistleHead', {
      n,
      max,
      total: decision.total,
      unchecked: decision.unchecked.length,
    }),
    ...shown.map(rel => `  - ${rel}`),
  ]
  if (decision.unchecked.length > shown.length) {
    lines.push(t('whistleMore', { n: decision.unchecked.length - shown.length }))
  }
  lines.push(t('whistleHow'))
  if (evidencePath) lines.push(t('whistleWhere', { path: evidencePath }))
  lines.push(t('whistleIgnore'))
  return lines.join('\n')
}

/**
 * Attach the whistle to one agent's scoped context.
 *
 * @param {any} ctx
 * @param {any} agent
 * @param {{ mode: string, maxWhistlesPerSession: number, requireWhistleAfterWrite: boolean, evidenceDir: string, cfg: any }} settings
 * @param {{ sessions: Map<string, { whistles: number, mutatedThisTurn: boolean, whistled: Set<string> }>, agents: WeakSet<object> }} state
 */
export function attachToAgent(ctx, agent, settings, state) {
  const sessionId = agent?.session?.id ?? agent?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  if (agent !== null && typeof agent === 'object') {
    if (state.agents.has(agent)) return
    state.agents.add(agent)
  }
  if (!state.sessions.has(sessionId)) state.sessions.set(sessionId, { whistles: 0, mutatedThisTurn: false, whistled: new Set() })

  const scoped = agent?.ctx ?? ctx
  if (typeof scoped?.on !== 'function') return

  const disposeResult = scoped.on('tools/result', payload => {
    try {
      const toolName = payload?.name ?? payload?.tool?.name ?? payload?.call?.name
      if (typeof toolName !== 'string') return
      if (!isWriteTool(toolName, payload)) return
      const st = state.sessions.get(sessionId)
      if (st) st.mutatedThisTurn = true
    } catch {
      // Never break the tool pipeline.
    }
  })

  const disposeStop = scoped.on('agent/turn-stopping', async () => {
    try {
      if (settings.mode === 'off') return
      const st = state.sessions.get(sessionId)
      if (!st) return
      if (settings.requireWhistleAfterWrite && !st.mutatedThisTurn) return
      if (st.whistles >= settings.maxWhistlesPerSession) return
      const root = agent?.session?.header?.cwd
      if (typeof root !== 'string' || root.length === 0) return

      const artifact = readLatest(root, settings.evidenceDir)
      const decision = evaluateWhistle({ root, cfg: settings.cfg, artifact })
      if (!decision.shouldWhistle) return

      // warn: the same file at the same content is named once.
      // strict: every turn keeps speaking until selftest runs, still bounded
      // by maxWhistlesPerSession so it cannot loop forever.
      const strict = settings.mode === 'strict'
      const fresh = strict
        ? decision.unchecked
        : decision.unchecked.filter(file => !st.whistled.has(whistleKey(file)))
      if (fresh.length === 0) return
      if (!strict) {
        for (const file of fresh) st.whistled.add(whistleKey(file))
      }

      st.whistles += 1
      st.mutatedThisTurn = false
      const text = whistleText(
        { total: decision.total, unchecked: fresh.map(file => ({ rel: file.rel })) },
        st.whistles,
        settings.maxWhistlesPerSession,
        artifact?.artifactPath ?? undefined,
        strict ? 'strict' : 'warn',
      )
      await agent.followup({
        id: `whistle-${sessionId}-${st.whistles}-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-selftest' },
      })
    } catch {
      // A whistle must never break a turn.
    }
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try { disposeResult?.() } catch { /* already disposed */ }
      try { disposeStop?.() } catch { /* already disposed */ }
    }, `dsh-selftest: whistle ${sessionId}`)
  }
}

/**
 * Install the whistle on the profile context.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 * @returns {{ settings: any, attach: (agent: any) => void }|null}
 */
export function installWhistle(ctx, config = {}) {
  let resolved
  try {
    resolved = resolveConfig(config)
  } catch {
    return null
  }
  const settings = {
    mode: String(resolved.whistleMode ?? WHISTLE_DEFAULTS.mode),
    maxWhistlesPerSession: Number(resolved.maxWhistlesPerSession ?? WHISTLE_DEFAULTS.maxWhistlesPerSession),
    requireWhistleAfterWrite: resolved.requireWhistleAfterWrite !== false,
    evidenceDir: String(resolved.evidenceDir ?? ''),
    cfg: resolved,
  }
  if (settings.mode === 'off') return null
  if (typeof ctx?.on !== 'function') return null

  const state = {
    sessions: /** @type {Map<string, any>} */ (new Map()),
    agents: new WeakSet(),
  }
  const attach = agent => {
    try {
      attachToAgent(ctx, agent, settings, state)
    } catch {
      // Never break agent creation.
    }
  }
  try {
    ctx.on('agent/created', payload => {
      try { attach(payload?.agent ?? payload) } catch { /* never break agent creation */ }
    })
  } catch {
    // Profiles without the agents service simply have no whistle.
  }
  return { settings, attach }
}
