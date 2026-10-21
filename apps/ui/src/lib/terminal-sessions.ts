import type { ITheme } from "@xterm/xterm"
import { z } from "zod"
import { create } from "zustand"
import { terminalFontStack, useAppearanceStore } from "@/lib/appearance-store"
import { copyText, readClipboardText } from "@/lib/clipboard"
import { getCustomTheme } from "@/lib/custom-theme-cache"
import { createLogger } from "@/lib/logger"
import { openSourceTarget } from "@/lib/source-opener"
import { TerminalInputQueue } from "@/lib/terminal-input-queue"
import {
  EMPTY_TERMINAL_GROUP,
  MAX_TERMINAL_PANES_PER_TAB,
  activateTerminalTab,
  addTerminalTab,
  findTerminalTab,
  focusTerminalPane,
  isTerminalId,
  layoutTerminalIds,
  parseTerminalGroup,
  removeTerminalPane,
  removeTerminalTab,
  renameTerminalTab,
  resizeTerminalSplit,
  splitTerminalPane,
  type TerminalGroup,
  type TerminalSplitDirection,
} from "@/lib/terminal-layout"
import {
  cleanTerminalTitle,
  isGestureRequiredError,
  isRetryableTerminalError,
  isTerminalGoneError,
  isTerminalUnreadableError,
  isWindowsShell,
  looksLikeShellPrompt,
  readTerminalSnapshot,
  terminalErrorMessage,
  terminalPollDelay,
} from "@/lib/terminal-protocol"
import {
  importedTerminalColors,
  resolveTerminalTheme,
} from "@/lib/terminal-theme"
import type {
  XtermCallbacks,
  XtermHandle,
  XtermOptions,
} from "@/lib/terminal-xterm"
import { customThemeIdOf } from "@/lib/vscode-theme"
import {
  detectShells,
  terminalClose,
  terminalOpen,
  terminalRead,
  terminalResize,
  terminalWrite,
  type ShellInfo,
} from "@/services/backend/workspaceApi"
import { getElectronApi } from "@/services/ipc-facade"

/**
 * The desktop terminal's sessions. Each terminal is a PTY on the backend
 * (`/shell/pty/*`) shown by xterm.js. Tabs, splits and what each terminal
 * is doing live in `useTerminalStore` for the panel to render; the PTY
 * polling, the input queue and the xterm instance live here, outside React,
 * so a terminal keeps running while its panel is hidden, its tab is in the
 * background or its pane shows a chat. Closing a terminal ends its PTY; the
 * window unloading ends them all.
 *
 * Desktop terminals are read by polling: the WebSocket terminal channel is
 * for paired devices (`ws/terminalChannel.ts`), and every write carries a
 * capability only the desktop's main process (or a paired session with the
 * terminal grant) can mint.
 */

const log = createLogger("terminal")

export type TerminalStatus =
  | "idle"
  | "starting"
  | "running"
  | "exited"
  | "ended"
  | "failed"

export interface TerminalInfo {
  readonly id: string
  /** The chat (or folder) whose panel shows the terminal. */
  readonly scopeKey: string
  readonly cwd: string
  /** The shell asked for; none starts the project's or the system's default. */
  readonly shell?: string
  /** The shell the backend started (`cmd`, `powershell`, `bash`, …). */
  readonly shellKind?: string
  /** What the running program last named the window (OSC 0/2). */
  readonly processTitle?: string
  readonly status: TerminalStatus
  readonly exitCode?: number | null
  /** Why it could not start. */
  readonly error?: string
  /** Typed input the backend refused; cleared by the next write that lands. */
  readonly inputError?: string
  /** Opening was refused for want of a recent click or key press. */
  readonly needsGesture?: boolean
  /** The backend's PTY while there may be one. */
  readonly ptySessionId?: string
  /** Restored after a reload: read the PTY again instead of starting one. */
  readonly reattach?: boolean
  /** The view showing the terminal; another view of it offers to take it. */
  readonly ownerViewId?: string
}

interface TerminalStoreState {
  readonly groups: Readonly<Record<string, TerminalGroup>>
  readonly terminals: Readonly<Record<string, TerminalInfo>>
}

/** One group of tabs per chat; a folder without a chat gets its own. */
export function terminalScopeKey(
  threadId: string | null | undefined,
  cwd: string | null | undefined
): string {
  return threadId ? `thread:${threadId}` : `folder:${cwd ?? ""}`
}

// ── Saved across a reload of this window ─────────────────────────────────

const STORAGE_KEY = "betterc0de-terminal-sessions"
const MAX_SAVED_TERMINALS = 64
const MAX_SAVED_GROUPS = 32

