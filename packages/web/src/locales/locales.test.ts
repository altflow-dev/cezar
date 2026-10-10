import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BUCKET_ORDER } from '@/lib/task-groups'
import { pl } from './pl'

/* The dictionary is keyed by English source text, so nothing ties an entry to its call site
 * but the text itself. These checks are what stop it rotting: a reworded English string
 * silently drops its translation, and a mistyped placeholder prints a literal `{name}`. */

const SRC = join(import.meta.dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'locales' ? [] : sourceFiles(full)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : []
  })
}

const source = sourceFiles(SRC).map((file) => readFileSync(file, 'utf8')).join('\n')
const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort()
const literal = (key: string) => key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

describe('Polish dictionary', () => {
  it('keeps every placeholder of its English source', () => {
    for (const [key, value] of Object.entries(pl)) {
      for (const form of typeof value === 'string' ? [value] : value) {
        // A plural form may drop `{count}` (e.g. "one file"), never invent a name.
        const allowed = typeof value === 'string' ? placeholders(key) : [...placeholders(key), '{count}']
        expect(placeholders(form).filter((name) => !allowed.includes(name)), key).toEqual([])
        if (typeof value === 'string') expect(placeholders(form), key).toEqual(placeholders(key))
      }
    }
  })

  it('has no entry whose English source left the code', () => {
    // Bucket labels are identity in `lib/task-groups` and translated where they render.
    const dynamic = new Set<string>(BUCKET_ORDER)
    // Substring, not an exact literal: JSX keeps layout whitespace inside the source string.
    const orphans = Object.keys(pl).filter((key) => !dynamic.has(key) && !source.includes(literal(key)))
    expect(orphans).toEqual([])
  })

  it('never translates text that is sent to an agent or executed', () => {
    for (const key of Object.keys(pl)) {
      expect(key.startsWith('{{'), key).toBe(false)
      expect(/^(npx|npm|git|gh) \S+( \S+)?$/.test(key), key).toBe(false)
    }
  })
})
