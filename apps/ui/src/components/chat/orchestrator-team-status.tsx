import { useEffect, useRef, useState } from "react"
import type { OrchestratorJob, OrchestratorSession } from "@betterc0de/schema"
import {
  UsersIcon,
  ArrowUpRightIcon,
  Loader2Icon,
  CheckIcon,
  CircleAlertIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProviderIcon } from "@/components/provider-icon"
import { OrchestratorContext } from "./orchestrator-context"
import { useProviders } from "@/hooks/use-providers"
import { useChatStore, useThreadById } from "@/lib/chat-store"
import { HttpError } from "@/lib/errors"
import {
  restoreOrchestrationSelection,
  openOrchestratorChat,
  teamModelChoices,
  teamModelKey,
} from "@/lib/orchestrator"
import {
  getOrchestratorStatus,
  stopOrchestrator,
} from "@/services/backend/orchestratorApi"

const JOB_LABELS = {
  queued: "Queued",
  running: "Working",
  waiting: "Needs your input",
  cancelling: "Stopping",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
} satisfies Record<OrchestratorJob["status"], string>

/** Poll only while this team is visible. Worker output stays in worker chats/MCP results. */
export function OrchestratorTeamStatus({ threadId }: { threadId: string }) {
  const thread = useThreadById(threadId)
  const [snapshot, setSnapshot] = useState<OrchestratorSession | null>(null)
  const isWorker =
    snapshot?.jobs.some((job) => job.threadId === threadId) === true
  const rootId = isWorker ? snapshot.threadId : threadId
  const wantsOrchestration = useChatStore(
    (state) => state.settingsByThread[rootId]?.orchestration?.enabled === true
  )
  // Streaming only matters while orchestration is on: it keeps the team
  // status fresh during a turn. Without it, a start/stop must not refetch.
  const pollWhileStreaming = useChatStore(
    (state) =>
      wantsOrchestration &&
      state.streamingByThread[rootId]?.isStreaming === true
  )
  const session = snapshot?.threadId === rootId ? snapshot : null
  const [error, setError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [reload, setReload] = useState(0)
  const revision = useRef(0)
  const mounted = useRef(false)
  useEffect(() => {
    if (session) restoreOrchestrationSelection(session)
    if (
      isWorker &&
      !useChatStore.getState().settingsByThread[threadId]?.orchestrationWorker
    )
      useChatStore
        .getState()
        .setThreadSetting(threadId, "orchestrationWorker", true)
  }, [session, isWorker, threadId])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      const current = ++revision.current
      try {
        let next = await getOrchestratorStatus(rootId, controller.signal)
        if (!next && thread?.parentThreadId) {
          const parent = await getOrchestratorStatus(
            thread.parentThreadId,
            controller.signal
          )
          if (parent?.jobs.some((job) => job.threadId === threadId))
            next = parent
        }
        if (controller.signal.aborted || current !== revision.current) return
        setSnapshot(next)
        setError(null)
        if (
          pollWhileStreaming ||
          next?.status === "ready" ||
          next?.jobs.some((job) =>
            ["running", "waiting", "cancelling"].includes(job.status)
          )
        )
          timer = setTimeout(() => void refresh(), 2500)
      } catch (failure) {
        if (failure instanceof HttpError && failure.status === 403) return
        if (!controller.signal.aborted && current === revision.current) {
          setError("Team status unavailable. Retrying…")
          timer = setTimeout(() => void refresh(), 5000)
        }
      }
    }
    void refresh()
    return () => {
      mounted.current = false
      controller.abort()
      clearTimeout(timer)
    }
  }, [
    rootId,
    reload,
    wantsOrchestration,
    pollWhileStreaming,
    thread?.parentThreadId,
    threadId,
  ])

  async function stop() {
    if (stopping || !session) return
    setStopping(true)
    ++revision.current
    try {
      const next = await stopOrchestrator(session.threadId)
      if (mounted.current) {
        setSnapshot(next)
        useChatStore
          .getState()
          .setThreadSetting(session.threadId, "orchestration", {
            enabled: false,
          })
        setError(null)
      }
    } catch {
      if (mounted.current)
        setError(
          "Could not stop every task. Retry or open the worker chat to stop it."
        )
    } finally {
      if (mounted.current) {
        setStopping(false)
        setReload((value) => value + 1)
      }
    }
  }

  // The provider catalog is only needed to label an existing team, so panes
  // without one never subscribe to it.
  if (!session) return null
  return (
    <OrchestratorTeamPanel
      session={session}
      threadId={threadId}
      rootId={rootId}
      stopping={stopping}
      error={error}
      onStop={() => void stop()}
      onContextChange={() => setReload((value) => value + 1)}
    />
  )
}

