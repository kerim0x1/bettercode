import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RUNTIME_HOOK_LIMITS } from "@betterc0de/schema/runtime-records"
import {
  MODE_INSTRUCTIONS,
  PERMISSION_INSTRUCTIONS,
  VISUAL_REPLIES_INSTRUCTIONS,
} from "@betterc0de/schema/system-instruction"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandApprovalMarker } from "../../security/commandApproval"
import {
  promptMcpsFromServers,
  resolveConfiguredMcpServers,
} from "../desktop-config/mcp"
import { resolveTurnSystemInstruction } from "../effective-rules"
import { ShellSessionService } from "../shell"
import {
  buildPreparedTurnInstruction,
  readRuntimeHooks,
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

/** A hook as the desktop stores it once the user approved its command. */
function approvedHook(hook: {
  id: string
  event?: string
  command: string
  enabled?: boolean
}) {
  return {
    ...hook,
    approval: createCommandApprovalMarker("hook", hook.command),
  }
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
  const state = {
    config: { dataDir },
    settings: { get: () => ({ custom_rules: "Answer in German." }) },
    shellSessions: new ShellSessionService(),
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
    const { home, state } = await desktop()
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
    // The same list the turn attaches (services/desktop-config/mcp.ts).
    expect(
      promptMcpsFromServers(await resolveConfiguredMcpServers(state, ""))
    ).toEqual([
      { name: "files", command: "npx", args: ["mcp-files"] },
      { name: "remote", command: "https://mcp.example", args: [] },
    ])
  })

  it("reads hooks, a hook without an event running on message send", async () => {
    const { home } = await desktop()
    await write(path.join(home, "hooks.json"), [
      approvedHook({ id: "a", command: "lint" }),
      { id: "b", event: "on_commit", command: "notify", enabled: false },
      // A marker for another command approves nothing.
      {
        id: "c",
        command: "curl evil",
        approval: createCommandApprovalMarker("hook", "lint"),
      },
    ])
    expect(await readRuntimeHooks(home)).toEqual([
      {
        id: "a",
        event: "on_message_send",
        command: "lint",
        enabled: true,
        approved: true,
      },
      {
        id: "b",
        event: "on_commit",
        command: "notify",
        enabled: false,
        approved: false,
      },
      {
        id: "c",
        event: "on_message_send",
        command: "curl evil",
        enabled: true,
        approved: false,
      },
    ])
  })

  it("reads as many hooks as the desktop stores, and refuses more", async () => {
    const { home } = await desktop()
    const hooks = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `hook-${index}`,
        event: "on_commit",
        command: "notify",
        enabled: true,
      }))
    // More than the backend's old cap of 256, within the shared limit.
    await write(path.join(home, "hooks.json"), hooks(300))
    expect(await readRuntimeHooks(home)).toHaveLength(300)
    await write(
      path.join(home, "hooks.json"),
      hooks(RUNTIME_HOOK_LIMITS.maxHooks + 1)
    )
    await expect(readRuntimeHooks(home)).rejects.toThrow(/more than/)
  })

  it("refuses a message hook that is not a hook record, and leaves other events alone", async () => {
    const { home } = await desktop()
    await write(path.join(home, "hooks.json"), [
      { id: "later", event: "on_build", command: "x", enabled: true },
    ])
    expect(await readRuntimeHooks(home)).toEqual([
      {
        id: "later",
        event: "on_build",
        command: "x",
        enabled: true,
        approved: false,
      },
    ])
    await write(path.join(home, "hooks.json"), [
      { id: "lint", command: "x".repeat(5_000), enabled: true },
    ])
    await expect(readRuntimeHooks(home)).rejects.toThrow(
      /entry 1 is not a valid hook/
    )
  })

  it("finds nothing where the desktop keeps no settings", async () => {
    const empty = await temporaryDirectory("betterc0de-empty-")
    expect(await readRuntimeSkills(empty)).toEqual([])
    expect(await readRuntimeSubagents(empty)).toEqual([])
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
    // Names only: command lines and URLs can carry credentials.
    expect(instruction).toContain("- **files**\n")
    expect(instruction).toContain("- **remote**\n")
    expect(instruction).not.toContain("npx mcp-files")
    expect(instruction).not.toContain("mcp.example")
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

  it("describes visual replies only while Settings → Chat → Visual Replies is on", async () => {
    const { state } = await desktop()
    const withSettings = (settings: Record<string, unknown>) =>
      ({
        ...(state as Record<string, unknown>),
        settings: { get: () => settings },
      }) as never
    const on = await buildPreparedTurnInstruction(
      withSettings({ visual_replies: true }),
      request()
    )
    expect(on).toContain(VISUAL_REPLIES_INSTRUCTIONS)
    expect(on).toContain("```html-render")
    const off = await buildPreparedTurnInstruction(
      withSettings({ visual_replies: false }),
      request()
    )
    expect(off).not.toContain("html-render")
  })
})

