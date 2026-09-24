import { z } from "zod"

/**
 * How the app and its code editor talk. The editor is CodeMirror 6 in a
 * WebView (apps/mobile/editor, bundled into editor-html.ts): the app sends
 * commands as JSON messages, the editor answers with events, and the app
 * checks every event before it acts on one.
 */

/** Files larger than this are only shown, not edited, on the phone. */
export const MAX_EDITABLE_BYTES = 1024 * 1024

export const EDITOR_LANGUAGES = [
  "javascript",
  "typescript",
  "json",
  "markdown",
  "css",
  "html",
  "python",
  "yaml",
  "text",
] as const
export type EditorLanguage = (typeof EDITOR_LANGUAGES)[number]

const EXTENSIONS: Record<string, EditorLanguage> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  py: "python",
  pyi: "python",
  yml: "yaml",
  yaml: "yaml",
}

/** The language to highlight a file in, by its extension. */
export function editorLanguageFor(fileName: string): EditorLanguage {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  return (extension && EXTENSIONS[extension]) || "text"
}

/** From the app to the editor. */
export type EditorCommand =
  | {
      type: "load"
      text: string
      language: EditorLanguage
      readOnly: boolean
      wrap: boolean
      /** A line to show, counted from 1. */
      line?: number
    }
  | { type: "setWrap"; wrap: boolean }
  | { type: "setReadOnly"; readOnly: boolean }
  | { type: "requestText"; requestId: string }
  /**
   * The desktop has `text` now; changes count from it. It is the text that
   * was saved, which may be older than what the editor holds by then.
   */
  | { type: "markSaved"; text: string }
  | { type: "undo" }
  | { type: "redo" }

/** From the editor to the app. */
export const editorEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("changed"),
    /** Whether the text differs from what was loaded. */
    dirty: z.boolean(),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
  }),
  z.object({
    type: z.literal("text"),
    requestId: z.string().min(1).max(64),
    // Well above the editable size: a checked message, not a copy of it.
    // Null when the editor holds no text (its page started over), rather
    // than an empty text that a save would write.
    text: z
      .string()
      .max(MAX_EDITABLE_BYTES * 4)
      .nullable(),
  }),
  z.object({ type: z.literal("error"), message: z.string().max(2_000) }),
])
export type EditorEvent = z.infer<typeof editorEventSchema>

/** An event from the editor, or null for anything that is not one. */
export function parseEditorEvent(data: string): EditorEvent | null {
  try {
    const parsed = editorEventSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