const savedTerminalSchema = z.object({
  scopeKey: z.string().min(1).max(4_096),
  cwd: z.string().max(32 * 1024),
  shell: z.string().max(1_024).optional(),
  shellKind: z.string().max(256).optional(),
  ptySessionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/)
    .optional(),
  ended: z.boolean().optional(),
})

const savedStateSchema = z.object({
  version: z.literal(1),
  groups: z.record(z.string().max(4_096), z.unknown()),
  terminals: z.record(z.string(), z.unknown()),
})

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage
  } catch {
    return null
  }
}

/**
 * The layout this window had before a reload. A terminal that was running
 * is read again (`reattach`); one that had ended shows as ended.
 */
function readSavedState(): TerminalStoreState {
  const empty: TerminalStoreState = { groups: {}, terminals: {} }
  let raw: unknown
  try {
    const text = sessionStore()?.getItem(STORAGE_KEY)
    if (!text) return empty
    raw = JSON.parse(text)
  } catch {
    return empty
  }
  const parsed = savedStateSchema.safeParse(raw)
  if (!parsed.success) return empty
  const terminals: Record<string, TerminalInfo> = {}
  for (const [id, value] of Object.entries(parsed.data.terminals).slice(
    0,
    MAX_SAVED_TERMINALS
  )) {
    const saved = savedTerminalSchema.safeParse(value)
    if (!isTerminalId(id) || !saved.success) continue
    const { scopeKey, cwd, shell, shellKind, ptySessionId, ended } = saved.data
    terminals[id] = {
      id,
      scopeKey,
      cwd,
      ...(shell ? { shell } : {}),
      ...(shellKind ? { shellKind } : {}),
      ...(ended
        ? { status: "ended" as const }
        : ptySessionId
          ? { status: "idle" as const, ptySessionId, reattach: true }
          : { status: "idle" as const }),
    }
  }
  const groups: Record<string, TerminalGroup> = {}
  const used = new Set<string>()
  for (const [scopeKey, value] of Object.entries(parsed.data.groups).slice(
    0,
    MAX_SAVED_GROUPS
  )) {
    const group = parseTerminalGroup(
      value,
      (id) => terminals[id]?.scopeKey === scopeKey && !used.has(id)
    )
    if (!group) continue
    groups[scopeKey] = group
    for (const tab of group.tabs) {
      for (const id of layoutTerminalIds(tab.layout)) used.add(id)
    }
  }
  for (const id of Object.keys(terminals)) {
    if (!used.has(id)) delete terminals[id]
  }
  return { groups, terminals }
}

