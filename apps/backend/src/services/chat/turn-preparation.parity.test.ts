import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_DESIGN_DEFAULTS,
  designBriefSchema,
  type DesignBrief,
  type DesignDefaults,
} from "@betterc0de/schema/design"
import {
  formatBetterC0deProjectPermissionRulesForPrompt,
  mergePromptMcps,
  mergePromptSkills,
  mergePromptSubagents,
  projectAgentsToPromptSubagents,
  selectPromptSkillsForProvider,
  type PromptMcp,
  type PromptPermissionRule,
  type PromptSkill,
  type PromptSubagent,
  type RuntimePromptSkill,
} from "@betterc0de/schema/prompt-context"
import {
  buildSystemInstruction,
  type EnvContext,
} from "@betterc0de/schema/system-instruction"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveAppEffectiveRules } from "../effective-rules"
import { ensureScratchWorkspace } from "../scratchWorkspace"
import { listProjectAgents } from "../workspace/agents"
import { listProjectMcpServers } from "../workspace/mcp"
import { listProjectPermissions } from "../workspace/permissions"
import { listProjectSkills } from "../workspace/resources"
import { buildPreparedTurnInstruction } from "./turn-preparation"

/**
 * Parity of the backend's turn instruction with the one the desktop built
 * itself (apps/ui `lib/chat/send-message.ts`, before the desktop left the
 * preparation to the backend with `prepareTurn`).
 *
 * `desktopInstruction` below is that renderer code, step for step, fed as
 * the renderer was fed: the user's skills, subagents and MCP servers as the
 * desktop process listed them over IPC (apps/shell skills-ipc, subagents-ipc
 * and mcp-ipc read the same files), its own rules (`getCustomRules`: the
 * backend setting, else `rules.md`), the project's lists and rules from this
 * backend's endpoints, and the composer's modes and design brief. The
 * backend builder must produce the same text for the same inputs.
 *
 * The desktop's project path is canonical (it comes from a folder picker);
 * the backend's is the canonical root the dispatch resolved.
 */

const temporary: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  )
  temporary.push(directory)
  return directory
}

async function write(file: string, content: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8"
  )
}

interface DesktopSettings {
  custom_rules: string
  design_defaults?: DesignDefaults
}

/** A desktop settings folder with skills, subagents, MCP servers and rules, and a project. */
async function desktop(settings: DesktopSettings) {
  vi.stubEnv("BETTERC0DE_HOME", "")
  const home = await temporaryDirectory("betterc0de-parity-home-")
  const dataDir = path.join(home, "userdata")
  await fs.mkdir(dataDir, { recursive: true })
  await write(path.join(home, "skills", "style", "manifest.json"), {
    name: "Style",
    enabled: true,
  })
  await write(path.join(home, "skills", "style", "content.md"), "Use tabs.")
  await write(path.join(home, "skills", "codex-only", "manifest.json"), {
    name: "Codex only",
    providerKinds: ["codex"],
  })
  await write(
    path.join(home, "skills", "codex-only", "content.md"),
    "Prefer apply_patch."
  )
  await write(path.join(home, "skills", "off", "manifest.json"), {
    name: "Switched off",
    enabled: false,
  })
  await write(path.join(home, "skills", "off", "content.md"), "Never shown.")
  await write(path.join(home, "subagents", "reviewer", "manifest.json"), {
    name: "Reviewer",
    description: "Reviews a change",
  })
  await write(
    path.join(home, "subagents", "reviewer", "prompt.md"),
    "Review carefully."
  )
  await write(path.join(home, "mcp-servers.json"), [
    {
      id: "files",
      name: "files",
      command: "npx",
      args: ["mcp-files"],
      enabled: true,
    },
    {
      id: "switched-off",
      name: "switched-off",
      command: "npx",
      enabled: false,
    },
    { id: "remote", name: "remote", type: "http", url: "https://mcp.example" },
  ])
  await write(path.join(home, "rules.md"), "Prefer short answers.")
  const project = await temporaryDirectory("betterc0de-parity-project-")
  await write(
    path.join(project, "AGENTS.md"),
    "Run the linter before committing."
  )
  const state = {
    config: { dataDir, runtimeHome: home },
    settings: { get: () => settings },
  } as never
  return { home, dataDir, project, state }
}

