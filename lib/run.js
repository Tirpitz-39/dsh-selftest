/**
 * Step execution.
 *
 * Two families of steps:
 *   - `inline` / `policy` run in-process (JSON parse, plugin rule) — no child;
 *   - `command` spawns a child and captures exit code + bounded output.
 *
 * Windows specifics, both learned the hard way elsewhere in this profile:
 *   - `npm`/`pnpm` are `.cmd` shims with no executable; spawning them directly
 *     fails with ENOENT, and Node blocks running `.cmd` with arguments
 *     (CVE-2024-27980), so those go through `cmd.exe /d /s /c`.
 *   - Killing a timeout must take the whole tree (`taskkill /T`), otherwise
 *     grandchildren keep the stdout pipe open and 'close' never fires.
 *
 * @module dsh-selftest/run
 */

import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { t } from './i18n.js'

const MAX_OUTPUT_CHARS = 12_000

/**
 * Create a temp directory that survives a confined sandbox.
 *
 * Claim checks run under the harness sandbox, which may allow writes only
 * inside the session workspace. Probe in order: OS temp, the process cwd, then
 * whatever the caller can offer.
 *
 * @param {string} prefix
 * @param {string[]} [fallbackDirs]
 * @returns {string|null}
 */
export function makeTempDir(prefix, fallbackDirs = []) {
  const candidates = [tmpdir(), process.cwd(), ...fallbackDirs]
  const seen = new Set()
  for (const base of candidates) {
    if (typeof base !== 'string' || base.length === 0) continue
    const key = base.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    try {
      return mkdtempSync(join(base, prefix))
    } catch { /* try the next candidate */ }
  }
  return null
}

/**
 * @typedef {object} StepResult
 * @property {'pass'|'fail'|'skip'} status
 * @property {number|null} exitCode
 * @property {number} ms
 * @property {string} output
 * @property {boolean} timedOut
 */

/**
 * @param {import('./plan.js').Step} step
 * @param {{ timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<StepResult>}
 */
export async function executeStep(step, options) {
  if (step.kind === 'inline' || step.kind === 'policy') {
    const started = Date.now()
    try {
      const outcome = step.run ? step.run() : { ok: true }
      const status = outcome.skipped === true ? 'skip' : outcome.ok === true ? 'pass' : 'fail'
      return {
        status,
        exitCode: null,
        ms: Date.now() - started,
        output: typeof outcome.detail === 'string' ? outcome.detail : '',
        timedOut: false,
      }
    } catch (error) {
      return {
        status: 'fail',
        exitCode: null,
        ms: Date.now() - started,
        output: messageOf(error),
        timedOut: false,
      }
    }
  }

  return runCommandStep(step, options)
}

/**
 * @param {import('./plan.js').Step} step
 * @param {{ timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<StepResult>}
 */
async function runCommandStep(step, options) {
  const started = Date.now()
  /** @type {string[]} */
  let args = [...(step.args ?? [])]
  /** @type {string|null} */
  let listDir = null

  if (Array.isArray(step.listFiles)) {
    listDir = makeTempDir('dsh-selftest-', step.cwd ? [step.cwd] : [])
    if (listDir === null) {
      return {
        status: 'fail',
        exitCode: null,
        ms: 0,
        output: t('tempFileFailed'),
        timedOut: false,
      }
    }
    // Plain string lists are line-oriented (the .ps1 batch parser); object
    // entries carry per-file metadata and are written as JSON (the JS batch).
    const stringList = step.listFiles.every(item => typeof item === 'string')
    const listPath = join(listDir, stringList ? 'files.txt' : 'files.json')
    writeFileSync(listPath, stringList ? step.listFiles.join('\n') : JSON.stringify({ files: step.listFiles }), 'utf8')
    args = args.map(arg => (arg === '{{LIST_FILE}}' ? listPath : arg))
  }

  let copyDir = null
  if (typeof step.esmCopy === 'string' && step.esmCopy.length > 0) {
    // Node 20/22 `--check` can pass a syntax error in a bare `.js` module that
    // has no package.json; checking an `.mjs` copy makes the parse unambiguous.
    try {
      copyDir = makeTempDir('dsh-selftest-esm-', step.cwd ? [step.cwd] : [])
      if (copyDir === null) throw new Error(t('tempFileFailed'))
      const copyPath = join(copyDir, 'check.mjs')
      copyFileSync(step.esmCopy, copyPath)
      args = args.map(arg => (arg === '{{ESM_COPY}}' ? copyPath : arg))
    } catch (error) {
      if (copyDir !== null) {
        try { rmSync(copyDir, { recursive: true, force: true }) } catch { /* best effort */ }
        copyDir = null
      }
      return {
        status: 'fail',
        exitCode: null,
        ms: Date.now() - started,
        output: messageOf(error),
        timedOut: false,
      }
    }
  }

  const cleanup = () => {
    if (listDir !== null) {
      try { rmSync(listDir, { recursive: true, force: true }) } catch { /* best effort */ }
      listDir = null
    }
    if (copyDir !== null) {
      try { rmSync(copyDir, { recursive: true, force: true }) } catch { /* best effort */ }
      copyDir = null
    }
  }

  try {
    const spec = buildSpawnSpec(step, args)
    const result = await spawnCollect(spec, {
      cwd: step.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      label: step.title,
    })
    return { ...result, ms: Date.now() - started }
  } catch (error) {
    return {
      status: 'fail',
      exitCode: null,
      ms: Date.now() - started,
      output: messageOf(error),
      timedOut: false,
    }
  } finally {
    cleanup()
  }
}

