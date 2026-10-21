import { useId, useLayoutEffect, useRef } from "react"
import {
  CircleAlertIcon,
  PlayIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { ShellIcon } from "@/components/terminal/shell-icon"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { shellDisplayName, terminalDisplayName } from "@/lib/terminal-protocol"
import {
  attachTerminalView,
  claimTerminalView,
  dismissTerminalInputError,
  fitTerminal,
  restartTerminal,
  setActiveTerminal,
  startTerminal,
  useTerminalStore,
  type TerminalInfo,
} from "@/lib/terminal-sessions"
import { cn } from "@/lib/utils"

/**
 * One terminal on screen. Its xterm element belongs to the session
 * registry and is moved into this view while the view shows it; states the
 * terminal cannot draw itself (starting, waiting for a click, failed, ended,
 * shown in another panel) sit over or under it.
 */
export function TerminalPaneView({
  scopeKey,
  terminalId,
  active,
  showHeader,
  titlesEnabled,
  onRequestClose,
}: {
  scopeKey: string
  terminalId: string
  /** The pane with the keyboard in its tab. */
  active: boolean
  /** Split panes name themselves; a lone pane has the tab for that. */
  showHeader: boolean
  titlesEnabled: boolean
  /** Close with the panel's confirmation when something still runs. */
  onRequestClose: (terminalId: string) => void
}) {
  const viewId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const info = useTerminalStore((state) => state.terminals[terminalId])

  // Before paint, so the view never flashes the "shown elsewhere" note.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const detach = attachTerminalView(terminalId, viewId, container)
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => fitTerminal(terminalId))
    })
    observer.observe(container)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      detach()
    }
  }, [terminalId, viewId])

  if (!info) return null
  const label = terminalDisplayName(info, titlesEnabled)
  const shown = !info.ownerViewId || info.ownerViewId === viewId
  const markActive = () => setActiveTerminal(scopeKey, terminalId)

  return (
    <div
      role="group"
      aria-label={`Terminal: ${label}`}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onMouseDownCapture={markActive}
      onFocusCapture={markActive}
    >
      {showHeader ? (
        <div
          className={cn(
            "flex h-6 shrink-0 items-center gap-1.5 border-b border-border/40 px-2 font-sans text-[11px]",
            active ? "text-foreground" : "text-muted-foreground"
          )}
        >
          <ShellIcon shell={info.shellKind ?? info.shell} className="size-3" />
          <span className="min-w-0 truncate">{label}</span>
          <button
            type="button"
            aria-label={`Close ${label}`}
            title="Close terminal"
            onClick={() => onRequestClose(terminalId)}
            className="ml-auto grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className={cn(
            "absolute inset-0 py-1 pr-1 pl-2",
            !shown && "invisible"
          )}
        />
        {shown ? (
          <TerminalOverlay info={info} />
        ) : (
          <CenteredNote>
            <p className="text-xs text-muted-foreground">
              This terminal is shown in another panel.
            </p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => claimTerminalView(terminalId, viewId)}
            >
              Show here
            </Button>
          </CenteredNote>
        )}
      </div>
      {shown ? (
        <TerminalFooter info={info} onRequestClose={onRequestClose} />
      ) : null}
    </div>
  )
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center font-sans">
      {children}
    </div>
  )
}

/** What covers the screen while there is no shell to show. */
function TerminalOverlay({ info }: { info: TerminalInfo }) {
  const shell = shellDisplayName(info.shellKind ?? info.shell)
  if (info.status === "starting") {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 font-sans text-xs text-muted-foreground">
        <Spinner
          className="size-3.5 motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span role="status">
          {info.reattach === false && info.ptySessionId
            ? "Reconnecting…"
            : `Starting ${shell === "Terminal" ? "the shell" : shell}…`}
        </span>
      </div>
    )
  }
  if (info.status === "idle" && info.needsGesture) {
    return (
      <CenteredNote>
        <p className="text-xs text-muted-foreground">
          The terminal starts when you ask for it.
        </p>
        <Button size="xs" onClick={() => void startTerminal(info.id)}>
          <PlayIcon data-icon="inline-start" />
          Start terminal
        </Button>
      </CenteredNote>
    )
  }
  if (info.status === "failed") {
    return (
      <CenteredNote>
        <p
          role="alert"
          className="flex items-center gap-1.5 text-xs font-medium text-destructive"
        >
          <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
          Couldn't start the terminal
        </p>
        {info.error ? (
          <p className="max-w-[48ch] text-[11px] break-words text-muted-foreground">
            {info.error}
          </p>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          onClick={() => restartTerminal(info.id)}
        >
          <RotateCwIcon data-icon="inline-start" />
          Try again
        </Button>
      </CenteredNote>
    )
  }
  return null
}

/** Under the screen: how the process ended, or input that did not arrive. */
function TerminalFooter({
  info,
  onRequestClose,
}: {
  info: TerminalInfo
  onRequestClose: (terminalId: string) => void
}) {
  if (info.status === "exited" || info.status === "ended") {
    const text =
      info.status === "ended"
        ? "This terminal session has ended."
        : info.exitCode === null || info.exitCode === undefined
          ? "The process exited."
          : `The process exited with code ${info.exitCode}.`
    return (
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border/40 px-2 font-sans text-[11px] text-muted-foreground">
        <span role="status" className="min-w-0 flex-1 truncate">
          {text}
        </span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => restartTerminal(info.id)}
        >
          <RotateCwIcon data-icon="inline-start" />
          Restart
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => onRequestClose(info.id)}
        >
          Close
        </Button>
      </div>
    )
  }
  if (info.status === "running" && info.inputError) {
    return (
      <div
        role="alert"
        className="flex h-8 shrink-0 items-center gap-2 border-t border-border/40 px-2 font-sans text-[11px] text-warning"
      >
        <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate" title={info.inputError}>
          Input didn't reach the terminal: {info.inputError}
        </span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => dismissTerminalInputError(info.id)}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <XIcon className="size-3" />
        </button>
      </div>
    )
  }
  return null
}
