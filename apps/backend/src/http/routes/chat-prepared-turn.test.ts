import { routingTestServices } from "../../testUtils/routing-services"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  MODE_INSTRUCTIONS,
  PERMISSION_INSTRUCTIONS,
  SPECIAL_MODE_INSTRUCTIONS,
} from "@betterc0de/schema/system-instruction"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { createCommandApprovalMarker } from "../../security/commandApproval"
import { registerChatRoutes as registerChatRoutesUnfilled } from "./chat"
import { withInertStateArgument } from "../../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const registerChatRoutes = withInertStateArgument(registerChatRoutesUnfilled, 1)

// `/chat/send` with `prepareTurn`, as every client sends it: the user's
// hooks run first (for every message, prepared or not), and the turn gets
// the instruction the backend builds.

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

const DESKTOP = { Authorization: "Bearer desktop-secret" }
const PHONE = { Authorization: "Bearer phone-secret" }

/** The chat routes of a desktop whose settings folder is `home`, with one project. */
async function desktopWithProject(
  hooks: unknown[] = [],
  options: {
    storedPermissionLevel?: string
    /** Runs the hooks; without it every hook fails (no shell here). */
    runCommand?: (input: unknown) => Promise<unknown>
  } = {}
) {
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
    remoteAccess: {
      authenticate: (token: string) =>
        token === "phone-secret"
          ? { id: "phone-session", accessLevel: "full" }
          : null,
    },
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
      getThreadSettings: () =>
        options.storedPermissionLevel
          ? { permissionLevel: options.storedPermissionLevel }
          : null,
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
    ...(options.runCommand
      ? { shellSessions: { runCommand: options.runCommand } }
      : {}),
  } as unknown as AppState)
  const request = (
    route: string,
    overrides: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) =>
    app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
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
  const send = (
    overrides: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) => request("/chat/send", overrides, headers)
  const persistUser = (
    overrides: Record<string, unknown>,
    headers: Record<string, string> = DESKTOP
  ) => request("/chat/persist-user", overrides, headers)
  const sentTurn = () =>
    (
      startTurn.mock.calls[0] as unknown as [
        string,
        { systemInstruction?: string | null; permissionLevel?: string },
      ]
    )[1]
  const sentInstruction = () => sentTurn().systemInstruction ?? ""
  return { send, persistUser, startTurn, sentTurn, sentInstruction }
}

/** A failing "on message send" hook the user approved on the desktop. */
function failingHook(): { command: string; hook: unknown } {
  const command = `node -e "process.stderr.write('lint failed'); process.exit(2)"`
  return {
    command,
    hook: {
      id: "lint",
      event: "on_message_send",
      command,
      enabled: true,
      // Approved on the desktop: only approved commands run here.
      approval: createCommandApprovalMarker("hook", command),
    },
  }
}

describe("a prepared turn", () => {
  it("gets the instruction when the client sends none", async () => {
    const { send, sentInstruction } = await desktopWithProject()
    const response = await send({ prepareTurn: true })
    expect(response.status).toBe(200)
    expect(sentInstruction()).toContain(MODE_INSTRUCTIONS.plan!)
    expect(sentInstruction()).toContain("Answer in German.")
  })

  it("carries the composer's focus mode into the instruction", async () => {
    const { send, sentInstruction } = await desktopWithProject()
    await send({ prepareTurn: true, specialMode: "security" })
    expect(sentInstruction()).toContain(SPECIAL_MODE_INSTRUCTIONS.security!)
  })

  it("is left alone without prepareTurn: the client sent its own instruction", async () => {
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
    const { command, hook } = failingHook()
    const { send, startTurn } = await desktopWithProject([hook])
    const response = await send({ prepareTurn: true })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      code: "message_hook_failed",
      error: expect.stringContaining(`Hook "${command}" failed`),
    })
    expect(startTurn).not.toHaveBeenCalled()
  })
})

describe("message hooks", () => {
  it("run without prepareTurn too: no client can send around them", async () => {
    const { command, hook } = failingHook()
    const { send, startTurn } = await desktopWithProject([hook])
    for (const headers of [{}, DESKTOP, PHONE]) {
      const response = await send({}, headers)
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({
        code: "message_hook_failed",
        error: expect.stringContaining(`Hook "${command}" failed`),
      })
    }
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("refuse the message when a hook is not approved, whoever sent it", async () => {
    const command = `node -e "process.exit(0)"`
    const { send, startTurn } = await desktopWithProject([
      { id: "lint", event: "on_message_send", command, enabled: true },
    ])
    const response = await send({})
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      code: "message_hook_failed",
      error: expect.stringContaining("is not approved"),
    })
    expect(startTurn).not.toHaveBeenCalled()
  })
})

