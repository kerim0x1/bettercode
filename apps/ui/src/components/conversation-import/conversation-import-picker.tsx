import type { ConversationImportCandidate } from "@betterc0de/schema"
import {
  CheckIcon,
  CircleAlertIcon,
  FolderIcon,
  FolderXIcon,
  MessagesSquareIcon,
  RotateCwIcon,
} from "lucide-react"
import { BrandMark } from "@/components/settings/brand-mark"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { ConversationImportState } from "@/hooks/use-conversation-import"
import {
  CONVERSATION_IMPORT_PROVIDER_NAMES,
  conversationImportKey,
  formatMessageCount,
  formatSessionDate,
  groupSelectionState,
  isImportable,
  withSelection,
  type ConversationImportFilter,
  type ConversationImportGroup,
} from "@/lib/conversation-import"
import { cn } from "@/lib/utils"

/**
 * Picks earlier Claude Code and Codex conversations to import, grouped by
 * project with a checkbox per project and per chat. Used inline by the
 * onboarding step and inside `ConversationImportDialog`; each owner puts
 * its own buttons below it and starts the import with `state.runImport`.
 */
export function ConversationImportPicker({
  state,
  listClassName,
}: {
  state: ConversationImportState
  /** Height bounds of the scrolling list. */
  listClassName?: string
}) {
  const { list, groups, importing } = state
  const shown = groups.flatMap((group) => group.candidates).filter(isImportable)
  const allSelected =
    shown.length > 0 &&
    shown.every((candidate) =>
      state.selected.has(conversationImportKey(candidate))
    )

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ProviderFilter
          value={state.filter}
          onChange={state.setFilter}
          disabled={importing || !list}
        />
        <div className="flex-1" />
        {list && list.candidates.length > 0 ? (
          <>
            <span
              className="text-xs text-muted-foreground tabular-nums"
              aria-live="polite"
            >
              {state.selectedCount} selected
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={importing || state.importableCount === 0}
              onClick={() =>
                state.setSelected(
                  withSelection(state.selected, shown, !allSelected)
                )
              }
            >
              {allSelected ? "Select none" : "Select all"}
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Look for conversations again"
          title="Look for conversations again"
          disabled={importing || state.loading}
          // Counted files stay cached by size and time, so another look
          // picks up new sessions and finishes counting the rest.
          onClick={() => state.reload()}
        >
          <RotateCwIcon
            className={cn(state.loading && "motion-safe:animate-spin")}
          />
        </Button>
      </div>

      <div
        className={cn(
          "min-h-24 overflow-y-auto overscroll-contain rounded-xl border border-border/60 bg-card/30",
          listClassName
        )}
      >
        <PickerBody state={state} />
      </div>

      {list && !list.complete && !state.loading ? (
        <p className="text-[11px] text-muted-foreground">
          Some message counts are still missing: the scan stops after a few
          seconds. Look again to count the rest.
        </p>
      ) : null}

      <ImportStatus state={state} />
    </div>
  )
}

function PickerBody({ state }: { state: ConversationImportState }) {
  const { list, groups } = state
  if (!list && state.loading) {
    return (
      <div
        role="status"
        className="flex h-full min-h-24 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground"
      >
        <Spinner className="size-4 text-muted-foreground" />
        <span>Looking for earlier conversations…</span>
        <span className="text-[11px] text-muted-foreground/80">
          A long history takes a few seconds the first time.
        </span>
      </div>
    )
  }
  if (!list) {
    return (
      <div
        role="alert"
        className="flex min-h-24 flex-col items-center justify-center gap-2 px-4 py-8 text-center text-xs"
      >
        <span className="flex items-center gap-1.5 text-destructive">
          <CircleAlertIcon className="size-3.5" aria-hidden="true" />
          {state.loadError ?? "Couldn't read the earlier conversations."}
        </span>
        <Button variant="outline" size="xs" onClick={() => state.reload()}>
          Retry
        </Button>
      </div>
    )
  }
  if (groups.length === 0) {
    const anyFound = list.sources.some((source) => source.found)
    return (
      <div className="flex min-h-24 items-center justify-center px-4 py-8 text-center text-xs text-muted-foreground">
        {state.filter !== "all" && list.candidates.length > 0
          ? `No ${CONVERSATION_IMPORT_PROVIDER_NAMES[state.filter]} conversations on this computer.`
          : anyFound
            ? "No earlier conversations to import."
            : "Claude Code and Codex have no conversations on this computer yet."}
      </div>
    )
  }
  return (
    <div className="divide-y divide-border/50">
      {groups.map((group) => (
        <CandidateGroup key={group.key} group={group} state={state} />
      ))}
    </div>
  )
}

/**
 * Radix marks a checkbox with `data-state`; the fill for a selected chat and
 * a lighter one for a partly selected project.
 */
const CHECKBOX_STATES =
  "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary/45 data-[state=indeterminate]:text-primary-foreground"

const FILTERS: Array<{ value: ConversationImportFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
]

/** A small segmented control in the toolbar language (raised bar, flat active fill). */
function ProviderFilter({
  value,
  onChange,
  disabled,
}: {
  value: ConversationImportFilter
  onChange: (value: ConversationImportFilter) => void
  disabled: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Show conversations from"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/70 p-0.5"
    >
      {FILTERS.map((filter, index) => {
        const active = filter.value === value
        return (
          <button
            key={filter.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(filter.value)}
            onKeyDown={(event) => {
              // Arrow keys move and select, as in other radio groups.
              const step =
                event.key === "ArrowRight" || event.key === "ArrowDown"
                  ? 1
                  : event.key === "ArrowLeft" || event.key === "ArrowUp"
                    ? -1
                    : 0
              if (!step) return
              event.preventDefault()
              const next = (index + step + FILTERS.length) % FILTERS.length
              const target = FILTERS[next]
              if (!target) return
              onChange(target.value)
              const radios =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="radio"]'
                )
              radios?.[next]?.focus()
            }}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 motion-reduce:transition-none",
              active
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
          >
            {filter.value !== "all" ? <BrandMark id={filter.value} /> : null}
            {filter.label}
          </button>
        )
      })}
    </div>
  )
}

