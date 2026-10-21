import type {
  BundledLanguage,
  BundledTheme,
  HighlighterGeneric,
  ThemeRegistrationAny,
} from "shiki"
import { createLogger } from "@/lib/logger"

/**
 * One Shiki highlighter for the whole renderer.
 *
 * Every highlighter instance carries its own regex engine plus a copy of each
 * loaded grammar and theme, so a highlighter per language (or per feature)
 * multiplies memory for no benefit. This module creates a single instance on
 * first use and loads languages and themes into it on demand.
 *
 * Shiki and its bundled grammars are imported lazily, so nothing loads until
 * the first code block or diff is highlighted.
 */

const log = createLogger("shiki-highlighter")

export type AppHighlighter = HighlighterGeneric<BundledLanguage, BundledTheme>
/** A language the highlighter has loaded, or plain text when it has none. */
export type HighlightLanguage = BundledLanguage | "text"
export type HighlightTheme = BundledTheme | ThemeRegistrationAny

interface HighlighterHandle {
  highlighter: AppHighlighter
  bundledLanguages: Readonly<Record<string, unknown>>
}

let handlePromise: Promise<HighlighterHandle> | null = null
const languageLoads = new Map<string, Promise<boolean>>()
const themeLoads = new Map<string, Promise<void>>()

function loadHandle(): Promise<HighlighterHandle> {
  if (handlePromise) return handlePromise
  const pending = import("shiki").then(async (shiki) => ({
    highlighter: await shiki.createHighlighter({ langs: [], themes: [] }),
    bundledLanguages: shiki.bundledLanguages as Readonly<
      Record<string, unknown>
    >,
  }))
  handlePromise = pending
  // A failed first load must not disable highlighting for the rest of the
  // session; the next caller tries again.
  pending.catch(() => {
    if (handlePromise === pending) handlePromise = null
  })
  return pending
}

async function ensureLanguage(
  { highlighter, bundledLanguages }: HighlighterHandle,
  requested: string | null | undefined
): Promise<HighlightLanguage> {
  const id = requested?.trim().toLowerCase() ?? ""
  if (!id) return "text"
  if (highlighter.getLoadedLanguages().includes(id)) {
    return id as BundledLanguage
  }
  // Fenced code can name any language; unknown names render as plain text
  // instead of failing the whole highlight.
  if (!Object.prototype.hasOwnProperty.call(bundledLanguages, id)) {
    return "text"
  }
  let pending = languageLoads.get(id)
  if (!pending) {
    // Several code blocks in one message often share a language. Share the
    // in-flight load so the grammar is fetched and compiled once.
    pending = highlighter
      .loadLanguage(id as BundledLanguage)
      .then(
        () => true,
        (error: unknown) => {
          log.warn(`Failed to load the ${id} grammar`, error)
          return false
        }
      )
      .finally(() => languageLoads.delete(id))
    languageLoads.set(id, pending)
  }
  const loaded = await pending
  return loaded && highlighter.getLoadedLanguages().includes(id)
    ? (id as BundledLanguage)
    : "text"
}

function ensureTheme(
  highlighter: AppHighlighter,
  theme: HighlightTheme
): Promise<void> {
  const name = typeof theme === "string" ? theme : theme.name
  if (!name) return highlighter.loadTheme(theme)
  if (highlighter.getLoadedThemes().includes(name)) return Promise.resolve()
  let pending = themeLoads.get(name)
  if (!pending) {
    pending = highlighter
      .loadTheme(theme)
      .finally(() => themeLoads.delete(name))
    themeLoads.set(name, pending)
  }
  return pending
}

export interface HighlighterRequest {
  /** Language id or alias. Unknown or missing languages resolve to "text". */
  language?: string | null
  /** Themes the caller will pass to `codeToTokens`. Loaded once by name. */
  themes?: readonly HighlightTheme[]
}

export interface HighlighterResult {
  highlighter: AppHighlighter
  /** The language to pass as `lang`; "text" when the grammar is unavailable. */
  language: HighlightLanguage
}

/**
 * Resolve the shared highlighter with the requested language and themes
 * loaded. Rejects only when Shiki itself or a requested theme fails to load.
 */
export async function getHighlighter(
  request: HighlighterRequest = {}
): Promise<HighlighterResult> {
  const handle = await loadHandle()
  const [language] = await Promise.all([
    ensureLanguage(handle, request.language),
    Promise.all(
      (request.themes ?? []).map((theme) =>
        ensureTheme(handle.highlighter, theme)
      )
    ),
  ])
  return { highlighter: handle.highlighter, language }
}

/** Test-only: drop the shared instance so each test starts cold. */
export function resetHighlighterForTests(): void {
  const current = handlePromise
  handlePromise = null
  languageLoads.clear()
  themeLoads.clear()
  void current?.then(
    ({ highlighter }) => highlighter.dispose(),
    () => undefined
  )
}
