import { create } from "zustand"
import type { PermissionLevel } from "@betterc0de/schema/chat-controls"
import { getWindowAppMode, setWindowAppMode } from "@/lib/launch-params"
import type { ProviderComposerSelectionMap } from "@/lib/provider-composer-selection"
import {
  MAX_PROMPT_HISTORY_ENTRIES,
  type PromptHistoryEntry,
} from "@/lib/prompt-history"
import {
  MAX_PROMPT_STASH_ENTRIES,
  type PromptStashEntry,
} from "@/lib/prompt-stash"

// ── Types ──

export type ContextWindow = "200k" | "1m"
export type AppMode = "agent" | "editor" | "design"
export type WorkspaceTab =
  | "overview"
  | "plan"
  | "files"
  | "git"
  | "diff"
  | "browser"
/** Which view fills the LeftSidebar's content slot in editor mode. The
 *  ActivityBar toggles between these — VS-Code pattern where clicking
 *  Files, Outline, Source Control, or Agents in the icon strip swaps the
 *  whole sidebar instead of stacking them. */
export type EditorSidebarView =
  | "files"
  | "search"
  | "map"
  | "references"
  | "outline"
  | "source-control"
  | "diff"
  | "agents"
/** The composer's permission presets (shared with the phone app). */
export type { PermissionLevel }
export type AgentWindowMode = "sidebar" | "tab" | "popout" | "fullscreen"

export interface PreferencesState {
  // Model/Chat Preferences
  selectedModel: string
  selectedProviderId: string
  modelSelectionByProvider: ProviderComposerSelectionMap
  contextWindow: ContextWindow
  thinkingMode: string | null
  webSearch: boolean
  chatMode: string
  specialMode: string | null
  agentWindowMode: AgentWindowMode
  /**
   * Codex / Claude CLI Fast Mode toggle (priority compute).
   *   - Codex: maps to `serviceTier: "fast"` on the wire.
   *   - Claude CLI: maps to `settings.fastMode: true` in the Agent SDK.
   * Persisted across sessions like the other model-pref toggles.
   */
  fastMode: boolean

  // UI/Layout Preferences
  sidebarOpen: boolean
  sidebarWidth: number
  rightSidebarOpen: boolean
  rightSidebarWidth: number
  workspaceSidebarOpen: boolean
  explorerWidth: number
  diffFileListWidth: number
  chatPanelWidth: number
  editorSplitRatio: number
  editorWordWrap: boolean
  editorMinimap: boolean
  editorStickyScroll: boolean
  editorRenderWhitespace: boolean
  editorInlayHints: boolean
  editorLineNumbers: boolean

  // Panel States
  fileTreeOpen: boolean
  terminalOpen: boolean
  diffOpen: boolean
  consolePanelOpen: boolean
  consolePanelHeight: number

  // Mode/Tab
  appMode: AppMode
  workspaceTab: WorkspaceTab
  editorSidebarView: EditorSidebarView
  permissionLevel: PermissionLevel

  // Collections (migrated from legacy bc_* keys)
  hiddenProviders: string[]
  hiddenModels: string[]
  favorites: string[]
  promptHistoryEntries: PromptHistoryEntry[]
  promptStashEntries: PromptStashEntry[]
  providerVisibilityDefaultsVersion: number

  // Actions
  set: <
    K extends keyof Omit<
      PreferencesState,
      "set" | "setMultiple" | "save" | "load" | "reset"
    >,
  >(
    key: K,
    value: PreferencesState[K]
  ) => void
  setMultiple: (patch: Partial<PreferencesState>) => void
  save: () => void
  load: () => void
  reset: () => void
}

// ── Constants ──

const STORAGE_KEY = "betterc0de-preferences"
const RESET_EPOCH_STORAGE_KEY = `${STORAGE_KEY}:reset-epoch`
const PROVIDER_VISIBILITY_DEFAULTS_VERSION = 12

export const DEFAULT_HIDDEN_PROVIDERS = ["or-qwen", "or-deepseek"] as const

