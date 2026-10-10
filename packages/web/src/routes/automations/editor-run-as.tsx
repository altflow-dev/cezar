import type { Skill, WorkflowDef } from '@open-mercato/cezar-api-client'
import { EnginePills, type EnginePick } from '@/components/engine-pills'
import { PickerPill } from '@/components/picker-pill'
import { Label } from '@/components/ui/label'
import { SourcePill } from '@/components/source-pill'
import { Switch } from '@/components/ui/switch'
import type { TaskSource } from '@/lib/task-source'
import { t } from '@/lib/i18n'

/**
 * The "runs as" row of What to run (spec 2026-09-14-automations-redesign § UI/UX 4.4): the
 * composer's own pills — skill or workflow (`SourcePill`), runner + model (`EnginePills`, so the automation cannot pick
 * a backend the Inbox could not), the read-only base branch — and the Autonomous switch on the
 * right.
 */
export function EditorRunAs({
  source,
  sourcesReady,
  skills,
  skillUsage,
  workflows,
  onSource,
  pick,
  onPick,
  baseBranch,
  autonomous,
  onAutonomous,
}: {
  source: TaskSource | null
  sourcesReady: boolean
  skills: readonly Skill[]
  skillUsage: Readonly<Record<string, number>> | undefined
  workflows: readonly WorkflowDef[]
  onSource: (source: TaskSource | null) => void
  pick: EnginePick
  onPick: (pick: EnginePick) => void
  baseBranch: string | undefined
  autonomous: boolean
  onAutonomous: (autonomous: boolean) => void
}) {
  return (
    <div data-slot="editor-run-as" className="flex flex-wrap items-center gap-2">
      <SourcePill
        source={source}
        ready={sourcesReady}
        skills={skills}
        skillUsage={skillUsage}
        workflows={workflows}
        onPick={onSource}
      />
      <EnginePills pick={pick} onChange={onPick} accounts />
      <PickerPill
        slot="editor-base-pill"
        ariaLabel={t('Base branch')}
        readOnly
        hint={t('Every run branches off the project\'s base branch.')}
        label={<span className="font-mono text-[11.5px]">{t('base: ')}{baseBranch ?? '…'}</span>}
        value={baseBranch ?? ''}
        options={[]}
        onPick={() => undefined}
      />
      <span className="flex-1" />
      <Label className="text-[13px] font-medium">
        {t('Autonomous')}
        <Switch aria-label={t('Autonomous')} checked={autonomous} onCheckedChange={onAutonomous} />
      </Label>
    </div>
  )
}
