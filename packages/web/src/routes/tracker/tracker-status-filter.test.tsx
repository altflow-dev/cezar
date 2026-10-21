import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { ProjectScopeContext } from '@/api/project-scope-context'
import { TRACKER_STATE_FILTER_STORAGE_KEY } from '@/lib/tracker-state-filter'
import { TrackerRoute } from './tracker'

vi.mock('@/api/ws', () => ({ subscribeTopic: () => () => {} }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

const states = [
  { id: '86-0', name: 'Submitted', label: 'Zgłoszona', resolved: false },
  { id: '86-1', name: 'Open', label: 'Otwarta', resolved: false },
  { id: '86-3', name: 'FIXED', label: 'Do zweryfikowania', resolved: true },
]

function serve(statesResponse: unknown = { available: true, states }) {
  const lists: URL[] = []
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  // jsdom has no ResizeObserver; Radix positions the popover with floating-ui, which observes.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  // ...nor scrollIntoView, which cmdk calls on the highlighted item.
  Element.prototype.scrollIntoView ??= () => {}
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.pathname.endsWith('/tracker/association')) return json({ association: {
      kind: 'youtrack', source: { id: 'yt', webUrl: 'https://acme.youtrack.cloud' }, externalId: '22-68', externalName: 'Medicore',
    } })
    if (url.pathname.endsWith('/tracker/states')) return json(statesResponse)
    if (url.pathname.endsWith('/tracker') || url.pathname.endsWith('/tracker/search')) {
      lists.push(url)
      return json({ available: true, items: [], truncated: false })
    }
    return new Promise<never>(() => {})
  }))
  return lists
}

function show(projectId: string) {
  return render(
    <ProjectScopeContext.Provider value={{ projectId, apiBase: '/api' }}>
      <MemoryRouter initialEntries={['/tracker']}>
        <QueryClientProvider client={createQueryClient()}>
          <Routes><Route path="/tracker" element={<TrackerRoute />} /></Routes>
        </QueryClientProvider>
      </MemoryRouter>
    </ProjectScopeContext.Provider>,
  )
}

const statusesOf = (url: URL | undefined) => url?.searchParams.get('statuses') ?? null

describe('tracker state filter', () => {
  it('filters server-side by the chosen states and remembers them per project across remounts', async () => {
    const lists = serve()
    show('alpha')
    fireEvent.click(await screen.findByRole('button', { name: 'Filter states' }))
    fireEvent.click(await screen.findByText('Do zweryfikowania'))
    await waitFor(() => expect(statusesOf(lists.at(-1))).toBe('["FIXED"]'))
    fireEvent.click(await screen.findByText('Zgłoszona'))
    await waitFor(() => expect(statusesOf(lists.at(-1))).toBe('["FIXED","Submitted"]'))
    expect((screen.getByLabelText('Issue state') as HTMLSelectElement).value).toBe('selected')
    cleanup()

    // A reload or a trip to another tab remounts the view: the choice comes back for this project.
    lists.length = 0
    show('alpha')
    await waitFor(() => expect(lists.length).toBeGreaterThan(0))
    expect(statusesOf(lists[0])).toBe('["FIXED","Submitted"]')
    expect(screen.getByRole('button', { name: 'Filter states' }).textContent).toContain('2')
    cleanup()

    // Another project has its own (empty) answer.
    lists.length = 0
    show('beta')
    await waitFor(() => expect(lists.length).toBeGreaterThan(0))
    expect(statusesOf(lists[0])).toBeNull()
    expect(lists[0]?.searchParams.get('state')).toBe('active')
  })

  it('goes back to Active/All from the select and remembers that too', async () => {
    const lists = serve()
    localStorage.setItem(TRACKER_STATE_FILTER_STORAGE_KEY, JSON.stringify({ alpha: { state: 'active', statuses: ['Open'] } }))
    show('alpha')
    await waitFor(() => expect(statusesOf(lists.at(-1))).toBe('["Open"]'))
    fireEvent.change(screen.getByLabelText('Issue state'), { target: { value: 'all' } })
    await waitFor(() => expect(lists.at(-1)?.searchParams.get('state')).toBe('all'))
    expect(statusesOf(lists.at(-1))).toBeNull()
    expect(JSON.parse(localStorage.getItem(TRACKER_STATE_FILTER_STORAGE_KEY)!)).toEqual({ alpha: { state: 'all', statuses: [] } })
  })

  it('ignores a remembered state the tracker no longer has, without ever asking for it', async () => {
    const lists = serve()
    localStorage.setItem(TRACKER_STATE_FILTER_STORAGE_KEY, JSON.stringify({ alpha: { state: 'active', statuses: ['Removed', 'Open'] } }))
    show('alpha')
    await waitFor(() => expect(lists.length).toBeGreaterThan(0))
    expect(lists.map(statusesOf)).toEqual(lists.map(() => '["Open"]'))
  })

  it('hides the filter and applies no remembered state when the tracker has no state catalogue', async () => {
    const lists = serve({ available: false, code: 'unavailable', reason: 'This tracker does not offer a state filter.' })
    localStorage.setItem(TRACKER_STATE_FILTER_STORAGE_KEY, JSON.stringify({ alpha: { state: 'all', statuses: ['Open'] } }))
    show('alpha')
    await waitFor(() => expect(lists.length).toBeGreaterThan(0))
    expect(statusesOf(lists[0])).toBeNull()
    expect(lists[0]?.searchParams.get('state')).toBe('all')
    expect(screen.queryByRole('button', { name: 'Filter states' })).toBeNull()
  })
})