function savedState(state: TerminalStoreState): unknown {
  const terminals: Record<string, unknown> = {}
  for (const info of Object.values(state.terminals).slice(
    0,
    MAX_SAVED_TERMINALS
  )) {
    const ended =
      info.status === "exited" ||
      info.status === "ended" ||
      info.status === "failed"
    terminals[info.id] = {
      scopeKey: info.scopeKey,
      cwd: info.cwd,
      ...(info.shell ? { shell: info.shell } : {}),
      ...(info.shellKind ? { shellKind: info.shellKind } : {}),
      ...(!ended && info.ptySessionId
        ? { ptySessionId: info.ptySessionId }
        : {}),
      ...(ended ? { ended: true } : {}),
    }
  }
  return { version: 1, groups: state.groups, terminals }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function saveNow(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  try {
    sessionStore()?.setItem(
      STORAGE_KEY,
      JSON.stringify(savedState(useTerminalStore.getState()))
    )
  } catch {
    // Storage full or blocked: the layout just doesn't survive a reload.
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(saveNow, 300)
}

export const useTerminalStore = create<TerminalStoreState>(() =>
  readSavedState()
)

function terminalInfo(id: string): TerminalInfo | undefined {
  return useTerminalStore.getState().terminals[id]
}

function patchTerminal(id: string, patch: Partial<TerminalInfo>): void {
  useTerminalStore.setState((state) => {
    const current = state.terminals[id]
    if (!current) return state
    const changed = (Object.keys(patch) as Array<keyof TerminalInfo>).some(
      (key) => current[key] !== patch[key]
    )
    if (!changed) return state
    return { terminals: { ...state.terminals, [id]: { ...current, ...patch } } }
  })
}

function updateGroup(
  scopeKey: string,
  update: (group: TerminalGroup) => TerminalGroup
): void {
  useTerminalStore.setState((state) => {
    const group = state.groups[scopeKey] ?? EMPTY_TERMINAL_GROUP
    const next = update(group)
    if (next === group) return state
    const groups = { ...state.groups }
    if (next.tabs.length === 0) delete groups[scopeKey]
    else groups[scopeKey] = next
    return { groups }
  })
}

// ── Runtime: PTY, polling, input and xterm, outside React ────────────────

interface TerminalRuntime {
  readonly id: string
  /** xterm's element; moved into whichever view shows the terminal. */
  readonly host: HTMLDivElement
  xterm: XtermHandle | null
  xtermLoading: Promise<XtermHandle | null> | null
  queue: TerminalInputQueue | null
  /** Typed while the shell was starting, sent once it runs. */
  typedWhileStarting: string
  cursor: number
  pollTimer: ReturnType<typeof setTimeout> | null
  polling: boolean
  pollAgain: boolean
  idleReads: number
  failures: number
  resizeTimer: ReturnType<typeof setTimeout> | null
  sentSize: { cols: number; rows: number } | null
  /** Views showing the terminal, most recent last; the last one has it. */
  viewers: string[]
  readonly containers: Map<string, HTMLElement>
  readonly disposables: Array<{ dispose(): void }>
  /** Bumped by every start, so a late answer to an older one is ignored. */
  startToken: number
  disposed: boolean
}

const runtimes = new Map<string, TerminalRuntime>()
/** A prepared command to type once the terminal runs. */
const pendingInputs = new Map<string, string>()
/** Terminals to focus as soon as they show. */
const focusRequests = new Set<string>()

const MAX_TYPED_WHILE_STARTING = 64 * 1024

function ensureRuntime(id: string): TerminalRuntime {
  let runtime = runtimes.get(id)
  if (!runtime) {
    const host = document.createElement("div")
    host.className = "h-full w-full"
    runtime = {
      id,
      host,
      xterm: null,
      xtermLoading: null,
      queue: null,
      typedWhileStarting: "",
      cursor: 0,
      pollTimer: null,
      polling: false,
      pollAgain: false,
      idleReads: 0,
      failures: 0,
      resizeTimer: null,
      sentSize: null,
      viewers: [],
      containers: new Map(),
      disposables: [],
      startToken: 0,
      disposed: false,
    }
    runtimes.set(id, runtime)
  }
  return runtime
}

function disposeRuntime(runtime: TerminalRuntime): void {
  runtime.disposed = true
  runtime.startToken += 1
  stopPolling(runtime)
  if (runtime.resizeTimer) clearTimeout(runtime.resizeTimer)
  runtime.queue?.dispose()
  runtime.queue = null
  for (const disposable of runtime.disposables.splice(0)) disposable.dispose()
  runtime.xterm?.dispose()
  runtime.xterm = null
  runtime.host.remove()
  runtimes.delete(runtime.id)
}

// ── xterm ────────────────────────────────────────────────────────────────

type XtermModule = typeof import("@/lib/terminal-xterm")
let xtermModule: Promise<XtermModule> | null = null

function loadXterm(): Promise<XtermModule> {
  if (!xtermModule) {
    xtermModule = import("@/lib/terminal-xterm").catch((error: unknown) => {
      xtermModule = null
      throw error
    })
  }
  return xtermModule
}

function clientPlatform(): XtermOptions["platform"] {
  const platform =
    getElectronApi()?.platform ??
    (typeof navigator === "undefined" ? "" : navigator.platform)
  if (/^darwin$|^mac/i.test(platform)) return "mac"
  if (/^win/i.test(platform)) return "windows"
  return "other"
}

function currentFontFamily(): string {
  return terminalFontStack(useAppearanceStore.getState().terminalFontFamily)
}

function cursorShouldBlink(): boolean {
  const reducedMotion =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  return useAppearanceStore.getState().animationsEnabled && !reducedMotion
}

function currentTheme(): ITheme {
  const template = useAppearanceStore.getState().template
  const custom = getCustomTheme(customThemeIdOf(template))
  const colors = (
    custom?.shiki as { colors?: Readonly<Record<string, unknown>> } | undefined
  )?.colors
  return resolveTerminalTheme(
    document.documentElement,
    importedTerminalColors(colors)
  )
}

function xtermCallbacks(runtime: TerminalRuntime): XtermCallbacks {
  return {
    copy: (text) => {
      if (text) void copyText(text)
    },
    requestPaste: () => {
      void readClipboardText().then((text) => {
        if (text && !runtime.disposed) runtime.xterm?.terminal.paste(text)
      })
    },
    openUrl: (url) => {
      void openSourceTarget({ kind: "external", url })
    },
  }
}

/**
 * The terminal's xterm, made once its host is on screen (xterm measures its
 * font when it opens); null while it is not.
 */
function ensureXterm(runtime: TerminalRuntime): Promise<XtermHandle | null> {
  if (runtime.xterm) return Promise.resolve(runtime.xterm)
  if (runtime.xtermLoading) return runtime.xtermLoading
  const loading = loadXterm().then(
    (module) => {
      runtime.xtermLoading = null
      if (runtime.disposed) return null
      if (runtime.xterm) return runtime.xterm
      if (!runtime.host.isConnected || runtime.host.clientWidth === 0) {
        return null
      }
      const handle = module.createXterm(
        runtime.host,
        {
          fontFamily: currentFontFamily(),
          theme: currentTheme(),
          cursorBlink: cursorShouldBlink(),
          platform: clientPlatform(),
        },
        xtermCallbacks(runtime)
      )
      runtime.xterm = handle
      const terminal = handle.terminal
      runtime.disposables.push(
        terminal.onData((data) => sendInput(runtime, data)),
        terminal.onBinary((data) => sendInput(runtime, data)),
        terminal.onResize(() => scheduleResize(runtime)),
        terminal.onTitleChange((title) =>
          patchTerminal(runtime.id, {
            processTitle: cleanTerminalTitle(title) || undefined,
          })
        )
      )
      watchAppearance()
      return handle
    },
    (error: unknown) => {
      runtime.xtermLoading = null
      log.error("The terminal could not be loaded", error)
      patchTerminal(runtime.id, {
        status: "failed",
        error: "The terminal could not be loaded. Reload the window.",
      })
      return null
    }
  )
  runtime.xtermLoading = loading
  return loading
}

let appearanceWatched = false
let appliedThemeKey = ""

/** Theme, font and cursor follow the appearance settings and the OS. */
function watchAppearance(): void {
  if (appearanceWatched || typeof document === "undefined") return
  appearanceWatched = true
  appliedThemeKey = JSON.stringify(currentTheme())
  let frame = 0
  const refresh = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      applyAppearance()
    })
  }
  // Templates, imported themes and tints change through the appearance
  // store; System mode also flips the light/dark class on <html>. Its style
  // attribute is left alone: layout variables change there on every frame
  // of a sidebar drag.
  new MutationObserver(refresh).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-custom-theme"],
  })
  useAppearanceStore.subscribe(refresh)
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener(
      "change",
      refresh
    )
  }
}

