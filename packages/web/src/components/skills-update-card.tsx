import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2Icon, RefreshCwIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { applySkillsUpdate, checkSkillsUpdate, createRun } from '@/api/client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { startedRunPath } from '@/routes/new-task-form'
import type { SkillsUpdateState } from '@open-mercato/cezar-api-client'
import { t } from '@/lib/i18n'

type UpdateRequest =
  | { action: 'check'; seq: number }
  | { action: 'apply'; seq: number; previousUpdatedAt: string | null }

function scopeLabel(scope: SkillsUpdateState['scopes'][number]['scope']) {
  return scope === 'project' ? t('Project installation') : t('Global installation')
}

/** Manual check and apply controls for Open Mercato skill installations. */
export function SkillsUpdateCard({
  projectId,
  state,
  loadError,
}: {
  projectId: string
  state?: SkillsUpdateState
  loadError: Error | null
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const latestAction = useRef(0)
  const [showUpgradeNotesPrompt, setShowUpgradeNotesPrompt] = useState(false)
  const startUpgradeNotes = useMutation({
    mutationFn: () =>
      createRun({
        task: t('Apply the upgrade notes after updating the installed Open Mercato skills.'),
        steps: [
          {
            id: 'apply-upgrade-notes',
            name: t('Apply upgrade notes'),
            skill: 'om-apply-upgrade-notes',
            prompt: '{{task}}',
          },
        ],
      }),
    onSuccess: (created) => {
      setShowUpgradeNotesPrompt(false)
      void navigate(startedRunPath(created))
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const accept = (result: SkillsUpdateState, request: UpdateRequest) => {
    // A forced check may finish after an apply. Only the newest user intent owns the cache.
    if (request.seq !== latestAction.current) return
    queryClient.setQueryData(workspaceQueryKeys.skillsUpdate(projectId), result)
    if (request.action === 'apply' && result.updatedAt && result.updatedAt !== request.previousUpdatedAt) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
      toast(result.status === 'error' ? t('Some skill updates failed.') : t('Open Mercato skills updated.'))
      setShowUpgradeNotesPrompt(true)
    }
  }
  const reject = (error: Error, request: UpdateRequest) => {
    if (request.seq === latestAction.current) toast(error.message, { tone: 'danger' })
  }
  const checkMutation = useMutation({
    mutationFn: (request: Extract<UpdateRequest, { action: 'check' }>) =>
      checkSkillsUpdate(projectId).then((result) => ({ result, request })),
    onSuccess: ({ result, request }) => accept(result, request),
    onError: (error: Error, request) => reject(error, request),
  })
  const applyMutation = useMutation({
    mutationFn: (request: Extract<UpdateRequest, { action: 'apply' }>) =>
      applySkillsUpdate(projectId).then((result) => ({ result, request })),
    onSuccess: ({ result, request }) => accept(result, request),
    onError: (error: Error, request) => reject(error, request),
  })
  const run = (action: 'check' | 'apply') => {
    const seq = ++latestAction.current
    if (action === 'apply') applyMutation.mutate({ action, seq, previousUpdatedAt: state?.updatedAt ?? null })
    else checkMutation.mutate({ action, seq })
  }

  const scopes = state?.scopes ?? []
  const trackedScopes = scopes.filter((scope) => scope.skills.length > 0)
  const tracked = trackedScopes.length > 0
  const retryable = state?.status === 'error'
  const canApply = tracked && (state?.available || retryable)
  const pending = applyMutation.isPending || state?.status === 'updating'
  const failed = scopes.filter((scope) => scope.status === 'error' || scope.status === 'unavailable')
  const succeeded = scopes.filter((scope) => scope.updatedAt && !failed.includes(scope))

  let message = t('Checking installed Open Mercato skills…')
  if (loadError) message = t('Update status is unavailable right now.')
  else if (state?.status === 'available') message = t('An update is available for your installed Open Mercato skills.')
  else if (state?.status === 'updating') message = t('Updating installed Open Mercato skills…')
  else if (state?.status === 'current' && !tracked) {
    message = state.needsUpgradeNotes ? t('Skill files were updated.') : t('No installed Open Mercato skills are tracked for updates.')
  }
  else if (state?.status === 'current') message = t('Installed Open Mercato skills are up to date.')
  else if (state?.status === 'unavailable') {
    message = state.scopes.find((scope) => scope.reason)?.reason ?? t('Automatic updates are unavailable.')
  } else if (state?.status === 'error') message = t('The update did not finish for every installation.')

  return (
    <>
      <section
        data-slot="skills-update-card"
        aria-live="polite"
        className="rounded-lg border border-border bg-muted/30 p-3"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{message}</p>
            {state?.checkedAt ? (
              <p className="mt-1 text-xs text-soft-foreground">
                {t('Last checked ')}{new Date(state.checkedAt).toLocaleString()}.
              </p>
            ) : null}
            {trackedScopes.length > 0 ? (
              <ul className="mt-1 text-xs text-soft-foreground">
                {trackedScopes.map((scope) => (
                  <li key={scope.scope}>
                    {scopeLabel(scope.scope)} · {scope.skills.length}{t(' tracked')}
                  </li>
                ))}
              </ul>
            ) : null}
            {failed.length > 0 ? (
              <p className="mt-1 text-xs text-destructive">
                {t('Failed: ')}{failed.map((scope) => scopeLabel(scope.scope)).join(', ')}
                {succeeded.length
                  ? '; updated: ' + succeeded.map((scope) => scopeLabel(scope.scope)).join(', ')
                  : ''}
                .
              </p>
            ) : null}
          </div>
          {canApply ? (
            <Button data-action="skills-update-apply" size="sm" disabled={pending} onClick={() => run('apply')}>
              <RefreshCwIcon
                aria-hidden="true"
                className={cn('size-3.5', pending && 'motion-safe:animate-spin')}
              />
              {pending ? t('Updating…') : retryable ? t('Retry') : t('Update now')}
            </Button>
          ) : state?.status === 'current' ? (
            <Button
              data-action="skills-update-check"
              variant="outline"
              size="sm"
              disabled={checkMutation.isPending}
              onClick={() => run('check')}
            >
              {t('Check again')}
            </Button>
          ) : state?.status === 'unavailable' || loadError ? (
            <Button
              data-action="skills-update-check"
              variant="outline"
              size="sm"
              disabled={checkMutation.isPending}
              onClick={() => run('check')}
            >
              {t('Retry check')}
            </Button>
          ) : null}
        </div>
        {state?.status === 'unavailable' || loadError ? (
          <div className="mt-2 text-xs text-soft-foreground">
            {t('Manual examples: ')}<code>npx skills update -p</code> · <code>npx skills update -g</code>{t('. These broad commands may update other tracked sources.')}
          </div>
        ) : null}
        {state?.needsUpgradeNotes ? (
          <div
            data-slot="skills-upgrade-notes"
            className="mt-3 flex gap-2 rounded-md border border-primary/30 bg-background p-2.5 text-xs text-foreground"
          >
            <CheckCircle2Icon
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-primary"
            />
            <span>
              {t('Skill files were updated. Run ')}<code>/om-apply-upgrade-notes</code>{t(' in each configured repository to apply descriptor migrations while preserving local edits.')}
            </span>
          </div>
        ) : null}
      </section>
      <Dialog
        open={showUpgradeNotesPrompt}
        onOpenChange={(open) => (startUpgradeNotes.isPending ? undefined : setShowUpgradeNotesPrompt(open))}
      >
        <DialogContent data-slot="skills-upgrade-notes-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('Apply the upgrade notes now?')}</DialogTitle>
            <DialogDescription>
              {t('The skill files were updated successfully. Start a new session with')}{' '}
              <code>/om-apply-upgrade-notes</code>{t(' to sync repository descriptors while preserving local edits?')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={startUpgradeNotes.isPending}
              onClick={() => setShowUpgradeNotesPrompt(false)}
            >
              {t('No')}
            </Button>
            <Button
              type="button"
              disabled={startUpgradeNotes.isPending}
              onClick={() => startUpgradeNotes.mutate()}
            >
              {startUpgradeNotes.isPending ? t('Starting…') : t('Yes, start session')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
