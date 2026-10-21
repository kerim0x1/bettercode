import { copyText } from "@/lib/clipboard"
import { useState, useRef, useCallback, useEffect, useMemo } from "react"
import { cn } from "@/lib/utils"
import { assetUrl } from "@/lib/asset-url"
import { useAppearanceStore } from "@/lib/appearance-store"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import {
  XIcon,
  TerminalIcon,
  PlusIcon,
  MaximizeIcon,
  MinimizeIcon,
  CircleDotIcon,
} from "lucide-react"
import {
  detectShells,
  runShellCommandDetailed,
} from "@/services/backend/workspaceApi"
import { createLogger } from "@/lib/logger"
import {
  TERMINAL_CLOSE_ACTIVE_SESSION_EVENT,
  TERMINAL_NEW_SESSION_EVENT,
  terminalSessionTargetsPanel,
  type TerminalCloseActiveSessionEventDetail,
  type TerminalNewSessionEventDetail,
} from "@/lib/terminal-events"

// M11: route catches through the shared logger so failures land in the error log store.
const log = createLogger("terminal-panel")

interface TerminalLine {
  id: string
  type: "input" | "output" | "error" | "system"
  text: string
  timestamp: number
}

type ShellType = "cmd" | "powershell" | "gitbash" | "wsl" | "bash" | "zsh"

interface ShellInfo {
  id: ShellType
  name: string
  default?: boolean
}

interface TerminalTab {
  id: string
  label: string
  cwd: string
  shell: ShellType
  lines: TerminalLine[]
  history: string[]
  historyIndex: number
}

interface TerminalPanelProps {
  threadId?: string | null
  open: boolean
  onClose: () => void
  cwd?: string
  mode?: "agent" | "editor" | "design"
}

function ShellIcon({
  shell,
  className,
}: {
  shell: string
  className?: string
}) {
  const cls = cn("size-3 shrink-0", className)
  switch (shell) {
    case "powershell":
      return (
        <img
          src={assetUrl("icons/shells/powershell.svg")}
          alt=""
          className={cn(cls, "dark:invert")}
        />
      )
    case "gitbash":
      return (
        <img src={assetUrl("icons/shells/git.svg")} alt="" className={cls} />
      )
    case "wsl":
      return (
        <img src={assetUrl("icons/shells/linux.svg")} alt="" className={cls} />
      )
    case "zsh":
      return <TerminalIcon className={cn(cls, "text-emerald-500")} />
    case "bash":
      return (
        <img
          src={assetUrl("icons/shells/gnubash.svg")}
          alt=""
          className={cls}
        />
      )
    default:
      return <TerminalIcon className={cls} />
  }
}

let defaultShell: ShellType = "cmd"

function createTab(
  cwd: string,
  shell?: ShellType,
  initialCommand?: string | null
): TerminalTab {
  const s = shell || defaultShell
  const shellNames: Record<string, string> = {
    cmd: "CMD",
    powershell: "powershell",
    gitbash: "bash",
    wsl: "WSL",
    bash: "bash",
    zsh: "zsh",
  }
  return {
    id: crypto.randomUUID(),
    label: shellNames[s] || s,
    cwd,
    shell: s,
    lines: initialCommand
      ? [
          {
            id: crypto.randomUUID(),
            type: "system",
            text: "Prepared command. Press Enter to run.",
            timestamp: Date.now(),
          },
        ]
      : [],
    history: [],
    historyIndex: -1,
  }
}

// Per-instance registry: multiple TerminalPanel instances (one per pane/tab)
// each contribute to window.__BETTERC0DE_TERMINALS__ without overwriting the
// others. Without this, one terminal's unmount wiped the whole shared list.
type RegisteredTerminals = NonNullable<Window["__BETTERC0DE_TERMINALS__"]>
const terminalRegistry = new Map<string, RegisteredTerminals>()
let terminalPanelSeq = 0
function syncGlobalTerminals() {
  const all: RegisteredTerminals = []
  for (const list of terminalRegistry.values()) all.push(...list)
  window.__BETTERC0DE_TERMINALS__ = all
}

