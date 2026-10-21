import { create } from "zustand"
import { getSettings, updateSettings } from "@/services/backend/coreApi"
import { getCliStatus } from "@/services/backend/providersApi"
import {
  DEFAULT_DESIGN_DEFAULTS,
  type DesignDefaults,
} from "@betterc0de/schema/design"
import type { ChatFolder, SnoozedChat } from "@betterc0de/schema"
import { handleError } from "@/lib/errors"

/**
 * DOM custom event dispatched after a successful `PATCH /settings`. Hooks
 * that poll provider state (`use-provider-status`, `use-provider-instances`,
 * `use-openrouter-models`) listen and refetch so the model picker reflects a
 * newly added or removed key within a frame instead of the next poll tick.
 */
export const SETTINGS_UPDATED_EVENT = "betterc0de:settings-updated"

export interface CliStatus {
  installed: boolean
  version: string | null
  authenticated: boolean
  authType: string | null
  binaryPath: string
}

export interface SettingsState {
  // Persisted
  theme: "system" | "light" | "dark"
  language: string
  timeFormat: "system" | "12h" | "24h"
  enableAssistantStreaming: boolean
  showMessageTimestamps: boolean
  showThinkingBlocks: boolean
  showReasoningSummaries: boolean
  showToolDetails: boolean
  showSessionProgressBar: boolean
  shellToolPartsExpanded: boolean
  editToolPartsExpanded: boolean
  showChatScrollbar: boolean
  showGenericToolOutput: boolean
  concealCodeBlocks: boolean
  /** Agents may answer with ```html-render pages, shown live in the chat. */
  visualReplies: boolean
  autoSaveConversations: boolean
  /** Resume a chat by itself once the usage limit that stopped it resets. */
  resumeAfterUsageLimit: boolean
  /** Continue, once, a chat whose turn a quit or crash interrupted. */
  continueAfterRestart: boolean
  diffWordWrap: boolean
  diffStyle: "auto" | "stacked"
  /** What Enter does while the agent works; Ctrl/Cmd+Enter does the other. */
  whileWorkingEnter: "queue" | "steer"
  confirmArchive: boolean
  confirmDelete: boolean
  autoTrustWorkspaces: boolean
  orchestratorEnabled: boolean
  notificationAgent: boolean
  notificationPermissions: boolean
  notificationErrors: boolean
  toastEnabled: boolean
  toastErrors: boolean
  toastAttention: boolean
  attentionBadges: boolean
  backendLogLevel: "error" | "warn" | "info" | "debug"
  backendLogFormat: "simple" | "json"
  backendTraceHttp: boolean
  backendTraceProviderEvents: boolean
  /** Opt-in: automatic crash and error reports. */
  crashReportsEnabled: boolean
  /** Opt-in: one anonymous usage ping per app start. */
  usagePingEnabled: boolean
  defaultThreadEnvMode: string
  textGenerationModel: string | null
  remoteAccessEnabled: boolean
  remoteAccessCustomUrl: string

  // Rules, skills, MCP servers and hooks are not settings: the desktop
  // configuration lives in BetterC0de's settings folder (lib/runtime-config).

  // Canvas Mode
  designDefaults: DesignDefaults

  // Archived threads
  archivedThreadIds: string[]

  // Folders of the compact chat list, in their order
  chatFolders: ChatFolder[]

  // Chats pinned to the top of the chat lists, in their order
  pinnedThreadIds: string[]

  // Chats snoozed out of the chat lists (lib/chat-snooze.ts)
  snoozedThreads: SnoozedChat[]

  // Runtime
  cliStatus: { claude: CliStatus; codex: CliStatus } | null
  loaded: boolean

  // Actions
  init: () => Promise<void>
  update: (patch: Record<string, unknown>) => Promise<void>
  refreshCli: () => Promise<void>
}

