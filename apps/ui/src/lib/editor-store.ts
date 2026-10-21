import { create } from "zustand"
import { readFile, writeFile } from "@/services/backend/workspaceApi"
import { HttpError } from "@/lib/errors/types"
import {
  isEditorPathEqualOrInside,
  normalizeEditorPath,
  rebaseEditorPath,
  resolveWorkspaceFilePath,
} from "@/lib/editor-path"
import { editorDiffKey, type EditorDiffTarget } from "@/lib/editor-diff"
import { dispatchEditorGotoLine } from "@/lib/editor-go-to-line"
import { dispatchEditorFileActivate } from "@/lib/preview-events"
import { createLogger } from "@/lib/logger"
import { getEditorFileKind, type EditorFileKind } from "@/lib/editor-file-kind"

const log = createLogger("editor")

export interface EditorTab {
  id: string
  /** Git comparisons are separate, read-only documents, even for the same path. */
  diff?: EditorDiffTarget
  filePath: string
  fileName: string
  /** Missing on legacy/in-memory fixtures; those tabs are editable text. */
  fileKind?: EditorFileKind
  language: string
  content: string
  originalContent: string
  /** Changes on edits and accepted reads; async reads must match this revision. */
  revision: number
  /** Latest requested read for this document; older responses cannot commit. */
  readGeneration: number
  /** Changes when a tab is reused for another file or its path is moved. */
  documentVersion: number
  /**
   * Snapshot of the file's content *before* the most recent AI edit.
   * When set, MonacoEditorWrapper renders line-level diff decorations.
   * Cleared on user dismiss, manual save, or when the user starts editing.
   */
  aiBaselineContent: string | null
  isDirty: boolean
  isLoading: boolean
  isPinned: boolean
  isPreview: boolean
  cursorLine: number
  cursorColumn: number
  selectionLineCount: number
  selectionCharCount: number
  selectionContext?: EditorSelectionContext | null
}

export interface EditorSelectionContext {
  lineCount: number
  charCount: number
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  text: string
}

/** Identity and content version captured before asynchronous document work. */
export type EditorDocumentSnapshot = Readonly<
  Pick<
    EditorTab,
    "id" | "filePath" | "documentVersion" | "revision" | "content"
  >
>

export interface EditorDocumentChange {
  readonly expected: EditorDocumentSnapshot
  readonly content: string
}

export type EditorChangeResult =
  | { readonly status: "applied"; readonly changedTabIds: readonly string[] }
  | { readonly status: "conflict"; readonly filePaths: readonly string[] }

export type EditorSaveResult =
  | {
      readonly status: "saved"
      readonly tabId: string
      readonly filePath: string
      readonly savedRevision: number
      readonly hasUnsavedChanges: boolean
    }
  | {
      readonly status: "skipped"
      readonly tabId: string
      readonly reason: "closed" | "read-only" | "unchanged" | "document-changed"
    }