// ── The desktop's preparation, as the renderer did it ────────────────────

/** `navigator.platform` in the desktop's renderer on this machine. */
const rendererPlatform =
  process.platform === "win32"
    ? "Win32"
    : process.platform === "darwin"
      ? "MacIntel"
      : "Linux x86_64"

function readJsonOrNull(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fsSync.readFileSync(file, "utf8")) as unknown
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readTextOr(file: string, fallback: string): string {
  try {
    return fsSync.readFileSync(file, "utf8")
  } catch {
    return fallback
  }
}

function directoryEntries(dir: string): string[] {
  return fsSync
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
const text = (value: unknown): string =>
  typeof value === "string" ? value : ""

/**
 * `getRuntimePromptContext()` (apps/ui runtime-config.ts) over the desktop
 * process's lists (skills-ipc `readSkills`, subagents-ipc `readSubagents`,
 * mcp-ipc `mcp:list`, onboarding-ipc `rules:get`).
 */
function rendererPromptContext(home: string, settings: DesktopSettings) {
  const skills = directoryEntries(path.join(home, "skills"))
    .map((name) => {
      const dir = path.join(home, "skills", name)
      const manifest = readJsonOrNull(path.join(dir, "manifest.json"))
      if (!manifest) return null
      return {
        name: text(manifest.name),
        content: readTextOr(path.join(dir, "content.md"), ""),
        enabled: manifest.enabled !== false,
        source: text(manifest.source),
        sourcePath: text(manifest.sourcePath),
        providerKinds: strings(manifest.providerKinds),
        providerInstanceIds: strings(manifest.providerInstanceIds),
      }
    })
    .filter((skill): skill is NonNullable<typeof skill> => skill !== null)
    .filter((skill) => skill.enabled !== false)
  const subagents = directoryEntries(path.join(home, "subagents"))
    .map((name) => {
      const dir = path.join(home, "subagents", name)
      const manifest = readJsonOrNull(path.join(dir, "manifest.json"))
      if (!manifest) return null
      return {
        name: text(manifest.name),
        description: text(manifest.description),
        prompt: readTextOr(path.join(dir, "prompt.md"), ""),
        enabled: manifest.enabled !== false,
        source: text(manifest.source),
        sourcePath: text(manifest.sourcePath),
      }
    })
    .filter((agent): agent is NonNullable<typeof agent> => agent !== null)
    .filter((agent) => agent.enabled !== false)
  const storedMcps = JSON.parse(
    readTextOr(path.join(home, "mcp-servers.json"), "[]")
  ) as Array<Record<string, unknown>>
  const mcps = storedMcps
    .map((item) => ({
      name: text(item.name),
      command: text(item.command),
      args: strings(item.args),
      enabled: item.enabled !== false,
    }))
    .filter((mcp) => mcp.enabled !== false)
  const customRules = settings.custom_rules.trim()
    ? settings.custom_rules
    : readTextOr(path.join(home, "rules.md"), "")
  return { customRules, skills, mcps, subagents }
}

interface DesktopTurn {
  chatMode: string | null
  specialMode: string | null
  permissionLevel: string | null
  /** The thread's folder, or null for a chat without one. */
  projectPath: string | null
  appMode: "agent" | "editor" | "design" | null
  designContext: DesignBrief | null
  providerKind: string
  providerInstanceId: string | null
  ruleTargetPath: string | null
}

/** The renderer's `sendChatMessage` preparation, up to `buildSystemInstruction`. */
async function desktopInstruction(
  home: string,
  settings: DesktopSettings,
  state: Parameters<typeof resolveAppEffectiveRules>[0],
  turn: DesktopTurn
): Promise<string> {
  const projectPath = turn.projectPath
  const designDefaults = settings.design_defaults ?? DEFAULT_DESIGN_DEFAULTS
  const envContext: EnvContext = {
    os: rendererPlatform.includes("Win")
      ? "windows"
      : rendererPlatform.includes("Mac")
        ? "macos"
        : "linux",
    shell: "bash",
    projectPath: projectPath || undefined,
    projectName: projectPath
      ? projectPath.replace(/\\/g, "/").split("/").pop()
      : undefined,
  }

  let skills: PromptSkill[] = []
  let mcps: PromptMcp[] = []
  let customRules = ""
  let subagents: PromptSubagent[] = []
  let projectPermissionRules: PromptPermissionRule[] = []
  const promptContext = rendererPromptContext(home, settings)
  let runtimeSkills: RuntimePromptSkill[] = promptContext.skills
  let runtimeMcps: PromptMcp[] = promptContext.mcps
  let runtimeSubagents: PromptSubagent[] = promptContext.subagents
  if (projectPath) {
    const [projectMcps, projectSkills, projectAgents, permissions] =
      await Promise.all([
        listProjectMcpServers(projectPath),
        listProjectSkills(projectPath),
        listProjectAgents(projectPath),
        listProjectPermissions(projectPath),
      ])
    projectPermissionRules = permissions
    runtimeMcps = mergePromptMcps(
      runtimeMcps,
      projectMcps.map((mcp) => ({
        name: mcp.name,
        command: mcp.command,
        args: mcp.args,
      }))
    )
    runtimeSkills = mergePromptSkills(
      runtimeSkills,
      projectSkills.map((skill) => ({
        name: skill.name,
        content: skill.content,
        source: "betterc0de",
        sourcePath: skill.sourcePath,
        ...(skill.description ? { description: skill.description } : {}),
      }))
    )
    runtimeSubagents = mergePromptSubagents(
      runtimeSubagents,
      projectAgentsToPromptSubagents(projectAgents)
    )
  }
  customRules = promptContext.customRules
  skills = selectPromptSkillsForProvider(runtimeSkills, {
    providerKind: turn.providerKind,
    providerInstanceId: turn.providerInstanceId,
  })
  mcps = runtimeMcps.map((mcp) => ({
    name: mcp.name,
    command: mcp.command,
    args: mcp.args,
  }))
  subagents = runtimeSubagents.map((subagent) => ({
    name: subagent.name,
    description: subagent.description,
    prompt: subagent.prompt,
    mode: subagent.mode,
    model: subagent.model,
    source: subagent.source,
    sourcePath: subagent.sourcePath,
    tools: subagent.tools,
    permissions: subagent.permissions,
  }))

  // `/workspace/effective-rules` for the project and the rule target.
  let effectiveRules: string | null = null
  let effectiveRulesLoaded = false
  if (projectPath) {
    const resolution = await resolveAppEffectiveRules(state, {
      workspaceRoot: projectPath,
      targetPath: turn.ruleTargetPath,
    })
    effectiveRules = resolution.content || null
    effectiveRulesLoaded = true
  }
  const combinedProjectRules = [
    effectiveRules,
    formatBetterC0deProjectPermissionRulesForPrompt(projectPermissionRules),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n")

  return buildSystemInstruction(
    turn.chatMode || "agent",
    turn.specialMode,
    turn.permissionLevel,
    envContext,
    skills,
    mcps,
    effectiveRulesLoaded ? "" : customRules,
    subagents,
    combinedProjectRules || null,
    turn.appMode,
    turn.designContext,
    designDefaults
  )
}

// ── The same turns through the backend ───────────────────────────────────

function backendRequest(
  turn: DesktopTurn,
  projectPath: string | null = turn.projectPath
) {
  return {
    thread_id: "thread-1",
    message: "Plan the change",
    model_id: "test-model",
    provider_kind: turn.providerKind,
    provider_instance_id: turn.providerInstanceId,
    project_path: projectPath,
    rule_target_path: turn.ruleTargetPath,
    chat_mode: turn.chatMode,
    special_mode: turn.specialMode,
    permission_level: turn.permissionLevel,
    // The chat-send schema defaults a missing app mode to "agent".
    app_mode: turn.appMode ?? "agent",
    design_context: turn.designContext,
  }
}

const baseTurn: DesktopTurn = {
  chatMode: "agent",
  specialMode: null,
  permissionLevel: "ask-on-edit",
  projectPath: null,
  appMode: "agent",
  designContext: null,
  providerKind: "openai",
  providerInstanceId: null,
  ruleTargetPath: null,
}

describe("the backend's turn instruction and the desktop's", () => {
  it("match for a project turn with a mode, a focus overlay and a permission level", async () => {
    const settings = { custom_rules: "Answer in German." }
    const { home, project, state } = await desktop(settings)
    const turn: DesktopTurn = {
      ...baseTurn,
      chatMode: "plan",
      specialMode: "security",
      permissionLevel: "read-only",
      projectPath: project,
      ruleTargetPath: ".",
    }
    const expected = await desktopInstruction(home, settings, state, turn)
    expect(expected).toContain("Use tabs.")
    expect(expected).toContain("Run the linter before committing.")
    expect(
      await buildPreparedTurnInstruction(state, backendRequest(turn))
    ).toBe(expected)
  })

  it("match in Canvas mode with a design brief and the user's design presets", async () => {
    const settings = {
      custom_rules: "",
      design_defaults: DEFAULT_DESIGN_DEFAULTS,
    }
    const { home, project, state } = await desktop(settings)
    const turn: DesktopTurn = {
      ...baseTurn,
      // Skipped by the builder while the design overlay is on.
      specialMode: "frontend",
      permissionLevel: "allow-edits",
      projectPath: project,
      appMode: "design",
      designContext: designBriefSchema.parse({
        target: "website",
        colorMode: "dark",
        styleTemplateId: "minimal-saas",
        description: "A landing page for a command-line tool.",
      }),
      providerKind: "codex",
      providerInstanceId: "codex-main",
    }
    const expected = await desktopInstruction(home, settings, state, turn)
    expect(expected).toContain("A landing page for a command-line tool.")
    expect(
      await buildPreparedTurnInstruction(state, backendRequest(turn))
    ).toBe(expected)
  })

  it("match for a chat without a folder, which runs in its scratch workspace", async () => {
    // No backend setting: the desktop's rules.md stands in, as it did.
    const settings = { custom_rules: "" }
    const { home, dataDir, state } = await desktop(settings)
    const scratch = await ensureScratchWorkspace(dataDir, "thread-1")
    expect(scratch).not.toBeNull()
    const turn: DesktopTurn = {
      ...baseTurn,
      permissionLevel: "bypass",
      providerKind: "openrouter",
    }
    const expected = await desktopInstruction(home, settings, state, turn)
    expect(expected).toContain("Prefer short answers.")
    expect(expected).toContain("No project directory set")
    expect(
      await buildPreparedTurnInstruction(state, backendRequest(turn, scratch))
    ).toBe(expected)
    expect(
      await buildPreparedTurnInstruction(state, backendRequest(turn, null))
    ).toBe(expected)
  })

  it("match for Claude, which loads the user's own skills itself", async () => {
    const settings = { custom_rules: "Answer in German." }
    const { home, project, state } = await desktop(settings)
    const turn: DesktopTurn = {
      ...baseTurn,
      chatMode: "ask",
      projectPath: project,
      appMode: null,
      providerKind: "claude",
      providerInstanceId: "claude-main",
    }
    const expected = await desktopInstruction(home, settings, state, turn)
    expect(expected).not.toContain("Use tabs.")
    expect(
      await buildPreparedTurnInstruction(state, backendRequest(turn))
    ).toBe(expected)
  })
})