const PROVIDER_ACTIVATION_ALIASES: Record<string, readonly string[]> = {
  "anthropic-api": ["anthropic-api", "anthropic", "claude-api"],
  "or-qwen": ["or-qwen", "qwen"],
  qwen: ["or-qwen", "qwen"],
  "or-deepseek": ["or-deepseek", "deepseek"],
  deepseek: ["or-deepseek", "deepseek"],
}

const DEFAULTS: Omit<
  PreferencesState,
  "set" | "setMultiple" | "save" | "load" | "reset"
> = {
  // Model/Chat
  selectedModel: "claude-fable-5-1",
  selectedProviderId: "claude",
  modelSelectionByProvider: {},
  contextWindow: "1m",
  thinkingMode: "High",
  webSearch: false,
  chatMode: "agent",
  specialMode: null,
  agentWindowMode: "sidebar",
  fastMode: false,

  // UI/Layout
  sidebarOpen: true,
  sidebarWidth: 300,
  rightSidebarOpen: true,
  rightSidebarWidth: 380,
  workspaceSidebarOpen: true,
  explorerWidth: 240,
  diffFileListWidth: 280,
  chatPanelWidth: 450,
  editorSplitRatio: 0.5,
  editorWordWrap: false,
  editorMinimap: true,
  editorStickyScroll: true,
  editorRenderWhitespace: false,
  editorInlayHints: true,
  editorLineNumbers: true,

  // Panel States
  fileTreeOpen: false,
  terminalOpen: false,
  diffOpen: false,
  consolePanelOpen: false,
  consolePanelHeight: 250,

  // Mode/Tab
  appMode: "agent",
  workspaceTab: "overview",
  editorSidebarView: "files",
  permissionLevel: "ask-on-edit",

  // Collections
  hiddenProviders: [...DEFAULT_HIDDEN_PROVIDERS],
  hiddenModels: [],
  favorites: [],
  promptHistoryEntries: [],
  promptStashEntries: [],
  providerVisibilityDefaultsVersion: PROVIDER_VISIBILITY_DEFAULTS_VERSION,
}

// ── Helper Functions ──

function migrateLegacyKeys(): Partial<PreferencesState> {
  const migrated: Partial<PreferencesState> = {}

  // Migrate bc_hidden_providers
  try {
    const raw = localStorage.getItem("bc_hidden_providers")
    if (raw) {
      const providers = JSON.parse(raw)
      if (Array.isArray(providers) && providers.length > 0) {
        migrated.hiddenProviders = providers
        localStorage.removeItem("bc_hidden_providers")
      }
    }
  } catch {
    // Silent fail
  }

  // Migrate bc_hidden_models
  try {
    const raw = localStorage.getItem("bc_hidden_models")
    if (raw) {
      const models = JSON.parse(raw)
      if (Array.isArray(models) && models.length > 0) {
        migrated.hiddenModels = models
        localStorage.removeItem("bc_hidden_models")
      }
    }
  } catch {
    // Silent fail
  }

  // Migrate bc_favorites
  try {
    const raw = localStorage.getItem("bc_favorites")
    if (raw) {
      const favs = JSON.parse(raw)
      if (Array.isArray(favs) && favs.length > 0) {
        migrated.favorites = favs
        localStorage.removeItem("bc_favorites")
      }
    }
  } catch {
    // Silent fail
  }

  return migrated
}

type PreferenceData = typeof DEFAULTS
type PreferenceDataKey = keyof PreferenceData
type StoredPreferences = Partial<PreferenceData>

const STRING_COLLECTION_LIMIT = 1_000
const ENUM_PREFERENCE_VALUES: Partial<
  Record<PreferenceDataKey, ReadonlySet<string>>
