import fs from "node:fs/promises"
import path from "node:path"
import { isRecord } from "@betterc0de/schema/json-read"
import {
  formatBetterC0deProjectPermissionRulesForPrompt,
  mergePromptMcps,
  mergePromptSkills,
  mergePromptSubagents,
  projectAgentsToPromptSubagents,
  selectPromptSkillsForProvider,
  type PromptMcp,
  type PromptPermissionRule,
  type PromptSubagent,
  type RuntimePromptSkill,
} from "@betterc0de/schema/prompt-context"
import {
  blockingHookFailureMessage,
  buildHookEnv,
  hookFailureText,
  resolveHookCwd,
  type RuntimeHookPayload,
} from "@betterc0de/schema/runtime-hooks"
import {
  buildSystemInstruction,
  type EnvContext,
} from "@betterc0de/schema/system-instruction"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import { desktopRuntimeHome } from "../desktop-runtime-home"
import { resolveAppEffectiveRules } from "../effective-rules"
import { runShellCommand } from "../shell"
import { listProjectAgents } from "../workspace/agents"
import { listProjectMcpServers } from "../workspace/mcp"
import { listProjectPermissions } from "../workspace/permissions"
import { listProjectSkills } from "../workspace/resources"

/**
 * The desktop prepares every message it sends itself (apps/ui chatApi.ts):
 * it runs the user's "on message send" hooks, and builds the turn's system
 * instruction from the user's skills, MCP servers and subagents, the
 * project's own, and the project's rules. A client that asks for it with
 * `prepareTurn` (the phone app) gets the same preparation here, from the
 * same sources: the desktop's settings folder (desktop-runtime-home.ts)
 * and the project folder.
 */

type PreparationState = Pick<AppState, "config" | "settings">

/** The parts of a `/chat/send` request that the preparation reads. */
export interface PreparedTurnRequest {
  thread_id: string
  message: string
  model_id: string
  provider_kind: string
  provider_instance_id?: string | null
  project_path?: string | null
  rule_target_path?: string | null
  chat_mode?: string | null
  permission_level?: string | null
  app_mode?: "agent" | "editor" | "design" | null
}

export interface RuntimeHookEntry {
  id: string
  event: string
  command: string
  enabled: boolean
}

/** Most entries read from one settings file or folder. */
const MAX_ENTRIES = 256
/** Largest settings file read (the desktop's MCP store allows 4 MB). */
const MAX_FILE_BYTES = 4 * 1024 * 1024

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

async function readTextFile(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    return await fs.readFile(file, "utf8")
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/** A settings file's JSON, or `null` when it is missing or not JSON (logged). */
async function readJsonFile(file: string): Promise<unknown> {
  const content = await readTextFile(file)
  if (content === null) return null
  try {
    return JSON.parse(content) as unknown
  } catch (error) {
    logger.warn(
      { file, err: error instanceof Error ? error.message : String(error) },
      "turn preparation: a settings file is not JSON; it is left out"
    )
    return null
  }
}

async function directoryNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .slice(0, MAX_ENTRIES)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

/** The user's skills (`skills/<id>/manifest.json` and `content.md`), enabled ones. */
export async function readRuntimeSkills(
  home: string
): Promise<RuntimePromptSkill[]> {
  const dir = path.join(home, "skills")
  const skills: RuntimePromptSkill[] = []
  for (const name of await directoryNames(dir)) {
    const manifest = await readJsonFile(path.join(dir, name, "manifest.json"))
    if (!isRecord(manifest) || manifest.enabled === false) continue
    skills.push({
      name: text(manifest.name),
      content: (await readTextFile(path.join(dir, name, "content.md"))) ?? "",
      providerKinds: strings(manifest.providerKinds),
      providerInstanceIds: strings(manifest.providerInstanceIds),
      source: text(manifest.source),
      sourcePath: text(manifest.sourcePath),
    })
  }
  return skills
}

/** The user's subagents (`subagents/<id>/manifest.json` and `prompt.md`), enabled ones. */
export async function readRuntimeSubagents(
  home: string
): Promise<PromptSubagent[]> {
  const dir = path.join(home, "subagents")
  const subagents: PromptSubagent[] = []
  for (const name of await directoryNames(dir)) {
    const manifest = await readJsonFile(path.join(dir, name, "manifest.json"))
    if (!isRecord(manifest) || manifest.enabled === false) continue
    subagents.push({
      name: text(manifest.name),
      description: text(manifest.description),
      prompt: (await readTextFile(path.join(dir, name, "prompt.md"))) ?? "",
      source: text(manifest.source),
      sourcePath: text(manifest.sourcePath),
    })
  }
  return subagents
}

/** The user's MCP servers (`mcp-servers.json`), enabled ones. */
export async function readRuntimeMcps(home: string): Promise<PromptMcp[]> {
  const stored = await readJsonFile(path.join(home, "mcp-servers.json"))
  if (!Array.isArray(stored)) return []
  return stored
    .slice(0, MAX_ENTRIES)
    .filter(isRecord)
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({
      name: text(entry.name),
      command: text(entry.command),
      args: strings(entry.args),
    }))
}

