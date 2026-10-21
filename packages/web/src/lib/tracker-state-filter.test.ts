import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TRACKER_STATE_FILTER_STORAGE_KEY,
  effectiveStatuses,
  normalizeTrackerStateFilter,
  readTrackerStateFilter,
  writeTrackerStateFilter,
} from './tracker-state-filter'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('tracker state filter preference', () => {
  it('remembers one filter per project and leaves the others alone', () => {
    writeTrackerStateFilter('alpha', { state: 'active', statuses: ['Submitted', 'Open'] })
    writeTrackerStateFilter('beta', { state: 'all', statuses: [] })
    expect(readTrackerStateFilter('alpha')).toEqual({ state: 'active', statuses: ['Submitted', 'Open'] })
    expect(readTrackerStateFilter('beta')).toEqual({ state: 'all', statuses: [] })
    expect(readTrackerStateFilter('gamma')).toBeNull()
    writeTrackerStateFilter('alpha', { state: 'all', statuses: [] })
    expect(readTrackerStateFilter('alpha')).toEqual({ state: 'all', statuses: [] })
    expect(readTrackerStateFilter('beta')).toEqual({ state: 'all', statuses: [] })
  })

  it('degrades a corrupt or hand-edited value to no answer, keeping only usable names', () => {
    localStorage.setItem(TRACKER_STATE_FILTER_STORAGE_KEY, 'not json')
    expect(readTrackerStateFilter('alpha')).toBeNull()
    localStorage.setItem(TRACKER_STATE_FILTER_STORAGE_KEY, JSON.stringify({ alpha: { state: 'closed' }, beta: [1] }))
    expect(readTrackerStateFilter('alpha')).toBeNull()
    expect(readTrackerStateFilter('beta')).toBeNull()
    expect(normalizeTrackerStateFilter({ state: 'all', statuses: ['A', 3, '', 'A', 'B'] })).toEqual({ state: 'all', statuses: ['A', 'B'] })
    expect(normalizeTrackerStateFilter({ state: 'active' })).toEqual({ state: 'active', statuses: [] })
  })

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => writeTrackerStateFilter('alpha', { state: 'all', statuses: ['A'] })).not.toThrow()
    expect(readTrackerStateFilter('alpha')).toBeNull()
  })

  it('ignores remembered states the tracker no longer has, and every state without a catalogue', () => {
    expect(effectiveStatuses(['Open', 'Removed', 'FIXED'], ['Submitted', 'Open', 'FIXED'])).toEqual(['Open', 'FIXED'])
    expect(effectiveStatuses(['Removed'], ['Open'])).toEqual([])
    expect(effectiveStatuses(['Open'], null)).toEqual([])
  })
})
