import { useCallback, useId, useState } from "react"
import { FolderGit2Icon, GitBranchIcon } from "lucide-react"
import type { AutomationView } from "@betterc0de/schema"
import {
  BYPASS_CONFIRM_ACTION,
  BYPASS_CONFIRM_BODY,
  BYPASS_CONFIRM_TITLE,
  PERMISSION_LEVELS,
  type PermissionLevel,
} from "@betterc0de/schema/chat-controls"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  automationInputFromDraft,
  draftProblems,
  type AutomationDraft,
} from "@/lib/automations"
import { cn } from "@/lib/utils"
import {
  createAutomation,
  updateAutomation,
} from "@/services/backend/automations-api"
import {
  AutomationField,
  AutomationSection,
  AutomationSegments,
  FIELD_INPUT,
  FIELD_SELECT,
} from "./automation-fields"
import { AutomationModelFields } from "./automation-model-fields"
import { AutomationProjectField } from "./automation-project-field"
import { AutomationTriggerFields } from "./automation-trigger-fields"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const RUN_LOCATIONS = [
  { value: "local", label: "Project folder", icon: FolderGit2Icon },
  { value: "worktree", label: "New worktree each run", icon: GitBranchIcon },
] as const satisfies ReadonlyArray<{
  value: AutomationDraft["runLocation"]
  label: string
  icon: typeof GitBranchIcon
}>

