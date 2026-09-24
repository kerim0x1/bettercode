import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  MODE_INSTRUCTIONS,
  PERMISSION_INSTRUCTIONS,
} from "@betterc0de/schema/system-instruction"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveTurnSystemInstruction } from "../effective-rules"
import {
  buildPreparedTurnInstruction,
  readRuntimeHooks,
  readRuntimeMcps,
  readRuntimeSkills,
  readRuntimeSubagents,
  runMessageSendHooks,
  type PreparedTurnRequest,
} from "./turn-preparation"

const temporary: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
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

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

/**
 * The desktop's settings folder (the backend's data in `<home>/userdata`,
 * as the desktop starts it) and a project, with the user's skills, MCP
 * servers and subagents as the desktop stores them.
 */
async function desktop() {
  vi.stubEnv("BETTERC0DE_HOME", "")
  const home = await temporaryDirectory("betterc0de-home-")
  const dataDir = path.join(home, "userdata")
  await fs.mkdir(dataDir, { recursive: true })
  const project = await temporaryDirectory("betterc0de-project-")
  await write(path.join(home, "skills", "style", "manifest.json"), {
    name: "Style",
    enabled: true,
  })
  await write(path.join(home, "skills", "style", "content.md"), "Use tabs.")
  await write(path.join(home, "skills", "off", "manifest.json"), {
    name: "Switched off",
    enabled: false,
  })
  await write(path.join(home, "skills", "off", "content.md"), "Never shown.")
  await write(
    path.join(home, "skills", "broken", "manifest.json"),
    "{ not json"
  )
  await write(path.join(home, "subagents", "reviewer", "manifest.json"), {
    name: "Reviewer",
    description: "Reviews a change",
  })
  await write(
    path.join(home, "subagents", "reviewer", "prompt.md"),
    "Review carefully."
  )
  await write(path.join(home, "mcp-servers.json"), [
    { name: "files", command: "npx", args: ["mcp-files"], enabled: true },
    { name: "switched-off", command: "npx", enabled: false },
    { name: "remote", type: "http", url: "https://mcp.example" },
  ])
  const state = {
    config: { dataDir },
    settings: { get: () => ({ custom_rules: "Answer in German." }) },
  } as never
  return { home, project, state }
}

const request = (
  overrides: Partial<PreparedTurnRequest> = {}
): PreparedTurnRequest => ({
  thread_id: "thread-1",
  message: "Plan the change",
  model_id: "gpt-test",
  provider_kind: "openai",
  provider_instance_id: null,
  project_path: null,
  chat_mode: "agent",
  permission_level: "ask-on-edit",
  app_mode: "agent",
  ...overrides,
})

describe("the desktop's settings the preparation reads", () => {
  it("reads the enabled skills, subagents and MCP servers, as the desktop lists them", async () => {
    const { home } = await desktop()
    expect(await readRuntimeSkills(home)).toEqual([
      {
        name: "Style",
        content: "Use tabs.",
        providerKinds: [],
        providerInstanceIds: [],
        source: "",
        sourcePath: "",
      },
    ])
    expect(await readRuntimeSubagents(home)).toEqual([
      {
        name: "Reviewer",
        description: "Reviews a change",
        prompt: "Review carefully.",
        source: "",
        sourcePath: "",
      },
    ])
    expect(await readRuntimeMcps(home)).toEqual([
      { name: "files", command: "npx", args: ["mcp-files"] },
      { name: "remote", command: "", args: [] },
    ])
  })

  it("reads hooks, a hook without an event running on message send", async () => {
    const { home } = await desktop()
    await write(path.join(home, "hooks.json"), [
      { id: "a", command: "lint" },
      { id: "b", event: "on_commit", command: "notify", enabled: false },
    ])
    expect(await readRuntimeHooks(home)).toEqual([
      { id: "a", event: "on_message_send", command: "lint", enabled: true },
      { id: "b", event: "on_commit", command: "notify", enabled: false },
    ])
  })

  it("finds nothing where the desktop keeps no settings", async () => {
    const empty = await temporaryDirectory("betterc0de-empty-")
    expect(await readRuntimeSkills(empty)).toEqual([])
    expect(await readRuntimeSubagents(empty)).toEqual([])
    expect(await readRuntimeMcps(empty)).toEqual([])
    expect(await readRuntimeHooks(empty)).toEqual([])
  })
})

