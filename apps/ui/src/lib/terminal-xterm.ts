import { FitAddon } from "@xterm/addon-fit"
import {
  Terminal,
  type IBufferCell,
  type IBufferRange,
  type ILink,
  type ITheme,
} from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { findTerminalUrls } from "@/lib/terminal-links"

/**
 * xterm.js for the desktop terminal, with BetterC0de's keys, clipboard and
 * links. `terminal-sessions.ts` loads this module on demand, so xterm and
 * its style sheet stay out of the first paint.
 */

export const TERMINAL_FONT_SIZE = 12
export const TERMINAL_LINE_HEIGHT = 1.2
export const TERMINAL_SCROLLBACK = 5_000

export interface XtermCallbacks {
  /** Copies text the user selected or asked to copy. */
  readonly copy: (text: string) => void
  /** Reads the clipboard for a right-click paste. */
  readonly requestPaste: () => void
  /** Opens a web address the user Ctrl/Cmd-clicked. */
  readonly openUrl: (url: string) => void
}

export interface XtermOptions {
  readonly fontFamily: string
  readonly theme: ITheme
  readonly cursorBlink: boolean
  readonly platform: "mac" | "windows" | "other"
}

export interface XtermHandle {
  readonly terminal: Terminal
  /** Fits rows and columns to the host; false while the host has no size. */
  fit(): boolean
  dispose(): void
}

const LINK_HINT = (platform: XtermOptions["platform"]) =>
  platform === "mac" ? "Cmd+click to open" : "Ctrl+click to open"

/** A link opens on Ctrl/Cmd-click, so a plain click can still select text. */
function wantsLink(event: MouseEvent, platform: XtermOptions["platform"]) {
  return platform === "mac" ? event.metaKey : event.ctrlKey
}

export function createXterm(
  host: HTMLElement,
  options: XtermOptions,
  callbacks: XtermCallbacks
): XtermHandle {
  const terminal = new Terminal({
    allowProposedApi: false,
    cursorBlink: options.cursorBlink,
    cursorInactiveStyle: "outline",
    drawBoldTextInBrightColors: true,
    fontFamily: options.fontFamily,
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    // Any theme's ANSI colors stay readable on the panel's surface.
    minimumContrastRatio: 4.5,
    rightClickSelectsWord: false,
    scrollback: TERMINAL_SCROLLBACK,
    smoothScrollDuration: 0,
    theme: options.theme,
    // OSC 8 hyperlinks: web addresses only, on Ctrl/Cmd-click.
    linkHandler: {
      allowNonHttpProtocols: false,
      activate: (event, text) => {
        if (wantsLink(event, options.platform)) callbacks.openUrl(text)
      },
    },
  })
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  // The host is on screen by now, so xterm measures the font correctly.
  terminal.open(host)
  const disposables = [
    terminal.registerLinkProvider({
      provideLinks: (line, done) =>
        done(urlLinks(terminal, line, options.platform, callbacks)),
    }),
  ]

  terminal.attachCustomKeyEventHandler((event) =>
    handleKey(terminal, event, options.platform, callbacks)
  )

  // Right-click copies a selection, or pastes when there is none.
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    if (terminal.hasSelection()) {
      callbacks.copy(terminal.getSelection())
      terminal.clearSelection()
      return
    }
    callbacks.requestPaste()
  }
  host.addEventListener("contextmenu", onContextMenu)

  // Copy on select, once the selection has settled.
  let copyTimer: ReturnType<typeof setTimeout> | null = null
  disposables.push(
    terminal.onSelectionChange(() => {
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        copyTimer = null
        if (terminal.hasSelection()) callbacks.copy(terminal.getSelection())
      }, 250)
    })
  )

  return {
    terminal,
    fit: () => {
      if (
        !terminal.element ||
        host.clientWidth === 0 ||
        host.clientHeight === 0
      ) {
        return false
      }
      const size = fitAddon.proposeDimensions()
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) {
        return false
      }
      fitAddon.fit()
      return true
    },
    dispose: () => {
      if (copyTimer) clearTimeout(copyTimer)
      host.removeEventListener("contextmenu", onContextMenu)
      for (const disposable of disposables) disposable.dispose()
      terminal.dispose()
    },
  }
}

