import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, PreviewState } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { PreviewCard, previewUrl } from './preview-card'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

const NOW = Date.parse('2026-11-24T12:00:00.000Z')

const preview = (extra: Partial<PreviewState> = {}): PreviewState => ({
  status: 'ready',
  composeProject: 'cez-app-r1',
  ports: [
    { label: 'frontend', service: 'web', hostPort: 41003, path: '/' },
    { label: 'backend', service: 'api', hostPort: 41004, path: '/admin/' },
  ],
  credentials: [{ label: 'Admin', url: 'backend', user: 'admin@example.com', password: 'admin123' }],
  notes: '## What changed\n- The invoice list paginates',
  changedFiles: ['billing/views.py', 'web/src/Invoices.tsx'],
  startedAt: '2026-11-24T11:00:00.000Z',
  readyAt: '2026-11-24T11:05:00.000Z',
  expiresAt: '2026-11-25T11:05:00.000Z',
  ...extra,
})

const run = (p: PreviewState | undefined, extra: Partial<ApiRun> = {}): ApiRun =>
  ({
    id: 'r1',
    title: 't',
    workflow: 'implement-and-preview',
    task: 't',
    status: 'review',
    createdAt: '2026-11-24T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...(p ? { preview: p } : {}),
    ...extra,
  }) as ApiRun

function stubFetch(answer: (path: string, method: string) => Response = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) {
  const sent: { path: string; method: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method })
      return answer(path, method)
    }),
  )
  return sent
}

const mount = (r: ApiRun) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <PreviewCard run={r} now={NOW} />
      <Toaster />
    </QueryClientProvider>,
  )

describe('previewUrl', () => {
  it('uses the host the cockpit was reached on', () => {
    expect(previewUrl({ hostPort: 41003, path: '/' }, '10.0.0.5')).toBe('http://10.0.0.5:41003/')
    expect(previewUrl({ hostPort: 41004, path: '/admin/' }, 'devbox.lan')).toBe('http://devbox.lan:41004/admin/')
    expect(previewUrl({ hostPort: 41003, path: '/' }, '::1')).toBe('http://[::1]:41003/')
  })
})

describe('PreviewCard', () => {
  it('renders nothing without a preview, or for an archived task', () => {
    const { container, rerender } = mount(run(undefined))
    expect(container.querySelector('[data-slot="preview-card"]')).toBeNull()
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <PreviewCard run={run(preview(), { archived: true })} now={NOW} />
      </QueryClientProvider>,
    )
    expect(container.querySelector('[data-slot="preview-card"]')).toBeNull()
  })

  it('a ready preview shows a link per port on this host, the logins, the notes and the files', () => {
    mount(run(preview()))
    const links = screen.getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `http://${window.location.hostname || 'localhost'}:41003/`,
      `http://${window.location.hostname || 'localhost'}:41004/admin/`,
    ])
    expect(links[0]?.getAttribute('target')).toBe('_blank')
    expect(screen.getByText('admin@example.com')).toBeTruthy()
    expect(screen.getByText('The invoice list paginates')).toBeTruthy()
    expect(screen.getByText('2 changed files')).toBeTruthy()
    expect(screen.getByText('stops in 23 hours')).toBeTruthy()
  })

  it('masks the password until asked', () => {
    mount(run(preview()))
    const cell = document.querySelector('[data-slot="preview-password"]') as HTMLElement
    expect(cell.textContent).not.toContain('admin123')
    fireEvent.click(screen.getByRole('button', { name: 'Show the password' }))
    expect(cell.textContent).toBe('admin123')
  })

  it('Stop, Keep longer and Restart call their routes', async () => {
    const sent = stubFetch((path) =>
      new Response(JSON.stringify(path.endsWith('/extend') ? { expiresAt: '2026-11-26T00:00:00.000Z' } : { ok: true }), {
        status: path.endsWith('/restart') ? 202 : 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    mount(run(preview()))
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }))
    await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/runs/r1/preview/stop'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: /Keep longer/ }))
    await waitFor(() => expect(sent.some((r) => r.path.endsWith('/runs/r1/preview/extend'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
    await waitFor(() => expect(sent.some((r) => r.path.endsWith('/runs/r1/preview/restart'))).toBe(true))
  })

  it('a refused action surfaces the server error as a toast', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'a preview is already building' }), { status: 409, headers: { 'content-type': 'application/json' } }))
    mount(run(preview()))
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
    expect(await screen.findByText(/already building/)).toBeTruthy()
  })

  it('building shows progress and no links or actions but itself', () => {
    mount(run(preview({ status: 'building', ports: [] })))
    expect(screen.getByText('Building…')).toBeTruthy()
    expect(screen.queryAllByRole('link')).toEqual([])
    expect(screen.queryByRole('button', { name: /Restart|Stop/ })).toBeNull()
  })

  it('failed shows the error and offers to start again', () => {
    mount(run(preview({ status: 'failed', ports: [], error: 'docker compose up failed (exit 1)' })))
    expect(screen.getByText('docker compose up failed (exit 1)')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Start again/ })).toBeTruthy()
    expect(screen.queryAllByRole('link')).toEqual([])
  })

  it('stopped says why, hides the logins and offers to start again', () => {
    mount(run(preview({ status: 'stopped', stopReason: 'ttl' })))
    expect(screen.getByText('stopped because its time ran out')).toBeTruthy()
    expect(screen.queryByText('admin@example.com')).toBeNull()
    expect(screen.getByRole('button', { name: /Start again/ })).toBeTruthy()
  })

  it('Logs opens a dialog with the container output', async () => {
    stubFetch(() => new Response(JSON.stringify({ text: 'api-1  | Listening on :8000' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    mount(run(preview()))
    fireEvent.click(screen.getByRole('button', { name: /Logs/ }))
    expect(await screen.findByText(/Listening on :8000/)).toBeTruthy()
  })
})
