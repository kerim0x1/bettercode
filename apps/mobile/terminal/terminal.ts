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
 * comes in; that mode runs while VoiceOver or TalkBack does. Otherwise the
 * rows stay readable: explored with a screen reader, or read by the device
 * tests.
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

// A phone keyboard's keys come as keyCode 229, and their text a moment later
// in an input event. xterm reads that text by comparing its input field
// before the key with the field after a timer. On a slow phone the text came
// after the timer, so xterm sent nothing for it: whoami arrived as "whmi"
// and "woami" on CI's Android emulator. So xterm leaves these keys alone,
// and the page sends each one's text from its input event, before xterm
// sees that event. Other keys (a hardware keyboard, iOS's keys) and
// compositions stay with xterm.
let keyboardKey = false
terminal.attachCustomKeyEventHandler((event) => {
  if (event.type !== "keydown") return true
  keyboardKey = event.keyCode === 229
  return !keyboardKey
})
document.addEventListener(
  "input",
  (event) => {
    if (!keyboardKey || event.target !== terminal.textarea) return
    const input = event as InputEvent
    if (input.isComposing) return
    const data =
      input.inputType === "insertText"
        ? input.data
        : input.inputType === "insertLineBreak"
          ? "\r"
          : input.inputType === "deleteContentBackward"
            ? "\u007f"
            : null
    if (!data) return
    event.stopPropagation()
    send({ type: "input", data })
  },
  true
)
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
