import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultSettings } from "@betterc0de/schema"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import type { ServerConfig } from "../../config"
import { buildApp as buildAppUnfilled } from "../router"
import { openDatabase } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import { RemoteAccessService } from "../../remote/service"
import { stopAllToolOutputArchiveStores } from "../../services/tool-output-archive-store"
import { routerLifecycleServices } from "../../testUtils/routing-services"
import { withInertStateArgument } from "../../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const buildApp = withInertStateArgument(buildAppUnfilled, 1)

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-themes-http-")
  )
  const db = openDatabase(path.join(directory, "test.sqlite"))
  runMigrations(db)
  const values = { ...defaultSettings(), remote_access_enabled: true }
  const settings = {
    get: () => values,
    getPublic: () => values,
    updatePublic: vi.fn(async () => values),
  }
  const config: ServerConfig = {
    host: "0.0.0.0",
    port: 3773,
    dataDir: directory,
    dbPath: path.join(directory, "test.sqlite"),
    settingsPath: path.join(directory, "settings.json"),
    authPath: path.join(directory, "auth.json"),
    logsDir: path.join(directory, "logs"),
    providerLogsDir: path.join(directory, "logs", "provider"),
    providerEventLogPath: path.join(
      directory,
      "logs",
      "provider",
      "events.log"
    ),
    authToken: "desktop-secret",
  }
  const remoteAccess = new RemoteAccessService(db, { isEnabled: () => true })
  const state = {
    ...routerLifecycleServices(),
    config,
    db,
    settings,
    remoteAccess,
    providerRegistry: { all: () => [] },
    threads: { persistUserMessageForTurn: vi.fn() },
  } as unknown as AppState
  const app = buildApp(config, state)
  cleanups.push(async () => {
    await stopAllToolOutputArchiveStores()
    await remoteAccess.close()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { app, directory }
}

const desktop = {
  Authorization: "Bearer desktop-secret",
  "Content-Type": "application/json",
}

async function pairedHeaders(app: ReturnType<typeof fixture>["app"]) {
  const grant = (await (
    await app.request("/api/v1/remote/pairing-links", {
      method: "POST",
      headers: desktop,
      body: "{}",
    })
  ).json()) as { credential: string }
  const paired = (await (
    await app.request("/api/v1/remote/mobile/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: grant.credential }),
    })
  ).json()) as { sessionToken: string }
  return {
    Authorization: `Bearer ${paired.sessionToken}`,
    "Content-Type": "application/json",
  }
}

const THEME = JSON.stringify({
  name: "Test Dark",
  type: "dark",
  colors: { "editor.background": "#101010" },
  tokenColors: [{ scope: "comment", settings: { foreground: "#888888" } }],
})

describe("themes routes", () => {
  it.each([null, [], "theme", 42, true])(
    "rejects a non-object import body (%j) before accessing the theme store",
    async (body) => {
      const { app, directory } = fixture()
      const response = await app.request("/api/v1/themes/import", {
        method: "POST",
        headers: desktop,
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: "Invalid import request",
        code: "invalid_request",
      })
      expect(fs.existsSync(path.join(directory, "themes"))).toBe(false)
    }
  )

  it("imports pasted JSON, lists and reads it, and rejects junk with 422", async () => {
    const { app, directory } = fixture()
    const imported = await app.request("/api/v1/themes/import", {
      method: "POST",
      headers: desktop,
      body: JSON.stringify({ kind: "text", text: THEME, source: "paste" }),
    })
    expect(imported.status).toBe(200)
    const theme = (await imported.json()) as {
      id: string
      mode: string
      source: unknown
    }
    expect(theme).toMatchObject({
      id: "test-dark",
      mode: "dark",
      source: { kind: "paste" },
    })
    expect(
      fs.existsSync(path.join(directory, "themes", "test-dark.json"))
    ).toBe(true)

    const list = (await (
      await app.request("/api/v1/themes", { headers: desktop })
    ).json()) as {
      themes: Array<{ id: string; preview: { bg: string } }>
    }
    expect(list.themes.map((t) => t.id)).toEqual(["test-dark"])
    expect(list.themes[0]?.preview.bg).toBe("#101010")
    // The listing is a summary; the color tables come with the single read.
    expect(JSON.stringify(list)).not.toContain("tokenColors")
    const full = (await (
      await app.request("/api/v1/themes/test-dark", { headers: desktop })
    ).json()) as {
      tokenColors: unknown[]
    }
    expect(full.tokenColors).toHaveLength(1)

    const junk = await app.request("/api/v1/themes/import", {
      method: "POST",
      headers: desktop,
      body: JSON.stringify({ kind: "text", text: "{ nope", source: "file" }),
    })
    expect(junk.status).toBe(422)
    expect(((await junk.json()) as { error: string }).error).toMatch(
      /Not valid theme JSON/
    )
    expect(
      (await app.request("/api/v1/themes/missing", { headers: desktop })).status
    ).toBe(404)
  })

  it("lets a paired device read themes but not scan, import or delete", async () => {
    const { app } = fixture()
    await app.request("/api/v1/themes/import", {
      method: "POST",
      headers: desktop,
      body: JSON.stringify({ kind: "text", text: THEME }),
    })
    const remote = await pairedHeaders(app)
    expect(
      (await app.request("/api/v1/themes", { headers: remote })).status
    ).toBe(200)
    expect(
      (await app.request("/api/v1/themes/test-dark", { headers: remote }))
        .status
    ).toBe(200)
    expect(
      (await app.request("/api/v1/themes/installed", { headers: remote }))
        .status
    ).toBe(403)
    expect(
      (
        await app.request("/api/v1/themes/import", {
          method: "POST",
          headers: remote,
          body: JSON.stringify({ kind: "text", text: THEME }),
        })
      ).status
    ).toBe(403)
    expect(
      (
        await app.request("/api/v1/themes/test-dark", {
          method: "DELETE",
          headers: remote,
        })
      ).status
    ).toBe(403)
    // The desktop can; the summary list follows.
    expect(
      (
        await app.request("/api/v1/themes/test-dark", {
          method: "DELETE",
          headers: desktop,
        })
      ).status
    ).toBe(200)
    expect(
      (await app.request("/api/v1/themes/installed", { headers: desktop }))
        .status
    ).toBe(200)
  })
})