export class EditorSaveError extends Error {
  readonly filePath: string
  constructor(filePath: string, cause: unknown) {
    super(
      `Could not save ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
    this.name = "EditorSaveError"
    this.filePath = filePath
  }
}

export function captureEditorDocument(tab: EditorTab): EditorDocumentSnapshot {
  return {
    id: tab.id,
    filePath: tab.filePath,
    documentVersion: tab.documentVersion,
    revision: tab.revision,
    content: tab.content,
  }
}

function matchesDocument(
  tab: EditorTab | undefined,
  expected: EditorDocumentSnapshot
): boolean {
  return (
    !!tab &&
    !tab.diff &&
    (tab.fileKind ?? "text") === "text" &&
    tab.id === expected.id &&
    tab.filePath === expected.filePath &&
    tab.documentVersion === expected.documentVersion &&
    tab.revision === expected.revision &&
    tab.content === expected.content
  )
}

type EditorSelectionUpdate =
  | EditorSelectionContext
  | { lineCount: number; charCount: number }

export interface EditorLocation {
  filePath: string
  diff?: EditorDiffTarget
  line: number
  column: number
}

export interface EditorRecentFile extends EditorLocation {
  fileName: string
  language: string
}

interface OpenFileOptions {
  line?: number
  column?: number
  preserveNavigation?: boolean
  reloadExisting?: boolean
  preview?: boolean
}

interface EditorState {
  tabs: EditorTab[]
  activeTabId: string | null
  navigationBackStack: EditorLocation[]
  navigationForwardStack: EditorLocation[]
  recentlyClosedTabs: EditorTab[]
  recentFiles: EditorRecentFile[]

  openFile: (filePath: string, options?: OpenFileOptions) => Promise<void>
  openDiff: (
    target: EditorDiffTarget,
    options?: Pick<OpenFileOptions, "preview" | "preserveNavigation">
  ) => void
  /**
   * Reload a tab because an AI tool modified the file on disk.
   * Captures the current in-memory content as the diff baseline, then fetches new content.
   */
  reloadFromAi: (filePath: string) => Promise<void>
  reloadFromDisk: (filePath: string) => Promise<void>
  clearAiDiff: (tabId: string) => void
  closeTab: (tabId: string) => void
  activateAdjacentTab: (direction: "previous" | "next") => void
  setActiveTab: (
    tabId: string,
    options?: { preserveNavigation?: boolean }
  ) => void
  updateContent: (tabId: string, content: string) => void
  /** Atomically validates all read dependencies before changing any buffer. Never saves to disk. */
  applyDocumentChanges: (
    changes: readonly EditorDocumentChange[],
    guards?: readonly EditorDocumentSnapshot[]
  ) => EditorChangeResult
  updateCursor: (
    tabId: string,
    line: number,
    column: number,
    selection?: EditorSelectionUpdate
  ) => void
  recordNavigationPoint: () => void
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  /** Rejects on write failure; successful writes report edits that still remain unsaved. */
  saveTab: (tabId: string) => Promise<EditorSaveResult>
  saveActiveTab: () => Promise<EditorSaveResult | null>
  saveAllTabs: () => Promise<readonly EditorSaveResult[]>
  moveTab: (tabId: string, direction: "left" | "right") => void
  togglePinTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => void
  closeTabsToRight: (tabId: string) => void
  closeSavedTabs: () => void
  closeAllTabs: () => void
  reopenClosedTab: () => Promise<void>
  handlePathMoved: (oldPath: string, newPath: string) => void
  handlePathDeleted: (path: string) => void
}

export function getLanguage(path: string): string {
  const fileName = path.split(/[/\\]/).pop()?.toLowerCase() || ""
  const specialNames: Record<string, string> = {
    dockerfile: "dockerfile",
    makefile: "plaintext",
    rakefile: "ruby",
    gemfile: "ruby",
    procfile: "plaintext",
  }
  if (specialNames[fileName]) return specialNames[fileName]
  const ext = fileName.includes(".") ? fileName.split(".").pop() || "" : ""
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    mts: "typescript",
    cts: "typescript",
    rs: "rust",
    py: "python",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    cs: "csharp",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "plaintext",
    xml: "xml",
    md: "markdown",
    mdx: "markdown",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    dockerfile: "dockerfile",
    gitignore: "plaintext",
    env: "plaintext",
    txt: "plaintext",
    lock: "plaintext",
    csv: "plaintext",
    vue: "html",
    svelte: "html",
    astro: "html",
    graphql: "graphql",
    gql: "graphql",
    prisma: "plaintext",
    proto: "plaintext",
    php: "php",
    rb: "ruby",
    swift: "swift",
    kt: "kotlin",
    kts: "kotlin",
    dart: "dart",
    lua: "lua",
    ps1: "powershell",
    psm1: "powershell",
    ini: "ini",
    properties: "ini",
    conf: "ini",
    m: "objective-c",
    mm: "objective-c",
    pl: "perl",
    pm: "perl",
    r: "r",
    fs: "fsharp",
    fsx: "fsharp",
    hbs: "handlebars",
    pug: "pug",
    razor: "razor",
    cshtml: "razor",
    tf: "plaintext",
    hcl: "plaintext",
  }
  return map[ext] || "plaintext"
}

function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath
}

const MAX_NAVIGATION_HISTORY = 100
const MAX_RECENTLY_CLOSED_TABS = 25
/**
 * UTF-16 code units of unsaved text kept for closed editors (about 5 MB of
 * ASCII). Clean closed tabs keep no text at all.
 */
export const MAX_RECENTLY_CLOSED_CONTENT_CHARS = 5 * 1024 * 1024
const MAX_RECENT_FILES = 100

function documentKey(document: {
  filePath: string
  diff?: EditorDiffTarget
}): string {
  return document.diff
    ? editorDiffKey(document.diff)
    : `file:${document.filePath}`
}

function currentLocation(
  state: Pick<EditorState, "tabs" | "activeTabId">
): EditorLocation | null {
  const tab = state.tabs.find((item) => item.id === state.activeTabId)
  if (!tab) return null
  return {
    filePath: tab.filePath,
    ...(tab.diff ? { diff: tab.diff } : {}),
    line: tab.cursorLine,
    column: tab.cursorColumn,
  }
}

function sameLocation(
  a: EditorLocation | null,
  b: EditorLocation | null
): boolean {
  return Boolean(
    a &&
    b &&
    a.filePath === b.filePath &&
    (a.diff ? editorDiffKey(a.diff) : null) ===
      (b.diff ? editorDiffKey(b.diff) : null) &&
    a.line === b.line &&
    a.column === b.column
  )
}

function appendNavigationLocation(
  stack: EditorLocation[],
  location: EditorLocation | null,
  destination?: EditorLocation | null
): EditorLocation[] {
  if (!location || sameLocation(location, destination ?? null)) return stack
  const last = stack[stack.length - 1] ?? null
  if (sameLocation(last, location)) return stack
  return [...stack, location].slice(-MAX_NAVIGATION_HISTORY)
}

/** Drop a closed document's text; reopening it reads the file again. */
function closedTabWithoutContent(tab: EditorTab): EditorTab {
  return {
    ...tab,
    content: "",
    originalContent: "",
    aiBaselineContent: null,
    isDirty: false,
    isLoading: false,
    selectionLineCount: 0,
    selectionCharCount: 0,
    selectionContext: null,
  }
}

/**
 * Only unsaved text buffers keep their text after close, because nothing else
 * holds those edits. Saved files, comparisons and previews are re-read.
 */
function closedTabSnapshot(tab: EditorTab): EditorTab {
  const keepsBuffer =
    tab.isDirty && !tab.diff && (tab.fileKind ?? "text") === "text"
  if (!keepsBuffer) return closedTabWithoutContent(tab)
  return {
    ...tab,
    aiBaselineContent: null,
    isLoading: false,
    selectionLineCount: 0,
    selectionCharCount: 0,
    selectionContext: null,
  }
}

/** Newest unsaved buffers win; older ones fall back to a disk read on reopen. */
function capRetainedClosedContent(stack: EditorTab[]): EditorTab[] {
  let retained = 0
  return stack.map((tab) => {
    if (!tab.isDirty) return tab
    const size = tab.content.length + tab.originalContent.length
    if (retained + size > MAX_RECENTLY_CLOSED_CONTENT_CHARS) {
      return closedTabWithoutContent(tab)
    }
    retained += size
    return tab
  })
}

function rememberClosedTabs(
  stack: EditorTab[],
  closedTabs: EditorTab[]
): EditorTab[] {
  if (closedTabs.length === 0) return stack
  const closedPaths = new Set(closedTabs.map(documentKey))
  return capRetainedClosedContent(
    [
      ...closedTabs.map(closedTabSnapshot),
      ...stack.filter((tab) => !closedPaths.has(documentKey(tab))),
    ].slice(0, MAX_RECENTLY_CLOSED_TABS)
  )
}

function rememberRecentFile(
  stack: EditorRecentFile[],
  file: EditorRecentFile | null
): EditorRecentFile[] {
  if (!file) return stack
  const key = file.filePath.toLowerCase()
  return [
    file,
    ...stack.filter((item) => item.filePath.toLowerCase() !== key),
  ].slice(0, MAX_RECENT_FILES)
}

function recentFileFromTab(tab: EditorTab): EditorRecentFile | null {
  if (tab.diff) return null
  return {
    filePath: tab.filePath,
    fileName: tab.fileName,
    language: tab.language,
    line: tab.cursorLine,
    column: tab.cursorColumn,
  }
}

function recentFileFromPath(
  filePath: string,
  line = 1,
  column = 1
): EditorRecentFile {
  return {
    filePath,
    fileName: getFileName(filePath),
    language: getLanguage(filePath),
    line,
    column,
  }
}

function orderPinnedTabs(tabs: EditorTab[]): EditorTab[] {
  const pinned: EditorTab[] = []
  const unpinned: EditorTab[] = []
  for (const tab of tabs) {
    if (tab.isPinned) pinned.push(tab)
    else unpinned.push(tab)
  }
  return [...pinned, ...unpinned]
}

function rebaseMovedTab(
  tab: EditorTab,
  oldPath: string,
  newPath: string
): EditorTab {
  // A Git comparison stays attached to its revision path after a rename.
  if (tab.diff) return tab
  const filePath = rebaseEditorPath(tab.filePath, oldPath, newPath)
  if (!filePath) return tab
  return {
    ...tab,
    filePath,
    documentVersion: tab.documentVersion + 1,
    isLoading: false,
    fileName: getFileName(filePath),
    language: getLanguage(filePath),
  }
}

function rebaseMovedLocation(
  location: EditorLocation,
  oldPath: string,
  newPath: string
): EditorLocation {
  if (location.diff) return location
  const filePath = rebaseEditorPath(location.filePath, oldPath, newPath)
  return filePath ? { ...location, filePath } : location
}

function rebaseMovedRecentFile(
  file: EditorRecentFile,
  oldPath: string,
  newPath: string
): EditorRecentFile {
  const filePath = rebaseEditorPath(file.filePath, oldPath, newPath)
  if (!filePath) return file
  return {
    ...file,
    filePath,
    fileName: getFileName(filePath),
    language: getLanguage(filePath),
  }
}

function reusablePreviewTab(tabs: EditorTab[]): EditorTab | null {
  return (
    tabs.find((tab) => tab.isPreview && !tab.isDirty && !tab.isPinned) ?? null
  )
}

type EditorStateSetter = (
  update: (state: EditorState) => Partial<EditorState>
) => void

/** Commit a disk read only to the unchanged document that requested it. */
async function reloadEditorDocument(
  get: () => EditorState,
  set: EditorStateSetter,
  tabId: string,
  mode: "initial" | "disk" | "ai"
): Promise<void> {
  const snapshot = get().tabs.find((tab) => tab.id === tabId)
  if (
    !snapshot ||
    snapshot.diff ||
    (snapshot.fileKind ?? "text") !== "text" ||
    snapshot.isDirty
  )
    return
  const generation = snapshot.readGeneration + 1
  set((state) => ({
    tabs: state.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, readGeneration: generation } : tab
    ),
  }))
  const mayCommit = (tab: EditorTab) =>
    tab.id === tabId &&
    tab.documentVersion === snapshot.documentVersion &&
    tab.filePath === snapshot.filePath &&
    tab.revision === snapshot.revision &&
    tab.readGeneration === generation &&
    !tab.isDirty
  try {
    const { content } = await readFile(snapshot.filePath)
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (!mayCommit(tab)) return tab
        return {
          ...tab,
          content,
          originalContent: content,
          revision: tab.revision + 1,
          isDirty: false,
          isLoading: false,
          aiBaselineContent:
            mode === "ai"
              ? content === tab.content
                ? tab.aiBaselineContent
                : (tab.aiBaselineContent ?? tab.content)
              : null,
        }
      }),
    }))
  } catch (error) {
    if (mode !== "initial") {
      log.warn("Failed to reload file:", snapshot.filePath, error)
      return
    }
    const content =
      error instanceof HttpError && error.status === 404
        ? `// File not found: ${snapshot.filePath}`
        : "// Failed to load file"
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        mayCommit(tab)
          ? { ...tab, content, isLoading: false, revision: tab.revision + 1 }
          : tab
      ),
    }))
  }
}