function applyAppearance(): void {
  const theme = currentTheme()
  const themeKey = JSON.stringify(theme)
  const fontFamily = currentFontFamily()
  const cursorBlink = cursorShouldBlink()
  for (const runtime of runtimes.values()) {
    const terminal = runtime.xterm?.terminal
    if (!terminal) continue
    if (themeKey !== appliedThemeKey) terminal.options.theme = theme
    if (terminal.options.fontFamily !== fontFamily) {
      terminal.options.fontFamily = fontFamily
      runtime.xterm?.fit()
    }
    if (terminal.options.cursorBlink !== cursorBlink) {
      terminal.options.cursorBlink = cursorBlink
    }
  }
  appliedThemeKey = themeKey
}

// ── Views ────────────────────────────────────────────────────────────────

/**
 * Shows the terminal in `container` (a pane of a terminal panel). The most
 * recent view of a terminal shows it; an earlier one, still mounted, shows
 * a placeholder until it claims the terminal back. Returns the detach.
 */
export function attachTerminalView(
  terminalId: string,
  viewId: string,
  container: HTMLElement
): () => void {
  if (!terminalInfo(terminalId)) return () => undefined
  const runtime = ensureRuntime(terminalId)
  runtime.viewers = [...runtime.viewers.filter((id) => id !== viewId), viewId]
  runtime.containers.set(viewId, container)
  placeHost(runtime)
  return () => {
    runtime.viewers = runtime.viewers.filter((id) => id !== viewId)
    runtime.containers.delete(viewId)
    if (!runtime.disposed) placeHost(runtime)
  }
}

/** "Show here": the view takes the terminal from another one. */
export function claimTerminalView(terminalId: string, viewId: string): void {
  const runtime = runtimes.get(terminalId)
  if (!runtime || !runtime.containers.has(viewId)) return
  runtime.viewers = [...runtime.viewers.filter((id) => id !== viewId), viewId]
  placeHost(runtime)
  focusTerminalInput(terminalId)
}

function placeHost(runtime: TerminalRuntime): void {
  const owner = runtime.viewers.at(-1)
  const container = owner ? runtime.containers.get(owner) : undefined
  patchTerminal(runtime.id, { ownerViewId: owner })
  if (!container) {
    runtime.host.remove()
    return
  }
  if (runtime.host.parentElement !== container) {
    container.appendChild(runtime.host)
  }
  activate(runtime)
}

