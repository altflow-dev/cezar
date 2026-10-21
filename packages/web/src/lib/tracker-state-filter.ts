/**
 * The tracker list's remembered state filter — per BROWSER and per PROJECT.
 *
 * Projects connect different trackers with different workflows (one YouTrack project says
 * „Do zweryfikowania”, a Jira project says "In Review"), so one answer per project id, in one
 * localStorage map like the sidebar collapse map (`lib/sidebar-collapse.ts`). It is a standing
 * preference about what the list is FOR, so it survives a reload and leaving the tab; it changes
 * only when the person changes it. A remembered state the tracker no longer has is ignored at
 * read time (`effectiveStatuses`), never an error and never a filter that hides everything.
 */

export const TRACKER_STATE_FILTER_STORAGE_KEY = 'cez-tracker-state-filter'

/** The same cap the server enforces on `statuses`. */
export const TRACKER_STATUSES_MAX = 50

export interface TrackerStateFilter {
  /** The Active/All narrowing, used while no specific state is chosen. */
  state: 'active' | 'all'
  /** Chosen workflow state names (the catalogue's `name`); nonempty, they replace `state`. */
  statuses: string[]
}

/** Anything (an older shape, a hand-edited value) → a valid filter, or null for "no answer". */
export function normalizeTrackerStateFilter(raw: unknown): TrackerStateFilter | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const state = value.state === 'all' ? 'all' : value.state === 'active' ? 'active' : null
  if (state === null) return null
  const statuses = Array.isArray(value.statuses)
    ? [...new Set(value.statuses.filter((name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 256))].slice(0, TRACKER_STATUSES_MAX)
    : []
  return { state, statuses }
}

function readMap(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(TRACKER_STATE_FILTER_STORAGE_KEY)
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    // Absent, private mode, or non-JSON — every project falls back to the default.
    return {}
  }
}

/** What this browser remembers for one project; null when it remembers nothing. */
export function readTrackerStateFilter(projectId: string): TrackerStateFilter | null {
  return normalizeTrackerStateFilter(readMap()[projectId])
}

export function writeTrackerStateFilter(projectId: string, filter: TrackerStateFilter): void {
  try {
    const map = readMap()
    map[projectId] = { state: filter.state, statuses: [...new Set(filter.statuses)].slice(0, TRACKER_STATUSES_MAX) }
    localStorage.setItem(TRACKER_STATE_FILTER_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Private mode / storage full — the choice still applies until the page reloads.
  }
}

/**
 * The remembered states that still exist, in the remembered order. `available` is the catalogue's
 * state names, or null when the catalogue is unavailable — then no state filter applies at all,
 * because a filter the person cannot see or change must not narrow the list.
 */
export function effectiveStatuses(chosen: readonly string[], available: readonly string[] | null): string[] {
  if (available === null) return []
  const known = new Set(available)
  return chosen.filter(name => known.has(name))
}
