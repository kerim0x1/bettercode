import { AGENT_SLASH_SPECS } from "./agent-slash-specs"
import { APP_SLASH_SPECS } from "./app-slash-specs"
import { APPEARANCE_SLASH_SPECS } from "./appearance-slash-specs"
import { COMPAT_CONFIG_SLASH_SPECS } from "./compat-config-slash-specs"
import { COMPAT_SLASH_SPECS } from "./compat-slash-specs"
import { COMPOSER_SLASH_SPECS } from "./composer-slash-specs"
import { DEBUG_SLASH_SPECS } from "./debug-slash-specs"
import { HELP_SLASH_SPECS } from "./help-slash-specs"
import { INTEGRATION_SLASH_SPECS } from "./integration-slash-specs"
import { LAYOUT_SLASH_SPECS } from "./layout-slash-specs"
import { MCP_SLASH_SPECS } from "./mcp-slash-specs"
import { MESSAGE_SCROLL_SLASH_SPECS } from "./message-scroll-slash-specs"
import { MODEL_CATALOG_SLASH_SPECS } from "./model-catalog-slash-specs"
import { PROJECT_SLASH_SPECS } from "./project-slash-specs"
import { PROMPT_SLASH_SPECS } from "./prompt-slash-specs"
import {
  PROVIDER_AUTH_SLASH_SPECS,
  PROVIDER_SUBCOMMAND_SLASH_SPECS,
} from "./provider-auth-slash-specs"
import { REQUEST_SLASH_SPECS } from "./request-slash-specs"
import { SESSION_CONTROL_SLASH_SPECS } from "./session-control-slash-specs"
import { SESSION_LIST_SLASH_SPECS } from "./session-list-slash-specs"
import { SESSION_SLASH_SPECS } from "./session-slash-specs"
import { THREAD_SLASH_SPECS } from "./thread-slash-specs"
import { TOGGLE_SLASH_SPECS } from "./toggle-slash-specs"
import { VCS_SLASH_SPECS } from "./vcs-slash-specs"
import { WORKSPACE_SLASH_SPECS } from "./workspace-slash-specs"
import { indexSlashCommands, slashCommandNames } from "./slash-registry"
import type {
  SlashCommandRun,
  SlashCommandRunSpec,
  SlashCommandRuntimeRun,
} from "./slash-run"

/**
 * Built-in commands that run before the runtime lists load. Their names do
 * not overlap, so the order here does not matter: the one matching spec
 * either ends the command or lets it continue to the runtime phase with the
 * output it set (`/resume <title>` that finds no chat continues to the
 * session list, `/models <query>` to the model catalog).
 */
export const PRE_RUNTIME_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRun>[] =
  [
    ...COMPOSER_SLASH_SPECS,
    ...SESSION_SLASH_SPECS,
    ...THREAD_SLASH_SPECS,
    ...MESSAGE_SCROLL_SLASH_SPECS,
    ...WORKSPACE_SLASH_SPECS,
  ]

/**
 * Built-in commands that read the runtime MCP, skill, subagent and project
 * lists. Order is precedence: for a shared name the first spec whose `when`
 * passes handles the command, so subcommand specs such as `/mcp add` or
 * `/providers login` sit ahead of the specs that own the bare name.
 */
export const RUNTIME_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    ...SESSION_CONTROL_SLASH_SPECS,
    ...HELP_SLASH_SPECS,
    ...SESSION_LIST_SLASH_SPECS,
    ...PROMPT_SLASH_SPECS,
    ...PROJECT_SLASH_SPECS,
    ...REQUEST_SLASH_SPECS,
    ...VCS_SLASH_SPECS,
    ...COMPAT_SLASH_SPECS,
    ...COMPAT_CONFIG_SLASH_SPECS,
    ...MCP_SLASH_SPECS,
    ...AGENT_SLASH_SPECS,
    ...DEBUG_SLASH_SPECS,
    ...INTEGRATION_SLASH_SPECS,
    ...PROVIDER_SUBCOMMAND_SLASH_SPECS,
    ...APP_SLASH_SPECS,
    ...LAYOUT_SLASH_SPECS,
    ...PROVIDER_AUTH_SLASH_SPECS,
    ...APPEARANCE_SLASH_SPECS,
    ...MODEL_CATALOG_SLASH_SPECS,
    ...TOGGLE_SLASH_SPECS,
  ]

export const PRE_RUNTIME_SLASH_INDEX = indexSlashCommands(
  PRE_RUNTIME_SLASH_SPECS
)
export const RUNTIME_SLASH_INDEX = indexSlashCommands(RUNTIME_SLASH_SPECS)

/** Every built-in slash command name, without the leading slash. */
export const BUILTIN_SLASH_COMMAND_NAMES: readonly string[] = slashCommandNames(
  [...PRE_RUNTIME_SLASH_SPECS, ...RUNTIME_SLASH_SPECS]
)