function OrchestratorTeamPanel({
  session,
  threadId,
  rootId,
  stopping,
  error,
  onStop,
  onContextChange,
}: {
  session: OrchestratorSession
  threadId: string
  rootId: string
  stopping: boolean
  error: string | null
  onStop: () => void
  onContextChange: () => void
}) {
  const providers = useProviders(session.projectPath)
  const choices = teamModelChoices(providers)
  const main = choices.find(
    (choice) => teamModelKey(choice.value) === teamModelKey(session.team.main)
  )
  const live = session.jobs.filter((job) =>
    ["queued", "running", "waiting", "cancelling"].includes(job.status)
  ).length
  return (
    <section
      aria-label="Orchestration agents"
      className="not-prose rounded-xl border border-border/60 bg-muted/10 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <UsersIcon className="size-4 text-muted-foreground" />
          <span className="font-medium">Agents</span>
          <span className="text-xs text-muted-foreground">
            {live
              ? `${live} active`
              : session.status === "stopped"
                ? "Stopped"
                : "Ready"}{" "}
            ·{" "}
            {session.mode === "chat"
              ? session.currentTaskCount
              : session.jobs.length}
            /{session.team.maxTasks} tasks
          </span>
        </div>
        {(session.status === "ready" || live > 0) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={stopping}
            onClick={onStop}
          >
            {stopping ? "Stopping…" : "Stop agents"}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border/40 px-4 py-3 text-xs text-muted-foreground">
        {main && <ProviderIcon provider={main.provider} className="size-3.5" />}
        <span>
          Main:{" "}
          <span className="text-foreground">
            {main?.label ?? session.team.main.modelId}
          </span>
        </span>
        <span>· Chooses models and tasks</span>
        {threadId !== rootId && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => openOrchestratorChat(session, providers)}
          >
            Main chat
            <ArrowUpRightIcon className="size-3.5" />
          </Button>
        )}
      </div>
      {!session.jobs.length ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">
          Your main model will delegate when useful. Change the allowed
          providers in + → Orchestration.
        </p>
      ) : (
        <div className="max-h-72 overflow-y-auto border-t border-border/40">
          {session.jobs.map((job) => {
            const member = session.team.members.find(
              (candidate) => candidate.id === job.memberId
            )
            const model =
              member &&
              choices.find(
                (choice) => teamModelKey(choice.value) === teamModelKey(member)
              )
            const running =
              job.status === "running" || job.status === "cancelling"
            const failed =
              job.status === "failed" ||
              job.status === "waiting" ||
              job.status === "interrupted"
            return (
              <button
                key={job.id}
                type="button"
                onClick={() =>
                  openOrchestratorChat(session, providers, job.threadId)
                }
                className="flex w-full items-center gap-3 border-b border-border/30 px-4 py-3 text-left last:border-0 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
                title={job.error ?? job.task}
              >
                {model ? (
                  <ProviderIcon
                    provider={model.provider}
                    className="size-4 shrink-0"
                  />
                ) : (
                  <UsersIcon className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {job.name || member?.name || job.memberId}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {model?.label ?? member?.modelId}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {job.error ?? job.task}
                  </span>
                </span>
                <span
                  className={`flex shrink-0 items-center gap-1.5 text-xs ${failed ? "text-amber-500" : "text-muted-foreground"}`}
                >
                  {running ? (
                    <Loader2Icon className="size-3.5 motion-safe:animate-spin" />
                  ) : job.status === "completed" ? (
                    <CheckIcon className="size-3.5" />
                  ) : failed ? (
                    <CircleAlertIcon className="size-3.5" />
                  ) : null}
                  {JOB_LABELS[job.status]}
                </span>
                <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            )
          })}
        </div>
      )}
      <OrchestratorContext
        key={session.threadId}
        session={session}
        onChange={onContextChange}
      />
      {error && (
        <p role="alert" className="px-4 py-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
