/**
 * dsh-selftest — derived self-check for changed files.
 *
 * The model-facing contract is one verb: `selftest`. It answers "what did I
 * just change, what does each change need checked, and did it pass", so a
 * completion claim stops being a memory exercise.
 *
 * This module is deliberately a thin shell: it builds the CLI arguments,
 * spawns `lib/cli.js` with a real node, and returns its JSON. The Harness host
 * is Electron, so `process.execPath` is `DSH NEXT.exe` — that cannot run
 * `--check` — hence the explicit node probe. Keeping all logic in the child
 * process also means edits under `lib/` take effect on the next call instead
 * of waiting for a Harness restart, which ESM caching would otherwise require.
 *
 * @module dsh-selftest
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installHardGate } from './hardgate.js'
import { installWhistle } from './whistle.js'
import { isMobilePlatform, pickNode } from './config.js'
import { t } from './i18n.js'

export const name = 'dsh-selftest'

/** The tool registry is the only service this plugin needs. */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = join(HERE, 'cli.js')

const DESCRIPTION = 'Check every file this session changed and run the tests that own them: git status + recent mtime; '
  + '.ps1 -> PowerShell parser + BOM rule, .js/.mjs/.cjs -> syntax + relative imports, .json -> JSON.parse, '
  + 'plus each changed plugin/project test suite. A changed plugin without tests fails by default. '
  + 'action="plan" lists what would run; quick=true checks syntax only (phones); prove=true health-checks '
  + 'the checkers themselves. result.checks lists the exact command that reproduces this run; any consumer '
  + '(a claim plugin, CI, an in-house scheduler) can read it from the JSON.'

/**
 * @param {any} exec
 * @returns {string|undefined}
 */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * @param {any} args
 * @param {any} exec
 * @returns {string[]}
 */
export function argumentList(args, exec) {
  /** @type {string[]} */
  const argv = ['--json']
  const action = typeof args.action === 'string' ? args.action : 'check'
  if (action === 'plan') argv.push('--explain')
  if (args.prove === true) argv.push('--prove')

  const root = typeof args.root === 'string' && args.root.length > 0 ? args.root : sessionCwd(exec)
  if (typeof root === 'string' && root.length > 0) argv.push('--root', root)
  if (typeof args.since === 'number' && Number.isFinite(args.since)) argv.push('--since', String(args.since))
  if (Array.isArray(args.files) && args.files.length > 0) {
    const files = args.files.filter(value => typeof value === 'string' && value.length > 0)
    if (files.length > 0) argv.push('--files', files.join(','))
  }
  if (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)) argv.push('--timeout', String(args.timeoutMs))
  if (args.strictPlugins === true) argv.push('--strict-plugins')
  if (args.strictPlugins === false) argv.push('--no-strict-plugins')
  if (args.quick === true) argv.push('--quick')
  // Phones have a narrow chat pane; keep the rendered text to the verdict,
  // the failures and the evidence path.
  if (isMobilePlatform()) argv.push('--summary')
  return argv
}

/**
 * @param {string[]} argv
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function runCli(argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(pickNode(), [CLI_PATH, ...argv], {
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      })
    } catch (error) {
      reject(error)
      return
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      reject(new Error(t('cliTimeout', { ms: timeoutMs })))
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const text = stdout.trim()
      if (text.length === 0) {
        const suffix = stderr.trim().length > 0 ? `: ${stderr.trim().slice(0, 500)}` : ''
        reject(new Error(t('cliNoOutput', { code, suffix })))
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error(t('cliBadJson', { code, text: text.slice(0, 500) })))
      }
    })
  })
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  ctx.tools.register({
    name: 'selftest',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'plan'],
          description: 'check (default) runs everything; plan only lists what would run.',
        },
        root: {
          type: 'string',
          description: 'Working directory to analyse. Defaults to the session working directory.',
        },
        since: {
          type: 'number',
          description: 'How many minutes back the mtime scan looks. Default 10.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Check exactly these files (absolute or relative to root) instead of collecting changes.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Per-command timeout in milliseconds. Default 120000.',
        },
        strictPlugins: {
          type: 'boolean',
          description: 'When true (default), a changed plugin source file whose plugin ships no tests is a failure.',
        },
        quick: {
          type: 'boolean',
          description: 'Syntax/JSON checks only: skip test suites and the plugin policy rule. Use on phones for a fast "check what I just changed" pass.',
        },
        prove: {
          type: 'boolean',
          description: 'Health-check the checkers themselves: run each checker against known-bad samples and require it '
            + 'to turn red, plus a known-clean sample that must pass. Use before trusting a suspiciously green result.',
        },
      },
    },
    output: {
      schema: {},
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' && value.text.length > 0 ? value.text : t('noRenderableResult'),
      }],
    },
    async execute(args, exec) {
      const perStep = typeof args?.timeoutMs === 'number' ? args.timeoutMs : 120_000
      const argv = argumentList(args ?? {}, exec)
      // The CLI runs many steps; give the whole run more room than one step.
      // A phone pays for every second the bubble waits, so it gets less.
      const totalTimeout = isMobilePlatform() ? Math.max(30_000, perStep * 2) : Math.max(60_000, perStep * 3)
      return runCli(argv, totalTimeout)
    },
  })

  // The whistle: at turn end, name the files that changed but were never
  // verified by selftest. It only speaks — it never runs checks, never
  // blocks, and every failure path is silent.
  installWhistle(ctx, config)

  // The hard gate: after a write, the next non-whitelisted call is denied
  // once until selftest runs. Strongest layer; `hardGate: off` disables it.
  installHardGate(ctx, config)
}
