import { useState, useCallback, useEffect } from "react"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { BrandMark } from "@/components/settings/brand-mark"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import {
  deleteRuntimeHook,
  listRuntimeHooks,
  saveRuntimeHook,
  type RuntimeHook,
} from "@/lib/runtime-config"
import { hasElectronApi } from "@/services/ipc-facade"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  FileDiffIcon,
  GitCommitHorizontalIcon,
  Loader2Icon,
  MessageSquareCheckIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { LinkIcon } from "@hugeicons/core-free-icons"

/**
 * The desktop process refuses to store a hook whose command the user did not
 * allow in its native approval dialog (apps/shell/hooks-ipc.cjs).
 */
const COMMAND_NOT_APPROVED = /not (?:allowed|approved)/i

/**
 * Inline text for a hook save, toggle or removal that failed. Cancelling the
 * approval dialog is a decision, not a fault, so it gets plain wording.
 */
export function hookActionErrorMessage(
  error: unknown,
  outcome: "Not saved" | "Not changed" | "Not removed"
): string {
  const message = error instanceof Error ? error.message : String(error)
  return COMMAND_NOT_APPROVED.test(message)
    ? `${outcome}: the command wasn't approved.`
    : `${outcome}: ${message}`
}

/*
 * What each event really covers: the backend runs "on message send" before
 * every message and blocks it on failure (services/chat/turn-preparation.ts);
 * the other three run in the desktop window (lib/runtime-hooks.ts) after
 * Diff panel stage/unstage/discard actions, commits made through gitCommit
 * (Git panel, chat toolbar) and finished responses.
 */
const HOOK_EVENTS: ReadonlyArray<{
  value: RuntimeHook["event"]
  label: string
  description: string
  icon: LucideIcon
}> = [
  {
    value: "on_message_send",
    label: "On Message Send",
    description:
      "Runs before each message is sent; if the command fails, the message is blocked.",
    icon: SendIcon,
  },
  {
    value: "on_response_complete",
    label: "On Response Complete",
    description:
      "Runs after each response finishes, while the BetterC0de desktop window is open.",
    icon: MessageSquareCheckIcon,
  },
  {
    value: "on_file_change",
    label: "On File Change",
    description:
      "Runs when you stage, unstage or discard changes in the Diff panel.",
    icon: FileDiffIcon,
  },
  {
    value: "on_commit",
    label: "On Commit",
    description:
      "Runs after you commit from BetterC0de's Git panel or chat toolbar.",
    icon: GitCommitHorizontalIcon,
  },
]

const HOOK_STATUS_LABEL: Record<
  Exclude<RuntimeHook["lastStatus"], "idle" | undefined>,
  string
> = {
  running: "Running",
  success: "Last run OK",
  error: "Last run failed",
}

