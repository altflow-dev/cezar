/* Cockpit language: the pure half. English source strings are the keys — `t('Save')` — so the
 * English cockpit needs no dictionary at all, a string nobody translated yet falls back to
 * readable English instead of a key name, and the test suites (which run in English) assert on
 * the same text the source shows.
 *
 * The language is fixed for the lifetime of the page: it is read from `localStorage` once, at
 * module load, and switching it reloads. That is what lets module-level constants (nav items,
 * option tables, formatters in `lib/`) call `t()` directly, with no hook and no re-render path
 * to forget. A browser-local preference like the theme: nothing to fetch, nothing to configure.
 */
import { pl } from '@/locales/pl'

export const LANGUAGE_STORAGE_KEY = 'cez-language'

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'pl', label: 'Polski' },
] as const
export type Language = (typeof LANGUAGES)[number]['code']

export const DEFAULT_LANGUAGE: Language = 'en'

/** One translation, or the Polish plural triple `[one, few, many]` — see `tp`. */
export type Dictionary = Record<string, string | readonly [string, string, string]>

const DICTIONARIES: Record<Language, Dictionary | null> = { en: null, pl }

/** Coerce anything (missing key, a language removed later, garbage) into a Language. */
export function normalizeLanguage(raw: unknown): Language {
  return LANGUAGES.some((language) => language.code === raw) ? (raw as Language) : DEFAULT_LANGUAGE
}

/** The stored preference, or English when storage is empty/unreadable (private mode). */
export function readStoredLanguage(): Language {
  try {
    return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY))
  } catch {
    return DEFAULT_LANGUAGE
  }
}

let current: Language = readStoredLanguage()

export function currentLanguage(): Language {
  return current
}

/** Tests only: the page never changes language without reloading. */
export function setLanguageForTest(language: Language): void {
  current = language
}

/**
 * Persist the choice and reload into it. `reload` is injectable because jsdom cannot navigate.
 * When storage is unwritable the choice cannot survive a reload, so nothing happens.
 */
export function switchLanguage(language: Language, reload: () => void = () => window.location.reload()): void {
  if (language === current) return
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    return
  }
  reload()
}

type Values = Record<string, string | number | null | undefined>

function interpolate(text: string, values: Values | undefined): string {
  if (!values) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name] ?? '') : match))
}

/**
 * Translate an English source string, filling `{name}` placeholders from `values`.
 * Whitespace around the text is layout (JSX keeps the space next to an element), so it is
 * preserved and never part of the dictionary key.
 */
export function t(text: string, values?: Values): string {
  const key = text.trim()
  const hit = DICTIONARIES[current]?.[key]
  if (typeof hit !== 'string') return interpolate(text, values)
  const start = text.length - text.trimStart().length
  return interpolate(text.slice(0, start) + hit + text.slice(start + key.length), values)
}

/** Polish picks among three forms; English between two. `count` is also available as `{count}`. */
function pluralIndex(count: number): 0 | 1 | 2 {
  const n = Math.abs(count)
  if (n === 1) return 0
  if (Number.isInteger(n) && n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 1
  return 2
}

/**
 * Plural-aware `t`: `tp(count, '{count} task', '{count} tasks')`. The dictionary is keyed by the
 * plural (`other`) form and holds `[one, few, many]`.
 */
export function tp(count: number, one: string, other: string, values?: Values): string {
  const all = { count, ...values }
  const hit = DICTIONARIES[current]?.[other]
  if (Array.isArray(hit)) return interpolate(hit[pluralIndex(count)]!, all)
  return interpolate(count === 1 ? one : other, all)
}
