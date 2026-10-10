import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LANGUAGE_STORAGE_KEY,
  normalizeLanguage,
  readStoredLanguage,
  setLanguageForTest,
  switchLanguage,
  t,
  tp,
} from './i18n'

afterEach(() => {
  setLanguageForTest('en')
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('language preference', () => {
  it('defaults to English and ignores anything it does not ship', () => {
    expect(readStoredLanguage()).toBe('en')
    expect(normalizeLanguage('pl')).toBe('pl')
    expect(normalizeLanguage('de')).toBe('en')
    expect(normalizeLanguage(null)).toBe('en')
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'pl')
    expect(readStoredLanguage()).toBe('pl')
  })

  it('persists a new language and reloads into it, and does nothing for the current one', () => {
    const reload = vi.fn()
    switchLanguage('en', reload)
    expect(reload).not.toHaveBeenCalled()
    switchLanguage('pl', reload)
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('pl')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload when the choice could not be stored', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    const reload = vi.fn()
    switchLanguage('pl', reload)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('t', () => {
  it('returns the English source untouched, filling placeholders', () => {
    expect(t('Settings')).toBe('Settings')
    expect(t('Branch: {branch}', { branch: 'main' })).toBe('Branch: main')
    expect(t('{missing} stays', { other: 1 })).toBe('{missing} stays')
  })

  it('translates, keeps the whitespace JSX put around the text, and falls back when a key is absent', () => {
    setLanguageForTest('pl')
    expect(t('Settings')).toBe('Ustawienia')
    expect(t(' Settings ')).toBe(' Ustawienia ')
    expect(t('Branch: {branch}', { branch: 'main' })).toBe('Gałąź: main')
    expect(t('A sentence nobody translated yet')).toBe('A sentence nobody translated yet')
  })

  it('leaves workflow placeholders alone when no values are passed', () => {
    expect(t('Update: {{task}}')).toBe('Update: {{task}}')
  })
})

describe('tp', () => {
  it('picks between the two English forms', () => {
    expect(tp(1, '{count} file', '{count} files')).toBe('1 file')
    expect(tp(0, '{count} file', '{count} files')).toBe('0 files')
  })

  it.each([
    [1, '1 plik'], [2, '2 pliki'], [4, '4 pliki'], [5, '5 plików'], [12, '12 plików'], [14, '14 plików'],
    [22, '22 pliki'], [25, '25 plików'], [112, '112 plików'], [0, '0 plików'],
  ])('picks the Polish form for %i', (count, expected) => {
    setLanguageForTest('pl')
    expect(tp(count, '{count} file', '{count} files')).toBe(expected)
  })

  it('falls back to English forms for an untranslated plural', () => {
    setLanguageForTest('pl')
    expect(tp(2, '{count} zebra', '{count} zebras')).toBe('2 zebras')
  })
})
