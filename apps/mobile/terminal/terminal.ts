/**
 * The phone's terminal: xterm.js inside the app's WebView, as the desktop's
 * terminal is. It never loads anything (the page's CSP is default-src
 * 'none'); the app sends it commands and it answers with events, both as
 * JSON messages (src/terminal/page-protocol.ts). What is typed goes to the
 * app, which sends it to the desktop; what the desktop prints comes back as
 * `output`. Built into src/terminal/terminal-html.ts by
 * scripts/build-mobile-pages.mjs.
 */
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import type {
  TerminalKey,
  TerminalPageCommand,
  TerminalPageEvent,
} from "../src/terminal/page-protocol"

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void }
  }
}

const ESCAPE = "\u001b"

// The app's own colours (src/design/theme.ts).
const terminal = new Terminal({
  cursorBlink: true,
  fontFamily: "Menlo, 'SF Mono', 'Roboto Mono', monospace",
  fontSize: 13,
  scrollback: 5_000,
  // Off until the app says VoiceOver or TalkBack runs (screenReader below).
  screenReaderMode: false,
  theme: {
    background: "#0A0A0A",
    foreground: "#FAFAFA",
    cursor: "#FAFAFA",
    cursorAccent: "#0A0A0A",
    selectionBackground: "rgba(56, 189, 248, 0.28)",
  },
})
const fit = new FitAddon()
terminal.loadAddon(fit)

function send(event: TerminalPageEvent): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(event))
}

/** What a key sends in the terminal's current mode. */
function sequence(key: TerminalKey): string {
  const application = terminal.modes.applicationCursorKeysMode
  const cursor = (letter: string) =>
    application ? `${ESCAPE}O${letter}` : `${ESCAPE}[${letter}`
  switch (key) {
    case "escape":
      return ESCAPE
    case "tab":
      return "\t"
    case "up":
      return cursor("A")
    case "down":
      return cursor("B")
    case "right":
      return cursor("C")
    case "left":
      return cursor("D")
    case "home":
      return cursor("H")
    case "end":
      return cursor("F")
    case "pageUp":
      return `${ESCAPE}[5~`
    case "pageDown":
      return `${ESCAPE}[6~`
  }
}

function handle(command: TerminalPageCommand): void {
  switch (command.type) {
    case "output":
      terminal.write(command.data)
      return
    case "key":
      send({ type: "input", data: sequence(command.key) })
      return
    case "focus":
      terminal.focus()
      return
    case "reset":
      terminal.reset()
      return
    case "screenReader":
      readOut(command.enabled === true)
      return
  }
}

/**
 * xterm hides the rows it draws from accessibility services. In screen
 * reader mode it keeps a tree of their text of its own and announces what
 * comes in, but it then reads a phone keyboard's typing by comparing the
 * input field's text after a timer, which dropped characters on a slow
 * Android emulator (whoami arrived as "whmi"). So that mode runs only while
 * VoiceOver or TalkBack does. Otherwise typing takes xterm's regular path,
 * and the rows stay readable: explored with a screen reader, or read by the
 * device tests.
 */
function readOut(screenReader: boolean): void {
  terminal.options.screenReaderMode = screenReader
  const rows = parent?.querySelector(".xterm-rows")
  if (screenReader) rows?.setAttribute("aria-hidden", "true")
  else rows?.removeAttribute("aria-hidden")
}

function receive(data: unknown): void {
  if (typeof data !== "string") return
  let command: TerminalPageCommand
  try {
    command = JSON.parse(data) as TerminalPageCommand
  } catch {
    return
  }
  if (
    !command ||
    typeof command !== "object" ||
    typeof command.type !== "string"
  )
    return
  try {
    handle(command)
  } catch (error) {
    send({
      type: "error",
      message:
        error instanceof Error
          ? error.message.slice(0, 2_000)
          : "The terminal failed.",
    })
  }
}

const parent = document.getElementById("terminal")
if (!parent) throw new Error("The terminal's page has no terminal element.")
terminal.open(parent)
readOut(false)
fit.fit()
terminal.onData((data) => send({ type: "input", data }))
terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }))
// The keyboard coming and going changes the page's height.
new ResizeObserver(() => fit.fit()).observe(parent)

// iOS delivers the app's messages to window, Android to document (from
// where an old WebView's event bubbles on to window): each once.
const received = new WeakSet<Event>()
function onMessage(event: Event): void {
  if (received.has(event)) return
  received.add(event)
  receive((event as MessageEvent).data)
}
window.addEventListener("message", onMessage)
document.addEventListener("message", onMessage)
send({ type: "ready", cols: terminal.cols, rows: terminal.rows })
