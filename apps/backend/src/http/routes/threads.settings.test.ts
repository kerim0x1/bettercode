import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { openDatabase, type Db } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import { ThreadService } from "../../services/threads/service"
import { withInertStateArgument } from "../../testUtils/inert-app-state"
import { registerThreadsRoutes as registerThreadsRoutesUnfilled } from "./threads"
import { registerThreadActivityBroadcaster } from "../../ws/threadActivityBroadcast"

// Doubles name only what a test exercises; the rest is filled in inert.
const registerThreadsRoutes = withInertStateArgument(
  registerThreadsRoutesUnfilled,
  1
)

// A chat's own settings (permission level, model selection, orchestration)
// are kept with the chat: PATCH /threads/:id with `{ settings }` changes
// them and nothing else, and every client reads them with the chat.

const DESKTOP = { Authorization: "Bearer desktop-secret" }
const PHONE = { Authorization: "Bearer phone-secret" }

let dir: string
let db: Db
let threads: ThreadService
let app: Hono
let allowTerminal = false

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-thread-settings-"))
  db = openDatabase(path.join(dir, "test.sqlite"))
  runMigrations(db)
  threads = new ThreadService(db)
  threads.upsertThreadMeta({
    thread_id: "thread-1",
    title: "Release notes",
    project_name: "Project",
    project_path: dir,
    created_at: "2026-10-01T10:00:00.000Z",
    updated_at: "2026-10-01T10:00:00.000Z",
    codex_thread_id: null,
  })
  allowTerminal = false
  app = new Hono()
  registerThreadsRoutes(app, {
    db,
    threads,
    config: { authToken: "desktop-secret" },
    remoteAccess: {
      authenticate: (token: string) =>
        token === "phone-secret"
          ? { id: "phone-session", accessLevel: "full" }
          : null,
    },
    settings: {
      get: () => ({ remote_access_allow_terminal: allowTerminal }),
    },
  } as unknown as AppState)
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const patch = (
  body: unknown,
  headers: Record<string, string> = DESKTOP,
  threadId = "thread-1"
) =>
  app.request(`/threads/${threadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

const readThread = async () =>
  (await (await app.request("/threads/thread-1")).json()) as Record<
    string,
    unknown
  >

describe("a chat's own settings", () => {
  it("are kept with the chat, changed key by key and cleared with null", async () => {
    expect(
      (
        await patch({
          settings: {
            permissionLevel: "allow-edits",
            selectedProviderId: "codex-main",
            selectedModel: "gpt-5.5",
            modelSelectionByProvider: {
              "codex-main": {
                selectedModel: "gpt-5.5",
                thinkingMode: "high",
                fastMode: true,
                optionSelections: [{ id: "reasoningEffort", value: "high" }],
              },
            },
          },
        })
      ).status
    ).toBe(204)
    expect(
      (
        await patch({
          settings: {
            permissionLevel: "read-only",
            orchestration: { enabled: false },
          },
        })
      ).status
    ).toBe(204)
    expect(threads.getThreadSettings("thread-1")).toEqual({
      permissionLevel: "read-only",
      selectedProviderId: "codex-main",
      selectedModel: "gpt-5.5",
      modelSelectionByProvider: {
        "codex-main": {
          selectedModel: "gpt-5.5",
          thinkingMode: "high",
          fastMode: true,
          optionSelections: [{ id: "reasoningEffort", value: "high" }],
        },
      },
      orchestration: { enabled: false },
    })

    expect(
      (await patch({ settings: { selectedModel: null, orchestration: null } }))
        .status
    ).toBe(204)
    const thread = await readThread()
    expect(thread.settings).toEqual({
      permissionLevel: "read-only",
      selectedProviderId: "codex-main",
      modelSelectionByProvider: {
        "codex-main": {
          selectedModel: "gpt-5.5",
          thinkingMode: "high",
          fastMode: true,
          optionSelections: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    })
    // Settings do not reorder the sidebar.
    expect(thread.updatedAt).toBe("2026-10-01T10:00:00.000Z")
  })

  it("are absent from a chat that has none, and gone once all are cleared", async () => {
    expect(await readThread()).not.toHaveProperty("settings")
    await patch({ settings: { permissionLevel: "bypass" } })
    await patch({ settings: { permissionLevel: null } })
    expect(threads.getThreadSettings("thread-1")).toBeNull()
    expect(await readThread()).not.toHaveProperty("settings")
  })

  it("are left alone by a metadata write, which ignores a settings key in it", async () => {
    await patch({ settings: { permissionLevel: "allow-edits" } })
    const response = await patch({
      title: "Renamed",
      projectName: "Project",
      projectPath: dir,
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-02T10:00:00.000Z",
      settings: { permissionLevel: "bypass" },
    })
    expect(response.status).toBe(204)
    expect(threads.getThreadSettings("thread-1")).toEqual({
      permissionLevel: "allow-edits",
    })
    expect((await readThread()).title).toBe("Renamed")
  })

  it("refuses an unknown chat, an unknown key and a malformed value", async () => {
    const missing = await patch(
      { settings: { permissionLevel: "read-only" } },
      DESKTOP,
      "thread-2"
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: "thread_not_found" })
    expect((await patch({ settings: { chatMode: "plan" } })).status).toBe(400)
    expect(
      (await patch({ settings: { orchestration: { enabled: true } } })).status
    ).toBe(400)
    expect(threads.getThreadSettings("thread-1")).toBeNull()
  })

  it("keep a paired device to its limits: no bypass without the terminal grant, no orchestration", async () => {
    const bypass = await patch(
      { settings: { permissionLevel: "bypass" } },
      PHONE
    )
    expect(bypass.status).toBe(403)
    expect(await bypass.json()).toMatchObject({
      code: "remote_bypass_disabled",
    })
    const orchestration = await patch(
      {
        settings: {
          orchestration: { enabled: true, providers: ["codex"] },
        },
      },
      PHONE
    )
    expect(orchestration.status).toBe(403)
    expect(threads.getThreadSettings("thread-1")).toBeNull()

    expect(
      (await patch({ settings: { permissionLevel: "ask-on-edit" } }, PHONE))
        .status
    ).toBe(204)
    allowTerminal = true
    expect(
      (await patch({ settings: { permissionLevel: "bypass" } }, PHONE)).status
    ).toBe(204)
    expect(threads.getThreadSettings("thread-1")).toEqual({
      permissionLevel: "bypass",
    })
  })
})

describe("a change to a chat's settings", () => {
  it("reaches every open client with the settings the backend now keeps", async () => {
    const broadcast = vi.fn()
    const unregister = registerThreadActivityBroadcaster({ broadcast })
    try {
      await patch({ settings: { permissionLevel: "allow-edits" } })
      await patch({
        settings: { selectedModel: "gpt-5.5", permissionLevel: null },
      })
      expect(broadcast.mock.calls.map(([frame]) => frame)).toEqual([
        {
          channel: "thread.metadata",
          data: {
            threadId: "thread-1",
            settings: { permissionLevel: "allow-edits" },
          },
        },
        {
          channel: "thread.metadata",
          data: {
            threadId: "thread-1",
            settings: { selectedModel: "gpt-5.5" },
          },
        },
      ])
    } finally {
      unregister()
    }
  })

  it("is not announced when it is refused", async () => {
    const broadcast = vi.fn()
    const unregister = registerThreadActivityBroadcaster({ broadcast })
    try {
      await patch({ settings: { permissionLevel: "bypass" } }, PHONE)
      await patch({ settings: { permissionLevel: "read-only" } }, DESKTOP, "x")
      expect(broadcast).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })
})