export function SettingsHooksSection() {
  const confirm = useConfirm()
  // Hooks live in the desktop app's own files; a paired browser has no
  // bridge to read or change them.
  const desktop = hasElectronApi()
  const [hooks, setHooks] = useState<RuntimeHook[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newHook, setNewHook] = useState<{
    event: RuntimeHook["event"]
    command: string
  }>({ event: "on_message_send", command: "" })
  // A new or changed command waits for the desktop's approval dialog.
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      // An unreadable hooks.json is an error here, not an empty list.
      setHooks(await listRuntimeHooks({ throwOnError: true }))
      setLoadError(false)
    } catch {
      setLoadError(true)
    } finally {
      setRefreshing(false)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleAddHook = useCallback(async () => {
    const command = newHook.command.trim()
    if (!command || saving) return
    setSaving(true)
    setFormError(null)
    try {
      await saveRuntimeHook({
        id: editingId || undefined,
        event: newHook.event,
        command,
        enabled: true,
      })
    } catch (error) {
      // Keep the form and its text so the user can change or retry it.
      setFormError(hookActionErrorMessage(error, "Not saved"))
      return
    } finally {
      setSaving(false)
    }
    setNewHook({ event: "on_message_send", command: "" })
    setEditingId(null)
    setShowAddForm(false)
    await refresh()
  }, [editingId, newHook, refresh, saving])

  const toggleHook = useCallback(
    async (hook: RuntimeHook, enabled: boolean) => {
      setListError(null)
      try {
        // An unapproved command asks for approval again here.
        await saveRuntimeHook({
          ...hook,
          enabled,
        })
      } catch (error) {
        setListError(hookActionErrorMessage(error, "Not changed"))
        return
      }
      await refresh()
    },
    [refresh]
  )

  const removeHook = useCallback(
    async (hook: RuntimeHook) => {
      const eventLabel =
        HOOK_EVENTS.find((evt) => evt.value === hook.event)?.label ?? hook.event
      const ok = await confirm({
        title: "Delete this hook?",
        description: `${eventLabel}: ${hook.command}\nBetterC0de stops running this command.`,
        confirmLabel: "Delete",
        destructive: true,
      })
      if (!ok) return
      setListError(null)
      try {
        await deleteRuntimeHook(hook.id)
      } catch (error) {
        setListError(hookActionErrorMessage(error, "Not removed"))
        return
      }
      await refresh()
    },
    [confirm, refresh]
  )

  const editHook = useCallback((hook: RuntimeHook) => {
    setEditingId(hook.id)
    setNewHook({ event: hook.event, command: hook.command })
    setFormError(null)
    setShowAddForm(true)
  }, [])

  const closeForm = useCallback(() => {
    setShowAddForm(false)
    setEditingId(null)
    setFormError(null)
  }, [])

  if (loading) {
    return (
      <SettingsSection title="Event Hooks">
        <div role="status" className="px-6 py-8 text-center">
          <Loader2Icon
            aria-hidden="true"
            className="mx-auto size-5 text-muted-foreground motion-safe:animate-spin"
          />
          <span className="sr-only">Loading hooks…</span>
        </div>
      </SettingsSection>
    )
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-[12.5px] leading-snug text-pretty text-muted-foreground">
          Run your own shell command when something happens in BetterC0de.
        </p>
        {desktop && !loadError ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            aria-expanded={showAddForm}
            onClick={() => (showAddForm ? closeForm() : setShowAddForm(true))}
          >
            <PlusIcon aria-hidden="true" className="size-3" /> Add Hook
          </Button>
        ) : null}
      </div>

      <SettingsSection title="Supported Events">
        {HOOK_EVENTS.map((evt) => {
          const count = hooks.filter((h) => h.event === evt.value).length
          const EventIcon = evt.icon
          return (
            <SettingsRow
              key={evt.value}
              label={evt.label}
              description={evt.description}
              icon={<EventIcon />}
            >
              {desktop && !loadError ? (
                <Badge variant="outline" className="text-[10px]">
                  {count} hook{count !== 1 ? "s" : ""}
                </Badge>
              ) : null}
            </SettingsRow>
          )
        })}
        <SettingsRow
          label="Claude Code hooks"
          description="Claude Code's own hooks (.claude/settings.json) are run by Claude Code and aren't listed here."
          icon={<BrandMark id="claude" />}
        >
          {null}
        </SettingsRow>
      </SettingsSection>

      {showAddForm && (
        <SettingsSection title={editingId ? "Edit Hook" : "New Hook"}>
          <div className="space-y-3 px-4 py-3">
            <div className="space-y-1.5">
              <label
                htmlFor="hook-event"
                className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase"
              >
                Event
              </label>
              <Select
                value={newHook.event}
                onValueChange={(v) =>
                  setNewHook({ ...newHook, event: v as RuntimeHook["event"] })
                }
              >
                <SelectTrigger id="hook-event" className="w-full" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_EVENTS.map((evt) => (
                    <SelectItem key={evt.value} value={evt.value}>
                      {evt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-pretty text-muted-foreground">
                {
                  HOOK_EVENTS.find((evt) => evt.value === newHook.event)
                    ?.description
                }
              </p>
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="hook-command"
                className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase"
              >
                Shell Command
              </label>
              <Input
                id="hook-command"
                className="h-8 font-mono text-xs"
                placeholder="npm run lint"
                value={newHook.command}
                aria-invalid={formError ? true : undefined}
                aria-describedby={
                  formError
                    ? "hook-command-hint hook-form-error"
                    : "hook-command-hint"
                }
                onChange={(e) => {
                  setFormError(null)
                  setNewHook({ ...newHook, command: e.target.value })
                }}
              />
              <p
                id="hook-command-hint"
                className="text-[11px] text-muted-foreground"
              >
                The desktop asks you to approve a new or changed command before
                saving it.
              </p>
            </div>
            {formError && (
              <p
                id="hook-form-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {formError}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeForm}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void handleAddHook()}
                disabled={!newHook.command.trim() || saving}
                aria-busy={saving}
              >
                {saving ? "Saving…" : editingId ? "Save Hook" : "Add Hook"}
              </Button>
            </div>
          </div>
        </SettingsSection>
      )}

      {listError && (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {listError}
        </p>
      )}

      {!desktop ? (
        <SettingsSection title="Configured Hooks">
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            Hooks are managed in the BetterC0de desktop app.
          </p>
        </SettingsSection>
      ) : loadError ? (
        <SettingsSection title="Configured Hooks">
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          >
            <p className="text-xs text-destructive">
              Couldn&apos;t load your hooks. Nothing was changed.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              {refreshing ? (
                <Loader2Icon
                  aria-hidden="true"
                  className="size-3.5 motion-safe:animate-spin"
                />
              ) : (
                <RefreshCwIcon aria-hidden="true" className="size-3.5" />
              )}
              Retry
            </Button>
          </div>
        </SettingsSection>
      ) : hooks.length > 0 ? (
        <SettingsSection title="Configured Hooks">
          {hooks.map((hook) => {
            const eventInfo = HOOK_EVENTS.find((e) => e.value === hook.event)
            return (
              <div key={hook.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {eventInfo?.label || hook.event}
                    </Badge>
                    {hook.lastStatus && hook.lastStatus !== "idle" && (
                      <Badge
                        variant="outline"
                        className={
                          hook.lastStatus === "error"
                            ? "shrink-0 text-[10px] text-destructive"
                            : "shrink-0 text-[10px]"
                        }
                      >
                        {HOOK_STATUS_LABEL[hook.lastStatus] ?? hook.lastStatus}
                      </Badge>
                    )}
                    {hook.approved === true && (
                      <Badge
                        variant="outline"
                        className="shrink-0 text-[10px] text-muted-foreground"
                      >
                        Approved
                      </Badge>
                    )}
                    {hook.approved === false && (
                      <Badge
                        variant="outline"
                        className="shrink-0 text-[10px] text-warning"
                      >
                        Not approved
                      </Badge>
                    )}
                  </div>
                  <p
                    className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                    title={hook.command}
                  >
                    {hook.command}
                  </p>
                  {hook.approved === false && (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Doesn&apos;t run on its own. Edit and save it to approve
                      the command.
                    </p>
                  )}
                  {(hook.lastError || hook.lastRunAt) && (
                    <p className="mt-1 truncate text-[10px] text-muted-foreground/70">
                      {hook.lastError ||
                        `Last run: ${new Date(
                          hook.lastRunAt || ""
                        ).toLocaleString()}`}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Edit hook ${hook.command}`}
                  onClick={() => editHook(hook)}
                >
                  <PencilIcon
                    aria-hidden="true"
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
                <Switch
                  checked={hook.enabled}
                  aria-label={`Enable hook ${hook.command}`}
                  onCheckedChange={(value) => void toggleHook(hook, value)}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Delete hook ${hook.command}`}
                  onClick={() => void removeHook(hook)}
                >
                  <Trash2Icon
                    aria-hidden="true"
                    className="size-3.5 text-muted-foreground hover:text-destructive"
                  />
                </Button>
              </div>
            )
          })}
        </SettingsSection>
      ) : !showAddForm ? (
        <SettingsSection title="Configured Hooks">
          <div className="px-6 py-8 text-center">
            <HugeiconsIcon
              icon={LinkIcon}
              strokeWidth={2}
              aria-hidden="true"
              className="mx-auto size-8 text-muted-foreground/30"
            />
            <p className="mt-2 text-sm text-muted-foreground">
              No hooks configured
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add a hook to run a command on one of the events above.
            </p>
          </div>
        </SettingsSection>
      ) : null}
    </>
  )
}
