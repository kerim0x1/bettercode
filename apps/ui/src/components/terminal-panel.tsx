import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChevronDownIcon,
  Columns2Icon,
  Maximize2Icon,
  Minimize2Icon,
  PlusIcon,
  Rows2Icon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { NoFolderEmptyState } from "@/components/layout/panes/no-folder-empty-state"
import { ShellIcon } from "@/components/terminal/shell-icon"
import { TerminalSplitView } from "@/components/terminal/terminal-split-view"
import { TerminalTabStrip } from "@/components/terminal/terminal-tab-strip"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  MENU_HEADING,
  MENU_ITEM,
  MENU_ITEM_HINT,
  MENU_PANEL,
  MENU_WIDTH_SM,
} from "@/components/ui/menu-chrome"
import { useAppearanceStore } from "@/lib/appearance-store"
import { createLogger } from "@/lib/logger"
import {
  TERMINAL_CLOSE_ACTIVE_SESSION_EVENT,
  TERMINAL_NEW_SESSION_EVENT,
  TERMINAL_SPLIT_EVENT,
  terminalSessionTargetsPanel,
  type TerminalCloseActiveSessionEventDetail,
  type TerminalNewSessionEventDetail,
  type TerminalSplitEventDetail,
} from "@/lib/terminal-events"
import {
  EMPTY_TERMINAL_GROUP,
  MAX_TERMINAL_PANES_PER_TAB,
  activeTerminalTab,
  layoutTerminalIds,
} from "@/lib/terminal-layout"
import {
  claimTerminalEvent,
  closeTerminal,
  closeTerminalTab,
  createTerminalTab,
  focusTerminalInput,
  isTerminalBusy,
  loadTerminalShells,
  renameTerminalTabTitle,
  setActiveTerminalTab,
  splitTerminal,
  terminalScopeKey,
  useTerminalStore,
} from "@/lib/terminal-sessions"
import { cn } from "@/lib/utils"
import type { ShellInfo } from "@/services/backend/workspaceApi"

const log = createLogger("terminal-panel")

interface TerminalPanelProps {
  threadId?: string | null
  open: boolean
  onClose: () => void
  /** The chat's workspace or worktree; terminals start there. */
  cwd?: string
  mode?: "agent" | "editor" | "design"
  /**
   * `panel`: the chat's bottom panel, part of the column's height, with a
   * maximize toggle. `fill`: a workspace pane's Terminal tab.
   */
  variant?: "panel" | "fill"
}

let terminalPanelSeq = 0

const ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"

/** The model picker's menu chrome, rows highlighted in `accent/50`. */
const SHELL_MENU_CLASS = cn(
  MENU_PANEL,
  MENU_WIDTH_SM,
  "**:data-[slot$=-item]:focus:bg-accent/50 **:data-[slot$=-item]:data-highlighted:bg-accent/50"
)

/**
 * The chat's interactive terminals: a tab strip with a shell picker, split
 * panes, and real shells (PTYs) that keep running while the panel is hidden.
 * Each chat has its own set; they start in its workspace or worktree.
 */
