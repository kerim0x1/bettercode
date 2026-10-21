import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  WebhookIcon,
} from "lucide-react"
import {
  describeAutomationSchedule,
  type AutomationRun,
  type AutomationView,
  type AutomationWebhookEndpointsResponse,
} from "@betterc0de/schema"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  ensureAutomationChats,
  openAutomationChat,
} from "@/lib/automation-chats"
import {
  draftFromAutomation,
  emptyAutomationDraft,
  formatNextRun,
  projectFolderName,
  type AutomationDraft,
} from "@/lib/automations"
import { useChatStore } from "@/lib/chat-store"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import {
  getAutomationWebhookEndpoints,
  listAutomations,
} from "@/services/backend/automations-api"
import { listProjects } from "@/services/backend/coreApi"
import { isRemoteRuntime } from "@/services/backend/runtime"
import { AutomationDetail } from "./automation-detail"
import { AutomationEditor } from "./automation-editor"
import { AutomationRunStatus } from "./automation-run-history"

const HEADER_BUTTON =
  "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-[0.96] disabled:opacity-50 motion-reduce:transition-none"

/** While the page is open and visible, run states are read this often. */
const REFRESH_MS = 15_000

type EditorState =
  | { readonly mode: "create"; readonly draft: AutomationDraft }
  | {
      readonly mode: "edit"
      readonly id: string
      readonly draft: AutomationDraft
      readonly secretConfigured: boolean
    }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The current time, updated every `intervalMs`, for "Today at 09:00". */
function useClock(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function runChatIds(automations: readonly AutomationView[]): string[] {
  return automations.flatMap((automation) =>
    automation.lastRun?.threadId ? [automation.lastRun.threadId] : []
  )
}

/** The open chat's project, the natural default for a new automation. */
function activeProjectPath(): string {
  const state = useChatStore.getState()
  return (
    state.threads.find((thread) => thread.id === state.activeThreadId)
      ?.projectPath ?? ""
  )
}

function AutomationListRow({
  automation,
  selected,
  now,
  onSelect,
}: {
  automation: AutomationView
  selected: boolean
  now: Date
  onSelect: () => void
}) {
  const TriggerIcon =
    automation.trigger.type === "webhook" ? WebhookIcon : CalendarClockIcon
  const summary =
    automation.trigger.type === "webhook"
      ? "Webhook"
      : describeAutomationSchedule(automation.trigger.schedule)
  const lastRun = automation.lastRun
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none motion-reduce:transition-none",
        selected ? "bg-muted/70" : "hover:bg-muted/40"
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <TriggerIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0",
            selected ? "text-primary" : "text-muted-foreground"
          )}
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {automation.name}
        </span>
        {!automation.enabled ? (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
            Paused
          </span>
        ) : null}
      </span>
      <span className="truncate pl-[22px] text-[11.5px] text-muted-foreground">
        {summary} · {projectFolderName(automation.projectPath)}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 pl-[22px] text-[11px] text-muted-foreground">
        {lastRun ? (
          <AutomationRunStatus
            status={lastRun.status}
            className="text-[11px]"
          />
        ) : (
          <span>No runs yet</span>
        )}
        <span aria-hidden="true">·</span>
        <span className="truncate">{formatNextRun(automation, now)}</span>
      </span>
    </button>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-primary/12">
        <CalendarClockIcon
          aria-hidden="true"
          className="size-5 text-primary"
          strokeWidth={1.5}
        />
      </span>
      <h2 className="text-[16px] font-semibold text-foreground">
        Let an agent work on a schedule
      </h2>
      <p className="text-[12.5px] text-muted-foreground">
        An automation runs a prompt in one of your projects every morning, every
        hour or when a webhook is called, for example by GitHub. Each run starts
        its own chat, so you can read what it did.
      </p>
      <Button
        type="button"
        size="sm"
        className="h-8 rounded-lg text-[12px]"
        onClick={onCreate}
      >
        <PlusIcon aria-hidden="true" className="size-3.5" />
        New automation
      </Button>
    </div>
  )
}

/**
 * Automations as a page in the main area, like Usage and Settings: the
 * automations on the left, the selected one (or the editor) on the right.
 * Opened by the sidebar's Scheduled action and Ctrl+Shift+A.
 */
