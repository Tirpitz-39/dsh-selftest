/**
 * Hard gate: the strongest enforcement layer.
 *
 * Once a turn has written files, the next call that is neither selftest nor a
 * read-only tool is **denied once** with a reason naming the unverified files.
 * The agent has to run selftest (or explain) before the flow continues.
 *
 * Design choices, kept deliberately small:
 *
 * - file writes are never denied (write / edit): blocking them would deadlock
 *   "fix the failing check" loops;
 * - read-only tools are never denied: the agent must still be able to look at
 *   what it is doing;
 * - everything else — shell commands (`git commit`, `npm install`, builds),
 *   unknown tools — is denied once per pending cycle;
 * - `selftest` clears the pending flag and is always allowed;
 * - every failure path fails open: a broken gate must never brick the session;
 * - `hardGate: off` disables the whole layer.
 *
 * The decision itself is the same freshness audit `--audit` exposes, so a data
 * consumer and the in-session gate agree on what "verified" means.
 *
 * @module dsh-selftest/hardgate
 */

import { resolve } from 'node:path'

import { auditFreshness } from './audit.js'
import { resolveConfig } from './config.js'
import { t } from './i18n.js'
import { safeRealpath } from './collect.js'

export const HARD_GATE_DEFAULTS = Object.freeze({
  mode: 'nag', // nag | off
})

/** Tools that never need evidence to run. */
const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'working_directory',
  'list_sessions',
  'list_agents',
  'list_subagent_models',
  'job_list',
  'job_output',
  'job_kill',
  'ask_user_question',
  'wrapup_check',
])

/** File-writing tools: allowed even while evidence is pending (fix loops). */
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isReadOnlyTool(name) {
  if (READ_ONLY_TOOLS.has(name)) return true
  if (name.startsWith('claim_')) return true
  return false
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isFileWriteTool(name) {
  return FILE_WRITE_TOOLS.has(name)
}

/**
 * @param {Map<string, { pending: boolean, nagged: boolean }>} sessions
 * @param {string} sessionId
 */
function stateOf(sessions, sessionId) {
  let state = sessions.get(sessionId)
  if (state === undefined) {
    state = { pending: false, nagged: false }
    sessions.set(sessionId, state)
  }
  return state
}

/**
 * Decide one pre-execute call.
 *
 * @param {object} options
 * @param {string} options.sessionId
 * @param {string} options.root
 * @param {string} options.toolName
 * @param {any} [options.arguments]
 * @param {Map<string, { pending: boolean, nagged: boolean }>} options.sessions
 * @param {any} options.cfg
 * @returns {{ action: 'allow' }|{ action: 'deny', reason: string }}
 */
export function decideCall({ sessionId, root, toolName, arguments: args = {}, sessions, cfg }) {
  const state = stateOf(sessions, sessionId)

  if (toolName === 'selftest') {
    // Only a selftest aimed at this session's own tree clears the gate.
    // Otherwise a call with `root: <some empty dir>` would be a free pass.
    const requested = typeof args?.root === 'string' && args.root.length > 0
      ? resolve(args.root)
      : resolve(root)
    if (safeRealpath(requested) === safeRealpath(root)) {
      state.pending = false
      state.nagged = false
    }
    return { action: 'allow' }
  }
  if (isReadOnlyTool(toolName)) return { action: 'allow' }
  if (isFileWriteTool(toolName)) {
    state.pending = true
    return { action: 'allow' }
  }
  if (!state.pending) return { action: 'allow' }
  if (state.nagged) return { action: 'allow' }

  const audit = auditFreshness({ root, cfg })
  if (audit.verdict === 'fresh' || audit.verdict === 'partial' || audit.verdict === 'nothing') {
    state.pending = false
    return { action: 'allow' }
  }

  state.nagged = true
  const shown = audit.unverified.slice(0, 6).map(file => file.rel)
  return {
    action: 'deny',
    reason: t('hardGateDenied', {
      n: audit.unverified.length,
      files: shown.join(', '),
    }),
  }
}

/**
 * Install the hard gate on the profile context.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 * @returns {{ settings: any, sessions: Map<string, any> }|null}
 */
export function installHardGate(ctx, config = {}) {
  let resolved
  try {
    resolved = resolveConfig(config)
  } catch {
    return null
  }
  const settings = {
    mode: String(resolved.hardGate ?? HARD_GATE_DEFAULTS.mode),
    cfg: resolved,
  }
  if (settings.mode === 'off') return null
  if (typeof ctx?.on !== 'function') return null
  if (typeof ctx.effect !== 'function') return null

  const sessions = new Map()
  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const session = exec && exec.agent ? exec.agent.session : null
        const sessionId = session?.id ?? exec?.agent?.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) return next()
        const root = session?.header?.cwd
        if (typeof root !== 'string' || root.length === 0) return next()
        const decision = decideCall({
          sessionId,
          root,
          toolName: String(exec?.name ?? ''),
          arguments: exec?.arguments ?? {},
          sessions,
          cfg: settings.cfg,
        })
        if (decision.action === 'deny') return { kind: 'deny', reason: decision.reason }
        return next()
      } catch {
        // Fail open: a broken gate must never brick the session.
        return next()
      }
    })
  })
  return { settings, sessions }
}
