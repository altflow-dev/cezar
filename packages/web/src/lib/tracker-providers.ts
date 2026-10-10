import { trackerKindSchema, type TrackerKind } from '@open-mercato/cezar-api-client'
import { t } from '@/lib/i18n'

/** Presentation only: credential values and adapter construction belong on the server. */
export const TRACKER_PROVIDERS = {
  jira: { label: t('Jira'), scopeLabel: t('Jira projects') },
  linear: { label: t('Linear'), scopeLabel: t('Linear teams') },
  youtrack: { label: t('YouTrack'), scopeLabel: t('YouTrack projects') },
} as const satisfies Record<TrackerKind, {
  label: string
  scopeLabel: string
}>

export const trackerProviders = trackerKindSchema.options.map(kind => ({ kind, ...TRACKER_PROVIDERS[kind] }))