let settingsUpdateGeneration = 0
const latestSettingsUpdateByKey = new Map<keyof SettingsState, number>()
let settingsInitPromise: Promise<void> | null = null

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "dark",
  language: "en",
  timeFormat: "24h",
  enableAssistantStreaming: true,
  showMessageTimestamps: true,
  showThinkingBlocks: true,
  showReasoningSummaries: false,
  showToolDetails: false,
  showSessionProgressBar: true,
  shellToolPartsExpanded: false,
  editToolPartsExpanded: false,
  showChatScrollbar: false,
  showGenericToolOutput: false,
  concealCodeBlocks: false,
  visualReplies: true,
  autoSaveConversations: true,
  resumeAfterUsageLimit: true,
  continueAfterRestart: true,
  diffWordWrap: true,
  diffStyle: "auto",
  whileWorkingEnter: "queue",
  confirmArchive: true,
  confirmDelete: true,
  autoTrustWorkspaces: false,
  orchestratorEnabled: false,
  notificationAgent: true,
  notificationPermissions: true,
  notificationErrors: false,
  toastEnabled: true,
  toastErrors: true,
  toastAttention: true,
  attentionBadges: true,
  backendLogLevel: "info",
  backendLogFormat: "simple",
  backendTraceHttp: false,
  backendTraceProviderEvents: false,
  crashReportsEnabled: false,
  usagePingEnabled: false,
  defaultThreadEnvMode: "local",
  textGenerationModel: null,
  remoteAccessEnabled: false,
  remoteAccessCustomUrl: "",
  designDefaults: DEFAULT_DESIGN_DEFAULTS,
  archivedThreadIds: [],
  chatFolders: [],
  pinnedThreadIds: [],
  snoozedThreads: [],
  cliStatus: null,
  loaded: false,

  init: async () => {
    if (get().loaded) return
    if (settingsInitPromise) return settingsInitPromise
    settingsInitPromise = (async () => {
      try {
        const settings = await getSettings()
        set({ ...settingsPatchToLocalState(settings), loaded: true })
      } catch (error) {
        // Keep `loaded` false so reopening Settings or another startup caller
        // can retry after a transient backend restart.
        console.warn("Failed to load settings; a later init will retry", error)
      }
    })()
    try {
      await settingsInitPromise
    } finally {
      settingsInitPromise = null
    }
  },

  update: (patch) => {
    const pending = (async () => {
      const optimistic = settingsPatchToLocalState(patch)
      const generation = ++settingsUpdateGeneration
      const optimisticKeys = Object.keys(optimistic) as Array<
        keyof PersistedSettingsState
      >
      for (const key of optimisticKeys) {
        latestSettingsUpdateByKey.set(key, generation)
      }
      const current = get()
      const rollback: Partial<SettingsState> = {}
      for (const key of optimisticKeys) {
        ;(rollback as Record<string, unknown>)[key] = current[key]
      }
      set(optimistic)
      try {
        const saved = await updateSettings(patch)
        // The backend is authoritative. This also prevents normalized/defaulted
        // values from drifting away from what was actually persisted.
        const reconciled = settingsPatchToLocalState(saved)
        const applicable: Partial<SettingsState> = {}
        for (const key of Object.keys(reconciled) as Array<
          keyof PersistedSettingsState
        >) {
          if ((latestSettingsUpdateByKey.get(key) ?? 0) <= generation) {
            ;(applicable as Record<string, unknown>)[key] = reconciled[key]
          }
        }
        set(applicable)
        // Notify the model picker (and any other status-aware UI) that
        // settings — and therefore provider configuration — may have
        // changed. `useProviderStatus` listens for this event and refetches
        // `/providers/status` so newly added API keys / removed keys flip
        // the dropdown's enabled state within ~one frame instead of
        // waiting for the next 30 s poll tick.
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT))
        }
      } catch (e) {
        const applicableRollback: Partial<SettingsState> = {}
        for (const key of optimisticKeys) {
          if (latestSettingsUpdateByKey.get(key) === generation) {
            ;(applicableRollback as Record<string, unknown>)[key] =
              rollback[key]
          }
        }
        set(applicableRollback)
        handleError(e, { source: "settings-save" })
        throw e
      }
    })()
    // Toggles may intentionally ignore the result. The error is already shown
    // above; attach a handler while preserving rejection for awaited workflows.
    void pending.catch(() => {})
    return pending
  },

  refreshCli: async () => {
    try {
      const status = await getCliStatus()
      set({ cliStatus: status as { claude: CliStatus; codex: CliStatus } })
    } catch (e) {
      console.warn("Failed to get CLI status:", e)
    }
  },
}))

type PersistedSettingsState = Omit<
  SettingsState,
  "cliStatus" | "loaded" | "init" | "update" | "refreshCli"
>

