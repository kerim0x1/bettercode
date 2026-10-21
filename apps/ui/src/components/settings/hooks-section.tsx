import { useState, useCallback, useEffect } from "react"
import { SettingsSection } from "@/components/settings/atoms"
import {
  deleteRuntimeHook,
  listRuntimeHooks,
  saveRuntimeHook,
  type RuntimeHook,
} from "@/lib/runtime-config"
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
import { PencilIcon, Trash2Icon, PlusIcon, Loader2Icon } from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { LinkIcon } from "@hugeicons/core-free-icons"

const HOOK_EVENTS = [
  {
    value: "on_message_send" as const,
    label: "On Message Send",
    description: "Runs before a message is sent to the AI",
  },
  {
    value: "on_response_complete" as const,
    label: "On Response Complete",
    description: "Runs after the AI finishes responding",
  },
  {
    value: "on_file_change" as const,
    label: "On File Change",
    description: "Runs when a file is created or modified",
  },
  {
    value: "on_commit" as const,
    label: "On Commit",
    description: "Runs after a git commit is made",
  },
]

export function SettingsHooksSection() {
  const [hooks, setHooks] = useState<RuntimeHook[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newHook, setNewHook] = useState<{
    event: RuntimeHook["event"]
    command: string
  }>({ event: "on_message_send", command: "" })

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setHooks(await listRuntimeHooks())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => setLoading(false))
  }, [refresh])

  const handleAddHook = useCallback(async () => {
    if (!newHook.command.trim()) return
    await saveRuntimeHook({
      id: editingId || undefined,
      event: newHook.event,
      command: newHook.command.trim(),
      enabled: true,
    })
    setNewHook({ event: "on_message_send", command: "" })
    setEditingId(null)
    setShowAddForm(false)
    await refresh()
  }, [editingId, newHook, refresh])

  const toggleHook = useCallback(
    async (hook: RuntimeHook, enabled: boolean) => {
      await saveRuntimeHook({
        ...hook,
        enabled,
      })
      await refresh()
    },
    [refresh]
  )

  const removeHook = useCallback(
    async (id: string) => {
      await deleteRuntimeHook(id)
      await refresh()
    },
    [refresh]
  )

  const editHook = useCallback((hook: RuntimeHook) => {
    setEditingId(hook.id)
    setNewHook({ event: hook.event, command: hook.command })
    setShowAddForm(true)
  }, [])

  if (loading) {
    return (
      <SettingsSection title="Event Hooks">
        <div className="px-6 py-8 text-center">
          <Loader2Icon className="mx-auto size-5 animate-spin text-muted-foreground" />
        </div>
      </SettingsSection>
    )
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          Event Hooks
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => setShowAddForm(!showAddForm)}
        >
          <PlusIcon className="size-3" /> Add Hook
        </Button>
      </div>

      {/* Supported events info */}
      <SettingsSection title="Supported Events">
        {HOOK_EVENTS.map((evt) => {
          const count = hooks.filter((h) => h.event === evt.value).length
          return (
            <div
              key={evt.value}
              className="flex items-center justify-between px-4 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{evt.label}</p>
                <p className="text-xs text-muted-foreground">
                  {evt.description}
                </p>
              </div>
              <Badge variant="outline" className="text-[10px]">
                {count} hook{count !== 1 ? "s" : ""}
              </Badge>
            </div>
          )
        })}
      </SettingsSection>

      {showAddForm && (
        <SettingsSection title={editingId ? "Edit Hook" : "New Hook"}>
          <div className="space-y-3 px-4 py-3">
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                Event
              </label>
              <Select
                value={newHook.event}
                onValueChange={(v) =>
                  setNewHook({ ...newHook, event: v as RuntimeHook["event"] })
                }
              >
                <SelectTrigger className="w-full" size="sm">
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
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                Shell Command
              </label>
              <Input
                className="h-8 font-mono text-xs"
                placeholder="npm run lint"
                value={newHook.command}
                onChange={(e) =>
                  setNewHook({ ...newHook, command: e.target.value })
                }
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowAddForm(false)
                  setEditingId(null)
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleAddHook}
                disabled={!newHook.command.trim()}
              >
                {editingId ? "Save Hook" : "Add Hook"}
              </Button>
            </div>
          </div>
        </SettingsSection>
      )}

      {hooks.length > 0 && (
        <SettingsSection title="Configured Hooks">
          {hooks.map((hook) => {
            const eventInfo = HOOK_EVENTS.find((e) => e.value === hook.event)
            return (
              <div key={hook.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {eventInfo?.label || hook.event}
                    </Badge>
                    {hook.lastStatus && hook.lastStatus !== "idle" && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {hook.lastStatus}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                    {hook.command}
                  </p>
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
                  onClick={() => editHook(hook)}
                >
                  <PencilIcon className="size-3.5 text-muted-foreground" />
                </Button>
                <Switch
                  checked={hook.enabled}
                  onCheckedChange={(value) => toggleHook(hook, value)}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => removeHook(hook.id)}
                >
                  <Trash2Icon className="size-3.5 text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            )
          })}
        </SettingsSection>
      )}

      {hooks.length === 0 && !showAddForm && (
        <SettingsSection title="Configured Hooks">
          <div className="px-6 py-8 text-center">
            <HugeiconsIcon
              icon={LinkIcon}
              strokeWidth={2}
              className="mx-auto size-8 text-muted-foreground/30"
            />
            <p className="mt-2 text-sm text-muted-foreground">
              No hooks configured
            </p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              Add hooks to automate actions on events
            </p>
          </div>
        </SettingsSection>
      )}
    </>
  )
}