/** Once on screen: make xterm, fit, redraw, focus if asked, and start. */
function activate(runtime: TerminalRuntime): void {
  void ensureXterm(runtime).then((handle) => {
    if (!handle || runtime.disposed || !runtime.host.isConnected) return
    handle.fit()
    handle.terminal.refresh(0, handle.terminal.rows - 1)
    if (focusRequests.delete(runtime.id)) handle.terminal.focus()
    const info = terminalInfo(runtime.id)
    if (!info || info.status !== "idle" || info.needsGesture) return
    if (info.reattach && info.ptySessionId) {
      void reattachTerminal(runtime, info.ptySessionId)
    } else {
      void startTerminal(runtime.id)
    }
  })
}

/** The view's size changed: fit the terminal (and make it, if it is new). */
export function fitTerminal(terminalId: string): void {
  const runtime = runtimes.get(terminalId)
  if (!runtime || runtime.disposed || !runtime.host.isConnected) return
  if (runtime.xterm) runtime.xterm.fit()
  else activate(runtime)
}

export function focusTerminalInput(terminalId: string): void {
  const runtime = runtimes.get(terminalId)
  const terminal = runtime?.xterm?.terminal
  if (terminal && runtime?.host.isConnected) terminal.focus()
  else focusRequests.add(terminalId)
}

/**
 * Whether closing the terminal would end something: a full-screen program,
 * or a line that does not end like a shell prompt (a dev server's output,
 * say). A terminal that never showed has nothing running yet.
 */
export function isTerminalBusy(terminalId: string): boolean {
  const info = terminalInfo(terminalId)
  if (info?.status !== "running") return false
  const terminal = runtimes.get(terminalId)?.xterm?.terminal
  if (!terminal) return false
  const buffer = terminal.buffer.active
  if (buffer.type === "alternate") return true
  const line = buffer.getLine(buffer.baseY + buffer.cursorY)
  return !looksLikeShellPrompt(
    line?.translateToString(true, 0, buffer.cursorX) ?? ""
  )
}

// ── Starting, reading and ending ─────────────────────────────────────────

function ptySize(cols: number, rows: number): { cols: number; rows: number } {
  const clamp = (value: number) =>
    Math.min(500, Math.max(2, Math.round(value) || 2))
  return { cols: clamp(cols), rows: clamp(rows) }
}

function isStale(runtime: TerminalRuntime, token: number): boolean {
  return runtime.disposed || runtime.startToken !== token
}

/** Starts a shell for a terminal that has none (new, or Start after a refusal). */
export async function startTerminal(terminalId: string): Promise<void> {
  const info = terminalInfo(terminalId)
  const runtime = runtimes.get(terminalId)
  if (!info || !runtime || runtime.disposed) return
  if (info.status === "starting" || info.status === "running") return
  const token = ++runtime.startToken
  stopPolling(runtime)
  runtime.queue?.dispose()
  runtime.queue = null
  patchTerminal(terminalId, {
    status: "starting",
    error: undefined,
    inputError: undefined,
    needsGesture: false,
    exitCode: undefined,
    reattach: false,
    ptySessionId: undefined,
    processTitle: undefined,
  })
  const handle = await ensureXterm(runtime)
  if (isStale(runtime, token)) return
  if (!handle) {
    // Not on screen yet: it starts when a view shows it.
    if (terminalInfo(terminalId)?.status === "starting") {
      patchTerminal(terminalId, { status: "idle" })
    }
    return
  }
  handle.fit()
  const size = ptySize(handle.terminal.cols, handle.terminal.rows)
  try {
    const snapshot = await terminalOpen({
      cwd: info.cwd,
      ...(info.shell ? { shell: info.shell } : {}),
      cols: size.cols,
      rows: size.rows,
    })
    if (isStale(runtime, token)) {
      void terminalClose(snapshot.sessionId).catch(() => undefined)
      return
    }
    runtime.cursor = 0
    runtime.sentSize = size
    patchTerminal(terminalId, {
      status: "running",
      ptySessionId: snapshot.sessionId,
      shellKind: snapshot.shell,
    })
    begin(runtime, handle, snapshot.sessionId, snapshot)
  } catch (error) {
    if (isStale(runtime, token)) return
    if (isGestureRequiredError(error)) {
      patchTerminal(terminalId, { status: "idle", needsGesture: true })
    } else {
      patchTerminal(terminalId, {
        status: "failed",
        error: terminalErrorMessage(error),
      })
    }
  }
}

