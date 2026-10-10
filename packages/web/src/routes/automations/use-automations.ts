import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import type { AutomationListEntry, AutomationsResponse, CreateAutomationInput } from '@open-mercato/cezar-api-client'
import {
  checkAutomation,
  createAutomation,
  deleteAutomation,
  getAutomations,
  runAutomationNow,
  setAutomationEnabled,
} from '@/api/client'
import { onWorkspaceEvent } from '@/api/global-events'
import { queryScope } from '@open-mercato/cezar-api-client'
import { useHealth } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import { cliOf } from '@/lib/automation-cli'
import { useActiveProjectId } from '@/lib/project-router'
import { t } from '@/lib/i18n'

/**
 * The Automations page's data and the row actions every screen shares (spec
 * 2026-09-14-automations-redesign § UI/UX). One query for the whole page — `GET /automations`
 * answers the definitions, their state, the stats and the zone in one read — invalidated by the
 * workspace `automation-change` event, so a fire, a pause or an edit from anywhere repaints
 * without polling.
 */
export const automationsQueryKey = () => [queryScope(), 'automations'] as const

export function useAutomationsGate(): { known: boolean; off: boolean } {
  // `!== true` deliberately: only a health payload that HAS answered switches this on.
  const health = useHealth()
  const known = health.data !== undefined
  return { known, off: known && health.data?.capabilities?.automations !== true }
}

export function useAutomationsQuery(enabled: boolean) {
  const queryClient = useQueryClient()
  const projectId = useActiveProjectId()
  const query = useQuery({
    queryKey: automationsQueryKey(),
    queryFn: ({ signal }) => getAutomations({ signal }),
    enabled,
  })
  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name !== 'automation-change') return
    const changed = payload as { project?: unknown }
    if (typeof changed.project === 'string' && (projectId === null || changed.project === projectId)) {
      void queryClient.invalidateQueries({ queryKey: automationsQueryKey() })
    }
  }), [projectId, queryClient])
  return query
}

export interface AutomationActions {
  /** Schedule → `run` (a launch, paused or not); poll → `check` with mode `execute`. */
  preview: (automation: AutomationListEntry) => Promise<void>
  runNow: (automation: AutomationListEntry) => Promise<void>
  toggleEnabled: (automation: AutomationListEntry) => Promise<void>
  /** Creates a PAUSED copy named "<name> (copy)". */
  duplicate: (automation: AutomationListEntry) => Promise<void>
  remove: (automation: AutomationListEntry) => Promise<void>
  copyCli: (automation: AutomationListEntry) => Promise<void>
  busy: boolean
}

export function useAutomationActions(data: AutomationsResponse | undefined): AutomationActions {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: automationsQueryKey() })
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' })

  const run = useMutation({
    mutationFn: async (automation: AutomationListEntry) => {
      if (automation.kind === 'schedule') {
        await runAutomationNow(automation.id)
        toast(t('Started "{name}" — the task is queued.', { name: automation.name }))
      } else {
        await checkAutomation(automation.id, 'execute')
        toast(t('Checking events for "{name}" now.', { name: automation.name }))
      }
    },
    onSuccess: () => void refresh(),
    onError: fail,
  })
  const preview = useMutation({
    mutationFn: async (automation: AutomationListEntry) => {
      await checkAutomation(automation.id, 'preview')
      toast(t('Preview queued for "{name}" — no tasks will launch. See the execution log for results.', { name: automation.name }))
    },
    onSuccess: () => void refresh(),
    onError: fail,
  })
  const toggle = useMutation({
    mutationFn: (automation: AutomationListEntry) => setAutomationEnabled(automation.id, !automation.enabled),
    onSuccess: () => void refresh(),
    onError: fail,
  })
  const duplicate = useMutation({
    mutationFn: (automation: AutomationListEntry) => {
      const body: CreateAutomationInput = {
        name: t('{name} (copy)', { name: automation.name }),
        ...(automation.description ? { description: automation.description } : {}),
        kind: automation.kind,
        ...(automation.kind === 'schedule'
          ? { schedule: automation.schedule }
          : automation.kind === 'tracker'
            ? { trackerTrigger: automation.trackerTrigger, intervalSeconds: automation.intervalSeconds, filters: automation.filters }
            : { events: automation.events, intervalSeconds: automation.intervalSeconds, filters: automation.filters }),
        task: automation.task,
      }
      return createAutomation(body)
    },
    onSuccess: (created) => {
      toast(t('Duplicated as "{name}", paused.', { name: created.automation.name }))
      void refresh()
    },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: (automation: AutomationListEntry) => deleteAutomation(automation.id),
    onSuccess: () => void refresh(),
    onError: fail,
  })

  return {
    preview: (automation) => preview.mutateAsync(automation).then(() => undefined, () => undefined),
    runNow: (automation) => run.mutateAsync(automation).then(() => undefined, () => undefined),
    toggleEnabled: (automation) => toggle.mutateAsync(automation).then(() => undefined, () => undefined),
    duplicate: (automation) => duplicate.mutateAsync(automation).then(() => undefined, () => undefined),
    remove: (automation) => remove.mutateAsync(automation).then(() => undefined, () => undefined),
    copyCli: async (automation) => {
      const line = cliOf({
        name: automation.name,
        kind: automation.kind,
        trackerTrigger: automation.trackerTrigger,
        schedule: automation.schedule,
        events: automation.events,
        intervalSeconds: automation.intervalSeconds,
        filters: automation.filters,
        task: automation.task,
      })
      await copyText(line)
    },
    busy: preview.isPending || run.isPending || toggle.isPending || duplicate.isPending || remove.isPending,
  }
  // `data` is accepted so a caller can key actions on the loaded zone later without a new hook.
  void data
}

/** Clipboard write with the honest failure the spec asks for (non-secure contexts have none). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(t('Copied to the clipboard.'))
  } catch {
    toast(t('Copy failed — select the text to copy it.'), { tone: 'danger' })
  }
}