function CandidateGroup({
  group,
  state,
}: {
  group: ConversationImportGroup
  state: ConversationImportState
}) {
  const name = group.name ?? "Without a folder"
  const importable = group.candidates.filter(isImportable).length
  const checked = groupSelectionState(group, state.selected)
  return (
    <section aria-label={name} className="py-1.5">
      <div className="flex items-center gap-2.5 px-3 py-1.5">
        <Checkbox
          className={CHECKBOX_STATES}
          checked={checked}
          disabled={state.importing || importable === 0}
          aria-label={`Select every chat in ${name}`}
          onCheckedChange={(value) =>
            state.setSelected(
              withSelection(state.selected, group.candidates, value === true)
            )
          }
        />
        {group.path ? (
          <FolderIcon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <MessagesSquareIcon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{name}</p>
          {group.path ? (
            <p
              className="truncate font-mono text-[10.5px] text-muted-foreground"
              title={group.path}
            >
              {group.path}
            </p>
          ) : null}
        </div>
        {group.path && !group.folderExists ? (
          <span
            className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
            title="The folder no longer exists. These chats import without a folder."
          >
            <FolderXIcon className="size-3.5" aria-hidden="true" />
            Folder not found
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {group.candidates.length}
        </span>
      </div>
      <ul className="flex flex-col">
        {group.candidates.map((candidate) => (
          <li key={conversationImportKey(candidate)}>
            <CandidateRow candidate={candidate} state={state} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function CandidateRow({
  candidate,
  state,
}: {
  candidate: ConversationImportCandidate
  state: ConversationImportState
}) {
  const meta = [
    formatMessageCount(candidate.messageCount),
    formatSessionDate(candidate.updatedAt),
    candidate.archived ? "Archived" : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const text = (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px]" title={candidate.title}>
        {candidate.title}
      </span>
      {meta ? (
        <span className="block truncate text-[11px] text-muted-foreground">
          {meta}
        </span>
      ) : null}
    </span>
  )
  // A row's checkbox sits under the project's folder icon: 6px margin and
  // 32px padding match the header's 12px padding, 16px checkbox and 10px gap.
  if (!isImportable(candidate)) {
    return (
      <div className="mx-1.5 flex items-start gap-2.5 py-1.5 pr-1.5 pl-[32px] text-muted-foreground">
        <CheckIcon
          className="mt-0.5 size-4 shrink-0 text-success"
          aria-hidden="true"
        />
        <BrandMark id={candidate.provider} className="mt-0.5 opacity-60" />
        {text}
        <span className="shrink-0 text-[11px]">In BetterC0de</span>
      </div>
    )
  }
  return (
    <label className="mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-lg py-1.5 pr-1.5 pl-[32px] hover:bg-muted/50 has-[:disabled]:cursor-default has-[:disabled]:hover:bg-transparent">
      <Checkbox
        className={cn("mt-0.5", CHECKBOX_STATES)}
        checked={state.selected.has(conversationImportKey(candidate))}
        disabled={state.importing}
        onCheckedChange={() => state.toggle(candidate)}
      />
      <BrandMark id={candidate.provider} className="mt-0.5" />
      {text}
    </label>
  )
}

function ImportStatus({ state }: { state: ConversationImportState }) {
  const { progress, outcome } = state
  if (progress) {
    const percent =
      progress.total > 0
        ? Math.round((progress.done / progress.total) * 100)
        : 0
    return (
      <div role="status" className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground tabular-nums">
          Importing {progress.done} of {progress.total}…
        </span>
        <Progress
          value={percent}
          aria-label="Import progress"
          className="h-1 [&>[data-slot=progress-indicator]]:motion-reduce:transition-none"
        />
      </div>
    )
  }
  if (!outcome) return null
  return (
    <div role="status" className="flex flex-col gap-1 text-xs">
      {outcome.imported > 0 || outcome.skipped > 0 ? (
        <span className="flex items-center gap-1.5">
          <CheckIcon className="size-3.5 text-success" aria-hidden="true" />
          {outcome.imported > 0
            ? `Imported ${outcome.imported} ${outcome.imported === 1 ? "chat" : "chats"}.`
            : "Nothing new to import."}
          {outcome.skipped > 0 ? (
            <span className="text-muted-foreground">
              {outcome.skipped} {outcome.skipped === 1 ? "was" : "were"} already
              in BetterC0de.
            </span>
          ) : null}
        </span>
      ) : null}
      {outcome.failed.length > 0 ? (
        <div role="alert" className="flex flex-col gap-0.5 text-destructive">
          <span className="flex items-center gap-1.5">
            <CircleAlertIcon className="size-3.5" aria-hidden="true" />
            {outcome.failed.length === 1
              ? "1 conversation couldn't be imported."
              : `${outcome.failed.length} conversations couldn't be imported.`}
          </span>
          <ul className="pl-5 text-[11px] text-muted-foreground">
            {outcome.failed.slice(0, 5).map((failure) => (
              <li key={failure.key} className="truncate">
                {failure.title ? `${failure.title}: ` : ""}
                {failure.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