export function TerminalPanel({
  open,
  onClose,
  cwd,
  mode = "agent",
  threadId,
  variant = "panel",
}: TerminalPanelProps) {
  const scopeKey = terminalScopeKey(threadId, cwd)
  const group = useTerminalStore(
    (state) => state.groups[scopeKey] ?? EMPTY_TERMINAL_GROUP
  )
  const terminals = useTerminalStore((state) => state.terminals)
  const titlesEnabled = useAppearanceStore(
    (state) => state.terminalTitleEnabled
  )
  const confirm = useConfirm()
  const [expanded, setExpanded] = useState(false)

  const instanceIdRef = useRef<string>("")
  if (!instanceIdRef.current) {
    terminalPanelSeq += 1
    instanceIdRef.current = `terminal-panel-${terminalPanelSeq}`
  }

  const activeTab = activeTerminalTab(group)
  const activeTerminalId = activeTab?.activeTerminalId ?? null
  const canSplit =
    activeTab !== null &&
    layoutTerminalIds(activeTab.layout).length < MAX_TERMINAL_PANES_PER_TAB

  const newTerminal = useCallback(
    (shell?: string) => {
      if (!cwd) return
      createTerminalTab(scopeKey, {
        cwd,
        ...(shell ? { shell } : {}),
        focus: true,
      })
    },
    [cwd, scopeKey]
  )

  const split = useCallback(
    (direction: "right" | "down") => {
      if (!activeTerminalId) return
      const created = splitTerminal(
        activeTerminalId,
        direction === "right" ? "row" : "column"
      )
      if (!created) {
        toast.info(
          `A tab holds up to ${MAX_TERMINAL_PANES_PER_TAB} terminals. Open a new tab instead.`,
          { id: "terminal-split-limit" }
        )
      }
    },
    [activeTerminalId]
  )

  /** After a close: hide the panel once the chat has no terminal left. */
  const afterClose = useCallback(() => {
    const next = useTerminalStore.getState().groups[scopeKey]
    if (!next) {
      onClose()
      return
    }
    const nextActive = activeTerminalTab(next)?.activeTerminalId
    if (nextActive) focusTerminalInput(nextActive)
  }, [onClose, scopeKey])

  const requestCloseTerminal = useCallback(
    async (terminalId: string) => {
      if (isTerminalBusy(terminalId)) {
        const confirmed = await confirm({
          title: "Close this terminal?",
          description:
            "A program is still running in it. Closing the terminal ends it.",
          confirmLabel: "Close terminal",
          destructive: true,
        })
        if (!confirmed) return
      }
      closeTerminal(terminalId)
      afterClose()
    },
    [afterClose, confirm]
  )

  const requestCloseTab = useCallback(
    async (tabId: string) => {
      const tab = useTerminalStore
        .getState()
        .groups[scopeKey]?.tabs.find((candidate) => candidate.id === tabId)
      if (!tab) return
      const busy = layoutTerminalIds(tab.layout).filter(isTerminalBusy).length
      if (busy > 0) {
        const confirmed = await confirm({
          title: "Close this tab?",
          description:
            busy === 1
              ? "A program is still running in this tab. Closing the tab ends it."
              : `Programs are still running in ${busy} of this tab's terminals. Closing the tab ends them.`,
          confirmLabel: "Close tab",
          destructive: true,
        })
        if (!confirmed) return
      }
      closeTerminalTab(scopeKey, tabId)
      afterClose()
    },
    [afterClose, confirm, scopeKey]
  )

  // Opening the panel gives an empty chat its first terminal and the
  // keyboard to the active one. Switching chats while it is open does not
  // start a shell on its own: the empty state offers one.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    // Opened before the chat's folder was known: wait for it.
    if (wasOpenRef.current || !cwd) return
    wasOpenRef.current = true
    const current = useTerminalStore.getState().groups[scopeKey]
    const active = current ? activeTerminalTab(current) : null
    if (active) focusTerminalInput(active.activeTerminalId)
    else createTerminalTab(scopeKey, { cwd, focus: true })
  }, [open, cwd, scopeKey])

  useEffect(() => {
    const panel = { id: instanceIdRef.current, mode, threadId }
    const onNewSession = (event: Event) => {
      const detail =
        (event as CustomEvent<TerminalNewSessionEventDetail>).detail ?? {}
      if (!terminalSessionTargetsPanel(detail, panel)) return
      const target = detail.cwd || cwd
      if (!target || !claimTerminalEvent(event)) return
      createTerminalTab(scopeKey, {
        cwd: target,
        ...(detail.shell ? { shell: detail.shell } : {}),
        ...(detail.initialCommand
          ? { initialInput: detail.initialCommand }
          : {}),
        focus: true,
      })
    }
    const onCloseActive = (event: Event) => {
      const detail = (
        event as CustomEvent<TerminalCloseActiveSessionEventDetail>
      ).detail
      if (detail?.targetPanelId !== panel.id || !activeTerminalId) return
      void requestCloseTerminal(activeTerminalId)
    }
    const onSplit = (event: Event) => {
      const detail = (event as CustomEvent<TerminalSplitEventDetail>).detail
      if (detail?.targetPanelId !== panel.id) return
      split(detail.direction)
    }
    window.addEventListener(TERMINAL_NEW_SESSION_EVENT, onNewSession)
    window.addEventListener(TERMINAL_CLOSE_ACTIVE_SESSION_EVENT, onCloseActive)
    window.addEventListener(TERMINAL_SPLIT_EVENT, onSplit)
    return () => {
      window.removeEventListener(TERMINAL_NEW_SESSION_EVENT, onNewSession)
      window.removeEventListener(
        TERMINAL_CLOSE_ACTIVE_SESSION_EVENT,
        onCloseActive
      )
      window.removeEventListener(TERMINAL_SPLIT_EVENT, onSplit)
    }
  }, [
    activeTerminalId,
    cwd,
    mode,
    requestCloseTerminal,
    scopeKey,
    split,
    threadId,
  ])

  if (!open) return null

  return (
    <div
      data-terminal-panel-id={instanceIdRef.current}
      data-terminal-thread={threadId ?? undefined}
      className={cn(
        "betterc0de-terminal flex min-h-0 flex-col bg-background text-foreground",
        variant === "panel"
          ? cn(
              "shrink-0 border-t border-border/60",
              expanded ? "h-[75%]" : "h-[40%] min-h-[180px]"
            )
          : "h-full"
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-1.5 font-sans">
        <TerminalTabStrip
          tabs={group.tabs}
          activeTabId={activeTab?.id ?? null}
          terminals={terminals}
          titlesEnabled={titlesEnabled}
          onSelect={(tabId) => {
            setActiveTerminalTab(scopeKey, tabId)
            const tab = group.tabs.find((candidate) => candidate.id === tabId)
            if (tab) focusTerminalInput(tab.activeTerminalId)
          }}
          onClose={(tabId) => void requestCloseTab(tabId)}
          onRename={(tabId, title) =>
            renameTerminalTabTitle(scopeKey, tabId, title)
          }
        />
        <div className="flex shrink-0 items-center gap-0.5">
          <NewTerminalControls disabled={!cwd} onNew={newTerminal} />
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label="Split terminal right"
            title="Split right (Ctrl+D)"
            disabled={!canSplit}
            onClick={() => split("right")}
          >
            <Columns2Icon className="size-3.5" />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label="Split terminal down"
            title="Split down (Ctrl+Shift+D)"
            disabled={!canSplit}
            onClick={() => split("down")}
          >
            <Rows2Icon className="size-3.5" />
          </button>
          {variant === "panel" ? (
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={
                expanded ? "Restore terminal size" : "Maximize terminal"
              }
              aria-pressed={expanded}
              title={expanded ? "Restore size" : "Maximize"}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <Minimize2Icon className="size-3.5" />
              ) : (
                <Maximize2Icon className="size-3.5" />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label="Hide terminal"
            title={
              variant === "panel"
                ? "Hide (Ctrl+`). Terminals keep running."
                : "Back to the chat. Terminals keep running."
            }
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {!cwd ? (
          <div className="min-w-0 flex-1 font-sans">
            <NoFolderEmptyState />
          </div>
        ) : activeTab ? (
          <TerminalSplitView
            key={activeTab.id}
            scopeKey={scopeKey}
            tab={activeTab}
            titlesEnabled={titlesEnabled}
            onRequestClose={(terminalId) =>
              void requestCloseTerminal(terminalId)
            }
          />
        ) : (
          <NoTerminalState onNew={() => newTerminal()} />
        )}
      </div>
    </div>
  )
}

/** A chat whose terminals were all closed, shown after switching to it. */
function NoTerminalState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center font-sans">
      <SquareTerminalIcon
        className="size-7 text-muted-foreground/50"
        strokeWidth={1.25}
        aria-hidden="true"
      />
      <div className="space-y-1">
        <p className="text-sm font-medium text-muted-foreground">
          No terminal in this chat
        </p>
        <p className="text-xs text-muted-foreground/70">
          Terminals start in the chat's folder and keep running while hidden.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onNew}>
        <PlusIcon data-icon="inline-start" />
        New terminal
      </Button>
    </div>
  )
}

/** `+` opens the default shell; the chevron picks one of the detected shells. */
function NewTerminalControls({
  disabled,
  onNew,
}: {
  disabled: boolean
  onNew: (shell?: string) => void
}) {
  const [shells, setShells] = useState<ShellInfo[] | null>(null)
  const [failed, setFailed] = useState(false)

  const loadShells = () => {
    if (shells) return
    setFailed(false)
    loadTerminalShells().then(setShells, (error: unknown) => {
      log.warn("Failed to load available shells", error)
      setFailed(true)
    })
  }

  return (
    <div className="flex items-center">
      <button
        type="button"
        className={ICON_BUTTON}
        aria-label="New terminal"
        title="New terminal (Ctrl+N in a terminal)"
        disabled={disabled}
        onClick={() => onNew()}
      >
        <PlusIcon className="size-3.5" />
      </button>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) loadShells()
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(ICON_BUTTON, "w-4")}
            aria-label="Choose a shell for a new terminal"
            title="Choose shell"
            disabled={disabled}
          >
            <ChevronDownIcon className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={SHELL_MENU_CLASS}>
          <div className={MENU_HEADING}>New terminal</div>
          {shells === null ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              {failed ? "Couldn't list the shells." : "Looking for shells…"}
            </div>
          ) : shells.length === 0 ? (
            <DropdownMenuItem className={MENU_ITEM} onSelect={() => onNew()}>
              <ShellIcon shell={undefined} />
              Default shell
            </DropdownMenuItem>
          ) : (
            shells.map((shell) => (
              <DropdownMenuItem
                key={shell.id}
                className={MENU_ITEM}
                onSelect={() => onNew(shell.id)}
              >
                <ShellIcon shell={shell.id} />
                <span className="min-w-0 flex-1 truncate">{shell.name}</span>
                {shell.default ? (
                  <span className={cn(MENU_ITEM_HINT, "mt-0")}>Default</span>
                ) : null}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
