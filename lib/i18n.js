/**
 * Locale selection + message lookup for user-facing text.
 *
 * Resolution order:
 *   1. DSH_SELFTEST_LANG          explicit override (zh / en)
 *   2. LC_ALL / LC_MESSAGES / LANG / LANGUAGE   (zh* -> zh, anything else -> en)
 *   3. the runtime locale from Intl (a Chinese system -> zh, otherwise en)
 *
 * Messages live in locale/en.json and locale/zh.json under the "messages" key.
 * The language is resolved lazily on first use and cached per process; use
 * setLang() to switch explicitly (tests, long-lived embedders).
 *
 * @module dsh-selftest/i18n
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'locale')
const FALLBACK = 'en'

/** @type {Record<string, string>} */
let messages = {}
/** @type {string|null} */
let current = null

/**
 * @param {unknown} raw
 * @returns {'zh'|'en'|null}
 */
function pick(raw) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text.length === 0) return null
  if (text.startsWith('zh')) return 'zh'
  if (text.startsWith('en')) return 'en'
  // A BCP-47 tag such as "ja-JP" or a Windows locale name; non-Chinese -> English.
  return text.includes('zh') ? 'zh' : 'en'
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {'zh'|'en'}
 */
export function resolveLang(env = process.env) {
  const explicit = pick(env.DSH_SELFTEST_LANG)
  if (explicit) return explicit
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
    const fromEnv = pick(env[key])
    if (fromEnv) return fromEnv
  }
  try {
    return pick(Intl.DateTimeFormat().resolvedOptions().locale) ?? FALLBACK
  } catch {
    return FALLBACK
  }
}

function loadMessages() {
  try {
    const raw = readFileSync(join(LOCALE_DIR, `${current}.json`), 'utf8')
    messages = JSON.parse(raw).messages ?? {}
  } catch {
    messages = {}
  }
}

function ensure() {
  if (current !== null) return
  current = resolveLang()
  loadMessages()
}

/** @returns {'zh'|'en'} */
export function currentLang() {
  ensure()
  return current
}

/**
 * Switch language explicitly and load its messages.
 * @param {string} lang
 * @returns {'zh'|'en'}
 */
export function setLang(lang) {
  current = pick(lang) ?? FALLBACK
  messages = {}
  loadMessages()
  return current
}

/**
 * Look up a message and substitute `{name}` placeholders.
 * Unknown keys return the key itself so a missing translation is visible
 * instead of silently rendering an empty line.
 *
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(key, params = {}) {
  ensure()
  const template = messages[key]
  if (typeof template !== 'string') return key
  return template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole))
}