describe("the permission level kept with the chat", () => {
  it("stands in for a turn that names none", async () => {
    const { send, sentTurn, sentInstruction } = await desktopWithProject([], {
      storedPermissionLevel: "allow-edits",
    })
    expect(
      (await send({ prepareTurn: true, permissionLevel: null })).status
    ).toBe(200)
    expect(sentTurn().permissionLevel).toBe("allow-edits")
    expect(sentInstruction()).toContain(PERMISSION_INSTRUCTIONS["allow-edits"]!)
  })

  it("never outranks the level a turn names", async () => {
    const { send, sentTurn } = await desktopWithProject([], {
      storedPermissionLevel: "allow-edits",
    })
    await send({ permissionLevel: "read-only" })
    expect(sentTurn().permissionLevel).toBe("read-only")
  })

  it("gives a paired device without the terminal grant no bypass", async () => {
    const { send, sentTurn } = await desktopWithProject([], {
      storedPermissionLevel: "bypass",
    })
    expect((await send({ permissionLevel: null }, PHONE)).status).toBe(200)
    expect(sentTurn().permissionLevel).toBe("ask-on-edit")
  })
})

describe("a provider plugin's prepared turn", () => {
  it("gets its instruction back with the recorded user message", async () => {
    const { persistUser, startTurn } = await desktopWithProject()
    const response = await persistUser({
      prepareTurn: true,
      specialMode: "security",
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      persisted: boolean
      systemInstruction?: string
    }
    expect(body.persisted).toBe(false)
    expect(body.systemInstruction).toContain(MODE_INSTRUCTIONS.plan!)
    expect(body.systemInstruction).toContain(
      SPECIAL_MODE_INSTRUCTIONS.security!
    )
    expect(body.systemInstruction).toContain("Answer in German.")
    // The plugin runs the turn; the backend starts nothing.
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("is refused when a message hook fails", async () => {
    const { hook } = failingHook()
    const { persistUser } = await desktopWithProject([hook])
    const response = await persistUser({ prepareTurn: true })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      code: "message_hook_failed",
    })
  })

  it("is prepared for the desktop only", async () => {
    const { persistUser } = await desktopWithProject()
    expect((await persistUser({ prepareTurn: true }, PHONE)).status).toBe(403)
  })

  it("leaves a plain record of the user message alone", async () => {
    const { hook } = failingHook()
    const { persistUser } = await desktopWithProject([hook])
    const response = await persistUser({})
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ persisted: false })
  })
})

describe("a provider plugin's fallback send", () => {
  /** An approved "on message send" hook; `runCommand` counts its runs. */
  function countedHook() {
    const command = `node -e "process.exit(0)"`
    const runCommand = vi.fn(async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
    }))
    return {
      runCommand,
      hook: {
        id: "check",
        event: "on_message_send",
        command,
        enabled: true,
        approval: createCommandApprovalMarker("hook", command),
      },
    }
  }

  async function persistedPluginTurn(
    persistUser: (
      overrides: Record<string, unknown>
    ) => Response | Promise<Response>
  ): Promise<string> {
    const response = await persistUser({
      prepareTurn: true,
      userMessageId: "message-1",
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { preparedTurnToken?: string }
    expect(body.preparedTurnToken).toEqual(expect.any(String))
    return body.preparedTurnToken!
  }

  it("does not run the hooks a second time for the same message", async () => {
    const { hook, runCommand } = countedHook()
    const { persistUser, send, startTurn } = await desktopWithProject([hook], {
      runCommand,
    })
    const preparedTurnToken = await persistedPluginTurn(persistUser)
    expect(runCommand).toHaveBeenCalledTimes(1)

    const response = await send(
      { prepareTurn: true, userMessageId: "message-1", preparedTurnToken },
      DESKTOP
    )
    expect(response.status).toBe(200)
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(startTurn).toHaveBeenCalledTimes(1)
  })

  it("runs them for a different message under the same token", async () => {
    const { hook, runCommand } = countedHook()
    const { persistUser, send } = await desktopWithProject([hook], {
      runCommand,
    })
    const preparedTurnToken = await persistedPluginTurn(persistUser)
    const response = await send(
      {
        prepareTurn: true,
        userMessageId: "message-1",
        message: "Something else entirely",
        preparedTurnToken,
      },
      DESKTOP
    )
    expect(response.status).toBe(200)
    expect(runCommand).toHaveBeenCalledTimes(2)
  })

  it("runs them for a paired device that presents the token", async () => {
    const { hook, runCommand } = countedHook()
    const { persistUser, send } = await desktopWithProject([hook], {
      runCommand,
    })
    const preparedTurnToken = await persistedPluginTurn(persistUser)
    const response = await send(
      { prepareTurn: true, userMessageId: "message-1", preparedTurnToken },
      PHONE
    )
    expect(response.status).toBe(200)
    expect(runCommand).toHaveBeenCalledTimes(2)
  })

  it("is refused by a failing hook even with an unknown token", async () => {
    const { hook } = failingHook()
    const { send, startTurn } = await desktopWithProject([hook])
    const response = await send(
      {
        prepareTurn: true,
        userMessageId: "message-1",
        preparedTurnToken: "not-a-token-the-backend-issued",
      },
      DESKTOP
    )
    expect(response.status).toBe(422)
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("gets no token without a message id to bind it to", async () => {
    const { hook, runCommand } = countedHook()
    const { persistUser } = await desktopWithProject([hook], { runCommand })
    const response = await persistUser({ prepareTurn: true })
    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty("preparedTurnToken")
  })
})