> = {
  contextWindow: new Set<ContextWindow>(["200k", "1m"]),
  appMode: new Set<AppMode>(["agent", "editor", "design"]),
  // "terminal" was removed as a workspace tab (the agent-mode terminal
  // lives in the bottom panel / pane tabs now); stale stored values fall
  // back to the "plan" default via the enum sanitizer.
  workspaceTab: new Set<WorkspaceTab>([
    "overview",
    "plan",
    "files",
    "git",
    "diff",
    "browser",
  ]),
  editorSidebarView: new Set<EditorSidebarView>([
    "files",
    "search",
    "map",
    "references",
    "outline",
    "source-control",
    "diff",
    "agents",
  ]),
  permissionLevel: new Set<PermissionLevel>([
    "read-only",
    "ask-on-edit",
    "default",
    "allow-edits",
    "bypass",
  ]),
  agentWindowMode: new Set<AgentWindowMode>([
    "sidebar",
    "tab",
    "popout",
    "fullscreen",
  ]),
}

function sanitizeStoredPreferences(value: unknown): StoredPreferences {
  if (!isPlainRecord(value)) return {}
  const sanitized: Partial<Record<PreferenceDataKey, unknown>> = {}

  for (const key of Object.keys(DEFAULTS) as PreferenceDataKey[]) {
    const candidate = value[key]
    const fallback = DEFAULTS[key]
    if (candidate === undefined) continue

    if (key === "promptHistoryEntries") {
      sanitized[key] = sanitizePromptEntries(
        candidate,
        MAX_PROMPT_HISTORY_ENTRIES
      )
      continue
    }
    if (key === "promptStashEntries") {
      sanitized[key] = sanitizePromptEntries(
        candidate,
        MAX_PROMPT_STASH_ENTRIES
      )
      continue
    }
    if (
      key === "hiddenProviders" ||
      key === "hiddenModels" ||
      key === "favorites"
    ) {
      const collection = sanitizeStringCollection(candidate)
      if (collection) sanitized[key] = collection
      continue
    }
    if (key === "modelSelectionByProvider") {
      if (isPlainRecord(candidate)) sanitized[key] = candidate
      continue
    }
    if (fallback === null) {
      if (candidate === null || typeof candidate === "string") {
        sanitized[key] = candidate
      }
      continue
    }
    if (typeof fallback === "boolean") {
      if (typeof candidate === "boolean") sanitized[key] = candidate
      continue
    }
    if (typeof fallback === "number") {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        sanitized[key] = candidate
      }
      continue
    }
    if (typeof fallback === "string" && typeof candidate === "string") {
      const allowed = ENUM_PREFERENCE_VALUES[key]
      if (!allowed || allowed.has(candidate)) sanitized[key] = candidate
    }
  }

  return sanitized as StoredPreferences
}

function parseStoredPreferences(raw: string | null): StoredPreferences {
  if (!raw) return {}
  try {
    return sanitizeStoredPreferences(JSON.parse(raw) as unknown)
  } catch {
    return {}
  }
}

function mergeProviderSelectionMaps(
  stored: ProviderComposerSelectionMap | undefined,
  patch: ProviderComposerSelectionMap | undefined
): ProviderComposerSelectionMap {
  const merged: ProviderComposerSelectionMap = { ...(stored ?? {}) }
  for (const [providerId, selection] of Object.entries(patch ?? {})) {
    merged[providerId] = {
      ...(merged[providerId] ?? {}),
      ...selection,
    }
  }
  return merged
}

function mergePreferencePatch(
  stored: StoredPreferences,
  patch: StoredPreferences
): PreferenceData {
  const merged = {
    ...DEFAULTS,
    ...stored,
    ...patch,
  }
  if (patch.modelSelectionByProvider !== undefined) {
    merged.modelSelectionByProvider = mergeProviderSelectionMaps(
      stored.modelSelectionByProvider,
      patch.modelSelectionByProvider
    )
  }
  return merged
}

function mergeDirtyPreferencePatches(
  current: StoredPreferences,
  patch: StoredPreferences
): StoredPreferences {
  const merged: StoredPreferences = { ...current, ...patch }
  if (patch.modelSelectionByProvider !== undefined) {
    merged.modelSelectionByProvider = mergeProviderSelectionMaps(
      current.modelSelectionByProvider,
      patch.modelSelectionByProvider
    )
  }
  return merged
}

