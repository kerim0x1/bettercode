import { useCallback, useMemo } from "react"
import { CheckIcon, ChevronDownIcon, GitCompareArrowsIcon } from "lucide-react"
import { Spinner } from "@/components/kibo-ui/spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MENU_HEADING, MENU_WIDTH_MD } from "@/components/ui/menu-chrome"
import { useThreadAttention } from "@/lib/attention-store"
import { useChatStore, useThreadById } from "@/lib/chat-store"
import {
  useThreadIsRunning,
  useThreadRunningElapsed,
} from "@/lib/chat/running-selectors"
import { compareGroupThreadIds, compareModelLabel } from "@/lib/compare-models"
import { getModelInfo } from "@/lib/get-model-info"
import { logoNeedsDarkInvert } from "@/lib/logo-invert"
import { useSettingsStore } from "@/lib/settings-store"
import { cn } from "@/lib/utils"
import { ORCHESTRATION_MENU_CLASS } from "./orchestration-model-menu"

/**
 * The chats one prompt started with several models (Compare), linked by the
 * `compareGroupId` in their settings: a switcher in the chat header to jump
 * between them with their status, and a small marker for sidebar rows.
 */

type ChatStoreState = ReturnType<typeof useChatStore.getState>

/** The chats of the comparison `threadId` belongs to, oldest first; empty when none. */
export function useCompareGroup(threadId: string | null | undefined): string[] {
  const groupId = useChatStore((state) =>
    threadId ? state.settingsByThread[threadId]?.compareGroupId : undefined
  )
  // One string, so the list changes only when the group does.
  const key = useChatStore(
    useCallback(
      (state: ChatStoreState) =>
        groupId
          ? compareGroupThreadIds(
              state.threads,
              state.settingsByThread,
              groupId
            ).join("\n")
          : "",
      [groupId]
    )
  )
  return useMemo(() => (key ? key.split("\n") : []), [key])
}

function openCompareChat(threadId: string, title: string) {
  useChatStore.getState().setActiveThread(threadId)
  window.dispatchEvent(
    new CustomEvent("betterc0de:open-thread", {
      detail: { threadId, label: title },
    })
  )
}

/** A compared chat's model: the one it was started with, else its last. */
function useCompareModel(threadId: string): {
  name: string
  logo: string
} {
  const modelId = useChatStore(
    (state) =>
      state.settingsByThread[threadId]?.selectedModel ??
      state.threads.find((thread) => thread.id === threadId)?.lastModelId ??
      undefined
  )
  const info = getModelInfo(modelId)
  return {
    name: compareModelLabel(info?.name ?? modelId ?? "Model"),
    logo: info?.logo ?? "",
  }
}

function CompareSwitcherRow({
  threadId,
  current,
}: {
  threadId: string
  current: boolean
}) {
  const thread = useThreadById(threadId)
  const model = useCompareModel(threadId)
  const running = useThreadIsRunning(threadId)
  const runningFor = useThreadRunningElapsed(threadId)
  const attention = useThreadAttention(threadId)
  const attentionEnabled = useSettingsStore((state) => state.attentionBadges)
  if (!thread) return null
  const waiting = attentionEnabled && (attention?.total ?? 0) > 0
  const started = thread.messages.length > 0 || (thread.messageCount ?? 0) > 0
  const status = running
    ? `Working${runningFor ? ` ${runningFor}` : ""}`
    : waiting
      ? "Waiting for you"
      : started
        ? "Done"
        : "Not started"
  return (
    <DropdownMenuItem
      aria-current={current ? "true" : undefined}
      title={thread.title}
      onSelect={() => openCompareChat(threadId, thread.title)}
      className="h-8 gap-2 rounded-[var(--radius)] px-2 text-[12px] font-normal"
    >
      <span
        aria-hidden="true"
        className="flex size-3.5 shrink-0 items-center justify-center"
      >
        {running ? (
          <Spinner variant="bars" size={12} className="text-primary" />
        ) : waiting ? (
          <span className="size-[7px] rounded-full bg-warning" />
        ) : (
          <span
            className={cn(
              "size-[7px] rounded-full border",
              current
                ? "border-foreground bg-foreground"
                : "border-muted-foreground/60"
            )}
          />
        )}
      </span>
      {model.logo ? (
        <img
          src={model.logo}
          alt=""
          className={cn(
            "size-3.5 shrink-0",
            logoNeedsDarkInvert(model.logo) && "dark:invert"
          )}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{model.name}</span>
      <span
        className={cn(
          "shrink-0 text-[10.5px] tabular-nums",
          running
            ? "text-primary"
            : waiting
              ? "text-warning"
              : "text-muted-foreground"
        )}
      >
        {status}
      </span>
      {current ? (
        <CheckIcon
          aria-label="Open"
          className="size-3.5 shrink-0 text-primary"
        />
      ) : null}
    </DropdownMenuItem>
  )
}

/**
 * Compare in the chat header: which of the compared chats this is, and a
 * menu of all of them with their model and status to switch between them.
 * Renders nothing for a chat that is not part of a comparison.
 */
export function CompareSwitcher({
  threadId,
  className,
}: {
  threadId: string | null | undefined
  className?: string
}) {
  const members = useCompareGroup(threadId)
  if (!threadId || members.length < 2) return null
  const position = members.indexOf(threadId) + 1
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Compare: chat ${position} of ${members.length}`}
          title="Switch between the compared models"
          className={cn(
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none data-[state=open]:bg-muted/60 data-[state=open]:text-foreground motion-reduce:transition-none",
            className
          )}
        >
          <GitCompareArrowsIcon
            aria-hidden="true"
            className="size-3.5 shrink-0"
            strokeWidth={1.75}
          />
          <span>Compare</span>
          <span className="text-muted-foreground/70 tabular-nums">
            {position}/{members.length}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-3 shrink-0 opacity-60"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          ORCHESTRATION_MENU_CLASS,
          MENU_WIDTH_MD,
          "motion-reduce:animate-none"
        )}
      >
        <DropdownMenuLabel className={MENU_HEADING}>
          Compared models
        </DropdownMenuLabel>
        {members.map((id) => (
          <CompareSwitcherRow
            key={id}
            threadId={id}
            current={id === threadId}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A sidebar row's sign that its chat is one of a comparison, with the count. */
export function CompareMarker({
  threadId,
  className,
}: {
  threadId: string
  className?: string
}) {
  const members = useCompareGroup(threadId)
  if (members.length < 2) return null
  const label = `Compare · ${members.length} chats`
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "flex shrink-0 items-center gap-0.5 text-[9.5px] text-sidebar-foreground/45 tabular-nums",
        className
      )}
    >
      <GitCompareArrowsIcon
        aria-hidden="true"
        className="size-3"
        strokeWidth={1.75}
      />
      {members.length}
    </span>
  )
}