export function AutomationsPage({ onClose }: { onClose: () => void }) {
  const remote = isRemoteRuntime()
  const now = useClock(30_000)
  const [automations, setAutomations] = useState<AutomationView[] | null>(null)
  const [endpoints, setEndpoints] =
    useState<AutomationWebhookEndpointsResponse | null>(null)
  const [projects, setProjects] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const endpointsRef = useRef(endpoints)
  endpointsRef.current = endpoints

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const { automations: list } = await listAutomations()
      setAutomations(list)
      setError(null)
      void ensureAutomationChats(runChatIds(list))
    } catch (failure) {
      if (!quiet) setError(errorMessage(failure))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  const loadEndpoints = useCallback(async () => {
    try {
      setEndpoints(await getAutomationWebhookEndpoints())
    } catch {
      // Read again with the next refresh.
    }
  }, [])

  useEffect(() => {
    if (remote) return
    void load()
    void loadEndpoints()
    listProjects().then(
      (list) => setProjects(list.map((project) => project.path)),
      () => undefined
    )
  }, [remote, load, loadEndpoints])

  useEffect(() => {
    if (remote) return
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return
      void load(true)
      if (!endpointsRef.current) void loadEndpoints()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [remote, load, loadEndpoints])

  const selected =
    automations?.find((automation) => automation.id === selectedId) ??
    automations?.[0] ??
    null

  const openCreate = () =>
    setEditor({
      mode: "create",
      draft: emptyAutomationDraft(new Date(), {
        projectPath: activeProjectPath(),
      }),
    })

  const openEdit = (automation: AutomationView) =>
    setEditor({
      mode: "edit",
      id: automation.id,
      draft: draftFromAutomation(automation, new Date()),
      secretConfigured: automation.webhook?.secretConfigured ?? false,
    })

  const replace = (updated: AutomationView) =>
    setAutomations((current) => {
      if (!current) return [updated]
      return current.some((automation) => automation.id === updated.id)
        ? current.map((automation) =>
            automation.id === updated.id ? updated : automation
          )
        : [...current, updated]
    })

  const openChat = (run: AutomationRun) => {
    if (!run.threadId) return
    const threadId = run.threadId
    onClose()
    void openAutomationChat(threadId, run.threadTitle ?? "Automation run").then(
      (opened) => {
        if (!opened) toast.error("This run's chat no longer exists.")
      }
    )
  }

  let body: ReactNode
  if (remote) {
    body = (
      <div className="mx-auto flex max-w-md items-start gap-3 px-6 py-16 text-[12.5px] text-muted-foreground">
        <MonitorIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>Automations are managed in the BetterC0de desktop app.</p>
      </div>
    )
  } else if (automations === null) {
    body = error ? (
      <div
        role="alert"
        className="mx-auto mt-10 flex max-w-lg flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-[12px] text-foreground"
      >
        <span className="min-w-0 flex-1">{error}</span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={loading}
          onClick={() => void load()}
        >
          Retry
        </Button>
      </div>
    ) : (
      <p className="px-6 py-10 text-center text-[12px] text-muted-foreground">
        Loading automations…
      </p>
    )
  } else if (automations.length === 0 && !editor) {
    body = <EmptyState onCreate={openCreate} />
  } else {
    body = (
      <div className="grid h-full min-h-0 grid-rows-[minmax(0,auto)_minmax(0,1fr)] @[860px]/automations:grid-cols-[300px_minmax(0,1fr)] @[860px]/automations:grid-rows-1">
        <nav
          aria-label="Automations"
          className="max-h-[40vh] min-h-0 overflow-y-auto border-b border-border/40 p-2 @[860px]/automations:max-h-none @[860px]/automations:border-r @[860px]/automations:border-b-0"
        >
          <ul className="flex flex-col gap-0.5">
            {automations.map((automation) => (
              <li key={automation.id}>
                <AutomationListRow
                  automation={automation}
                  selected={!editor && automation.id === selected?.id}
                  now={now}
                  onSelect={() => {
                    setEditor(null)
                    setSelectedId(automation.id)
                  }}
                />
              </li>
            ))}
          </ul>
        </nav>
        <div className="@container/automation min-h-0 overflow-y-auto">
          <div className="mx-auto w-full max-w-[880px] px-6 py-6 @[640px]/automation:px-10">
            {editor ? (
              <AutomationEditor
                key={editor.mode === "edit" ? editor.id : "new"}
                mode={editor.mode}
                automationId={editor.mode === "edit" ? editor.id : null}
                initial={editor.draft}
                secretConfigured={
                  editor.mode === "edit" ? editor.secretConfigured : false
                }
                projects={projects}
                now={now}
                onCancel={() => setEditor(null)}
                onSaved={(saved) => {
                  replace(saved)
                  setSelectedId(saved.id)
                  toast.success(
                    editor.mode === "edit"
                      ? "Automation saved"
                      : "Automation created"
                  )
                  setEditor(null)
                }}
              />
            ) : selected ? (
              <AutomationDetail
                key={selected.id}
                automation={selected}
                endpoints={endpoints?.endpoints ?? null}
                remoteAccessEnabled={endpoints?.remoteAccessEnabled ?? null}
                now={now}
                onEdit={() => openEdit(selected)}
                onUpdated={replace}
                onRefresh={() => void load(true)}
                onDeleted={(id) => {
                  setAutomations(
                    (current) =>
                      current?.filter((automation) => automation.id !== id) ??
                      null
                  )
                  setSelectedId(null)
                  toast.success("Automation deleted")
                }}
                onOpenChat={openChat}
              />
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 bg-background px-3">
        <div className="flex items-center gap-2.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Back to chat"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-[0.96]"
          >
            <ArrowLeftIcon className="size-3.5" strokeWidth={1.5} />
          </Button>
          <div className="flex items-center gap-2">
            <CalendarClockIcon
              aria-hidden="true"
              className="size-3.5 text-muted-foreground"
              strokeWidth={1.5}
            />
            <h1 className="text-[12px] font-medium">Automations</h1>
          </div>
        </div>
        {!remote ? (
          <div className="flex items-center gap-2">
            {loading && automations !== null ? (
              <Spinner
                aria-hidden="true"
                className="size-3 text-muted-foreground motion-reduce:animate-none"
              />
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void load()
                void loadEndpoints()
              }}
              disabled={loading}
              className={HEADER_BUTTON}
            >
              <RefreshCwIcon
                aria-hidden="true"
                className={cn(
                  "size-3.5",
                  loading && "motion-safe:animate-spin"
                )}
                strokeWidth={1.5}
              />
              Refresh
            </Button>
            <Button
              size="sm"
              className="h-7 rounded-md px-2.5 text-[11.5px]"
              disabled={automations === null}
              onClick={openCreate}
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
              New automation
            </Button>
          </div>
        ) : null}
      </header>
      <div className="@container/automations min-h-0 flex-1 overflow-y-auto">
        {body}
      </div>
    </main>
  )
}