/** Reads a PTY this window had before it reloaded, from its first kept output. */
async function reattachTerminal(
  runtime: TerminalRuntime,
  sessionId: string
): Promise<void> {
  const token = ++runtime.startToken
  patchTerminal(runtime.id, { status: "starting", reattach: false })
  const handle = await ensureXterm(runtime)
  if (isStale(runtime, token)) return
  if (!handle) {
    patchTerminal(runtime.id, { status: "idle", reattach: true })
    return
  }
  try {
    const snapshot = await terminalRead(sessionId, 0)
    if (isStale(runtime, token)) return
    runtime.cursor = 0
    runtime.sentSize = null
    patchTerminal(runtime.id, {
      status: "running",
      shellKind: snapshot.shell,
    })
    begin(runtime, handle, sessionId, snapshot)
    scheduleResize(runtime)
  } catch {
    if (isStale(runtime, token)) return
    finish(runtime, "ended")
  }
}

/** The shell runs: show what it printed so far, wire input, and read on. */
function begin(
  runtime: TerminalRuntime,
  handle: XtermHandle,
  sessionId: string,
  snapshot: Parameters<typeof readTerminalSnapshot>[1]
): void {
  const shell = terminalInfo(runtime.id)?.shellKind
  // ConPTY redraws on resize itself; xterm must not reflow its lines too.
  if (isWindowsShell(shell)) {
    handle.terminal.options.windowsPty = { backend: "conpty" }
  }
  runtime.queue = createInputQueue(runtime, sessionId)
  if (!applySnapshot(runtime, snapshot)) return
  const prepared = pendingInputs.get(runtime.id) ?? ""
  pendingInputs.delete(runtime.id)
  const typed = prepared + runtime.typedWhileStarting
  runtime.typedWhileStarting = ""
  if (typed) runtime.queue.push(typed)
  runtime.idleReads = 0
  runtime.failures = 0
  schedulePoll(runtime, 0)
}

function createInputQueue(
  runtime: TerminalRuntime,
  sessionId: string
): TerminalInputQueue {
  return new TerminalInputQueue({
    send: (data) => terminalWrite(sessionId, data),
    onSent: () => {
      if (terminalInfo(runtime.id)?.inputError) {
        patchTerminal(runtime.id, { inputError: undefined })
      }
      kickPoll(runtime)
    },
    isRetryable: isRetryableTerminalError,
    onFailed: (error) => {
      if (runtime.disposed) return
      if (isTerminalGoneError(error)) {
        finish(runtime, "ended")
        return
      }
      // The reason only, never what was typed.
      log.warn("Terminal input was not delivered", terminalErrorMessage(error))
      patchTerminal(runtime.id, { inputError: terminalErrorMessage(error) })
    },
  })
}

function sendInput(runtime: TerminalRuntime, data: string): void {
  const info = terminalInfo(runtime.id)
  const status = info?.status
  // A key press in a terminal waiting for one starts it, and is kept.
  const waitingForKey = status === "idle" && info?.needsGesture === true
  if (status === "starting" || waitingForKey) {
    if (
      runtime.typedWhileStarting.length + data.length <=
      MAX_TYPED_WHILE_STARTING
    ) {
      runtime.typedWhileStarting += data
    }
    if (waitingForKey) void startTerminal(runtime.id)
    return
  }
  if (status !== "running" || !runtime.queue) return
  if (!runtime.queue.push(data)) {
    patchTerminal(runtime.id, {
      inputError: "That paste is too large for the terminal.",
    })
  }
}

const SKIPPED_NOTE = "\r\n\x1b[2m[earlier output was not kept]\x1b[22m\r\n"

/** Writes what a read brought; false once the process has ended. */
function applySnapshot(
  runtime: TerminalRuntime,
  snapshot: Parameters<typeof readTerminalSnapshot>[1]
): boolean {
  const update = readTerminalSnapshot(runtime.cursor, snapshot)
  runtime.cursor = update.nextCursor
  const terminal = runtime.xterm?.terminal
  if (terminal) {
    if (update.skipped) terminal.write(SKIPPED_NOTE)
    if (update.output) terminal.write(update.output)
  }
  runtime.idleReads = update.output ? 0 : runtime.idleReads + 1
  if (update.exit) {
    finish(runtime, "exited", update.exit.exitCode)
    return false
  }
  return true
}

function finish(
  runtime: TerminalRuntime,
  status: "exited" | "ended",
  exitCode: number | null = null
): void {
  stopPolling(runtime)
  runtime.queue?.dispose()
  runtime.queue = null
  runtime.typedWhileStarting = ""
  patchTerminal(runtime.id, {
    status,
    exitCode,
    reattach: false,
    ...(status === "ended" ? { ptySessionId: undefined } : {}),
  })
}

function stopPolling(runtime: TerminalRuntime): void {
  if (runtime.pollTimer) clearTimeout(runtime.pollTimer)
  runtime.pollTimer = null
  runtime.pollAgain = false
}