describe("hooks before a prepared turn", () => {
  it("runs the enabled message hooks with the desktop's environment", async () => {
    const { home, project, state } = await desktop()
    const out = path.join(project, "hook-env.json").replace(/\\/g, "/")
    await write(path.join(home, "hooks.json"), [
      approvedHook({
        id: "record",
        event: "on_message_send",
        command: `node -e "require('fs').writeFileSync('${out}', JSON.stringify({event: process.env.BETTERC0DE_HOOK_EVENT, message: process.env.BETTERC0DE_MESSAGE, thread: process.env.BETTERC0DE_THREAD_ID, provider: process.env.BETTERC0DE_PROVIDER, cwd: process.cwd()}))"`,
        enabled: true,
      }),
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

  it("records each run in hooks.json, where Settings → Hooks shows it", async () => {
    const { home, project, state } = await desktop()
    const failing = `node -e "process.stderr.write('lint failed'); process.exit(3)"`
    await write(path.join(home, "hooks.json"), [
      approvedHook({
        id: "ok",
        event: "on_message_send",
        command: "node -e 0",
      }),
      { ...approvedHook({ id: "lint", command: failing }), createdAt: "then" },
    ])
    await expect(
      runMessageSendHooks(state, request({ project_path: project }))
    ).rejects.toMatchObject({ code: "message_hook_failed" })
    const stored = JSON.parse(
      await fs.readFile(path.join(home, "hooks.json"), "utf8")
    ) as Array<Record<string, unknown>>
    expect(stored[0]).toMatchObject({
      id: "ok",
      lastStatus: "success",
      lastExitCode: 0,
      lastError: null,
    })
    expect(stored[1]).toMatchObject({
      id: "lint",
      createdAt: "then",
      lastStatus: "error",
      lastExitCode: 3,
      lastError: "lint failed",
    })
    expect(typeof stored[1]!.lastRunAt).toBe("string")
    // The record keeps the approval: the hook still runs next time.
    expect(stored[1]!.approval).toEqual(
      createCommandApprovalMarker("hook", failing)
    )
  })

  it("finds the hooks of a desktop whose data folder is not named userdata", async () => {
    vi.stubEnv("BETTERC0DE_HOME", "")
    const home = await temporaryDirectory("betterc0de-home-")
    const dataDir = await temporaryDirectory("betterc0de-custom-data-")
    const command = `node -e "process.exit(4)"`
    await write(path.join(home, "hooks.json"), [
      approvedHook({ id: "gate", event: "on_message_send", command }),
    ])
    // The runtime home comes from ServerConfig (BETTERC0DE_RUNTIME_HOME),
    // never from the data folder's name.
    const state = {
      config: { dataDir, runtimeHome: home },
      settings: { get: () => ({}) },
      shellSessions: new ShellSessionService(),
    } as never
    await expect(runMessageSendHooks(state, request())).rejects.toMatchObject({
      code: "message_hook_failed",
    })
  })

  it("refuses the message when a hook fails, in the desktop's words", async () => {
    const { home, project, state } = await desktop()
    const command = `node -e "process.stderr.write('lint failed'); process.exit(2)"`
    await write(path.join(home, "hooks.json"), [
      approvedHook({
        id: "lint",
        event: "on_message_send",
        command,
        enabled: true,
      }),
    ])
    await expect(
      runMessageSendHooks(state, request({ project_path: project }))
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "message_hook_failed",
      message: `Hook "${command}" failed: lint failed`,
    })
  })

  it("refuses the message, without running anything, when a hook is not approved", async () => {
    const { home, project, state } = await desktop()
    const marker = path.join(project, "ran.txt").replace(/\\/g, "/")
    const command = `node -e "require('fs').writeFileSync('${marker}', 'ran')"`
    await write(path.join(home, "hooks.json"), [
      { id: "unapproved", event: "on_message_send", command, enabled: true },
    ])
    await expect(
      runMessageSendHooks(state, request({ project_path: project }))
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "message_hook_failed",
      message: expect.stringContaining("is not approved"),
    })
    await expect(fs.access(marker)).rejects.toThrow()
  })

  it.each([
    ["not JSON", "{ broken"],
    ["not a list", JSON.stringify({ hooks: [] })],
    ["a list with a non-hook", JSON.stringify(["lint"])],
  ])(
    "refuses the message when hooks.json is %s instead of skipping the hooks",
    async (_label, content) => {
      const { home, project, state } = await desktop()
      await write(path.join(home, "hooks.json"), content)
      await expect(readRuntimeHooks(home)).rejects.toThrow(/hooks\.json/)
      await expect(
        runMessageSendHooks(state, request({ project_path: project }))
      ).rejects.toMatchObject({
        statusCode: 422,
        code: "message_hook_failed",
        message: expect.stringContaining("could not be read"),
      })
    }
  )

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
