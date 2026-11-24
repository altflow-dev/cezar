import { useMutation, useQuery } from '@tanstack/react-query'
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  MonitorPlayIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SquareIcon,
  TimerResetIcon,
} from 'lucide-react'
import { useState } from 'react'

import { extendRunPreview, fetchRunPreviewLogs, restartRunPreview, stopRunPreview } from '@/api/client'
import type { ApiRun, PreviewCredential, PreviewPort, PreviewState, PreviewStopReason } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { t, tp } from '@/lib/i18n'

import { Markdown } from './markdown'

/**
 * A task's preview environment (spec 2026-11-24-preview-environments, phase 3): the app standing
 * in docker on ports of its own, for manual testing at review. Everything here is read off the
 * run record's `preview`, which the run SSE keeps fresh — the buttons only ask for changes.
 *
 * Links carry no host from the server: a preview is reached on the host the viewer reached the
 * cockpit on, so `http://10.0.0.5:4321` shows `http://10.0.0.5:41003`.
 */

/** `http://<cockpit host>:<port><path>` — previews are plain http on their own ports. */
export function previewUrl(port: Pick<PreviewPort, 'hostPort' | 'path'>, hostname: string = window.location.hostname): string {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname || 'localhost'
  return `http://${host}:${port.hostPort}${port.path}`
}

function stopReasonText(reason: PreviewStopReason | undefined): string {
  switch (reason) {
    case 'user':
      return t('stopped by hand')
    case 'archived':
      return t('stopped because the task was archived')
    case 'deleted':
      return t('stopped because the task was deleted')
    case 'merged':
      return t('stopped because the PR was merged or closed')
    case 'ttl':
      return t('stopped because its time ran out')
    case 'limit':
      return t('stopped to make room for a newer preview')
    case 'worktree-removed':
      return t('stopped because the task worktree was removed')
    case 'cancelled':
      return t('stopped because the task was cancelled')
    case 'boot-missing':
      return t('its containers were gone when cezar restarted')
    default:
      return t('stopped')
  }
}

function StatusChip({ preview }: { preview: PreviewState }) {
  const base = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium'
  switch (preview.status) {
    case 'building':
      return (
        <span data-slot="preview-status" className={`${base} bg-accent text-foreground`}>
          <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />
          {t('Building…')}
        </span>
      )
    case 'ready':
      return <span data-slot="preview-status" className={`${base} bg-success/15 text-success`}>{t('Ready')}</span>
    case 'stale':
      return <span data-slot="preview-status" className={`${base} bg-violet/15 text-violet`}>{t('Out of date — restart it')}</span>
    case 'failed':
      return <span data-slot="preview-status" className={`${base} bg-danger/15 text-danger`}>{t('Failed')}</span>
    case 'stopped':
      return <span data-slot="preview-status" className={`${base} bg-muted text-muted-foreground`}>{t('Stopped')}</span>
  }
}

function expiresInText(expiresAt: string | undefined, now: number): string | null {
  if (!expiresAt) return null
  const hours = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 3_600_000))
  return hours < 1 ? t('stops in under an hour') : tp(hours, 'stops in {count} hour', 'stops in {count} hours')
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <CopyIcon className="size-3.5" aria-hidden="true" />}
    </Button>
  )
}

function CredentialRow({ credential }: { credential: PreviewCredential }) {
  const [shown, setShown] = useState(false)
  return (
    <tr data-slot="preview-credential">
      <td className="py-1 pr-3 text-muted-foreground">{credential.label}</td>
      <td className="py-1 pr-1 font-mono">{credential.user}</td>
      <td className="py-1 pr-3">
        <CopyButton value={credential.user} label={t('Copy the login of {label}', { label: credential.label })} />
      </td>
      <td className="py-1 pr-1 font-mono" data-slot="preview-password">
        {shown ? credential.password : '••••••••'}
      </td>
      <td className="flex py-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={shown ? t('Hide the password') : t('Show the password')}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOffIcon className="size-3.5" aria-hidden="true" /> : <EyeIcon className="size-3.5" aria-hidden="true" />}
        </Button>
        <CopyButton value={credential.password} label={t('Copy the password of {label}', { label: credential.label })} />
      </td>
    </tr>
  )
}

