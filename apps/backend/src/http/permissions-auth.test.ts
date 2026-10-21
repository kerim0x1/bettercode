import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import { buildApp as buildAppUnfilled } from "./router"
import { routerLifecycleServices } from "../testUtils/routing-services"
import { withInertStateArgument } from "../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const buildApp = withInertStateArgument(buildAppUnfilled, 1)

function config(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 3773,
    dataDir: "/tmp/betterc0de-permissions-auth",
    dbPath: "/tmp/betterc0de-permissions-auth/betterc0de.db",
    settingsPath: "/tmp/betterc0de-permissions-auth/settings.json",
    authPath: "/tmp/betterc0de-permissions-auth/auth.json",
    logsDir: "/tmp/betterc0de-permissions-auth/logs",
    providerLogsDir: "/tmp/betterc0de-permissions-auth/logs/provider",
    providerEventLogPath:
      "/tmp/betterc0de-permissions-auth/logs/provider/events.log",
    authToken: "secret",
  }
}

describe("provider-neutral permission API authentication", () => {
  it("keeps durable grant APIs behind the versioned bearer-auth boundary", async () => {
    const listGrants = vi.fn(() => [])
    const app = buildApp(config(), {
      ...routerLifecycleServices(),
      providerRegistry: { all: () => [] },
      threads: { persistUserMessageForTurn: vi.fn() },
      db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
      agentPermissions: { listGrants },
    } as unknown as AppState)

    const unauthorized = await app.request("/api/v1/permissions/grants/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(unauthorized.status).toBe(401)
    expect(listGrants).not.toHaveBeenCalled()

    const authorized = await app.request("/api/v1/permissions/grants/list", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: "{}",
    })
    expect(authorized.status).toBe(200)
    expect(await authorized.json()).toEqual({ grants: [] })
    expect(listGrants).toHaveBeenCalledTimes(1)
  })
})
