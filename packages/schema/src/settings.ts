import { z } from "zod"
import {
  DEFAULT_COMMIT_MESSAGE_MODELS,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_IMAGE_GENERATION_MODEL,
  modelSelectionSchema,
  type ModelSelection,
} from "./model-selection"
import { providerInstanceConfigMapSchema } from "./provider-instance"
import { DEFAULT_DESIGN_DEFAULTS, designDefaultsSchema } from "./design"
import { guardrailRuleSchema } from "./guardrails"
import { pipelineDefinitionSchema } from "./pipelines"
import { orchestratorTeamSchema } from "./orchestrator"
import { storedApiKeysSchema } from "./api-keys"
export {
  secretPatchSchema,
  secretStateSchema,
  secretStorageSchema,
  type SecretPatch,
  type SecretState,
  type SecretStorage,
} from "./secret"

/**
 * Settings schema — mirrors the renderer's SettingsState in src/lib/settings-store.ts.
 * Every field is optional or has a default so a blank/partial settings.json validates
 * and round-trips without data loss.
 *
 * NOTE: Backend uses snake_case keys on disk; the renderer converts to camelCase on load.
 * This schema is the on-disk shape.
 */

// ── Provider schemas ────────────────────────────────────────────────────

// Older settings files serialized absent optional strings as null. Normalize
// only these fields; malformed values and required settings still fail validation.
const optionalSettingsString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional()
)

export const providerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  api_key: optionalSettingsString,
  api_keys: storedApiKeysSchema.optional(),
  custom_models: z.array(z.string()).default([]),
  hidden_models: z.array(z.string()).default([]),
  base_url: optionalSettingsString,
  binaryPath: optionalSettingsString,
  apiEndpoint: optionalSettingsString,
  serverUrl: optionalSettingsString,
  serverUsername: optionalSettingsString,
  serverPassword: optionalSettingsString,
})

const optInProviderConfigSchema = providerConfigSchema.extend({
  enabled: z.boolean().default(false),
})

export const providerSettingsSchema = z.object({
  codex: providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
  claude: providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
  cursor: providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
  betterc0de: optInProviderConfigSchema.default({
    enabled: false,
    custom_models: [],
    hidden_models: [],
  }),
  "claude-terminal": optInProviderConfigSchema.default({
    enabled: false,
    custom_models: [],
    hidden_models: [],
  }),
  openai: providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
  anthropic: providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
  google: providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
  grok: providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
  // xAI Grok Build CLI — separate settings slot from the "grok" API-key
  // provider above.
  "grok-cli": providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
  openrouter: providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
  deepseek: providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
  lmstudio: providerConfigSchema.default({
    enabled: true,
    custom_models: [],
    hidden_models: [],
  }),
})

// ── Extensibility schemas (skills, MCP servers, hooks) ──────────────────

export const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  triggerPattern: z.string().default(""),
  promptTemplate: z.string().default(""),
  enabled: z.boolean().default(true),
})

/**
 * An MCP server in `settings.json` (`mcp_servers`): `args` is one string
 * and `envVars` is `KEY=value` lines, both split by the backend
 * (`AcpMcpServers.ts`). Not the desktop's `mcp-servers.json` record, whose
 * `args` is a list (`RuntimeMcpServerRecord` in `runtime-records.ts`).
 */
export const mcpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.string().default(""),
  envVars: z.string().default(""),
  enabled: z.boolean().default(true),
})

/**
 * A hook in `settings.json` (`hooks`). Hooks that run are the desktop's
 * `hooks.json` records (`RuntimeHookRecord` in `runtime-records.ts`); no
 * runner reads this list.
 */
export const hookSchema = z.object({
  id: z.string(),
  event: z.enum([
    "on_message_send",
    "on_response_complete",
    "on_file_change",
    "on_commit",
  ]),
  command: z.string(),
  enabled: z.boolean().default(true),
})

/**
 * A helper model id. It reaches a provider CLI as a single argv entry (on
 * Windows possibly through a `.cmd` shim), so only model-id characters are
 * accepted. A blank or null value restores the built-in default.
 */
const helperModelIdSchema = (fallback: string) =>
  z.preprocess(
    (value) => {
      if (value === null) return undefined
      if (typeof value !== "string") return value
      const trimmed = value.trim()
      return trimmed ? trimmed : undefined
    },
    z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/, "Invalid model id")
      .default(fallback)
  )