function sanitizeStringCollection(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(-STRING_COLLECTION_LIMIT)
}

function sanitizePromptEntries(
  value: unknown,
  maxEntries: number
): PromptHistoryEntry[] {
  if (!Array.isArray(value)) return []
  const entries: PromptHistoryEntry[] = []
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) continue
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.input !== "string" ||
      typeof candidate.timestamp !== "number" ||
      !Number.isFinite(candidate.timestamp) ||
      !isOptionalNullableString(candidate.threadId) ||
      !isOptionalNullableString(candidate.projectPath)
    ) {
      continue
    }
    entries.push({
      id: candidate.id,
      input: candidate.input,
      timestamp: candidate.timestamp,
      threadId: candidate.threadId ?? null,
      projectPath: candidate.projectPath ?? null,
    })
  }
  return entries.slice(-maxEntries)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isOptionalNullableString(
  value: unknown
): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string"
}

export function providerActivationKeys(providerId: string): readonly string[] {
  return PROVIDER_ACTIVATION_ALIASES[providerId] ?? [providerId]
}

function providerIdMatchesHiddenFamily(
  candidateId: string | null | undefined,
  defaultHiddenProviderId: string
): boolean {
  if (!candidateId) return false
  const candidate = candidateId.toLowerCase().replace(/[^a-z0-9]/g, "")
  const aliases = providerActivationKeys(defaultHiddenProviderId)
  return aliases.some((alias) => {
    const key = alias.toLowerCase().replace(/[^a-z0-9]/g, "")
    return candidate === key || candidate.includes(key)
  })
}

function hasProviderBeenActivated(
  providerId: string,
  parsed: StoredPreferences
): boolean {
  if (providerIdMatchesHiddenFamily(parsed.selectedProviderId, providerId)) {
    return true
  }

  if (
    Object.keys(parsed.modelSelectionByProvider ?? {}).some((candidateId) =>
      providerIdMatchesHiddenFamily(candidateId, providerId)
    )
  ) {
    return true
  }

  return (
    parsed.favorites?.some((favorite) => {
      if (typeof favorite !== "string") return false
      const providerKey = favorite.split("::", 1)[0]
      return providerIdMatchesHiddenFamily(providerKey, providerId)
    }) === true
  )
}

function applyProviderVisibilityDefaults(
  parsed: StoredPreferences,
  loaded: Partial<PreferencesState>
): Partial<PreferencesState> {
  if (
    parsed.providerVisibilityDefaultsVersion ===
    PROVIDER_VISIBILITY_DEFAULTS_VERSION
  ) {
    return loaded
  }

  const hiddenProviders = new Set(loaded.hiddenProviders ?? [])
  for (const providerId of DEFAULT_HIDDEN_PROVIDERS) {
    if (!hasProviderBeenActivated(providerId, parsed)) {
      hiddenProviders.add(providerId)
    }
  }

  return {
    ...loaded,
    hiddenProviders: [...hiddenProviders],
    providerVisibilityDefaultsVersion: PROVIDER_VISIBILITY_DEFAULTS_VERSION,
  }
}

// ── Store ──

// H7/M2: real debounce + flush on unload.  The previous implementation used
// `setTimeout(..., 0)` which is just a deferral, not a debounce — five rapid
// changes scheduled five independent saves, and any change made in the few
// milliseconds before window close was lost because the macrotask never fired.
const SAVE_DEBOUNCE_MS = 100
let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null
let saveNeeded = false
let pendingSaveResetEpoch: string | null = null
let dirtyPreferencePatch: StoredPreferences = {}

function readResetEpoch(): string | null {
  try {
    return localStorage.getItem(RESET_EPOCH_STORAGE_KEY)
  } catch {
    return null
  }
}

