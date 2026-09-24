/**
 * The phone's code editor: CodeMirror 6 inside the app's WebView. It never
 * loads anything (the page's CSP is default-src 'none'); the app sends it
 * commands and it answers with events, both as JSON messages
 * (src/editor/protocol.ts). Built into src/editor/editor-html.ts by
 * scripts/build-mobile-editor.mjs.
 */
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete"
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { yaml } from "@codemirror/lang-yaml"
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import { tags } from "@lezer/highlight"
import {
  joinedLength,
  lineBreakOf,
  type LineBreak,
} from "../src/editor/line-breaks"
import type {
  EditorCommand,
  EditorEvent,
  EditorLanguage,
} from "../src/editor/protocol"

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void }
  }
}

// The app's own colours (src/design/theme.ts).
const theme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "#FAFAFA",
      backgroundColor: "#0A0A0A",
      fontSize: "13px",
    },
    ".cm-scroller": {
      fontFamily: "Menlo, 'SF Mono', 'Roboto Mono', monospace",
      lineHeight: "1.55",
    },
    ".cm-content": { caretColor: "#FAFAFA", padding: "8px 0 40vh" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#FAFAFA" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "rgba(56, 189, 248, 0.28)" },
    ".cm-gutters": {
      backgroundColor: "#0A0A0A",
      color: "#737373",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.04)" },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "#A3A3A3",
    },
    ".cm-matchingBracket, .cm-selectionMatch": {
      backgroundColor: "rgba(255, 255, 255, 0.12)",
    },
    ".cm-tooltip": {
      backgroundColor: "#171717",
      border: "1px solid rgba(255, 255, 255, 0.18)",
      color: "#FAFAFA",
    },
  },
  { dark: true }
)

const highlightStyle = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.modifier,
      tags.operatorKeyword,
      tags.controlKeyword,
    ],
    color: "#C792EA",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "#8DE5A8",
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#F78C6C" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "#737373",
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "#82AAFF",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#FFCB6B" },
  { tag: [tags.propertyName, tags.attributeName], color: "#B7C0BB" },
  { tag: tags.tagName, color: "#FF9AA7" },
  { tag: tags.heading, color: "#FAFAFA", fontWeight: "bold" },
  { tag: [tags.link, tags.url], color: "#38BDF8", textDecoration: "underline" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.invalid, color: "#F87171" },
])

function languageSupport(language: EditorLanguage): Extension {
  switch (language) {
    case "javascript":
      return javascript({ jsx: true })
    case "typescript":
      return javascript({ jsx: true, typescript: true })
    case "json":
      return json()
    case "markdown":
      return markdown()
    case "css":
      return css()
    case "html":
      return html()
    case "python":
      return python()
    case "yaml":
      return yaml()
    default:
      return []
  }
}

const readOnlyState = (readOnly: boolean): Extension => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
]

const language = new Compartment()
const access = new Compartment()
const wrapping = new Compartment()
let view: EditorView | null = null
/** The file's line break, which the text's lines are joined with. */
let lineBreak: LineBreak = "\n"
/**
 * The desktop's text as the editor knows it, loaded or last saved: the app
 * hears whether the editor's text differs from it.
 */
let loaded = ""
let changeTimer: ReturnType<typeof setTimeout> | null = null

function send(event: EditorEvent): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(event))
}

/** The editor's text, with the file's line breaks. */
function currentText(editor: EditorView): string {
  const doc = editor.state.doc
  return doc.sliceString(0, doc.length, lineBreak)
}

function reportChange(): void {
  if (!view) return
  send({
    type: "changed",
    // A different length needs no look at the text.
    dirty:
      joinedLength(view.state.doc, lineBreak) !== loaded.length ||
      currentText(view) !== loaded,
    canUndo: undoDepth(view.state) > 0,
    canRedo: redoDepth(view.state) > 0,
  })
}

/** Typing sends at most one change report every 150 ms. */
function scheduleChange(): void {
  if (changeTimer) return
  changeTimer = setTimeout(() => {
    changeTimer = null
    reportChange()
  }, 150)
}

function extensions(command: Extract<EditorCommand, { type: "load" }>) {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    // Suggestions only from the words in the file, and only when asked.
    autocompletion({ activateOnTyping: false }),
    highlightSelectionMatches(),
    syntaxHighlighting(highlightStyle),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    theme,
    language.of(languageSupport(command.language)),
    access.of(readOnlyState(command.readOnly)),
    wrapping.of(command.wrap ? EditorView.lineWrapping : []),
    // Code, not prose: no capitals, corrections or spell checking.
    EditorView.contentAttributes.of({
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: "false",
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) scheduleChange()
    }),
  ]
}

function goToLine(line: number): void {
  if (!view) return
  const doc = view.state.doc
  const target = doc.line(Math.min(Math.max(1, Math.floor(line)), doc.lines))
  view.dispatch({
    selection: { anchor: target.from },
    effects: EditorView.scrollIntoView(target.from, { y: "center" }),
  })
}

function handle(command: EditorCommand): void {
  switch (command.type) {
    case "load": {
      lineBreak = lineBreakOf(command.text)
      const state = EditorState.create({
        doc: command.text,
        extensions: extensions(command),
      })
      if (view) view.setState(state)
      else {
        const parent = document.getElementById("editor")
        if (!parent) throw new Error("The editor's page has no editor element.")
        view = new EditorView({ state, parent })
      }
      // The text as the editor gives it back: in a file that mixes line
      // breaks, all are its most common one (src/editor/line-breaks.ts).
      loaded = currentText(view)
      if (command.line) goToLine(command.line)
      reportChange()
      return
    }
    case "setWrap":
      view?.dispatch({
        effects: wrapping.reconfigure(
          command.wrap ? EditorView.lineWrapping : []
        ),
      })
      return
    case "setReadOnly":
      view?.dispatch({
        effects: access.reconfigure(readOnlyState(command.readOnly)),
      })
      return
    case "requestText":
      send({
        type: "text",
        requestId: command.requestId,
        text: view ? currentText(view) : "",
      })
      return
    case "markSaved":
      // What was typed while the save was on its way is still unsaved.
      loaded = command.text
      reportChange()
      return
    case "undo":
      if (view) undo(view)
      return
    case "redo":
      if (view) redo(view)
      return
  }
}

function receive(data: unknown): void {
  if (typeof data !== "string") return
  let command: EditorCommand
  try {
    command = JSON.parse(data) as EditorCommand
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
          : "The editor failed.",
    })
  }
}

// iOS delivers the app's messages to window, Android to document.
window.addEventListener("message", (event) => receive(event.data))
document.addEventListener("message", ((event: MessageEvent) =>
  receive(event.data)) as EventListener)
send({ type: "ready" })
