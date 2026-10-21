import { CheckIcon, ListFilterIcon } from 'lucide-react'
import { useState } from 'react'
import type { TrackerStateOption } from '@open-mercato/cezar-api-client'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TRACKER_STATUSES_MAX } from '@/lib/tracker-state-filter'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

/**
 * Multi-select over the tracker's own workflow states. Shows each state's display label (YouTrack's
 * localized name) and hands back its `name`, which is what the server filters by. Selecting none
 * means "no state filter" — the Active/All select applies again.
 */
export function TrackerStatusFilter({ options, selected, onChange }: {
  options: readonly TrackerStateOption[]; selected: readonly string[]; onChange: (statuses: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const toggle = (name: string) => onChange(selected.includes(name) ? selected.filter(value => value !== name) : [...selected, name])
  const needle = query.trim().toLowerCase()
  const visible = options.filter(option => !needle || option.label.toLowerCase().includes(needle) || option.name.toLowerCase().includes(needle))
  const chosen = options.filter(option => selected.includes(option.name))
  const summary = chosen.length === 1 ? chosen[0]!.label : chosen.length > 1 ? String(chosen.length) : ''
  return <Popover onOpenChange={open => { if (!open) setQuery('') }}>
    <PopoverTrigger asChild><button type="button" aria-label={t('Filter states')} title={chosen.map(option => option.label).join(', ') || undefined} className={cn('flex min-w-0 shrink items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-soft-foreground hover:bg-muted', chosen.length > 0 && 'border-primary/60 text-foreground')}><ListFilterIcon aria-hidden="true" className="size-3.5 shrink-0" /><span className="truncate">{t('States')}{summary ? ` · ${summary}` : ''}</span></button></PopoverTrigger>
    <PopoverContent align="end" sideOffset={6} className="w-64 p-0">
      <Command label={t('Find state')} shouldFilter={false}>
        <CommandInput aria-label={t('Find state')} placeholder={t('Find state…')} value={query} onValueChange={setQuery} maxLength={256} />
        <CommandList className="max-h-72">
          {selected.length ? <CommandItem onSelect={() => onChange([])}>{t('Clear filters')}</CommandItem> : null}
          {visible.map(option => <CommandItem key={option.id} value={option.name} disabled={!selected.includes(option.name) && selected.length >= TRACKER_STATUSES_MAX} onSelect={() => toggle(option.name)}>
            <span className={cn('min-w-0 flex-1 truncate', option.resolved && 'text-muted-foreground')}>{option.label}</span>
            {selected.includes(option.name) ? <CheckIcon className="size-3.5 text-primary" /> : null}
          </CommandItem>)}
          {!visible.length ? <p className="px-3 py-2 text-xs text-soft-foreground">{t('No matching states.')}</p> : null}
          <p className="px-3 py-2 text-[11px] text-soft-foreground">{t('Pick one or more states. Selected states replace the Active filter and are remembered for this project.')}</p>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}