// One exhaustive mapping for startup, optimistic updates, and server responses.
const settingsFields = {
  orchestratorEnabled: {
    key: "orchestrator_enabled",
    read: (value: unknown) => value === true,
  },
  theme: {
    key: "theme",
    read: (value: unknown) => value as SettingsState["theme"],
  },
  language: { key: "language", read: (value: unknown) => value as string },
  timeFormat: {
    key: "time_format",
    read: (value: unknown) => value as SettingsState["timeFormat"],
  },
  enableAssistantStreaming: {
    key: "enable_assistant_streaming",
    read: (value: unknown) => value !== false,
  },
  showMessageTimestamps: {
    key: "show_message_timestamps",
    read: (value: unknown) => value !== false,
  },
  showThinkingBlocks: {
    key: "show_thinking_blocks",
    read: (value: unknown) => value !== false,
  },
  showReasoningSummaries: {
    key: "show_reasoning_summaries",
    read: (value: unknown) => value === true,
  },
  showToolDetails: {
    key: "show_tool_details",
    read: (value: unknown) => value === true,
  },
  showSessionProgressBar: {
    key: "show_session_progress_bar",
    read: (value: unknown) => value !== false,
  },
  shellToolPartsExpanded: {
    key: "shell_tool_parts_expanded",
    read: (value: unknown) => value === true,
  },
  editToolPartsExpanded: {
    key: "edit_tool_parts_expanded",
    read: (value: unknown) => value === true,
  },
  showChatScrollbar: {
    key: "show_chat_scrollbar",
    read: (value: unknown) => value === true,
  },
  showGenericToolOutput: {
    key: "show_generic_tool_output",
    read: (value: unknown) => value === true,
  },
  concealCodeBlocks: {
    key: "conceal_code_blocks",
    read: (value: unknown) => value === true,
  },
  visualReplies: {
    key: "visual_replies",
    read: (value: unknown) => value !== false,
  },
  autoSaveConversations: {
    key: "auto_save_conversations",
    read: (value: unknown) => value !== false,
  },
  resumeAfterUsageLimit: {
    key: "resume_after_usage_limit",
    read: (value: unknown) => value !== false,
  },
  continueAfterRestart: {
    key: "continue_after_restart",
    read: (value: unknown) => value !== false,
  },
  diffWordWrap: {
    key: "diff_word_wrap",
    read: (value: unknown) => value !== false,
  },
  diffStyle: {
    key: "diff_style",
    read: (value: unknown) =>
      value === "stacked" || value === "auto" ? value : "auto",
  },
  whileWorkingEnter: {
    key: "while_working_enter",
    read: (value: unknown) => (value === "steer" ? "steer" : "queue"),
  },
  confirmArchive: {
    key: "confirm_archive",
    read: (value: unknown) => value !== false,
  },
  confirmDelete: {
    key: "confirm_delete",
    read: (value: unknown) => value !== false,
  },
  notificationAgent: {
    key: "notification_agent",
    read: (value: unknown) => value !== false,
  },
  notificationPermissions: {
    key: "notification_permissions",
    read: (value: unknown) => value !== false,
  },
  notificationErrors: {
    key: "notification_errors",
    read: (value: unknown) => value === true,
  },
  toastEnabled: {
    key: "toast_enabled",
    read: (value: unknown) => value !== false,
  },
  toastErrors: {
    key: "toast_errors",
    read: (value: unknown) => value !== false,
  },
  toastAttention: {
    key: "toast_attention",
    read: (value: unknown) => value !== false,
  },
  attentionBadges: {
    key: "attention_badges",
    read: (value: unknown) => value !== false,
  },
  backendLogLevel: {
    key: "backend_log_level",
    read: (value: unknown) =>
      value === "error" ||
      value === "warn" ||
      value === "info" ||
      value === "debug"
        ? value
        : "info",
  },
  backendLogFormat: {
    key: "backend_log_format",
    read: (value: unknown) => (value === "json" ? "json" : "simple"),
  },
  backendTraceHttp: {
    key: "backend_trace_http",
    read: (value: unknown) => value === true,
  },
  backendTraceProviderEvents: {
    key: "backend_trace_provider_events",
    read: (value: unknown) => value === true,
  },
  // Telemetry is opt-in: only an explicit `true` counts as consent.
  crashReportsEnabled: {
    key: "crash_reports_enabled",
    read: (value: unknown) => value === true,
  },
  usagePingEnabled: {
    key: "usage_ping_enabled",
    read: (value: unknown) => value === true,
  },
  defaultThreadEnvMode: {
    key: "default_thread_env_mode",
    read: (value: unknown) => value as string,
  },
  textGenerationModel: {
    key: "text_generation_model",
    read: (value: unknown) => (value as string | null) ?? null,
  },
  remoteAccessEnabled: {
    key: "remote_access_enabled",
    read: (value: unknown) => value === true,
  },
  remoteAccessCustomUrl: {
    key: "remote_access_custom_url",
    read: (value: unknown) => (value as string) || "",
  },
  designDefaults: {
    key: "design_defaults",
    read: (value: unknown) => value as DesignDefaults,
  },
  archivedThreadIds: {
    key: "archived_thread_ids",
    read: (value: unknown) => value as string[],
  },
  chatFolders: {
    key: "chat_folders",
    read: (value: unknown) =>
      Array.isArray(value) ? (value as ChatFolder[]) : [],
  },
  pinnedThreadIds: {
    key: "pinned_thread_ids",
    read: (value: unknown) =>
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [],
  },
  snoozedThreads: {
    key: "snoozed_threads",
    read: (value: unknown) =>
      Array.isArray(value) ? (value as SnoozedChat[]) : [],
  },
  autoTrustWorkspaces: {
    key: "auto_trust_workspaces",
    // Opt-in: only an explicit `true` turns automatic workspace trust on.
    read: (value: unknown) => value === true,
  },
} satisfies {
  [K in keyof PersistedSettingsState]: {
    key: keyof import("@betterc0de/schema").Settings
    read: (value: unknown) => PersistedSettingsState[K]
  }
}

function settingsPatchToLocalState(
  patch: Record<string, unknown>
): Partial<PersistedSettingsState> {
  return Object.fromEntries(
    Object.entries(settingsFields)
      .filter(([, field]) => Object.hasOwn(patch, field.key))
      .map(([local, field]) => [local, field.read(patch[field.key])])
  ) as Partial<PersistedSettingsState>
}