/** The user's hooks (`hooks.json`); one without an event runs on message send, as on the desktop. */
export async function readRuntimeHooks(
  home: string
): Promise<RuntimeHookEntry[]> {
  const stored = await readJsonFile(path.join(home, "hooks.json"))
  if (!Array.isArray(stored)) return []
  return stored
    .slice(0, MAX_ENTRIES)
    .filter(isRecord)
    .map((entry) => ({
      id: text(entry.id),
      event: text(entry.event) || "on_message_send",
      command: text(entry.command),
      enabled: entry.enabled !== false,
    }))
}

interface PromptContext {
  skills: RuntimePromptSkill[]
  mcps: PromptMcp[]
  subagents: PromptSubagent[]
  permissionRules: PromptPermissionRule[]
}

/**
 * The user's and the project's skills, MCP servers and subagents, merged as
 * the desktop merges them. Like the desktop, a project whose settings do
 * not load contributes nothing, and settings that do not load at all leave
 * the prompt without them; both are logged here.
 */
async function gatherPromptContext(
  state: PreparationState,
  projectPath: string | null
): Promise<PromptContext> {
  const context: PromptContext = {
    skills: [],
    mcps: [],
    subagents: [],
    permissionRules: [],
  }
  const home = desktopRuntimeHome(state.config.dataDir)
  try {
    if (home) {
      const [skills, mcps, subagents] = await Promise.all([
        readRuntimeSkills(home),
        readRuntimeMcps(home),
        readRuntimeSubagents(home),
      ])
      context.skills = skills
      context.mcps = mcps
      context.subagents = subagents
    }
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "turn preparation: the desktop's skills, MCP servers and subagents did not load; the turn goes without them"
    )
    return context
  }
  if (!projectPath) return context
  try {
    const [projectMcps, projectSkills, projectAgents, permissions] =
      await Promise.all([
        listProjectMcpServers(projectPath),
        listProjectSkills(projectPath),
        listProjectAgents(projectPath),
        listProjectPermissions(projectPath),
      ])
    context.permissionRules = permissions
    context.mcps = mergePromptMcps(
      context.mcps,
      projectMcps.map((mcp) => ({
        name: mcp.name,
        command: mcp.command,
        args: mcp.args,
      }))
    )
    context.skills = mergePromptSkills(
      context.skills,
      projectSkills.map((skill) => ({
        name: skill.name,
        content: skill.content,
        source: "betterc0de",
        sourcePath: skill.sourcePath,
      }))
    )
    context.subagents = mergePromptSubagents(
      context.subagents,
      projectAgentsToPromptSubagents(projectAgents)
    )
  } catch (error) {
    logger.warn(
      {
        projectPath,
        err: error instanceof Error ? error.message : String(error),
      },
      "turn preparation: the project's skills, MCP servers and agents did not load; the turn goes without them"
    )
  }
  return context
}