describe("the system instruction of a prepared turn", () => {
  it("has the desktop's mode, permission, project, skills, subagents, MCP servers and rules", async () => {
    const { project, state } = await desktop()
    await write(
      path.join(project, "AGENTS.md"),
      "Run the linter before committing."
    )
    const instruction = await buildPreparedTurnInstruction(
      state,
      request({
        project_path: project,
        chat_mode: "plan",
        permission_level: "read-only",
      })
    )
    expect(instruction).toContain(MODE_INSTRUCTIONS.plan!)
    expect(instruction).toContain(PERMISSION_INSTRUCTIONS["read-only"]!)
    expect(instruction).toContain(`Path: ${project}`)
    expect(instruction).toContain("### Style\nUse tabs.")
    expect(instruction).not.toContain("Never shown.")
    expect(instruction).toContain("### Reviewer\nReviews a change")
    expect(instruction).toContain("- **files**: `npx mcp-files`")
    expect(instruction).toContain("- **remote**: `configuration only`")
    expect(instruction).toContain("Run the linter before committing.")
    expect(instruction).toContain("Answer in German.")
    // The rules are in already: the turn adds nothing to them (it only
    // trims the instruction).
    expect(
      await resolveTurnSystemInstruction(state, {
        workspaceRoot: project,
        systemInstruction: instruction,
      })
    ).toBe(instruction.trim())
  })

  it("gives Claude and Codex only the project's skills, which they cannot load themselves", async () => {
    const { project, state } = await desktop()
    const instruction = await buildPreparedTurnInstruction(
      state,
      request({ project_path: project, provider_kind: "claude" })
    )
    expect(instruction).not.toContain("### Style")
  })

  it("carries the user's rules without a project", async () => {
    const { state } = await desktop()
    const instruction = await buildPreparedTurnInstruction(state, request())
    expect(instruction).toContain("Answer in German.")
    expect(instruction).toContain("No project directory set")
  })
})

describe("hooks before a prepared turn", () => {
  it("runs the enabled message hooks with the desktop's environment", async () => {
    const { home, project, state } = await desktop()
    const out = path.join(project, "hook-env.json").replace(/\\/g, "/")
    await write(path.join(home, "hooks.json"), [
      {
        id: "record",
        event: "on_message_send",
        command: `node -e "require('fs').writeFileSync('${out}', JSON.stringify({event: process.env.BETTERC0DE_HOOK_EVENT, message: process.env.BETTERC0DE_MESSAGE, thread: process.env.BETTERC0DE_THREAD_ID, provider: process.env.BETTERC0DE_PROVIDER, cwd: process.cwd()}))"`,
        enabled: true,
      },
    ])
    await runMessageSendHooks(state, request({ project_path: project }))
    const seen = JSON.parse(await fs.readFile(out, "utf8")) as Record<
      string,
      string
    >
    expect(seen).toMatchObject({
      event: "on_message_send",
      message: "Plan the change",
      thread: "thread-1",
      provider: "openai",
    })
    expect(await fs.realpath(seen.cwd!)).toBe(await fs.realpath(project))
  })

  it("refuses the message when a hook fails, in the desktop's words", async () => {
    const { home, project, state } = await desktop()
    const command = `node -e "process.stderr.write('lint failed'); process.exit(2)"`
    await write(path.join(home, "hooks.json"), [
      { id: "lint", event: "on_message_send", command, enabled: true },
    ])
    await expect(
      runMessageSendHooks(state, request({ project_path: project }))
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "message_hook_failed",
      message: `Hook "${command}" failed: lint failed`,
    })
  })

  it("leaves out disabled hooks and hooks for other events", async () => {
    const { home, project, state } = await desktop()
    const failing = `node -e "process.exit(1)"`
    await write(path.join(home, "hooks.json"), [
      { id: "off", event: "on_message_send", command: failing, enabled: false },
      { id: "commit", event: "on_commit", command: failing, enabled: true },
    ])
    await expect(
      runMessageSendHooks(state, request({ project_path: project }))
    ).resolves.toBeUndefined()
  })

  it("runs nothing for a backend the desktop did not start", async () => {
    vi.stubEnv("BETTERC0DE_HOME", "")
    const dataDir = await temporaryDirectory("betterc0de-data-")
    const state = {
      config: { dataDir },
      settings: { get: () => ({}) },
    } as never
    await expect(runMessageSendHooks(state, request())).resolves.toBeUndefined()
  })
})
