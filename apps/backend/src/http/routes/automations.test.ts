import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import type { AutomationInput } from "@betterc0de/schema"
import type { AppState } from "../../appState"
import type { ServerConfig } from "../../config"
import { automationServices } from "../../services/automations/registry"
import { AutomationService } from "../../services/automations/service"
import type {
  AutomationHistory,
  AutomationStore,
  StoredAutomation,
} from "../../services/automations/store"
import { githubSignature } from "../../services/automations/webhook"
import { registerAutomationWebhookRoute } from "./automations"

class MemoryStore implements AutomationStore {
  automations: StoredAutomation[] = []
  history: Record<string, AutomationHistory> = {}
  load() {
    return { automations: [], history: {} }
  }
  saveAutomations(automations: readonly StoredAutomation[]) {
    this.automations = [...automations]
  }
  saveHistory(history: Readonly<Record<string, AutomationHistory>>) {
    this.history = { ...history }
  }
}

const SECRET = "a long secret"

async function setup(verifyGithubSignature: boolean) {
  const started: string[] = []
  const service = new AutomationService({
    store: new MemoryStore(),
    runner: {
      async start(request) {
        started.push(request.message)
        return { settled: new Promise<void>(() => undefined) }
      },
    },
    resolveProject: async (projectPath) => projectPath,
    timers: { set: () => null, clear: () => undefined },
    secrets: { encrypt: (value) => value, decrypt: (value) => value },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
  const input: AutomationInput = {
    name: "Review pull requests",
    projectPath: "/work/project",
    prompt: "Review {{body.pull_request.title}}.",
    providerKind: "claude",
    providerInstanceId: null,
    modelId: "claude-sonnet-5",
    modelSelection: null,
    reasoningEffort: null,
    permissionLevel: "read-only",
    runLocation: "local",
    trigger: { type: "webhook", verifyGithubSignature },
    enabled: true,
    ...(verifyGithubSignature ? { webhookSecret: SECRET } : {}),
  }
  const automation = await service.create(input)
  const config = {
    host: "127.0.0.1",
    port: 3773,
    authToken: "desktop-bearer",
  } as unknown as ServerConfig
  const state = { config } as unknown as AppState
  automationServices.set(state, service)
  const app = new Hono()
  registerAutomationWebhookRoute(app, state)
  return {
    app,
    path: automation.webhook!.path!,
    started,
    service,
    id: automation.id,
  }
}

const post = (
  app: Hono,
  path: string,
  body: string,
  headers: Record<string, string> = {}
) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  })

describe("POST /hooks/automations/:id/:token", () => {
  it("starts a run without a session", async () => {
    const { app, path, started } = await setup(false)
    const response = await post(
      app,
      path,
      JSON.stringify({ pull_request: { title: "Fix login" } })
    )
    expect(response.status).toBe(202)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.json()).toMatchObject({
      accepted: true,
      message: "Run started.",
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(started[0]).toContain(">Fix login</")
  })

  it("answers a malformed or wrong token with 404", async () => {
    const { app, path } = await setup(false)
    const base = path.slice(0, path.lastIndexOf("/"))
    expect((await post(app, `${base}/short`, "{}")).status).toBe(404)
    expect((await post(app, `${base}/${"A".repeat(43)}`, "{}")).status).toBe(
      404
    )
    expect(
      (await post(app, `/hooks/automations/not-there/${"A".repeat(43)}`, "{}"))
        .status
    ).toBe(404)
  })

  it("checks the GitHub signature against the raw bytes sent", async () => {
    const { app, path } = await setup(true)
    // Whitespace a JSON round trip would drop: the signature covers it.
    const body = '{\n  "pull_request": { "title": "Fix login" }\n}'
    const signed = await post(app, path, body, {
      "X-Hub-Signature-256": githubSignature(
        SECRET,
        new TextEncoder().encode(body)
      ),
    })
    expect(signed.status).toBe(202)
    const forged = await post(app, path, body, {
      "X-Hub-Signature-256": githubSignature(
        "wrong secret",
        new TextEncoder().encode(body)
      ),
    })
    expect(forged.status).toBe(401)
    expect(await forged.json()).toEqual({
      error: "The X-Hub-Signature-256 signature did not match.",
      code: "invalid_signature",
    })
  })

  it("refuses a body over 256 KB", async () => {
    const { app, path, service, id } = await setup(false)
    const response = await post(
      app,
      path,
      JSON.stringify({ text: "x".repeat(300 * 1024) })
    )
    expect(response.status).toBe(413)
    expect(service.detail(id).deliveries).toEqual([])
  })

  it("reaches nothing but the webhook", async () => {
    const { app } = await setup(false)
    expect((await app.request("/hooks/automations")).status).toBe(404)
    expect(
      (await app.request("/api/v1/automations", { method: "GET" })).status
    ).toBe(404)
  })
})
