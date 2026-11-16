/**
 * Batch JavaScript checker used by the `js:batch` step.
 *
 * One node process parses every changed JS file with `vm.Script` (CJS) or
 * `vm.SourceTextModule` (ESM) — never executing it — and additionally verifies
 * that relative imports resolve to a file that exists. That replaces one
 * `node --check` spawn per file, which is the dominant cost on a phone.
 *
 * Usage: node --experimental-vm-modules parse-js.mjs -ListFile <payload.json>
 * Payload: { "files": [{ "file": "...", "kind": "esm"|"cjs" }] }
 * Output:  { "files": [{ "file": "...", "ok": true|false, "errors": [{message, line}] }] }
 *
 * @module dsh-selftest/parse-js
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import vm from 'node:vm'

const args = process.argv.slice(2)
const listIndex = args.indexOf('-ListFile')
if (listIndex < 0 || listIndex + 1 >= args.length) {
  process.stderr.write('usage: node --experimental-vm-modules parse-js.mjs -ListFile <payload.json>\n')
  process.exit(2)
}

/** @type {{ files: Array<{ file: string, kind: 'esm'|'cjs' }> }} */
const payload = JSON.parse(readFileSync(args[listIndex + 1], 'utf8'))

const IMPORT_CANDIDATE_EXTS = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json']
const IMPORT_SPECIFIERS = [
  /(?:^|[^\w$.])from\s+['"](\.[^'"]+)['"]/g, // import ... from './x'
  /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g, // import('./x')
  /(?:^|[^\w$.])import\s+['"](\.[^'"]+)['"]/g, // import './x'
]

/**
 * @param {string} specifier
 * @param {string} fromFile
 * @returns {boolean}
 */
function resolves(specifier, fromFile) {
  const base = resolve(dirname(fromFile), specifier)
  for (const ext of IMPORT_CANDIDATE_EXTS) {
    if (ext === '' && existsSync(base) && extname(base) !== '') return true
    if (existsSync(base + ext)) return true
  }
  for (const indexName of ['index.js', 'index.mjs', 'index.ts', 'index.tsx']) {
    if (existsSync(join(base, indexName))) return true
  }
  return false
}

/**
 * Blank out comments so import-looking text inside them (`// import ... from
 * './x'`) is never treated as a real import. Length and line breaks are
 * preserved so reported line numbers stay correct.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
  return withoutBlocks.replace(/(^|[^:'"`])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length))
}

/**
 * Is `column` inside an open string literal on `line`? A single-line scan is
 * enough here: it keeps text that merely *looks* like an import (for example
 * `"import './nope.js'"` inside a test fixture) from being reported as one.
 *
 * @param {string} line
 * @param {number} column
 * @returns {boolean}
 */
function insideString(line, column) {
  let quote = null
  for (let i = 0; i < column && i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
  }
  return quote !== null
}

/**
 * @param {string} source
 * @param {string} file
 * @returns {Array<{ message: string, line: number }>}
 */
function unresolvedImports(source, file) {
  const errors = []
  const lines = source.split(/\r?\n/)
  /** @type {number[]} */
  const lineStarts = [0]
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') lineStarts.push(i + 1)
  }
  /** @param {number} index */
  function locationOf(index) {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return { line: lo, column: index - lineStarts[lo] }
  }

  const scannable = stripComments(source)
  for (const pattern of IMPORT_SPECIFIERS) {
    for (const match of scannable.matchAll(pattern)) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) continue
      // Skip matches whose keyword sits inside a string literal: a fixture
      // that quotes an import must not turn into a failed unresolved import.
      const keyword = match[0].search(/import|from/)
      const at = locationOf(match.index + (keyword >= 0 ? keyword : 0))
      if (insideString(lines[at.line] ?? '', at.column)) continue
      if (resolves(specifier, file)) continue
      const line = lines.findIndex(text => text.includes(`'${specifier}'`) || text.includes(`"${specifier}"`)) + 1
      errors.push({ message: `relative import '${specifier}' cannot be resolved`, line: Math.max(1, line) })
    }
  }
  return errors
}

/**
 * @param {unknown} error
 * @returns {number}
 */
function errorLine(error) {
  const stack = error instanceof Error ? String(error.stack ?? '') : ''
  for (const line of stack.split('\n')) {
    if (line.includes('node:internal')) continue
    const match = line.match(/^(.*?):(\d+)(?::\d+)?$/)
    if (match) return Number(match[2])
  }
  return 1
}

const out = []
for (const entry of payload.files) {
  try {
    const source = readFileSync(entry.file, 'utf8').replace(/^\uFEFF/, '')
    if (entry.kind === 'esm') {
      if (typeof vm.SourceTextModule !== 'function') {
        out.push({
          file: entry.file,
          ok: false,
          errors: [{ message: 'vm.SourceTextModule is unavailable; run node with --experimental-vm-modules', line: 1 }],
        })
        continue
      }
      new vm.SourceTextModule(source, { identifier: entry.file })
    } else {
      new vm.Script(source, { filename: entry.file })
    }
    const importErrors = unresolvedImports(source, entry.file)
    out.push({ file: entry.file, ok: importErrors.length === 0, errors: importErrors })
  } catch (error) {
    out.push({
      file: entry.file,
      ok: false,
      errors: [{ message: error instanceof Error ? error.message : String(error), line: errorLine(error) }],
    })
  }
}

process.stdout.write(JSON.stringify({ files: out }))
// A batch that found a problem must also say so through its exit code: under
// a confined sandbox the parent may only be able to inherit stdio (no pipes),
// in which case the JSON cannot be captured and the exit code is the only
// signal left. Mirrors what parse-ps1.ps1 does.
if (out.some(entry => entry.ok !== true)) process.exitCode = 1