function schedulePoll(runtime: TerminalRuntime, delayMs: number): void {
  if (runtime.pollTimer) clearTimeout(runtime.pollTimer)
  runtime.pollTimer = setTimeout(() => {
    runtime.pollTimer = null
    void poll(runtime)
  }, delayMs)
}

/** Input landed: read the echo now. */
function kickPoll(runtime: TerminalRuntime): void {
  runtime.idleReads = 0
  if (runtime.polling) runtime.pollAgain = true
  else if (terminalInfo(runtime.id)?.status === "running") {
    schedulePoll(runtime, 0)
  }
}

function isOnScreen(runtime: TerminalRuntime): boolean {
  return (
    runtime.viewers.length > 0 &&
    (typeof document === "undefined" || document.visibilityState !== "hidden")
  )
}

async function poll(runtime: TerminalRuntime): Promise<void> {
  const info = terminalInfo(runtime.id)
  const sessionId = info?.ptySessionId
  if (runtime.disposed || info?.status !== "running" || !sessionId) return
  if (runtime.polling) {
    runtime.pollAgain = true
    return
  }
  runtime.polling = true
  let next: number | null = null
  try {
    const snapshot = await terminalRead(sessionId, runtime.cursor)
    if (
      runtime.disposed ||
      terminalInfo(runtime.id)?.ptySessionId !== sessionId
    ) {
      return
    }
    runtime.failures = 0
    if (!applySnapshot(runtime, snapshot)) return
    next = terminalPollDelay({
      idleReads: runtime.idleReads,
      failures: 0,
      visible: isOnScreen(runtime),
    })
  } catch (error) {
    if (runtime.disposed) return
    if (isTerminalUnreadableError(error)) {
      finish(runtime, "ended")
      return
    }
    runtime.failures += 1
    next = terminalPollDelay({
      idleReads: runtime.idleReads,
      failures: runtime.failures,
      visible: isOnScreen(runtime),
    })
  } finally {
    runtime.polling = false
  }
  if (next === null) return
  if (runtime.pollAgain) {
    runtime.pollAgain = false
    next = 0
  }
  schedulePoll(runtime, next)
}

function scheduleResize(runtime: TerminalRuntime): void {
  if (runtime.resizeTimer) clearTimeout(runtime.resizeTimer)
  runtime.resizeTimer = setTimeout(() => {
    runtime.resizeTimer = null
    const info = terminalInfo(runtime.id)
    const terminal = runtime.xterm?.terminal
    if (!terminal || info?.status !== "running" || !info.ptySessionId) return
    const size = ptySize(terminal.cols, terminal.rows)
    const sent = runtime.sentSize
    if (sent && sent.cols === size.cols && sent.rows === size.rows) return
    runtime.sentSize = size
    void terminalResize(info.ptySessionId, size.cols, size.rows).catch(() => {
      runtime.sentSize = null
    })
  }, 120)
}

/** A finished, ended or failed terminal starts over with a fresh shell. */
export function restartTerminal(terminalId: string): void {
  const info = terminalInfo(terminalId)
  const runtime = runtimes.get(terminalId)
  if (!info || !runtime) return
  if (info.ptySessionId && info.status !== "ended") {
    void terminalClose(info.ptySessionId).catch(() => undefined)
  }
  stopPolling(runtime)
  runtime.queue?.dispose()
  runtime.queue = null
  // A clean screen: modes a crashed program left on (mouse, alternate
  // screen) must not leak into the new shell.
  runtime.xterm?.terminal.reset()
  patchTerminal(terminalId, {
    status: "idle",
    needsGesture: false,
    reattach: false,
    ptySessionId: undefined,
  })
  focusRequests.add(terminalId)
  void startTerminal(terminalId)
}

// ── Tabs and panes ───────────────────────────────────────────────────────

function newId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

export interface NewTerminalOptions {
  readonly cwd: string
  readonly shell?: string
  /** Typed into the shell once it runs, without Enter. */
  readonly initialInput?: string
  /** Give it the keyboard when it shows. */
  readonly focus?: boolean
}

function addTerminal(scopeKey: string, options: NewTerminalOptions): string {
  const id = newId()
  const info: TerminalInfo = {
    id,
    scopeKey,
    cwd: options.cwd,
    ...(options.shell ? { shell: options.shell } : {}),
    status: "idle",
  }
  useTerminalStore.setState((state) => ({
    terminals: { ...state.terminals, [id]: info },
  }))
  if (options.initialInput) pendingInputs.set(id, options.initialInput)
  if (options.focus) focusRequests.add(id)
  return id
}