function LogsDialog({ runId, services, open, onOpenChange }: { runId: string; services: string[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [service, setService] = useState<string>('')
  const logs = useQuery({
    queryKey: ['run-preview-logs', runId, service],
    queryFn: () => fetchRunPreviewLogs(runId, service || undefined),
    enabled: open,
    staleTime: 0,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="preview-logs-dialog" className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('Preview logs')}</DialogTitle>
          <DialogDescription>{t('The last lines the containers printed.')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <select
            aria-label={t('Service')}
            className="rounded-md border border-input bg-card px-2 py-1 text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            <option value="">{t('All services')}</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <Button type="button" variant="outline" size="sm" onClick={() => void logs.refetch()} disabled={logs.isFetching}>
            <RotateCwIcon className="size-3.5" aria-hidden="true" />
            {t('Refresh')}
          </Button>
        </div>
        <pre className="max-h-[60vh] min-w-0 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] whitespace-pre-wrap">
          {logs.isPending ? t('Loading…') : logs.isError ? logs.error.message : logs.data?.text || t('(no output)')}
        </pre>
      </DialogContent>
    </Dialog>
  )
}

export function PreviewCard({ run, now = Date.now() }: { run: ApiRun; now?: number }) {
  const preview = run.preview
  const [logsOpen, setLogsOpen] = useState(false)
  const onError = (error: Error) => toast(error.message, { tone: 'danger' })
  const restart = useMutation({ mutationFn: () => restartRunPreview(run.id), onError })
  const stop = useMutation({ mutationFn: () => stopRunPreview(run.id), onError })
  const extend = useMutation({ mutationFn: () => extendRunPreview(run.id), onError })
  if (!preview || run.archived) return null

  const live = preview.status === 'ready' || preview.status === 'stale'
  const busy = restart.isPending || stop.isPending || extend.isPending
  const services = [...new Set(preview.ports.map((p) => p.service))]
  const expires = live ? expiresInText(preview.expiresAt, now) : null

  return (
    <section data-slot="preview-card" aria-label={t('Preview')} className="flex flex-col gap-3 rounded-md border border-border bg-card px-3.5 py-3">
      <header className="flex flex-wrap items-center gap-2">
        <MonitorPlayIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-[13px] font-semibold">{t('Preview')}</h2>
        <StatusChip preview={preview} />
        {expires ? <span className="text-[11px] text-muted-foreground">{expires}</span> : null}
        {preview.status === 'stopped' ? <span className="text-[11px] text-muted-foreground">{stopReasonText(preview.stopReason)}</span> : null}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {preview.status !== 'building' ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => restart.mutate()}>
              <RotateCwIcon className="size-3.5" aria-hidden="true" />
              {preview.status === 'stopped' || preview.status === 'failed' ? t('Start again') : t('Restart')}
            </Button>
          ) : null}
          {live ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => extend.mutate()}>
              <TimerResetIcon className="size-3.5" aria-hidden="true" />
              {t('Keep longer')}
            </Button>
          ) : null}
          {live || preview.status === 'failed' ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setLogsOpen(true)}>
              <ScrollTextIcon className="size-3.5" aria-hidden="true" />
              {t('Logs')}
            </Button>
          ) : null}
          {live || preview.status === 'failed' ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => stop.mutate()}>
              <SquareIcon className="size-3.5" aria-hidden="true" />
              {t('Stop')}
            </Button>
          ) : null}
        </div>
      </header>

      {preview.status === 'failed' && preview.error ? (
        <p data-slot="preview-error" className="rounded-md bg-danger/10 px-2.5 py-1.5 font-mono text-[11px] text-danger whitespace-pre-wrap">
          {preview.error}
        </p>
      ) : null}

      {live && preview.ports.length ? (
        <div data-slot="preview-links" className="flex flex-wrap gap-2">
          {preview.ports.map((p) => (
            <Button key={`${p.label}-${p.hostPort}`} asChild size="sm">
              <a href={previewUrl(p)} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                {p.label}
                <span className="font-mono text-[11px] opacity-75">:{p.hostPort}</span>
              </a>
            </Button>
          ))}
        </div>
      ) : null}

      {live && preview.credentials?.length ? (
        <div>
          <h3 className="mb-1 text-[11px] uppercase text-muted-foreground">{t('Test logins')}</h3>
          <table className="text-[12px]">
            <tbody>
              {preview.credentials.map((c) => (
                <CredentialRow key={`${c.label}-${c.user}`} credential={c} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {preview.notes ? (
        <div data-slot="preview-notes" className="text-[13px]">
          <Markdown variant="document">{preview.notes}</Markdown>
        </div>
      ) : null}

      {preview.changedFiles?.length ? (
        <details data-slot="preview-files" className="text-[12px]">
          <summary className="cursor-pointer text-muted-foreground">
            {tp(preview.changedFiles.length, '{count} changed file', '{count} changed files')}
          </summary>
          <ul className="mt-1 ml-4 list-disc font-mono text-[11px]">
            {preview.changedFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <LogsDialog runId={run.id} services={services} open={logsOpen} onOpenChange={setLogsOpen} />
    </section>
  )
}