// ── Chat folders ────────────────────────────────────────────────────────

/** Most chat folders, and chats per folder, that settings keep. */
export const CHAT_FOLDER_LIMIT = 100
export const CHAT_FOLDER_THREAD_LIMIT = 1000
export const CHAT_FOLDER_NAME_MAX = 80

/**
 * A folder the user made in the sidebar's compact chat list. Its chats
 * stay in it, in this order, pinned above the rest of the list.
 */
export const chatFolderSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().trim().min(1).max(CHAT_FOLDER_NAME_MAX),
    thread_ids: z
      .array(z.string().min(1).max(200))
      .max(CHAT_FOLDER_THREAD_LIMIT)
      .default([]),
  })
  .strict()

export type ChatFolder = z.infer<typeof chatFolderSchema>

// ── Pinned and snoozed chats ────────────────────────────────────────────

/** Most pinned and snoozed chats that settings keep. */
export const PINNED_CHAT_LIMIT = 200
export const SNOOZED_CHAT_LIMIT = 500

/**
 * A chat snoozed in the sidebar's chat lists. It stays out of the lists
 * until `until`, or earlier when it changes after `since` (a new message)
 * or a turn that was `running` when it was snoozed ends. An entry whose
 * time has passed stays until the chat is opened, so the list can mark the
 * chat as back. A list of records rather than an object keyed by thread
 * id, because settings views treat object keys as field names.
 */
export const snoozedChatSchema = z
  .object({
    thread_id: z.string().min(1).max(200),
    until: z.string().min(1).max(40),
    since: z.string().min(1).max(40),
    running: z.boolean().optional(),
  })
  .strict()

export type SnoozedChat = z.infer<typeof snoozedChatSchema>

// ── Root settings schema ────────────────────────────────────────────────

export const DEFAULT_TEXT_GENERATION_MODEL_SELECTION: ModelSelection = {
  instanceId: "codex",
  model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
}

