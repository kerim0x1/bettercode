import { z } from "zod"
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  modelSelectionSchema,
  type ModelSelection,
} from "./model-selection"
import { providerInstanceConfigMapSchema } from "./provider-instance"
import { DEFAULT_DESIGN_DEFAULTS, designDefaultsSchema } from "./design"
import { guardrailRuleSchema } from "./guardrails"
import { pipelineDefinitionSchema } from "./pipelines"
import { orchestratorTeamSchema } from "./orchestrator"
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
  (value) => value === null ? undefined : value,
  z.string().optional()
)

export const providerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  api_key: optionalSettingsString,
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
  // OpenCode CLI — the local `opencode` binary (headless server); both the
  // v1 and v2 HTTP surfaces are supported.
  "opencode-cli": providerConfigSchema.default({
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

export const mcpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.string().default(""),
  envVars: z.string().default(""),
  enabled: z.boolean().default(true),
})

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
    auto_save_conversations: z.boolean().default(true),
    diff_word_wrap: z.boolean().default(true),
    diff_style: z.enum(["auto", "stacked"]).default("auto"),
    confirm_archive: z.boolean().default(true),
    confirm_delete: z.boolean().default(true),
    notification_agent: z.boolean().default(true),
    notification_permissions: z.boolean().default(true),
    notification_errors: z.boolean().default(false),
    toast_enabled: z.boolean().default(true),
    toast_errors: z.boolean().default(true),
    toast_attention: z.boolean().default(true),
    attention_badges: z.boolean().default(true),
    backend_log_level: z.enum(["error", "warn", "info", "debug"]).default("info"),
    backend_log_format: z.enum(["simple", "json"]).default("simple"),
    backend_trace_http: z.boolean().default(false),
    backend_trace_provider_events: z.boolean().default(false),
    remote_access_enabled: z.boolean().default(false),
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
      (value) => value === null ? undefined : value,
      z.string().max(4096).optional()
    ),
    default_thread_env_mode: z.string().default("local"),
    // Opening a folder in your own IDE is itself the trust decision, so the
    // product default records trust on first use instead of dead-ending the
    // turn. Turn this off to require an explicit Settings → Permissions grant
    // before a workspace may run repo-declared MCP servers and formatters.
    auto_trust_workspaces: z.boolean().default(true),
    text_generation_model: optionalSettingsString,
    text_generation_model_selection: modelSelectionSchema.default(
      DEFAULT_TEXT_GENERATION_MODEL_SELECTION
    ),
    providers: providerSettingsSchema.default(
      {} as z.infer<typeof providerSettingsSchema>
    ),
    provider_instances: providerInstanceConfigMapSchema,
    custom_rules: z.string().default(""),
    skills: z.array(skillSchema).default([]),
    mcp_servers: z.array(mcpServerSchema).default([]),
    hooks: z.array(hookSchema).default([]),
    agent_guardrails: z.array(guardrailRuleSchema).default([]),
    pipelines: z.array(pipelineDefinitionSchema).default([]),
    design_defaults: designDefaultsSchema.default(DEFAULT_DESIGN_DEFAULTS),
    archived_thread_ids: z.array(z.string()).default([]),
  })
  .strict()

/** Remote devices may change presentation only. New settings are owner-only by default. */
export const remoteSettingsPatchSchema = settingsObjectSchema.pick({
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
}).partial().strict()

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