function cancelPendingSave() {
  if (pendingSaveTimer) clearTimeout(pendingSaveTimer)
  pendingSaveTimer = null
  saveNeeded = false
  pendingSaveResetEpoch = null
  dirtyPreferencePatch = {}
}

function persistPreferencePatch(
  patch: StoredPreferences,
  expectedResetEpoch: string | null
): boolean {
  try {
    if (readResetEpoch() !== expectedResetEpoch) return false
    const stored = parseStoredPreferences(localStorage.getItem(STORAGE_KEY))
    const merged = mergePreferencePatch(
      stored,
      sanitizeStoredPreferences(patch)
    )
    if (readResetEpoch() !== expectedResetEpoch) return false
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    return true
  } catch {
    return false
  }
}

function flushPendingSave() {
  if (!saveNeeded) return
  if (pendingSaveTimer) clearTimeout(pendingSaveTimer)
  pendingSaveTimer = null

  const expectedResetEpoch = pendingSaveResetEpoch
  if (readResetEpoch() !== expectedResetEpoch) {
    cancelPendingSave()
    return
  }
  if (!persistPreferencePatch(dirtyPreferencePatch, expectedResetEpoch)) return

  saveNeeded = false
  pendingSaveResetEpoch = null
  dirtyPreferencePatch = {}
}

function scheduleSave(patch: StoredPreferences) {
  const sanitizedPatch = sanitizeStoredPreferences(patch)
  if (Object.keys(sanitizedPatch).length === 0) return

  const resetEpoch = readResetEpoch()
  if (saveNeeded && pendingSaveResetEpoch !== resetEpoch) {
    cancelPendingSave()
  }
  dirtyPreferencePatch = mergeDirtyPreferencePatches(
    dirtyPreferencePatch,
    sanitizedPatch
  )
  saveNeeded = true
  pendingSaveResetEpoch = resetEpoch
  if (pendingSaveTimer) clearTimeout(pendingSaveTimer)
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null
    flushPendingSave()
  }, SAVE_DEBOUNCE_MS)
}

function handlePreferenceStorageEvent(event: StorageEvent) {
  if (
    event.key === RESET_EPOCH_STORAGE_KEY ||
    event.key === null ||
    (event.key === STORAGE_KEY && event.newValue === null)
  ) {
    cancelPendingSave()
    setWindowAppMode(DEFAULTS.appMode)
    usePreferencesStore.setState(DEFAULTS)
    return
  }
  if (event.key !== STORAGE_KEY) return

  const stored = parseStoredPreferences(event.newValue)
  const loaded = applyProviderVisibilityDefaults(stored, {
    ...DEFAULTS,
    ...stored,
  })
  usePreferencesStore.setState({
    ...mergePreferencePatch(
      sanitizeStoredPreferences(loaded),
      dirtyPreferencePatch
    ),
    appMode: usePreferencesStore.getState().appMode,
  })
}

