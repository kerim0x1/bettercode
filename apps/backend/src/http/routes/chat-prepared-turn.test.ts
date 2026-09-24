import { routingTestServices } from "../../testUtils/routing-services"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MODE_INSTRUCTIONS } from "@betterc0de/schema/system-instruction"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { registerChatRoutes } from "./chat"

// `/chat/send` with `prepareTurn`, as the phone app sends it: the desktop's
// hooks run first, and the turn gets the instruction the desktop builds.

const cleanup: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of cleanup.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(directory)
  return directory
}

/** The chat routes of a desktop whose settings folder is `home`, with one project. */
async function desktopWithProject(hooks: unknown[] = []) {
  vi.stubEnv("BETTERC0DE_HOME", "")
  const home = await temporaryDirectory("betterc0de-home-")
  const dataDir = path.join(home, "userdata")
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(path.join(home, "hooks.json"), JSON.stringify(hooks))
  const project = await temporaryDirectory("betterc0de-project-")
  const startTurn = vi.fn(() => {
    const completion = Promise.resolve()
    return { turnId: "turn-1", completion, settled: completion }
  })
  const app = new Hono()
  registerChatRoutes(app, {
    ...routingTestServices(),
    config: { dataDir, authToken: "desktop-secret" },
    remoteAccess: { authenticate: () => null },
    settings: {
      get: () => ({
        auto_save_conversations: false,
        custom_rules: "Answer in German.",
      }),
    },
    projectProjections: { listAll: () => [{ path: project }] },
    threads: {
      listProjects: () => [],
      getThreadProjectPath: () => project,
    },
    worktrees: { findForThread: () => null },
    worktreeRegistry: { listAll: () => [], findByThread: () => null },
    providerSessionBindings: {
      getLatestForThread: () => null,
      getLatestForThreadProvider: () => null,
    },
    providerHub: {
      has: () => true,
      assertCanStartTurn: vi.fn(),
      startTurn,
    },
    providers: { resolveProviderKind: vi.fn() },
  } as unknown as AppState)
  const send = (overrides: Record<string, unknown>) =>
    app.request("/chat/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        message: "Plan the change",
        modelId: "claude-opus",
        projectPath: project,
        chatMode: "plan",
        permissionLevel: "read-only",
        history: [],
        ...overrides,
      }),
    })
  const sentInstruction = () =>
    (
      startTurn.mock.calls[0] as unknown as [
        string,
        { systemInstruction?: string | null },
      ]
    )[1].systemInstruction ?? ""
  return { send, startTurn, sentInstruction }
}

describe("a prepared turn", () => {
  it("gets the desktop's instruction when the client sends none", async () => {
    const { send, sentInstruction } = await desktopWithProject()
    const response = await send({ prepareTurn: true })
    expect(response.status).toBe(200)
    expect(sentInstruction()).toContain(MODE_INSTRUCTIONS.plan!)
    expect(sentInstruction()).toContain("Answer in German.")
  })

  it("is left alone without prepareTurn: the desktop sends its own instruction", async () => {
    const { send, sentInstruction } = await desktopWithProject()
    const response = await send({})
    expect(response.status).toBe(200)
    expect(sentInstruction()).not.toContain(MODE_INSTRUCTIONS.plan!)
    // The rules still reach the turn, as before.
    expect(sentInstruction()).toContain("Answer in German.")
  })

  it("keeps an instruction the client did send", async () => {
    const { send, sentInstruction } = await desktopWithProject()
    await send({ prepareTurn: true, systemInstruction: "The client's own." })
    expect(sentInstruction()).toContain("The client's own.")
    expect(sentInstruction()).not.toContain(MODE_INSTRUCTIONS.plan!)
  })

  it("is refused, and never started, when a message hook fails", async () => {
    const command = `node -e "process.stderr.write('lint failed'); process.exit(2)"`
    const { send, startTurn } = await desktopWithProject([
      { id: "lint", event: "on_message_send", command, enabled: true },
    ])
    const response = await send({ prepareTurn: true })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      code: "message_hook_failed",
      error: `Hook "${command}" failed: lint failed`,
    })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("runs no hooks without prepareTurn: the desktop runs them itself", async () => {
    const command = `node -e "process.exit(2)"`
    const { send, startTurn } = await desktopWithProject([
      { id: "lint", event: "on_message_send", command, enabled: true },
    ])
    expect((await send({})).status).toBe(200)
    expect(startTurn).toHaveBeenCalledTimes(1)
  })
})
