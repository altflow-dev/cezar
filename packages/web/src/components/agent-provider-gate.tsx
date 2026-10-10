import type { ResolvedEngine } from '@/components/engine-pills'
import { Link } from '@/lib/project-router'
import { t } from '@/lib/i18n'

/** Explain an unavailable start and keep its recovery link in the active project. */
export function AgentProviderGate({ resolved, dataSlot }: {
  resolved: Pick<ResolvedEngine, 'providerPending' | 'providerError' | 'canRun'>
  dataSlot?: string
}) {
  if (resolved.providerPending || resolved.canRun) return null
  return (
    <span data-slot={dataSlot} className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {resolved.providerError
        ? t('Provider authentication could not be verified.')
        : t('Connect an agent provider to run this item.')}
      <Link to="/settings/agents#providers" className="font-medium text-foreground underline underline-offset-4">
        {t('Configure providers')}
      </Link>
    </span>
  )
}