/** A new tab with one terminal; its shell starts when the tab shows. */
export function createTerminalTab(
  scopeKey: string,
  options: NewTerminalOptions
): string {
  const id = addTerminal(scopeKey, options)
  updateGroup(scopeKey, (group) => addTerminalTab(group, newId(), id))
  return id
}

/**
 * Splits a terminal's pane right (`row`) or down (`column`) with a new
 * terminal in the same folder and shell; null when its tab is full.
 */
export function splitTerminal(
  terminalId: string,
  direction: TerminalSplitDirection
): string | null {
  const source = terminalInfo(terminalId)
  if (!source) return null
  const group = useTerminalStore.getState().groups[source.scopeKey]
  const tab = group ? findTerminalTab(group, terminalId) : undefined
  if (
    !tab ||
    layoutTerminalIds(tab.layout).length >= MAX_TERMINAL_PANES_PER_TAB
  ) {
    return null
  }
  const id = addTerminal(source.scopeKey, {
    cwd: source.cwd,
    ...(source.shell ? { shell: source.shell } : {}),
    focus: true,
  })
  const splitId = newId()
  updateGroup(
    source.scopeKey,
    (current) =>
      splitTerminalPane(current, terminalId, id, direction, splitId) ?? current
  )
  return id
}

function forgetTerminal(terminalId: string): void {
  const info = terminalInfo(terminalId)
  useTerminalStore.setState((state) => {
    if (!state.terminals[terminalId]) return state
    const terminals = { ...state.terminals }
    delete terminals[terminalId]
    return { terminals }
  })
  pendingInputs.delete(terminalId)
  focusRequests.delete(terminalId)
  const runtime = runtimes.get(terminalId)
  if (runtime) disposeRuntime(runtime)
  if (info?.ptySessionId && info.status !== "ended") {
    void terminalClose(info.ptySessionId).catch(() => undefined)
  }
}

/** Closes one terminal and ends its shell; its pane's neighbour takes the space. */
export function closeTerminal(terminalId: string): void {
  const info = terminalInfo(terminalId)
  if (!info) return
  updateGroup(info.scopeKey, (group) => removeTerminalPane(group, terminalId))
  forgetTerminal(terminalId)
}

/** Closes a tab and every terminal in it. */
export function closeTerminalTab(scopeKey: string, tabId: string): void {
  const group = useTerminalStore.getState().groups[scopeKey]
  if (!group) return
  const { removed } = removeTerminalTab(group, tabId)
  updateGroup(scopeKey, (current) => removeTerminalTab(current, tabId).group)
  for (const terminalId of removed) forgetTerminal(terminalId)
}

export function setActiveTerminal(scopeKey: string, terminalId: string): void {
  updateGroup(scopeKey, (group) => focusTerminalPane(group, terminalId))
}

export function setActiveTerminalTab(scopeKey: string, tabId: string): void {
  updateGroup(scopeKey, (group) => activateTerminalTab(group, tabId))
}

export function renameTerminalTabTitle(
  scopeKey: string,
  tabId: string,
  title: string
): void {
  updateGroup(scopeKey, (group) => renameTerminalTab(group, tabId, title))
}

export function setTerminalSplitRatio(
  scopeKey: string,
  tabId: string,
  splitId: string,
  ratio: number
): void {
  updateGroup(scopeKey, (group) =>
    resizeTerminalSplit(group, tabId, splitId, ratio)
  )
}

export function dismissTerminalInputError(terminalId: string): void {
  patchTerminal(terminalId, { inputError: undefined })
}

// ── Shared helpers for the panel ─────────────────────────────────────────

let shellsRequest: Promise<ShellInfo[]> | null = null

/** The shells `/shell/detect` found, asked once per window. */
export function loadTerminalShells(): Promise<ShellInfo[]> {
  shellsRequest ??= detectShells().then(
    (shells) => (Array.isArray(shells) ? shells : []),
    (error: unknown) => {
      shellsRequest = null
      throw error
    }
  )
  return shellsRequest
}

const claimedEvents = new WeakSet<Event>()

/**
 * Two mounted panels of one chat both hear a "new terminal" event; the
 * first to claim it handles it.
 */
export function claimTerminalEvent(event: Event): boolean {
  if (claimedEvents.has(event)) return false
  claimedEvents.add(event)
  return true
}

// ── Window lifetime ──────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  useTerminalStore.subscribe(scheduleSave)
  // The layout is kept for the reloaded page; the shells end with this one
  // (the desktop shell also ends them when it sees the page go).
  window.addEventListener("beforeunload", () => {
    saveNow()
    for (const info of Object.values(useTerminalStore.getState().terminals)) {
      if (info.ptySessionId && info.status !== "ended") {
        void terminalClose(info.ptySessionId).catch(() => undefined)
      }
    }
  })
}