/** The operating system as the desktop names it in the prompt. */
function desktopOsName(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "windows"
  if (platform === "darwin") return "macos"
  return "linux"
}

function envContext(projectPath: string | null): EnvContext {
  return {
    os: desktopOsName(),
    shell: "bash",
    projectPath: projectPath || undefined,
    projectName: projectPath
      ? projectPath.replace(/\\/g, "/").split("/").pop()
      : undefined,
  }
}

/**
 * The system instruction the desktop would send with this message: the
 * same builder, the same skills, MCP servers and subagents, and the
 * project's rules where the desktop puts them. The phone app offers no
 * special mode and no design brief.
 */
export async function buildPreparedTurnInstruction(
  state: PreparationState,
  request: PreparedTurnRequest
): Promise<string> {
  const projectPath = request.project_path?.trim() || null
  const context = await gatherPromptContext(state, projectPath)

  // The project's rules (its rule files and the user's rules) come from the
  // same resolution the desktop asks this backend for. Without a project,
  // or when that fails, the user's rules go in as they are.
  let effectiveRules: string | null = null
  let effectiveRulesLoaded = false
  if (projectPath) {
    try {
      const resolution = await resolveAppEffectiveRules(state, {
        workspaceRoot: projectPath,
        targetPath: request.rule_target_path ?? null,
      })
      effectiveRules = resolution.content || null
      effectiveRulesLoaded = true
    } catch (error) {
      logger.warn(
        {
          projectPath,
          err: error instanceof Error ? error.message : String(error),
        },
        "turn preparation: the project's rules did not resolve"
      )
    }
  }
  const settings = state.settings.get() as unknown as {
    custom_rules?: unknown
  }
  const customRules = effectiveRulesLoaded ? "" : text(settings.custom_rules)
  const projectRules = [
    effectiveRules,
    formatBetterC0deProjectPermissionRulesForPrompt(context.permissionRules),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n")

  return buildSystemInstruction(
    request.chat_mode || "agent",
    null,
    request.permission_level ?? null,
    envContext(projectPath),
    selectPromptSkillsForProvider(context.skills, {
      providerKind: request.provider_kind,
      providerInstanceId: request.provider_instance_id ?? null,
    }),
    context.mcps,
    customRules,
    context.subagents,
    projectRules || null,
    request.app_mode ?? "agent",
    null,
    null
  )
}

/**
 * Runs the user's enabled "on message send" hooks, in order, as the desktop
 * does before it sends a message. The first that fails refuses the message
 * (422 `message_hook_failed`, in the desktop's words). Unlike the desktop,
 * the backend does not record a hook's last run in `hooks.json`: that file
 * belongs to the desktop app, which may be writing it.
 */
export async function runMessageSendHooks(
  state: PreparationState,
  request: PreparedTurnRequest
): Promise<void> {
  const home = desktopRuntimeHome(state.config.dataDir)
  if (!home) return
  const hooks = (await readRuntimeHooks(home)).filter(
    (hook) => hook.enabled && hook.event === "on_message_send"
  )
  if (hooks.length === 0) return
  const payload: RuntimeHookPayload = {
    threadId: request.thread_id,
    message: request.message,
    modelId: request.model_id,
    providerKind: request.provider_kind,
    projectPath: request.project_path ?? undefined,
  }
  for (const hook of hooks) {
    let failure: string | null = null
    try {
      const result = await runShellCommand({
        command: hook.command,
        cwd: resolveHookCwd(payload),
        env: buildHookEnv("on_message_send", payload),
      })
      if (!result.success) failure = hookFailureText(result)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure !== null) {
      throw new HttpError(
        422,
        blockingHookFailureMessage(hook.command, failure),
        "message_hook_failed"
      )
    }
  }
}