/**
 * @param {import('./plan.js').Step} step
 * @param {string[]} args
 */
export function buildSpawnSpec(step, args) {
  const exe = String(step.exe ?? '')
  if (exe.length === 0) throw new Error('step has no executable')
  if (process.platform !== 'win32' || step.viaCmd !== true) {
    return { command: exe, args, shell: false }
  }
  const quote = (value) => (/[\s&|<>^()"]/.test(value) ? `"${String(value).replace(/"/g, '""')}"` : String(value))
  const line = [exe, ...args].map(quote).join(' ')
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', line], shell: false }
}

/**
 * @param {{ command: string, args: string[], shell: boolean }} spec
 * @param {{ cwd?: string, timeoutMs: number, signal?: AbortSignal, label?: string }} options
 * @returns {Promise<Omit<StepResult, 'ms'>>}
 */
async function spawnCollect(spec, options) {
  const piped = await spawnOnce(spec, options, 'pipe')
  if (piped.eperm !== true) return piped

  // Confined sandbox: named pipes cannot be created, so capturing stdout is
  // impossible. Fall back to inheriting the parent's stdio — the child's text
  // still reaches the caller, and the exit code (what decides pass/fail) is
  // unaffected. The marker goes to stderr so a `--json` caller's stdout stays
  // parseable.
  if (typeof options.label === 'string' && options.label.length > 0) {
    process.stderr.write(`[selftest] ${options.label}\n`)
  }
  return spawnOnce(spec, options, 'inherit')
}

/**
 * @param {{ command: string, args: string[], shell: boolean }} spec
 * @param {{ cwd?: string, timeoutMs: number, signal?: AbortSignal }} options
 * @param {'pipe'|'inherit'} mode
 * @returns {Promise<Omit<StepResult, 'ms'> & { eperm?: boolean }>}
 */
function spawnOnce(spec, options, mode) {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    /** @type {NodeJS.Timeout|undefined} */
    let timer
    let stdout = ''
    let stderr = ''

    /** @param {Omit<StepResult, 'ms'> & { eperm?: boolean }} result */
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const onAbort = () => {
      killTreeOf(child)
      finish({ status: 'fail', exitCode: null, output: 'aborted by caller', timedOut: false })
    }

    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(spec.command, spec.args, {
        cwd: options.cwd,
        shell: spec.shell,
        windowsHide: true,
        stdio: mode === 'inherit' ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      })
    } catch (error) {
      // A confined sandbox can reject the pipe at spawn time rather than
      // through an 'error' event; signal the caller so it can retry with
      // inherited stdio instead of reporting a hard failure.
      if (mode === 'pipe' && isPermissionError(error)) {
        finish({ status: 'fail', exitCode: null, output: '', timedOut: false, eperm: true })
        return
      }
      finish({ status: 'fail', exitCode: null, output: messageOf(error), timedOut: false })
      return
    }

    if (options.signal !== undefined) {
      if (options.signal.aborted) { onAbort(); return }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      timedOut = true
      killTreeOf(child)
      finish({
        status: 'fail',
        exitCode: null,
        output: truncate(`${stdout}\n${stderr}`.trim()) + `\n[timeout after ${options.timeoutMs}ms]`,
        timedOut: true,
      })
    }, options.timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk) })
    child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk) })

    child.on('error', (error) => {
      if (mode === 'pipe' && isPermissionError(error)) {
        finish({ status: 'fail', exitCode: null, output: '', timedOut: false, eperm: true })
        return
      }
      finish({ status: 'fail', exitCode: null, output: messageOf(error), timedOut })
    })

    child.on('close', (code) => {
      if (settled) return
      const merged = truncate(`${stdout}${stderr}`.trim())
      finish({
        status: code === 0 ? 'pass' : 'fail',
        exitCode: typeof code === 'number' ? code : null,
        output: merged,
        timedOut,
      })
    })
  })
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
function killTreeOf(child) {
  if (child === undefined || child === null || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* best effort */ }
    return
  }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

/**
 * @param {string} current
 * @param {string} chunk
 */
function appendBounded(current, chunk) {
  if (current.length >= MAX_OUTPUT_CHARS * 2) return current
  return (current + chunk).slice(0, MAX_OUTPUT_CHARS * 2)
}

/**
 * @param {string} text
 */
export function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const head = text.slice(0, MAX_OUTPUT_CHARS)
  return `${head}\n[... ${text.length - MAX_OUTPUT_CHARS} chars truncated]`
}

/**
 * @param {unknown} error
 */
function isPermissionError(error) {
  const code = /** @type {{ code?: string }} */ (error).code
  return code === 'EPERM' || code === 'EACCES'
}

/**
 * @param {unknown} error
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
