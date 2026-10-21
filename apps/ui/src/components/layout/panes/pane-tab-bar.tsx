import type { ReactNode } from "react"
import {
  CodeIcon,
  FolderOpenIcon,
  GitBranchIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ClipboardIcon, LayoutAlignRightIcon } from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PANE_TAB_DRAG_TYPE } from "@/components/layout/panes/pane-drop-zone"
import { AttentionBadge } from "@/components/attention/attention-badge"
import { PaneRunningDot } from "@/components/layout/panes/pane-running-dot"
import { useChatStore } from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { deriveThreadTitle } from "@/lib/thread-title"
import type { Pane, PaneTab, PaneTabKind } from "@/hooks/use-panes"

// "terminal" is deliberately absent — the user retired the terminal from the
// workspace taskbar. kindIcon below still handles the kind so any pane that
// somehow carries an old terminal tab renders instead of crashing.
const ADDABLE_KINDS: { kind: PaneTabKind; label: string }[] = [
  { kind: "chat", label: "Chat" },
  { kind: "plan", label: "Plan" },
  { kind: "diff", label: "Diff" },
  { kind: "files", label: "Files" },
  { kind: "git", label: "Git" },
]

function kindIcon(kind: PaneTabKind): ReactNode {
  switch (kind) {
    case "chat":
      return (
        <MessageSquareIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
      )
    case "terminal":
      return <TerminalIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
    case "plan":
      return (
        <HugeiconsIcon
          icon={ClipboardIcon}
          strokeWidth={1.5}
          className="size-3.5 shrink-0"
        />
      )
    case "diff":
      return <CodeIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
    case "files":
      return <FolderOpenIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
    case "git":
      return <GitBranchIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
  }
}

/**
 * Combined pane title/tab bar: the content tabs (chat / terminal / plan / diff /
 * files / git) double as the title row, with the "+" add-tab menu and the
 * pane's workspace toggle + close controls on the right. (No separate title
 * header — a single chat pane just shows its one chat tab, no duplicate
 * title.) Tabs are rounded chips (active = bg-muted pill) — same visual
 * language as the WorkspaceRightPanel strip. Tab chips are draggable for
 * drag-to-split. There is no maximize control: the user retired it.
 */
export function PaneTabBar({
  pane,
  chatTitle,
  isActive,
  canClose,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onClose,
}: {
  pane: Pane
  chatTitle: string
  isActive: boolean
  canClose: boolean
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onAddTab: (kind: PaneTabKind) => void
  onClose: () => void
}) {
  const chatTabCount = pane.tabs.filter((t) => t.kind === "chat").length
  // Each chat tab shows its OWN thread's title (a pane can hold several chats).
  const threads = useChatStore((s) => s.threads)
  const labelFor = (tab: PaneTab): string => {
    if (tab.kind !== "chat") return tab.title
    return deriveThreadTitle(
      threads.find((t) => t.id === tab.threadId),
      chatTitle
    )
  }
  // A pane holding exactly ONE chat renders as a Codex-style title row
  // (icon + title + "…" menu) instead of a tab chip — the chip look only
  // appears once a second tab exists.
  const soloChatTab =
    pane.tabs.length === 1 && pane.tabs[0]!.kind === "chat"
      ? pane.tabs[0]!
      : null

  if (soloChatTab) {
    return (
      <div className="flex h-10 shrink-0 items-stretch bg-background pr-1">
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move"
            e.dataTransfer.setData(
              PANE_TAB_DRAG_TYPE,
              JSON.stringify({ paneId: pane.id, tabId: soloChatTab.id })
            )
          }}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-2 px-3.5 select-none active:cursor-grabbing"
        >
          <FolderOpenIcon
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
          <span className="truncate text-[13px] font-medium text-foreground">
            {labelFor(soloChatTab)}
          </span>
          <PaneRunningDot threadId={soloChatTab.threadId} />
          {soloChatTab.threadId ? (
            <AttentionBadge threadId={soloChatTab.threadId} />
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Pane options"
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                <MoreHorizontalIcon className="size-3.5" strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {ADDABLE_KINDS.map(({ kind, label }) => (
                <DropdownMenuItem key={kind} onClick={() => onAddTab(kind)}>
                  {kindIcon(kind)}
                  <span className="ml-2">New {label} tab</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Pane controls */}
        <div className="flex shrink-0 items-center self-center">
          {isActive && <PaneWorkspaceToggle />}
          {canClose && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close pane"
              title="Close pane"
            >
              <XIcon className="size-3.5" strokeWidth={1.5} />
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-9 shrink-0 items-stretch bg-background pr-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {pane.tabs.map((tab) => {
          const active = tab.id === pane.activeTabId
          // Keep at least one chat tab alive.
          const canCloseTab = !(tab.kind === "chat" && chatTabCount <= 1)
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move"
                e.dataTransfer.setData(
                  PANE_TAB_DRAG_TYPE,
                  JSON.stringify({ paneId: pane.id, tabId: tab.id })
                )
              }}
              className={cn(
                "group relative flex h-7 shrink-0 cursor-grab items-center gap-1.5 rounded-md pl-2.5 text-[11px] font-medium transition-colors select-none active:cursor-grabbing",
                canCloseTab ? "pr-1" : "pr-2.5",
                active
                  ? "bg-muted/70 text-foreground"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              )}
            >
              <button
                type="button"
                onClick={() => onSelectTab(tab.id)}
                className="flex min-w-0 items-center gap-1.5 py-0"
              >
                {kindIcon(tab.kind)}
                <span className="max-w-[160px] truncate">{labelFor(tab)}</span>
                {tab.kind === "chat" && tab.threadId ? (
                  <>
                    <PaneRunningDot threadId={tab.threadId} />
                    <AttentionBadge threadId={tab.threadId} />
                  </>
                ) : null}
              </button>
              {canCloseTab && (
                <button
                  type="button"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseTab(tab.id)
                  }}
                  className="rounded p-0.5 text-muted-foreground/60 opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
          )
        })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Add tab"
              title="Add tab"
              className="flex h-7 shrink-0 items-center rounded-md px-2 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              <PlusIcon className="size-3.5" strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {ADDABLE_KINDS.map(({ kind, label }) => (
              <DropdownMenuItem key={kind} onClick={() => onAddTab(kind)}>
                {kindIcon(kind)}
                <span className="ml-2">{label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Pane controls */}
      <div className="flex shrink-0 items-center self-center">
        {isActive && <PaneWorkspaceToggle />}
        {canClose && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close pane"
            title="Close pane"
          >
            <XIcon className="size-3.5" strokeWidth={1.5} />
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Opens the workspace panel. While the panel is open its own header carries
 * the close control beside the view picker, so this button steps aside —
 * showing the same glyph in both places doubled the icon.
 */
function PaneWorkspaceToggle() {
  const workspaceOpen = usePreferencesStore((s) => s.rightSidebarOpen)
  if (workspaceOpen) return null

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={() =>
        usePreferencesStore.getState().set("rightSidebarOpen", true)
      }
      className="text-muted-foreground transition-[color,scale] duration-150 ease-out hover:text-foreground active:scale-[0.96]"
      aria-label="Open workspace"
      title="Open workspace"
    >
      <HugeiconsIcon
        icon={LayoutAlignRightIcon}
        strokeWidth={2}
        className="size-3.5"
      />
    </Button>
  )
}