const settingsObjectSchema = z
  .object({
    theme: z.string().default("dark"),
    language: z.string().default("en"),
    time_format: z.string().default("24h"),
    enable_assistant_streaming: z.boolean().default(true),
    show_message_timestamps: z.boolean().default(true),
    show_thinking_blocks: z.boolean().default(true),
    show_reasoning_summaries: z.boolean().default(false),
    show_tool_details: z.boolean().default(false),
    show_session_progress_bar: z.boolean().default(true),
    shell_tool_parts_expanded: z.boolean().default(false),
    edit_tool_parts_expanded: z.boolean().default(false),
    show_chat_scrollbar: z.boolean().default(false),
    show_generic_tool_output: z.boolean().default(false),
    conceal_code_blocks: z.boolean().default(false),
    // Settings → Chat → Visual Replies: agents are told they can answer
    // with a ```html-render page, and the chat shows such pages live in a
    // sandboxed frame. Off leaves the instruction out and shows them as code.
    visual_replies: z.boolean().default(true),
    auto_save_conversations: z.boolean().default(true),
    // Chats that continue by themselves (Settings → Chat; thread-resume.ts).
    // Owner-only, not in remoteSettingsPatchSchema: they let the backend
    // send messages on its own.
    /** Send "Continue." once the usage limit that stopped a chat resets. */
    resume_after_usage_limit: z.boolean().default(true),
    /** Continue, once, a chat whose turn a quit or crash interrupted. */
    continue_after_restart: z.boolean().default(true),
    diff_word_wrap: z.boolean().default(true),
    diff_style: z.enum(["auto", "stacked"]).default("auto"),
    // What Enter does in the desktop composer while the agent works: queue
    // the message for after the turn, or steer it into the running turn.
    // Ctrl/Cmd+Enter does the other one.
    while_working_enter: z.enum(["queue", "steer"]).default("queue"),
    confirm_archive: z.boolean().default(true),
    confirm_delete: z.boolean().default(true),
    notification_agent: z.boolean().default(true),
    notification_permissions: z.boolean().default(true),
    notification_errors: z.boolean().default(false),
    toast_enabled: z.boolean().default(true),
    toast_errors: z.boolean().default(true),
    toast_attention: z.boolean().default(true),
    attention_badges: z.boolean().default(true),
    backend_log_level: z
      .enum(["error", "warn", "info", "debug"])
      .default("info"),
    backend_log_format: z.enum(["simple", "json"]).default("simple"),
    backend_trace_http: z.boolean().default(false),
    backend_trace_provider_events: z.boolean().default(false),
    // Privacy (Settings → General → Privacy). Both are opt-in. The Electron
    // main process reads them straight from settings.json, so they also
    // apply while the backend is down. Not in remoteSettingsPatchSchema:
    // only the desktop owner can turn telemetry on.
    /** Send automatic crash and error reports (redacted logs included). */
    crash_reports_enabled: z.boolean().default(false),
    /** Send one usage ping per app start with a random installation ID. */
    usage_ping_enabled: z.boolean().default(false),
    remote_access_enabled: z.boolean().default(false),
    // With Remote Access on, also listen on the network interfaces (Wi-Fi,
    // LAN, the plain tailnet address). Off keeps the backend on loopback,
    // where Tailscale Serve or a tunnel still reaches it. Missing means on,
    // which is how Remote Access listened before the switch existed.
    remote_access_lan: z.boolean().default(true),
    remote_access_custom_url: z.string().max(2048).default(""),
    // Paired devices never get a terminal unless the desktop owner opts in:
    // a session bearer proves possession of a device, not a human at this
    // keyboard, so shell access from remote is a deliberate grant.
    remote_access_allow_terminal: z.boolean().default(false),
    // Publish the backend through Tailscale Serve (`https://<machine>.<tailnet>.ts.net`).
    // Tailscale terminates TLS on this machine and proxies to loopback, so
    // while this is on the backend trusts X-Forwarded-* from loopback peers.
    remote_access_tailscale_serve: z.boolean().default(false),
    deepgram_api_key: optionalSettingsString,
    voice_mic_device_id: optionalSettingsString,
    voice_language: optionalSettingsString,
    jev_search_enabled: z.boolean().default(false),
    orchestrator_enabled: z.boolean().default(false),
    orchestrator_team: orchestratorTeamSchema.nullable().default(null),
    jev_api_key: z.preprocess(
      (value) => (value === null ? undefined : value),
      z.string().max(4096).optional()
    ),
    default_thread_env_mode: z.string().default("local"),
    // Off by default: opening (or cloning) a folder is not consent to run the
    // commands it declares. Trust is recorded explicitly per workspace
    // (Settings → Permissions → Trust project), and only then may it run
    // repo-declared MCP servers, formatters and Claude project hooks. A stored
    // value is kept, so users who already turned this on keep auto-trust.
    auto_trust_workspaces: z.boolean().default(false),
    text_generation_model: optionalSettingsString,
    text_generation_model_selection: modelSelectionSchema.default(
      DEFAULT_TEXT_GENERATION_MODEL_SELECTION
    ),
    // Background helper models (image generation through the Codex CLI,
    // commit messages through the Codex or Claude CLI). Owner-only.
    image_generation_model: helperModelIdSchema(DEFAULT_IMAGE_GENERATION_MODEL),
    commit_message_codex_model: helperModelIdSchema(
      DEFAULT_COMMIT_MESSAGE_MODELS.codex
    ),
    commit_message_claude_model: helperModelIdSchema(
      DEFAULT_COMMIT_MESSAGE_MODELS.claude
    ),
    providers: providerSettingsSchema.default(
      {} as z.infer<typeof providerSettingsSchema>
    ),
    provider_instances: providerInstanceConfigMapSchema,
    // Legacy duplicates of the desktop configuration. Rules, skills, MCP
    // servers and hooks live in the runtime home's files (`rules.md`,
    // `skills/`, `mcp-servers.json`, `hooks.json`), which the backend owns.
    // These keys are accepted only so an existing settings.json still loads:
    // the backend merges them into those files once and removes them
    // (apps/backend/src/services/desktop-config/migration.ts), and refuses
    // to store them again.
    /** @deprecated Moved to `rules.md`; present only before migration. */
    custom_rules: z.string().optional(),
    /** @deprecated Moved to `skills/`; present only before migration. */
    skills: z.array(skillSchema).optional(),
    /** @deprecated Moved to `mcp-servers.json`; present only before migration. */
    mcp_servers: z.array(mcpServerSchema).optional(),
    /** @deprecated Moved to `hooks.json`; present only before migration. */
    hooks: z.array(hookSchema).optional(),
    agent_guardrails: z.array(guardrailRuleSchema).default([]),
    pipelines: z.array(pipelineDefinitionSchema).default([]),
    design_defaults: designDefaultsSchema.default(DEFAULT_DESIGN_DEFAULTS),
    archived_thread_ids: z.array(z.string()).default([]),
    // Folders of the sidebar's compact chat list, in their order.
    chat_folders: z.array(chatFolderSchema).max(CHAT_FOLDER_LIMIT).default([]),
    // Chats pinned to the top of the sidebar's chat lists, in their order.
    // `/pin`, `/pins` and `/quick-switch` use the same list.
    pinned_thread_ids: z
      .array(z.string().min(1).max(200))
      .max(PINNED_CHAT_LIMIT)
      .default([]),
    // Chats snoozed out of the sidebar's chat lists until a time.
    snoozed_threads: z
      .array(snoozedChatSchema)
      .max(SNOOZED_CHAT_LIMIT)
      .default([]),
  })
  .strict()