/**
 * Keys the terminal handles itself before xterm sees them. False means
 * "not for the shell": xterm leaves the event alone, and the browser's own
 * paste (Ctrl+Shift+V, and Ctrl+V on Windows) reaches xterm's paste
 * handler. App shortcuts were claimed already by the window's capture
 * listener (`use-global-shortcuts.ts`), which marks them handled.
 */
function handleKey(
  terminal: Terminal,
  event: KeyboardEvent,
  platform: XtermOptions["platform"],
  callbacks: XtermCallbacks
): boolean {
  if (event.defaultPrevented) return false
  if (event.type !== "keydown") return true
  const ctrlOnly = event.ctrlKey && !event.altKey && !event.metaKey
  // On macOS Cmd copies and pastes natively, and Ctrl+C stays the shell's.
  if (!ctrlOnly || platform === "mac") return true
  if (event.shiftKey && isKey(event, "c")) {
    if (terminal.hasSelection()) callbacks.copy(terminal.getSelection())
    event.preventDefault()
    return false
  }
  if (event.shiftKey && isKey(event, "v")) return false
  if (!event.shiftKey && isKey(event, "c")) {
    // Ctrl+C copies a selection; without one it goes to the shell as ^C.
    if (!terminal.hasSelection()) return true
    callbacks.copy(terminal.getSelection())
    terminal.clearSelection()
    event.preventDefault()
    return false
  }
  if (!event.shiftKey && isKey(event, "v")) return platform !== "windows"
  return true
}

/** The letter the key types; the key's position only on non-Latin layouts. */
function isKey(event: KeyboardEvent, letter: string): boolean {
  const key = event.key.toLowerCase()
  if (/^[a-z]$/.test(key)) return key === letter
  return event.code === `Key${letter.toUpperCase()}`
}

/** The http(s) links on one buffer line (1-based), wrapped rows included. */
function urlLinks(
  terminal: Terminal,
  lineNumber: number,
  platform: XtermOptions["platform"],
  callbacks: XtermCallbacks
): ILink[] | undefined {
  const buffer = terminal.buffer.active
  let first = lineNumber - 1
  while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1
  let last = lineNumber - 1
  while (buffer.getLine(last + 1)?.isWrapped) last += 1
  if (last - first > 20) return undefined

  // The text of the logical line, and each character's cell.
  let text = ""
  const cells: Array<{ x: number; y: number; width: number }> = []
  const scratch: IBufferCell = buffer.getNullCell()
  for (let y = first; y <= last; y += 1) {
    const line = buffer.getLine(y)
    if (!line) break
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x, scratch)
      if (!cell) break
      const width = cell.getWidth()
      if (width === 0) continue
      const chars = cell.getChars() || " "
      for (let index = 0; index < chars.length; index += 1) {
        cells.push({ x, y, width })
      }
      text += chars
    }
  }

  const links: ILink[] = []
  for (const match of findTerminalUrls(text)) {
    const start = cells[match.start]
    const end = cells[match.end - 1]
    if (!start || !end) continue
    if (start.y > lineNumber - 1 || end.y < lineNumber - 1) continue
    const range: IBufferRange = {
      start: { x: start.x + 1, y: start.y + 1 },
      end: { x: end.x + end.width, y: end.y + 1 },
    }
    links.push({
      range,
      text: match.url,
      decorations: { pointerCursor: true, underline: true },
      activate: (event) => {
        if (wantsLink(event, platform)) callbacks.openUrl(match.url)
      },
      hover: () => {
        if (terminal.element) terminal.element.title = LINK_HINT(platform)
      },
      leave: () => {
        if (terminal.element) terminal.element.removeAttribute("title")
      },
    })
  }
  return links.length > 0 ? links : undefined
}