export function TerminalPanel({
  open,
  onClose,
  cwd,
  mode: _mode = "agent",
  threadId,
}: TerminalPanelProps) {
  const resolvedCwd = cwd || "~"
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [
    createTab(resolvedCwd),
  ])
  const [activeTabId, setActiveTabId] = useState(tabs[0].id)
  const [sidebarOpen, _setSidebarOpen] = useState(true)
  const terminalTitleEnabled = useAppearanceStore(
    (state) => state.terminalTitleEnabled
  )
  const terminalTabLabel = useCallback(
    (tab: TerminalTab) => (terminalTitleEnabled ? tab.label : "Terminal"),
    [terminalTitleEnabled]
  )

  const instanceIdRef = useRef<string>("")
  if (!instanceIdRef.current) {
    terminalPanelSeq += 1
    instanceIdRef.current = `terminal-panel-${terminalPanelSeq}`
  }

  useEffect(() => {
    terminalRegistry.set(
      instanceIdRef.current,
      tabs.map((t) => ({
        id: t.id,
        label: terminalTabLabel(t),
        shell: t.shell,
        output: t.lines
          .filter((l) => l.type !== "system")
          .map((l) => l.text)
          .join("\n"),
        lineCount: t.lines.length,
      }))
    )
    syncGlobalTerminals()
    const id = instanceIdRef.current
    return () => {
      terminalRegistry.delete(id)
      syncGlobalTerminals()
    }
  }, [tabs, terminalTabLabel])

  const [input, setInput] = useState("")
  const [isRunning, setIsRunning] = useState(false)
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([
    { id: "cmd", name: "Command Prompt", default: true },
  ])
  const [expanded, setExpanded] = useState(false)
  const [, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void (async () => {
      try {
        const shells = await detectShells()
        if (Array.isArray(shells) && shells.length > 0) {
          // Narrow the API's `id: string` to the local ShellType union via a
          // runtime cast — the backend's detected shell list is open-ended
          // but in practice always one of the known kinds.
          setAvailableShells(shells as unknown as ShellInfo[])
          const def = (shells as unknown as ShellInfo[]).find((s) => s.default)
          if (def) defaultShell = def.id
        }
      } catch {
        log.warn("Failed to load available shells")
      }
    })()
  }, [])

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId]
  )

  // Each session keeps its cwd (including `cd`); project changes only seed new sessions.

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100)
  }, [open, activeTabId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      })
    }
  }, [activeTab?.lines])

  const addLine = useCallback(
    (tabId: string, type: TerminalLine["type"], text: string) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                lines: [
                  ...t.lines,
                  {
                    id: crypto.randomUUID(),
                    type,
                    text,
                    timestamp: Date.now(),
                  },
                ],
              }
            : t
        )
      )
    },
    []
  )

  const runCommand = useCallback(
    async (cmd: string) => {
      if (!cmd.trim() || isRunning) return
      const tabId = activeTabId
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                history: [cmd, ...t.history.filter((h) => h !== cmd)].slice(
                  0,
                  50
                ),
                historyIndex: -1,
              }
            : t
        )
      )
      addLine(tabId, "input", cmd)
      setInput("")
      setIsRunning(true)

      if (cmd.trim() === "clear" || cmd.trim() === "cls") {
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, lines: [] } : t))
        )
        setIsRunning(false)
        return
      }
      if (cmd.trim().startsWith("cd ")) {
        const newDir = cmd.trim().slice(3).trim()
        const resolved =
          newDir.startsWith("/") || newDir.startsWith("C:")
            ? newDir
            : `${activeTab.cwd}/${newDir}`
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, cwd: resolved } : t))
        )
        addLine(tabId, "system", `\u2192 ${resolved}`)
        setIsRunning(false)
        return
      }

      try {
        // Human-origin: user typed this command in the terminal UI.
        // `humanOrigin:true` + `permissionLevel:"bypass"` lets the backend
        // permission gate skip the LLM-approval flow for direct user input.
        const out = await runShellCommandDetailed(
          cmd,
          activeTab.cwd || ".",
          activeTab.shell,
          undefined,
          { humanOrigin: true, permissionLevel: "bypass" }
        )
        // The detailed response includes structured fields; show `combined`
        // (interleaved stdout+stderr) since that's what the legacy direct-
        // fetch path was rendering after JSON.stringify-ing the response.
        const result =
          typeof out.combined === "string" && out.combined.length > 0
            ? out.combined
            : ""
        if (result.trim()) {
          // Detect errors in output
          const lowerResult = result.toLowerCase()
          const isError =
            lowerResult.includes("error") ||
            lowerResult.includes("not found") ||
            lowerResult.includes("not recognized") ||
            lowerResult.includes("cannot find") ||
            lowerResult.includes("failed") ||
            lowerResult.includes("denied") ||
            lowerResult.includes("exception") ||
            lowerResult.includes("fatal") ||
            (lowerResult.startsWith("'") && lowerResult.includes("' is not"))
          addLine(tabId, isError ? "error" : "output", result)
        }
      } catch (err) {
        addLine(tabId, "error", String(err))
      } finally {
        setIsRunning(false)
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    },
    [activeTabId, activeTab, isRunning, addLine]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        runCommand(input)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        const tab = tabs.find((t) => t.id === activeTabId)
        if (tab && tab.history.length > 0) {
          const newIndex = Math.min(
            tab.historyIndex + 1,
            tab.history.length - 1
          )
          setTabs((prev) =>
            prev.map((t) =>
              t.id === activeTabId ? { ...t, historyIndex: newIndex } : t
            )
          )
          setInput(tab.history[newIndex] ?? "")
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        const tab = tabs.find((t) => t.id === activeTabId)
        if (tab) {
          const newIndex = tab.historyIndex - 1
          if (newIndex < 0) {
            setTabs((prev) =>
              prev.map((t) =>
                t.id === activeTabId ? { ...t, historyIndex: -1 } : t
              )
            )
            setInput("")
          } else {
            setTabs((prev) =>
              prev.map((t) =>
                t.id === activeTabId ? { ...t, historyIndex: newIndex } : t
              )
            )
            setInput(tab.history[newIndex] ?? "")
          }
        }
      } else if (e.key === "l" && e.ctrlKey) {
        e.preventDefault()
        setTabs((prev) =>
          prev.map((t) => (t.id === activeTabId ? { ...t, lines: [] } : t))
        )
      }
    },
    [input, tabs, activeTabId, runCommand]
  )

  const addTab = useCallback(
    (
      shell?: ShellType,
      tabCwd = resolvedCwd,
      initialCommand?: string | null
    ) => {
      const newTab = createTab(tabCwd, shell, initialCommand)
      setTabs((prev) => [...prev, newTab])
      setActiveTabId(newTab.id)
      if (initialCommand) setInput(initialCommand)
    },
    [resolvedCwd]
  )

  useEffect(() => {
    const onNewSession = (event: Event) => {
      const detail = (event as CustomEvent<TerminalNewSessionEventDetail>)
        .detail
      if (
        !terminalSessionTargetsPanel(detail ?? {}, {
          id: instanceIdRef.current,
          mode: _mode,
          threadId,
        })
      )
        return
      const shell = detail?.shell as ShellType | undefined
      addTab(shell, detail?.cwd || resolvedCwd, detail?.initialCommand)
    }
    window.addEventListener(TERMINAL_NEW_SESSION_EVENT, onNewSession)
    return () => {
      window.removeEventListener(TERMINAL_NEW_SESSION_EVENT, onNewSession)
    }
  }, [_mode, addTab, resolvedCwd, threadId])

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const filtered = prev.filter((t) => t.id !== tabId)
        if (filtered.length === 0) {
          // Schedule onClose outside of setState to avoid "Cannot update while rendering" error
          setTimeout(() => onClose(), 0)
          return prev
        }
        if (activeTabId === tabId) {
          setTimeout(() => setActiveTabId(filtered[filtered.length - 1].id), 0)
        }
        return filtered
      })
    },
    [activeTabId, onClose]
  )

  useEffect(() => {
    const onCloseActiveSession = (event: Event) => {
      const detail = (
        event as CustomEvent<TerminalCloseActiveSessionEventDetail>
      ).detail
      if (detail?.targetPanelId !== instanceIdRef.current) return
      closeTab(activeTabId)
    }
    window.addEventListener(
      TERMINAL_CLOSE_ACTIVE_SESSION_EVENT,
      onCloseActiveSession
    )
    return () => {
      window.removeEventListener(
        TERMINAL_CLOSE_ACTIVE_SESSION_EVENT,
        onCloseActiveSession
      )
    }
  }, [activeTabId, closeTab])

  const _copyOutput = useCallback(async () => {
    const text = activeTab.lines
      .filter((l) => l.type === "output" || l.type === "error")
      .map((l) => l.text)
      .join("\n")
    if (!(await copyText(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [activeTab])

  if (!open) return null

  return (
    <div
      data-terminal-panel-id={instanceIdRef.current}
      data-terminal-thread={threadId}
      className={cn(
        "betterc0de-terminal flex h-full flex-col bg-card transition-all duration-200"
      )}
    >
      {/* Top bar: shell tabs + actions */}
      <div className="flex h-[30px] items-center border-b border-border bg-sidebar">
        {/* Shell tabs */}
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTabId(tab.id)}
              className={cn(
                "flex h-[30px] items-center gap-1.5 border-r border-border px-2.5 text-[11px] transition-colors",
                tab.id === activeTabId
                  ? "bg-card text-foreground"
                  : "text-muted-foreground hover:text-foreground/80"
              )}
            >
              <ShellIcon shell={tab.shell} />
              <span>{terminalTabLabel(tab)}</span>
              {isRunning && tab.id === activeTabId && (
                <CircleDotIcon className="size-2 shrink-0 animate-pulse text-[#4ec9b0]" />
              )}
            </button>
          ))}
        </div>

        {/* Right actions */}
        <div className="flex h-full items-center gap-0 pr-1">
          {/* New tab */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-full items-center px-1.5 text-muted-foreground/70 transition-colors hover:text-foreground/80"
              >
                <PlusIcon className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              {availableShells.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  className="gap-2"
                  onClick={() => addTab(s.id)}
                >
                  <ShellIcon shell={s.id} />
                  <span className="flex-1 text-[11px]">{s.name}</span>
                  {s.default && (
                    <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                      default
                    </span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex h-full items-center px-1.5 text-muted-foreground/70 transition-colors hover:text-foreground/80"
          >
            {expanded ? (
              <MinimizeIcon className="size-3" />
            ) : (
              <MaximizeIcon className="size-3" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-full items-center px-1.5 text-muted-foreground/70 transition-colors hover:text-foreground/80"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      </div>

      {/* Main area: sidebar + terminal */}
      <div className="flex min-h-0 flex-1">
        {/* Session sidebar */}
        {sidebarOpen && (
          <div className="w-[160px] shrink-0 overflow-y-auto border-r border-border bg-sidebar">
            <div className="px-2.5 py-1.5 text-[10px] tracking-wider text-muted-foreground/70 uppercase">
              {tabs.length} Terminal
            </div>
            {tabs.map((tab) => (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={cn(
                  "group flex cursor-pointer items-center gap-1.5 px-2.5 py-1 text-[11px] transition-colors",
                  tab.id === activeTabId
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground/80"
                )}
              >
                <ShellIcon shell={tab.shell} />
                <span className="flex-1 truncate">{terminalTabLabel(tab)}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent"
                >
                  <XIcon className="size-2.5 text-muted-foreground/70" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Terminal output */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div
            ref={scrollRef}
            className="flex-1 overflow-x-hidden overflow-y-auto px-3 py-2 font-mono text-[12px] leading-[1.65]"
            onClick={() => inputRef.current?.focus()}
          >
            {activeTab.lines.map((line) => (
              <div
                key={line.id}
                className={cn(
                  "overflow-hidden break-all whitespace-pre-wrap",
                  line.type === "input" && "text-foreground",
                  line.type === "output" && "text-foreground/90",
                  line.type === "error" && "font-medium text-[#f44747]",
                  line.type === "system" && "text-[#569cd6] italic"
                )}
              >
                {line.type === "input" ? (
                  <span className="break-all">
                    <span className="text-[#4ec9b0]">&gt;</span>{" "}
                    <span className="text-[#dcdcaa]">{line.text}</span>
                  </span>
                ) : (
                  line.text
                )}
              </div>
            ))}
            {isRunning && (
              <div className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground/60">
                <span className="inline-flex gap-[2px]">
                  <span className="size-1 animate-bounce rounded-full bg-[#4ec9b0] [animation-delay:0ms]" />
                  <span className="size-1 animate-bounce rounded-full bg-[#4ec9b0] [animation-delay:150ms]" />
                  <span className="size-1 animate-bounce rounded-full bg-[#4ec9b0] [animation-delay:300ms]" />
                </span>
              </div>
            )}
            {/* Inline input prompt */}
            {!isRunning && (
              <div className="flex min-w-0 items-center">
                <span className="shrink-0 text-[#4ec9b0]">&gt;</span>
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  spellCheck={false}
                  autoComplete="off"
                  className="ml-1 min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[#dcdcaa] caret-[#4ec9b0] outline-none"
                  autoFocus
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