if (typeof window !== "undefined") {
  // Synchronous flush on window close so an immediate Cmd-Q / Ctrl-Q after
  // a preference change still persists. `pagehide` covers the same path on
  // mobile / bfcache, included for completeness.
  const flush = (_get: () => PreferencesState) => () => flushPendingSave()
  // We can't reach the store's `get` until the store is constructed below;
  // wire the flush after the store exists.  The closure variable is set by
  // the store factory — see the IIFE that runs immediately after `create`.
  ;(
    globalThis as {
      __bc_prefs_flush_install?: (g: () => PreferencesState) => void
    }
  ).__bc_prefs_flush_install = (g) => {
    const registrationOwner = globalThis as typeof globalThis & {
      __bcPreferencesListenerRegistration?: { dispose: () => void }
    }
    registrationOwner.__bcPreferencesListenerRegistration?.dispose()

    const beforeUnload = flush(g)
    const pageHide = flush(g)
    window.addEventListener("beforeunload", beforeUnload)
    window.addEventListener("pagehide", pageHide)
    window.addEventListener("storage", handlePreferenceStorageEvent)
    registrationOwner.__bcPreferencesListenerRegistration = {
      dispose: () => {
        window.removeEventListener("beforeunload", beforeUnload)
        window.removeEventListener("pagehide", pageHide)
        window.removeEventListener("storage", handlePreferenceStorageEvent)
        cancelPendingSave()
      },
    }
  }
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  ...DEFAULTS,

  set: (key, value) => {
    const patch = sanitizeStoredPreferences({ [key]: value })
    if (patch.appMode) setWindowAppMode(patch.appMode)
    set(patch)
    scheduleSave(patch)
  },

  setMultiple: (patch) => {
    const sanitizedPatch = sanitizeStoredPreferences(patch)
    if (sanitizedPatch.appMode) setWindowAppMode(sanitizedPatch.appMode)
    set(sanitizedPatch)
    scheduleSave(sanitizedPatch)
  },

  save: () => {
    flushPendingSave()
  },

  load: () => {
    cancelPendingSave()
    try {
      // First, try to load from localStorage
      const raw = localStorage.getItem(STORAGE_KEY)
      let loaded: Partial<PreferencesState> = {}
      let parsed: StoredPreferences = {}
      let visibilityDefaultsApplied = false
      let preferencesSanitized = false

      if (raw) {
        const decoded = JSON.parse(raw) as unknown
        parsed = sanitizeStoredPreferences(decoded)
        preferencesSanitized =
          JSON.stringify(decoded) !== JSON.stringify(parsed)
        // Merge only validated, known preference fields with defaults.
        loaded = { ...DEFAULTS, ...parsed }
      }

      // Migrate legacy keys
      const migrated = migrateLegacyKeys()

      // Merge everything: defaults < stored < migrated < current visibility defaults
      const merged = applyProviderVisibilityDefaults(
        { ...parsed, ...migrated },
        { ...DEFAULTS, ...loaded, ...migrated }
      )
      visibilityDefaultsApplied =
        raw !== null &&
        parsed.providerVisibilityDefaultsVersion !==
          PROVIDER_VISIBILITY_DEFAULTS_VERSION
      set({
        ...merged,
        appMode: getWindowAppMode(merged.appMode ?? DEFAULTS.appMode),
      })

      // Save if we migrated anything
      if (
        preferencesSanitized ||
        visibilityDefaultsApplied ||
        Object.keys(migrated).length > 0
      ) {
        const repairPatch = sanitizeStoredPreferences({
          ...migrated,
          ...(visibilityDefaultsApplied
            ? {
                hiddenProviders: merged.hiddenProviders,
                providerVisibilityDefaultsVersion:
                  PROVIDER_VISIBILITY_DEFAULTS_VERSION,
              }
            : {}),
        })
        persistPreferencePatch(repairPatch, readResetEpoch())
      }
    } catch {
      // Heal malformed storage so every future startup does not repeat the
      // same parse failure.
      set({ ...DEFAULTS, appMode: getWindowAppMode(DEFAULTS.appMode) })
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        // Storage may itself be unavailable.
      }
    }
  },

  reset: () => {
    cancelPendingSave()
    setWindowAppMode(DEFAULTS.appMode)
    set(DEFAULTS)

    try {
      localStorage.setItem(
        RESET_EPOCH_STORAGE_KEY,
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
      )
      localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem("bc_hidden_providers")
      localStorage.removeItem("bc_hidden_models")
      localStorage.removeItem("bc_favorites")
    } catch {
      // Storage may be unavailable; in-memory defaults still apply.
    }
  },
}))

// H7/M2: now that the store exists, install the beforeunload / pagehide
// flush so debounced preference changes are persisted on rapid close.
if (typeof window !== "undefined") {
  const installer = (
    globalThis as {
      __bc_prefs_flush_install?: (g: () => PreferencesState) => void
    }
  ).__bc_prefs_flush_install
  if (installer) installer(() => usePreferencesStore.getState())
}

// ── Export defaults for reference ──

export const PREFERENCE_DEFAULTS = DEFAULTS