export const useEditorStore = create<EditorState>((set, get) => {
  // Serialize disk writes per path, including a tab closed and reopened during save.
  const saveTails = new Map<string, Promise<EditorSaveResult>>()
  return {
    tabs: [],
    activeTabId: null,
    navigationBackStack: [],
    navigationForwardStack: [],
    recentlyClosedTabs: [],
    recentFiles: [],

    openDiff: (target, options = {}) => {
      target = { ...target, path: normalizeEditorPath(target.path) }
      dispatchEditorFileActivate()
      const state = get()
      const existing = state.tabs.find(
        (tab) => tab.diff && editorDiffKey(tab.diff) === editorDiffKey(target)
      )
      if (existing) {
        if (!options.preview)
          set((s) => ({
            tabs: s.tabs.map((tab) =>
              tab.id === existing.id ? { ...tab, isPreview: false } : tab
            ),
          }))
        get().setActiveTab(existing.id, options)
        return
      }
      const preview = options.preview ? reusablePreviewTab(state.tabs) : null
      const tab: EditorTab = {
        id: crypto.randomUUID(),
        diff: { ...target },
        filePath: resolveWorkspaceFilePath(target.cwd, target.path),
        fileName: getFileName(target.path),
        language: getLanguage(target.path),
        content: "",
        originalContent: "",
        revision: 0,
        readGeneration: 0,
        documentVersion: 0,
        aiBaselineContent: null,
        isDirty: false,
        isLoading: false,
        isPinned: false,
        isPreview: options.preview === true,
        cursorLine: 1,
        cursorColumn: 1,
        selectionLineCount: 0,
        selectionCharCount: 0,
      }
      set((s) => ({
        tabs: orderPinnedTabs(
          preview
            ? s.tabs.map((item) => (item.id === preview.id ? tab : item))
            : [...s.tabs, tab]
        ),
        activeTabId: tab.id,
        navigationBackStack: options.preserveNavigation
          ? s.navigationBackStack
          : appendNavigationLocation(
              s.navigationBackStack,
              currentLocation(state)
            ),
        navigationForwardStack: options.preserveNavigation
          ? s.navigationForwardStack
          : [],
      }))
    },

    openFile: async (filePath: string, options: OpenFileOptions = {}) => {
      dispatchEditorFileActivate()
      const state = get()
      const { tabs } = state
      const before = currentLocation(state)
      const wantsPreview = options.preview === true

      // If file already open, reload content from disk and activate
      const existing = tabs.find((t) => !t.diff && t.filePath === filePath)
      if (existing) {
        const nextLocation = {
          filePath,
          line: options.line ?? existing.cursorLine,
          column: options.column ?? existing.cursorColumn,
        }
        set((s) => ({
          activeTabId: existing.id,
          tabs: s.tabs.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  isPreview: wantsPreview ? t.isPreview : false,
                  cursorLine: nextLocation.line,
                  cursorColumn: nextLocation.column,
                }
              : t
          ),
          navigationBackStack: options.preserveNavigation
            ? s.navigationBackStack
            : appendNavigationLocation(
                s.navigationBackStack,
                before,
                nextLocation
              ),
          navigationForwardStack: options.preserveNavigation
            ? s.navigationForwardStack
            : [],
          recentFiles: rememberRecentFile(
            s.recentFiles,
            recentFileFromPath(filePath, nextLocation.line, nextLocation.column)
          ),
        }))
        // Reload editable text from disk (file may have been modified by AI).
        // Media previews own their binary loading lifecycle and must never be
        // decoded as UTF-8 here.
        if (
          (existing.fileKind ?? "text") !== "text" ||
          existing.isDirty ||
          options.reloadExisting === false
        )
          return
        await reloadEditorDocument(get, set, existing.id, "disk")
        return
      }

      const previewTab = wantsPreview ? reusablePreviewTab(tabs) : null
      const id = previewTab?.id ?? crypto.randomUUID()
      const fileKind = getEditorFileKind(filePath)
      const tab: EditorTab = {
        id,
        filePath,
        fileName: getFileName(filePath),
        fileKind,
        language: getLanguage(filePath),
        content: "",
        originalContent: "",
        revision: 0,
        readGeneration: 0,
        documentVersion: (previewTab?.documentVersion ?? -1) + 1,
        aiBaselineContent: null,
        isDirty: false,
        isLoading: fileKind === "text",
        isPinned: false,
        isPreview: wantsPreview,
        cursorLine: options.line ?? 1,
        cursorColumn: options.column ?? 1,
        selectionLineCount: 0,
        selectionCharCount: 0,
        selectionContext: null,
      }

      set((s) => ({
        tabs: orderPinnedTabs(
          previewTab
            ? s.tabs.map((existingTab) =>
                existingTab.id === previewTab.id ? tab : existingTab
              )
            : [...s.tabs, tab]
        ),
        activeTabId: id,
        navigationBackStack: options.preserveNavigation
          ? s.navigationBackStack
          : appendNavigationLocation(s.navigationBackStack, before, {
              filePath,
              line: tab.cursorLine,
              column: tab.cursorColumn,
            }),
        navigationForwardStack: options.preserveNavigation
          ? s.navigationForwardStack
          : [],
        recentFiles: rememberRecentFile(s.recentFiles, recentFileFromTab(tab)),
      }))

      if (fileKind !== "text") return

      await reloadEditorDocument(get, set, id, "initial")
    },

    reloadFromAi: async (filePath: string) => {
      const { tabs } = get()
      const existing = tabs.find((t) => !t.diff && t.filePath === filePath)
      if (!existing) {
        // The comparison refreshes itself; an AI update must not replace it
        // with an editable document or try to read a deleted revision path.
        if (
          tabs.some(
            (tab) =>
              tab.diff &&
              normalizeEditorPath(tab.filePath) ===
                normalizeEditorPath(filePath)
          )
        )
          return
        // No open tab → fall through to normal openFile (adds a new tab)
        await get().openFile(filePath)
        return
      }
      await reloadEditorDocument(get, set, existing.id, "ai")
    },

    reloadFromDisk: async (filePath: string) => {
      const existing = get().tabs.find(
        (tab) => !tab.diff && tab.filePath === filePath
      )
      if (existing) await reloadEditorDocument(get, set, existing.id, "disk")
    },

    clearAiDiff: (tabId: string) => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, aiBaselineContent: null } : t
        ),
      }))
    },

    closeTab: (tabId: string) => {
      const { tabs, activeTabId } = get()
      const idx = tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return

      const newTabs = tabs.filter((t) => t.id !== tabId)
      let newActive = activeTabId

      if (activeTabId === tabId) {
        if (newTabs.length === 0) {
          newActive = null
        } else if (idx < newTabs.length) {
          newActive = newTabs[idx].id
        } else {
          newActive = newTabs[newTabs.length - 1].id
        }
      }

      const closedTab = tabs[idx]
      if (!closedTab) return

      set((s) => ({
        tabs: newTabs,
        activeTabId: newActive,
        recentlyClosedTabs: rememberClosedTabs(s.recentlyClosedTabs, [
          closedTab,
        ]),
        navigationBackStack: s.navigationBackStack.filter(
          (location) => documentKey(location) !== documentKey(closedTab)
        ),
        navigationForwardStack: s.navigationForwardStack.filter(
          (location) => documentKey(location) !== documentKey(closedTab)
        ),
      }))
    },

    activateAdjacentTab: (direction: "previous" | "next") => {
      const state = get()
      if (state.tabs.length <= 1) return
      const currentIndex = state.tabs.findIndex(
        (tab) => tab.id === state.activeTabId
      )
      const baseIndex = currentIndex === -1 ? 0 : currentIndex
      const nextIndex =
        direction === "previous"
          ? (baseIndex - 1 + state.tabs.length) % state.tabs.length
          : (baseIndex + 1) % state.tabs.length
      const target = state.tabs[nextIndex]
      if (target) get().setActiveTab(target.id)
    },

    setActiveTab: (tabId: string, options = {}) => {
      const state = get()
      const destinationTab = state.tabs.find((tab) => tab.id === tabId)
      if (!destinationTab) return
      dispatchEditorFileActivate()
      if (state.activeTabId === tabId) return
      const before = currentLocation(state)
      const destination = {
        filePath: destinationTab.filePath,
        ...(destinationTab.diff ? { diff: destinationTab.diff } : {}),
        line: destinationTab.cursorLine,
        column: destinationTab.cursorColumn,
      }
      set((s) => ({
        activeTabId: tabId,
        navigationBackStack: options.preserveNavigation
          ? s.navigationBackStack
          : appendNavigationLocation(
              s.navigationBackStack,
              before,
              destination
            ),
        navigationForwardStack: options.preserveNavigation
          ? s.navigationForwardStack
          : [],
        recentFiles: rememberRecentFile(
          s.recentFiles,
          recentFileFromTab(destinationTab)
        ),
      }))
    },

    updateContent: (tabId: string, content: string) => {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== tabId || t.diff || (t.fileKind ?? "text") !== "text")
            return t
          const isDirty = content !== t.originalContent
          // If user starts typing while an AI diff overlay is showing, clear it
          // so their edits aren't confusingly highlighted as AI changes.
          const aiBaselineContent = isDirty ? null : t.aiBaselineContent
          return {
            ...t,
            content,
            revision: t.revision + 1,
            isLoading: false,
            isDirty,
            aiBaselineContent,
            isPreview: isDirty ? false : t.isPreview,
          }
        }),
      }))
    },

    updateCursor: (tabId: string, line: number, column: number, selection) => {
      set((s) => {
        const activeFilePath =
          s.activeTabId === tabId
            ? (s.tabs.find((tab) => tab.id === tabId)?.filePath ?? null)
            : null
        return {
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  cursorLine: line,
                  cursorColumn: column,
                  ...(selection
                    ? {
                        selectionLineCount: selection.lineCount,
                        selectionCharCount: selection.charCount,
                        selectionContext:
                          selection.charCount > 0 && "text" in selection
                            ? selection
                            : null,
                      }
                    : {}),
                }
              : t
          ),
          recentFiles: activeFilePath
            ? s.recentFiles.map((file) =>
                file.filePath === activeFilePath
                  ? { ...file, line, column }
                  : file
              )
            : s.recentFiles,
        }
      })
    },

    recordNavigationPoint: () => {
      const location = currentLocation(get())
      set((s) => ({
        navigationBackStack: appendNavigationLocation(
          s.navigationBackStack,
          location
        ),
        navigationForwardStack: [],
      }))
    },

    goBack: async () => {
      const state = get()
      const destination = state.navigationBackStack.at(-1)
      if (!destination) return
      const current = currentLocation(state)
      set((s) => ({
        navigationBackStack: s.navigationBackStack.slice(0, -1),
        navigationForwardStack: appendNavigationLocation(
          s.navigationForwardStack,
          current,
          destination
        ),
      }))
      if (destination.diff) {
        get().openDiff(destination.diff, { preserveNavigation: true })
        return
      }
      await get().openFile(destination.filePath, {
        line: destination.line,
        column: destination.column,
        preserveNavigation: true,
        reloadExisting: false,
      })
      dispatchEditorGotoLine(
        {
          filePath: destination.filePath,
          line: destination.line,
          column: destination.column,
          preserveNavigation: true,
        },
        { defer: true }
      )
    },

    goForward: async () => {
      const state = get()
      const destination = state.navigationForwardStack.at(-1)
      if (!destination) return
      const current = currentLocation(state)
      set((s) => ({
        navigationBackStack: appendNavigationLocation(
          s.navigationBackStack,
          current,
          destination
        ),
        navigationForwardStack: s.navigationForwardStack.slice(0, -1),
      }))
      if (destination.diff) {
        get().openDiff(destination.diff, { preserveNavigation: true })
        return
      }
      await get().openFile(destination.filePath, {
        line: destination.line,
        column: destination.column,
        preserveNavigation: true,
        reloadExisting: false,
      })
      dispatchEditorGotoLine(
        {
          filePath: destination.filePath,
          line: destination.line,
          column: destination.column,
          preserveNavigation: true,
        },
        { defer: true }
      )
    },

    applyDocumentChanges: (changes, guards = []) => {
      let result: EditorChangeResult = { status: "conflict", filePaths: [] }
      set((state) => {
        const byId = new Map(state.tabs.map((tab) => [tab.id, tab]))
        const expectations = [
          ...guards,
          ...changes.map((change) => change.expected),
        ]
        const conflicts = expectations.filter(
          (expected) => !matchesDocument(byId.get(expected.id), expected)
        )
        const ids = changes.map((change) => change.expected.id)
        if (conflicts.length || new Set(ids).size !== ids.length) {
          result = {
            status: "conflict",
            filePaths: [
              ...new Set(
                (conflicts.length ? conflicts : expectations).map(
                  (expected) => expected.filePath
                )
              ),
            ],
          }
          return state
        }
        const byChangeId = new Map(
          changes.map((change) => [change.expected.id, change])
        )
        result = { status: "applied", changedTabIds: ids }
        return {
          tabs: state.tabs.map((tab) => {
            const change = byChangeId.get(tab.id)
            if (!change || change.content === tab.content) return tab
            return {
              ...tab,
              content: change.content,
              revision: tab.revision + 1,
              isDirty: change.content !== tab.originalContent,
              isLoading: false,
              isPreview: false,
              aiBaselineContent: null,
            }
          }),
        }
      })
      return result
    },

    saveTab: async (tabId: string): Promise<EditorSaveResult> => {
      const snapshot = get().tabs.find((tab) => tab.id === tabId)
      if (!snapshot) return { status: "skipped", tabId, reason: "closed" }
      if (snapshot.diff || (snapshot.fileKind ?? "text") !== "text")
        return { status: "skipped", tabId, reason: "read-only" }
      if (!snapshot.isDirty)
        return { status: "skipped", tabId, reason: "unchanged" }
      const key = normalizeEditorPath(snapshot.filePath)
      const previous = saveTails.get(key) ?? Promise.resolve()
      const sameDocument = (tab: EditorTab) =>
        tab.id === tabId &&
        tab.documentVersion === snapshot.documentVersion &&
        tab.filePath === snapshot.filePath
      const pending = previous
        .catch(() => undefined)
        .then(async (): Promise<EditorSaveResult> => {
          if (!get().tabs.some(sameDocument))
            return { status: "skipped", tabId, reason: "document-changed" }
          const dir = snapshot.filePath.substring(
            0,
            Math.max(
              snapshot.filePath.lastIndexOf("/"),
              snapshot.filePath.lastIndexOf("\\")
            ) + 1
          )
          try {
            await writeFile(dir, snapshot.fileName, snapshot.content)
          } catch (error) {
            throw new EditorSaveError(snapshot.filePath, error)
          }
          set((state) => ({
            tabs: state.tabs.map((tab) =>
              sameDocument(tab)
                ? {
                    ...tab,
                    originalContent: snapshot.content,
                    isDirty: tab.content !== snapshot.content,
                    aiBaselineContent: null,
                  }
                : tab
            ),
          }))
          const current = get().tabs.find(sameDocument)
          return {
            status: "saved",
            tabId,
            filePath: snapshot.filePath,
            savedRevision: snapshot.revision,
            hasUnsavedChanges: !!current?.isDirty,
          }
        })
      saveTails.set(key, pending)
      try {
        return await pending
      } finally {
        if (saveTails.get(key) === pending) saveTails.delete(key)
      }
    },

    saveActiveTab: async () => {
      const { activeTabId } = get()
      return activeTabId ? get().saveTab(activeTabId) : null
    },

    saveAllTabs: async () => {
      const dirtyIds = get()
        .tabs.filter((tab) => tab.isDirty)
        .map((tab) => tab.id)
      const results: EditorSaveResult[] = []
      const failures: unknown[] = []
      for (const tabId of dirtyIds) {
        try {
          results.push(await get().saveTab(tabId))
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          failures
            .map((error) =>
              error instanceof Error ? error.message : String(error)
            )
            .join("\n")
        )
      return results
    },

    moveTab: (tabId: string, direction: "left" | "right") => {
      set((state) => {
        const index = state.tabs.findIndex((tab) => tab.id === tabId)
        if (index === -1) return state
        const nextIndex = direction === "left" ? index - 1 : index + 1
        if (nextIndex < 0 || nextIndex >= state.tabs.length) return state
        const tabs = [...state.tabs]
        const current = tabs[index]
        const target = tabs[nextIndex]
        if (!current || !target) return state
        if (current.isPinned !== target.isPinned) return state
        tabs[index] = target
        tabs[nextIndex] = current
        return { tabs }
      })
    },

    togglePinTab: (tabId: string) => {
      set((state) => ({
        tabs: orderPinnedTabs(
          state.tabs.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  isPinned: !tab.isPinned,
                  isPreview: tab.isPinned ? tab.isPreview : false,
                }
              : tab
          )
        ),
      }))
    },

    closeOtherTabs: (tabId: string) => {
      const state = get()
      const keep = state.tabs.find((tab) => tab.id === tabId)
      if (!keep) return
      const keptTabs = state.tabs.filter(
        (tab) => tab.id === tabId || tab.isPinned
      )
      const keptPaths = new Set(keptTabs.map(documentKey))
      const closedTabs = state.tabs.filter(
        (tab) => tab.id !== tabId && !tab.isPinned
      )
      set({
        tabs: keptTabs,
        activeTabId: keep.id,
        recentlyClosedTabs: rememberClosedTabs(
          state.recentlyClosedTabs,
          closedTabs
        ),
        navigationBackStack: state.navigationBackStack.filter((location) =>
          keptPaths.has(documentKey(location))
        ),
        navigationForwardStack: state.navigationForwardStack.filter(
          (location) => keptPaths.has(documentKey(location))
        ),
      })
    },

    closeTabsToRight: (tabId: string) => {
      const state = get()
      const index = state.tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1 || index === state.tabs.length - 1) return
      const closedTabs = state.tabs
        .slice(index + 1)
        .filter((tab) => !tab.isPinned)
      if (closedTabs.length === 0) return
      const closedIds = new Set(closedTabs.map((tab) => tab.id))
      const keepTabs = state.tabs.filter((tab) => !closedIds.has(tab.id))
      const keepPaths = new Set(keepTabs.map(documentKey))
      set({
        tabs: keepTabs,
        activeTabId: keepTabs.some((tab) => tab.id === state.activeTabId)
          ? state.activeTabId
          : tabId,
        recentlyClosedTabs: rememberClosedTabs(
          state.recentlyClosedTabs,
          closedTabs
        ),
        navigationBackStack: state.navigationBackStack.filter((location) =>
          keepPaths.has(documentKey(location))
        ),
        navigationForwardStack: state.navigationForwardStack.filter(
          (location) => keepPaths.has(documentKey(location))
        ),
      })
    },

    closeSavedTabs: () => {
      const state = get()
      const keptTabs = state.tabs.filter((tab) => tab.isDirty || tab.isPinned)
      const closedTabs = state.tabs.filter(
        (tab) => !tab.isDirty && !tab.isPinned
      )
      const keptPaths = new Set(keptTabs.map(documentKey))
      const activeStillOpen = keptTabs.some(
        (tab) => tab.id === state.activeTabId
      )
      set({
        tabs: keptTabs,
        activeTabId: activeStillOpen
          ? state.activeTabId
          : (keptTabs[0]?.id ?? null),
        recentlyClosedTabs: rememberClosedTabs(
          state.recentlyClosedTabs,
          closedTabs
        ),
        navigationBackStack: state.navigationBackStack.filter((location) =>
          keptPaths.has(documentKey(location))
        ),
        navigationForwardStack: state.navigationForwardStack.filter(
          (location) => keptPaths.has(documentKey(location))
        ),
      })
    },

    closeAllTabs: () => {
      const state = get()
      const keptTabs = state.tabs.filter((tab) => tab.isPinned)
      const keptPaths = new Set(keptTabs.map(documentKey))
      const closableTabs = state.tabs.filter((tab) => !tab.isPinned)
      const activeIndex = state.tabs.findIndex(
        (tab) => tab.id === state.activeTabId
      )
      const closedTabs =
        activeIndex === -1
          ? closableTabs
          : [
              state.tabs[activeIndex],
              ...state.tabs.slice(activeIndex + 1),
              ...state.tabs.slice(0, activeIndex),
            ].filter((tab): tab is EditorTab => Boolean(tab) && !tab.isPinned)
      set({
        tabs: keptTabs,
        activeTabId: keptTabs.some((tab) => tab.id === state.activeTabId)
          ? state.activeTabId
          : (keptTabs[0]?.id ?? null),
        recentlyClosedTabs: rememberClosedTabs(
          state.recentlyClosedTabs,
          closedTabs
        ),
        navigationBackStack: state.navigationBackStack.filter((location) =>
          keptPaths.has(documentKey(location))
        ),
        navigationForwardStack: state.navigationForwardStack.filter(
          (location) => keptPaths.has(documentKey(location))
        ),
      })
    },

    reopenClosedTab: async () => {
      const state = get()
      const [closedTab, ...rest] = state.recentlyClosedTabs
      if (!closedTab) return

      if (closedTab.diff) {
        set({ recentlyClosedTabs: rest })
        get().openDiff(closedTab.diff)
        return
      }

      const existing = state.tabs.find(
        (tab) => !tab.diff && tab.filePath === closedTab.filePath
      )
      if (existing) {
        set({ recentlyClosedTabs: rest })
        get().setActiveTab(existing.id)
        return
      }

      const id = crypto.randomUUID()
      // Saved documents were closed without their text; read the current file.
      const readsFromDisk =
        !closedTab.isDirty && (closedTab.fileKind ?? "text") === "text"
      const reopened: EditorTab = {
        ...closedTab,
        id,
        readGeneration: 0,
        isLoading: readsFromDisk,
        isPreview: false,
      }
      const before = currentLocation(state)
      set((s) => ({
        tabs: orderPinnedTabs([...s.tabs, reopened]),
        activeTabId: id,
        recentlyClosedTabs: rest,
        recentFiles: rememberRecentFile(
          s.recentFiles,
          recentFileFromTab(reopened)
        ),
        navigationBackStack: appendNavigationLocation(
          s.navigationBackStack,
          before,
          {
            filePath: reopened.filePath,
            line: reopened.cursorLine,
            column: reopened.cursorColumn,
          }
        ),
        navigationForwardStack: [],
      }))
      if (readsFromDisk) await reloadEditorDocument(get, set, id, "initial")
    },

    handlePathMoved: (oldPath: string, newPath: string) => {
      set((state) => ({
        tabs: state.tabs.map((tab) => rebaseMovedTab(tab, oldPath, newPath)),
        navigationBackStack: state.navigationBackStack.map((location) =>
          rebaseMovedLocation(location, oldPath, newPath)
        ),
        navigationForwardStack: state.navigationForwardStack.map((location) =>
          rebaseMovedLocation(location, oldPath, newPath)
        ),
        recentlyClosedTabs: state.recentlyClosedTabs.map((tab) =>
          rebaseMovedTab(tab, oldPath, newPath)
        ),
        recentFiles: state.recentFiles.map((file) =>
          rebaseMovedRecentFile(file, oldPath, newPath)
        ),
      }))
    },

    handlePathDeleted: (path: string) => {
      const state = get()
      const closedTabs = state.tabs.filter(
        (tab) => !tab.diff && isEditorPathEqualOrInside(tab.filePath, path)
      )
      const closedIds = new Set(closedTabs.map((tab) => tab.id))
      const keptTabs = state.tabs.filter((tab) => !closedIds.has(tab.id))
      const activeDeleted =
        state.activeTabId !== null && closedIds.has(state.activeTabId)
      const firstClosedIndex = state.tabs.findIndex((tab) =>
        closedIds.has(tab.id)
      )
      const nextActiveTab =
        firstClosedIndex === -1
          ? keptTabs.at(-1)
          : (keptTabs[Math.min(firstClosedIndex, keptTabs.length - 1)] ?? null)

      set({
        tabs: keptTabs,
        activeTabId: activeDeleted
          ? (nextActiveTab?.id ?? null)
          : state.activeTabId,
        recentlyClosedTabs: rememberClosedTabs(
          state.recentlyClosedTabs,
          closedTabs
        ),
        navigationBackStack: state.navigationBackStack.filter(
          (location) =>
            location.diff || !isEditorPathEqualOrInside(location.filePath, path)
        ),
        navigationForwardStack: state.navigationForwardStack.filter(
          (location) =>
            location.diff || !isEditorPathEqualOrInside(location.filePath, path)
        ),
        recentFiles: state.recentFiles.filter(
          (file) => !isEditorPathEqualOrInside(file.filePath, path)
        ),
      })
    },
  }
})