/** Permission preset and where runs work. Bypass asks first, as in the composer. */
function AutomationPermissionFields({
  draft,
  onChange,
}: {
  draft: AutomationDraft
  onChange: (patch: Partial<AutomationDraft>) => void
}) {
  const confirm = useConfirm()
  const permissionId = useId()
  const locationLabelId = useId()
  const selected =
    PERMISSION_LEVELS.find((level) => level.id === draft.permissionLevel) ??
    PERMISSION_LEVELS[0]
  const permissionHint =
    draft.permissionLevel === "ask-on-edit"
      ? `${selected?.desc ?? ""}. A run waits in its chat until you approve.`
      : (selected?.desc ?? "")
  return (
    <div className="grid gap-x-4 gap-y-3.5 @[560px]/automation:grid-cols-2">
      <AutomationField
        label="Permissions"
        htmlFor={permissionId}
        hint={permissionHint}
      >
        <Select
          value={draft.permissionLevel}
          onValueChange={(value) => {
            const level = value as PermissionLevel
            if (level !== "bypass") {
              onChange({ permissionLevel: level })
              return
            }
            void confirm({
              title: BYPASS_CONFIRM_TITLE,
              description: `${BYPASS_CONFIRM_BODY} Automations run while nobody watches.`,
              confirmLabel: BYPASS_CONFIRM_ACTION,
              destructive: true,
            }).then((ok) => {
              if (ok) onChange({ permissionLevel: level })
            })
          }}
        >
          <SelectTrigger id={permissionId} className={FIELD_SELECT}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {PERMISSION_LEVELS.map((level) => (
              <SelectItem
                key={level.id}
                value={level.id}
                className={level.danger ? "text-destructive" : undefined}
              >
                {level.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </AutomationField>
      <AutomationField
        label="Runs in"
        labelId={locationLabelId}
        group
        hint={
          draft.runLocation === "worktree"
            ? "Each run gets its own Git worktree from the current branch, so it never touches your working copy."
            : "Runs change files in the project folder itself."
        }
      >
        <AutomationSegments
          value={draft.runLocation}
          options={RUN_LOCATIONS}
          ariaLabelledBy={locationLabelId}
          onChange={(runLocation) => onChange({ runLocation })}
        />
      </AutomationField>
    </div>
  )
}

/**
 * Creating or editing an automation: name, project (trusted), prompt,
 * provider, model and reasoning, permissions, where runs work, and when it
 * starts. Problems show after the first Save, each under its field.
 */
export function AutomationEditor({
  mode,
  automationId,
  initial,
  secretConfigured,
  projects,
  now,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit"
  automationId: string | null
  initial: AutomationDraft
  secretConfigured: boolean
  projects: readonly string[]
  now: Date
  onCancel: () => void
  onSaved: (automation: AutomationView) => void
}) {
  const nameId = useId()
  const promptId = useId()
  const [draft, setDraft] = useState(initial)
  const [showProblems, setShowProblems] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const change = useCallback((patch: Partial<AutomationDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
  }, [])
  const problems = draftProblems(draft, { now, secretConfigured })
  const shown = showProblems ? problems : {}

  const save = async () => {
    setShowProblems(true)
    if (
      Object.keys(draftProblems(draft, { now: new Date(), secretConfigured }))
        .length > 0
    ) {
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const body = automationInputFromDraft(draft)
      const { automation } =
        mode === "edit" && automationId
          ? await updateAutomation(automationId, body)
          : await createAutomation(body)
      onSaved(automation)
    } catch (error) {
      setSaveError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      noValidate
      aria-label={mode === "edit" ? "Edit automation" : "New automation"}
      className="flex flex-col gap-7"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div>
        <h2 className="text-[18px] font-semibold text-foreground">
          {mode === "edit" ? "Edit automation" : "New automation"}
        </h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Each run starts a new chat in Agent mode, titled with the name and the
          date.
        </p>
      </div>

      <AutomationSection title="Task">
        <AutomationField label="Name" htmlFor={nameId} error={shown.name}>
          <Input
            id={nameId}
            autoComplete="off"
            aria-invalid={shown.name ? true : undefined}
            placeholder="Nightly issue triage"
            className={FIELD_INPUT}
            value={draft.name}
            onChange={(event) => change({ name: event.target.value })}
          />
        </AutomationField>
        <AutomationProjectField
          value={draft.projectPath}
          projects={projects}
          error={shown.projectPath}
          onChange={(projectPath) => change({ projectPath })}
        />
        <AutomationField
          label="Prompt"
          htmlFor={promptId}
          error={shown.prompt}
          hint="What the agent does in each run."
        >
          <Textarea
            id={promptId}
            aria-invalid={shown.prompt ? true : undefined}
            placeholder="Check the issues opened since yesterday, label them and summarise what needs attention."
            className="min-h-28 rounded-lg border-border/50 bg-background/50 px-2.5 py-2 text-[12.5px] md:text-[12.5px] dark:bg-input/30"
            value={draft.prompt}
            onChange={(event) => change({ prompt: event.target.value })}
          />
        </AutomationField>
      </AutomationSection>

      <AutomationSection title="Model">
        <AutomationModelFields
          draft={draft}
          onChange={change}
          error={shown.model}
        />
      </AutomationSection>

      <AutomationSection title="Permissions">
        <AutomationPermissionFields draft={draft} onChange={change} />
      </AutomationSection>

      <AutomationSection title="Trigger">
        <AutomationTriggerFields
          draft={draft}
          onChange={change}
          now={now}
          scheduleError={shown.schedule}
          secretError={shown.webhookSecret}
          secretConfigured={secretConfigured}
          saved={mode === "edit"}
        />
      </AutomationSection>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-border/40 bg-background px-1 py-3">
        {saveError ? (
          <p
            role="alert"
            className={cn("mr-auto min-w-0 text-[12px] text-destructive")}
          >
            {saveError}
          </p>
        ) : showProblems && Object.keys(problems).length > 0 ? (
          <p
            role="status"
            className="mr-auto text-[12px] text-muted-foreground"
          >
            Fix the fields marked above to save.
          </p>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 rounded-lg text-[12px]"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-8 rounded-lg text-[12px]"
          disabled={saving}
          aria-busy={saving}
        >
          {saving
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : "Create automation"}
        </Button>
      </div>
    </form>
  )
}
