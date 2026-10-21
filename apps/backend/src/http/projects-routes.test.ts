import { describe, expect, it } from "vitest"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import { buildApp as buildAppUnfilled } from "./router"
import { routerLifecycleServices } from "../testUtils/routing-services"
import { withInertStateArgument } from "../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const buildApp = withInertStateArgument(buildAppUnfilled, 1)

function makeConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 3773,
    dataDir: "/tmp/betterc0de-test",
    dbPath: "/tmp/betterc0de-test/betterc0de.db",
    settingsPath: "/tmp/betterc0de-test/settings.json",
    authPath: "/tmp/betterc0de-test/auth.json",
    logsDir: "/tmp/betterc0de-test/logs",
    providerLogsDir: "/tmp/betterc0de-test/logs/provider",
    providerEventLogPath: "/tmp/betterc0de-test/logs/provider/events.log",
    authToken: "secret",
  }
}

function makeState(): AppState {
  return {
    ...routerLifecycleServices(),
    providerRegistry: { all: () => [] },
    db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
    projectProjections: {
      listAll: () => [
        {
          project_id: "project-1",
          name: "Projected",
          path: "/repo/projected",
          created_at: "2026-05-13T00:00:00.000Z",
          updated_at: "2026-05-13T00:01:00.000Z",
        },
      ],
    },
    threads: {
      listProjects: () => [
        { name: "Projected thread", path: "/repo/projected" },
        { name: "Legacy", path: "/repo/legacy" },
      ],
    },
  } as unknown as AppState
}

describe("projects routes", () => {
  it("lists projected projects with thread-derived fallback projects", async () => {
    const app = buildApp(makeConfig(), makeState())
    const response = await app.request("/api/v1/projects", {
      headers: { Authorization: "Bearer secret" },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([
      {
        id: "project-1",
        name: "Projected",
        path: "/repo/projected",
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:01:00.000Z",
      },
      {
        name: "Legacy",
        path: "/repo/legacy",
      },
    ])
  })
})