/** Remote devices may change presentation only. New settings are owner-only by default. */
export const remoteSettingsPatchSchema = settingsObjectSchema
  .pick({
    theme: true,
    language: true,
    time_format: true,
    enable_assistant_streaming: true,
    show_message_timestamps: true,
    show_thinking_blocks: true,
    show_reasoning_summaries: true,
    show_tool_details: true,
    show_session_progress_bar: true,
    shell_tool_parts_expanded: true,
    edit_tool_parts_expanded: true,
    show_chat_scrollbar: true,
    show_generic_tool_output: true,
    conceal_code_blocks: true,
    // How answers look; a paired device that can send a message can ask
    // for such a page anyway.
    visual_replies: true,
    diff_word_wrap: true,
    diff_style: true,
    confirm_archive: true,
    confirm_delete: true,
    notification_agent: true,
    notification_permissions: true,
    notification_errors: true,
    toast_enabled: true,
    toast_errors: true,
    toast_attention: true,
    attention_badges: true,
  })
  .partial()
  .strict()

export const settingsSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
  const obj = { ...(raw as Record<string, unknown>) }
  if (
    obj.provider_instances === undefined &&
    obj.providerInstances !== undefined
  ) {
    obj.provider_instances = obj.providerInstances
  }
  delete obj.providerInstances
  if (obj.text_generation_model_selection === undefined) {
    if (obj.textGenerationModelSelection !== undefined) {
      obj.text_generation_model_selection = obj.textGenerationModelSelection
    } else {
      const legacyTextGenerationModel =
        typeof obj.text_generation_model === "string"
          ? obj.text_generation_model
          : typeof obj.textGenerationModel === "string"
            ? obj.textGenerationModel
            : null
      const model = legacyTextGenerationModel?.trim()
      if (model) {
        obj.text_generation_model_selection = {
          instanceId: "codex",
          model,
        }
      }
    }
  }
  delete obj.textGenerationModelSelection
  delete obj.textGenerationModel
  if (obj.design_defaults === undefined && obj.designDefaults !== undefined) {
    obj.design_defaults = obj.designDefaults
  }
  delete obj.designDefaults
  if (
    obj.providers &&
    typeof obj.providers === "object" &&
    !Array.isArray(obj.providers)
  ) {
    const providers = { ...(obj.providers as Record<string, unknown>) }
    if (providers.claude === undefined && providers.claudeAgent !== undefined) {
      providers.claude = providers.claudeAgent
    }
    if (
      providers.betterc0de === undefined &&
      providers.BetterC0de !== undefined
    ) {
      providers.betterc0de = providers.BetterC0de
    }
    delete providers.BetterC0de
    obj.providers = providers
  }
  return obj
}, settingsObjectSchema)

// ── HTTP PATCH wrapper ──────────────────────────────────────────────────

const settingsPatchRecordSchema = z.record(z.string(), z.unknown())

export const settingsPatchSchema = z
  .union([
    z.object({ patch: settingsPatchRecordSchema }).strict(),
    settingsPatchRecordSchema.refine((raw) => !("patch" in raw), {
      message: "patch must be an object",
    }),
  ])
  .transform((raw) => ({
    patch: ("patch" in raw ? raw.patch : raw) as Record<string, unknown>,
  }))
export type SettingsPatchBody = z.infer<typeof settingsPatchSchema>

// ── Exported types ──────────────────────────────────────────────────────

export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type ProviderSettings = z.infer<typeof providerSettingsSchema>
export type Skill = z.infer<typeof skillSchema>
export type McpServer = z.infer<typeof mcpServerSchema>
export type Hook = z.infer<typeof hookSchema>
export type Settings = z.infer<typeof settingsSchema>

export const defaultSettings = (): Settings => settingsSchema.parse({})
