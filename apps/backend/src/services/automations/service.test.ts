import type { AutomationInput } from "@betterc0de/schema"
import { describe, expect, it, vi } from "vitest"
import { HttpError } from "../../errors"
import {
  AutomationService,
  type AutomationRunRequest,
  type AutomationRunner,
  type AutomationTimers,
} from "./service"
import type {
  AutomationHistory,
  AutomationStore,
  StoredAutomation,
} from "./store"
import { githubSignature } from "./webhook"

const START = Date.parse("2026-06-15T10:00:00.000Z")
const MINUTE = 60_000

class MemoryStore implements AutomationStore {
  automations: StoredAutomation[] = []
  history: Record<string, AutomationHistory> = {}

  load() {
    return {
      automations: structuredClone(this.automations),
      history: structuredClone(this.history),
    }
  }

  saveAutomations(automations: readonly StoredAutomation[]) {
    this.automations = structuredClone([...automations])
  }

  saveHistory(history: Readonly<Record<string, AutomationHistory>>) {
    this.history = structuredClone({ ...history })
  }
}

/** Timers on a hand-driven clock. */
class ManualTimers implements AutomationTimers {
  private nextId = 1
  readonly pending = new Map<number, { at: number; callback: () => void }>()

  constructor(private readonly clock: { now: number }) {}

  set(callback: () => void, ms: number): unknown {
    const id = this.nextId++
    this.pending.set(id, { at: this.clock.now + ms, callback })
    return id
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number)
  }

  /** Moves the clock forward, firing every timer due on the way in order. */
  advance(ms: number): void {
    const target = this.clock.now + ms
    for (;;) {
      let nextId: number | null = null
      let nextAt = Number.POSITIVE_INFINITY
      for (const [id, timer] of this.pending) {
        if (timer.at <= target && timer.at < nextAt) {
          nextId = id
          nextAt = timer.at
        }
      }
      if (nextId === null) break
      const timer = this.pending.get(nextId)!
      this.pending.delete(nextId)
      this.clock.now = Math.max(this.clock.now, timer.at)
      timer.callback()
    }
    this.clock.now = target
  }
}

interface FakeRun {
  readonly request: AutomationRunRequest
  finish(): void
  fail(error: Error): void
}

function fakeRunner(options: { failStart?: Error } = {}) {
  const runs: FakeRun[] = []
  const runner: AutomationRunner = {
    async start(request) {
      if (options.failStart) throw options.failStart
      request.onChatCreated()
      let finish!: () => void
      let fail!: (error: Error) => void
      const settled = new Promise<void>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
      runs.push({ request, finish, fail })
      return { settled }
    },
  }
  return { runner, runs }
}

/** Lets the service's run bookkeeping (promise callbacks) catch up. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function makeService(
  options: {
    store?: MemoryStore
    now?: number
    runner?: AutomationRunner
    available?: () => boolean
  } = {}
) {
  const clock = { now: options.now ?? START }
  const timers = new ManualTimers(clock)
  const store = options.store ?? new MemoryStore()
  const fake = fakeRunner()
  const service = new AutomationService({
    store,
    runner: options.runner ?? fake.runner,
    resolveProject: async (projectPath) => projectPath,
    available: options.available,
    now: () => clock.now,
    timers,
    secrets: {
      encrypt: (value) => `enc:${value}`,
      decrypt: (value) => (value.startsWith("enc:") ? value.slice(4) : null),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    startupDelayMs: 0,
    historySaveDelayMs: 0,
  })
  return { service, store, timers, clock, runs: fake.runs }
}

function input(overrides: Partial<AutomationInput> = {}): AutomationInput {
  return {
    name: "Nightly triage",
    projectPath: "/work/project",
    prompt: "Look at the open issues.",
    providerKind: "codex",
    providerInstanceId: null,
    modelId: "gpt-5.5",
    modelSelection: null,
    reasoningEffort: null,
    permissionLevel: "ask-on-edit",
    runLocation: "local",
    trigger: {
      type: "schedule",
      schedule: { kind: "interval", every: 15, unit: "minutes" },
    },
    enabled: true,
    ...overrides,
  }
}

function stored(overrides: Partial<StoredAutomation> = {}): StoredAutomation {
  const at = new Date(START - 2 * 60 * MINUTE).toISOString()
  return {
    id: "a1",
    name: "Nightly triage",
    projectPath: "/work/project",
    prompt: "Look at the open issues.",
    providerKind: "codex",
    providerInstanceId: null,
    modelId: "gpt-5.5",
    modelSelection: null,
    reasoningEffort: null,
    permissionLevel: "ask-on-edit",
    runLocation: "local",
    trigger: {
      type: "schedule",
      schedule: { kind: "interval", every: 15, unit: "minutes" },
    },
    enabled: true,
    createdAt: at,
    updatedAt: at,
    scheduleAnchorAt: at,
    webhookToken: "enc:token",
    webhookSecret: null,
    ...overrides,
  }
}

const webhookInput = (verifyGithubSignature = false, webhookSecret?: string) =>
  input({
    trigger: { type: "webhook", verifyGithubSignature },
    prompt: "Review {{body.pull_request.title}} ({{headers.x-github-event}}).",
    ...(webhookSecret === undefined ? {} : { webhookSecret }),
  })

function tokenOf(path: string | null | undefined): string {
  const token = path?.split("/").at(-1)
  if (!token) throw new Error("no webhook path")
  return token
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe("AutomationService definitions", () => {
  it("creates, lists and deletes an automation", async () => {
    const { service, store } = makeService()
    const created = await service.create(input())
    expect(created).toMatchObject({
      name: "Nightly triage",
      enabled: true,
      running: false,
      lastRun: null,
      webhook: null,
      nextRunAt: new Date(START + 15 * MINUTE).toISOString(),
    })
    expect(store.automations).toHaveLength(1)
    expect(service.list().map((automation) => automation.id)).toEqual([
      created.id,
    ])
    expect(service.remove(created.id)).toBe(true)
    expect(service.list()).toEqual([])
    expect(store.automations).toEqual([])
  })

  it("refuses a one-time run in the past", async () => {
    const { service } = makeService()
    await expect(
      service.create(
        input({
          trigger: {
            type: "schedule",
            schedule: {
              kind: "once",
              at: new Date(START - MINUTE).toISOString(),
            },
          },
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "automation_schedule_past",
    })
  })

  it("needs a secret before it checks GitHub signatures", async () => {
    const { service } = makeService()
    await expect(service.create(webhookInput(true))).rejects.toBeInstanceOf(
      HttpError
    )
    const created = await service.create(webhookInput(true, "a long secret"))
    expect(created.webhook).toMatchObject({ secretConfigured: true })
  })

  it("never stores a secret or token in plain text", async () => {
    const { service, store } = makeService()
    await service.create(webhookInput(true, "a long secret"))
    expect(store.automations[0]!.webhookSecret).toBe("enc:a long secret")
    expect(store.automations[0]!.webhookToken).toMatch(/^enc:/)
  })
})

describe("AutomationService scheduler", () => {
  it("runs a schedule when it is due", async () => {
    const { service, timers, runs } = makeService()
    const created = await service.create(input())
    timers.advance(15 * MINUTE)
    await settle()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.request.title).toMatch(
      /^Nightly triage · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    )
    expect(runs[0]!.request.displayMessage).toContain(
      "**Automation:** Nightly triage · Scheduled run"
    )
    const detail = service.detail(created.id)
    expect(detail.runs[0]).toMatchObject({
      trigger: "schedule",
      status: "running",
      threadId: runs[0]!.request.threadId,
    })
    runs[0]!.finish()
    await settle()
    expect(service.detail(created.id).runs[0]!.status).toBe("completed")
  })

  it("catches up once at startup for every run missed while the app was off", async () => {
    const store = new MemoryStore()
    store.automations = [stored()]
    store.history = {
      a1: {
        // Handled two hours ago: eight runs were missed since.
        lastHandledAt: new Date(START - 2 * 60 * MINUTE).toISOString(),
        runs: [],
        deliveries: [],
      },
    }
    const { service, timers, runs } = makeService({ store })
    timers.advance(2_000)
    await settle()
    expect(runs).toHaveLength(1)
    expect(service.detail("a1").runs).toMatchObject([
      {
        trigger: "catch-up",
        scheduledFor: new Date(
          START - 2 * 60 * MINUTE + 15 * MINUTE
        ).toISOString(),
      },
    ])
    runs[0]!.finish()
    await settle()
    // Nothing else is caught up; the next run keeps the original cadence.
    timers.advance(14 * MINUTE)
    await settle()
    expect(runs).toHaveLength(1)
    timers.advance(MINUTE)
    await settle()
    expect(runs).toHaveLength(2)
    expect(service.detail("a1").runs[0]).toMatchObject({
      trigger: "schedule",
      scheduledFor: new Date(START + 15 * MINUTE).toISOString(),
    })
  })

  it("skips a run while the previous one is still going", async () => {
    const { service, runs } = makeService()
    const created = await service.create(input())
    expect(service.runNow(created.id).status).toBe("starting")
    const skipped = service.runNow(created.id)
    expect(skipped).toMatchObject({
      status: "skipped",
      threadId: null,
      error: "The previous run of this automation was still going.",
    })
    await settle()
    expect(runs).toHaveLength(1)
    expect(service.detail(created.id).runs.map((run) => run.status)).toEqual([
      "skipped",
      "running",
    ])
  })

  it("keeps the last 50 runs, newest first", async () => {
    const { service } = makeService()
    const created = await service.create(input())
    const ids: string[] = []
    for (let index = 0; index < 60; index += 1) {
      ids.push(service.runNow(created.id).id)
    }
    const history = service.detail(created.id).runs
    expect(history).toHaveLength(50)
    expect(history[0]!.id).toBe(ids[59])
    expect(history[49]!.id).toBe(ids[10])
  })

  it("records a run that could not start", async () => {
    const failing = fakeRunner({
      failStart: new HttpError(403, "Trust this project first.", "x"),
    })
    const { service } = makeService({ runner: failing.runner })
    const created = await service.create(input())
    service.runNow(created.id)
    await settle()
    expect(service.detail(created.id).runs[0]).toMatchObject({
      status: "failed",
      error: "Trust this project first.",
    })
    expect(service.list()[0]!.running).toBe(false)
  })

  it("marks runs left going by a previous start as interrupted", () => {
    const store = new MemoryStore()
    store.automations = [stored({ enabled: false })]
    store.history = {
      a1: {
        lastHandledAt: null,
        runs: [
          {
            id: "r1",
            trigger: "schedule",
            status: "running",
            scheduledFor: null,
            startedAt: new Date(START - MINUTE).toISOString(),
            finishedAt: null,
            threadId: "t1",
            threadTitle: "Nightly triage · 2026-06-15 09:59",
            error: null,
            deliveryId: null,
          },
        ],
        deliveries: [],
      },
    }
    const { service } = makeService({ store })
    expect(service.detail("a1").runs[0]).toMatchObject({
      status: "interrupted",
      finishedAt: new Date(START).toISOString(),
    })
  })

  it("does not catch up the time an automation was paused", async () => {
    const { service, timers, runs } = makeService()
    const created = await service.create(input())
    service.setEnabled(created.id, false)
    expect(service.list()[0]!.nextRunAt).toBeNull()
    timers.advance(2 * 60 * MINUTE)
    await settle()
    expect(runs).toHaveLength(0)
    service.setEnabled(created.id, true)
    timers.advance(2_000)
    await settle()
    expect(runs).toHaveLength(0)
    // The next quarter hour on the original cadence.
    timers.advance(15 * MINUTE)
    await settle()
    expect(runs).toHaveLength(1)
    expect(service.detail(created.id).runs[0]!.trigger).toBe("schedule")
  })

  it("starts nothing while the backend stops", async () => {
    let available = true
    const { service, timers, runs } = makeService({
      available: () => available,
    })
    await service.create(input())
    available = false
    timers.advance(15 * MINUTE)
    await settle()
    expect(runs).toHaveLength(0)
    service.dispose()
    expect(timers.pending.size).toBe(0)
  })
})

describe("AutomationService webhooks", () => {
  const headers = (extra: Record<string, string> = {}) =>
    Object.entries({
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      ...extra,
    })

  it("answers a wrong token like an unknown automation and logs nothing", async () => {
    const { service } = makeService()
    const created = await service.create(webhookInput())
    const outcome = service.receiveWebhook({
      automationId: created.id,
      token: "x".repeat(43),
      body: json({}),
      contentType: "application/json",
      headers: headers(),
    })
    expect(outcome).toEqual({
      status: 404,
      error: "Not found.",
      code: "not_found",
    })
    expect(service.detail(created.id).deliveries).toEqual([])
  })

  it("starts a run with the delivery's values in the prompt", async () => {
    const { service, runs } = makeService()
    const created = await service.create(webhookInput())
    const outcome = service.receiveWebhook({
      automationId: created.id,
      token: tokenOf(created.webhook?.path),
      body: json({ pull_request: { title: "Fix login" } }),
      contentType: "application/json",
      headers: headers({ Authorization: "Bearer never-in-a-prompt" }),
    })
    expect(outcome).toMatchObject({
      status: 202,
      response: { accepted: true, message: "Run started." },
    })
    await settle()
    expect(runs).toHaveLength(1)
    const message = runs[0]!.request.message
    expect(message).toMatch(
      /^Review <(webhook-data-[0-9a-f]+)>Fix login<\/\1> \(<\1>pull_request<\/\1>\)\./
    )
    expect(message).not.toContain("never-in-a-prompt")
    expect(service.detail(created.id).deliveries[0]).toMatchObject({
      status: 202,
      event: "pull_request",
      response: "Run started.",
    })
  })

  it("answers GitHub's ping without starting a run", async () => {
    const { service, runs } = makeService()
    const created = await service.create(webhookInput())
    const outcome = service.receiveWebhook({
      automationId: created.id,
      token: tokenOf(created.webhook?.path),
      body: json({ zen: "Design for failure." }),
      contentType: "application/json",
      headers: headers({ "X-GitHub-Event": "ping" }),
    })
    expect(outcome).toMatchObject({
      status: 200,
      response: { accepted: false },
    })
    await settle()
    expect(runs).toHaveLength(0)
  })

  it("checks the GitHub signature over the exact body", async () => {
    const { service, runs } = makeService()
    const secret = "a long secret"
    const created = await service.create(webhookInput(true, secret))
    const token = tokenOf(created.webhook?.path)
    const body = json({ pull_request: { title: "Fix login" } })

    const unsigned = service.receiveWebhook({
      automationId: created.id,
      token,
      body,
      contentType: "application/json",
      headers: headers(),
    })
    expect(unsigned).toMatchObject({ status: 401, code: "invalid_signature" })

    const signed = service.receiveWebhook({
      automationId: created.id,
      token,
      body,
      contentType: "application/json",
      headers: headers({
        "X-Hub-Signature-256": githubSignature(secret, body),
      }),
    })
    expect(signed).toMatchObject({ status: 202 })
    await settle()
    expect(runs).toHaveLength(1)
    expect(
      service.detail(created.id).deliveries.map((delivery) => delivery.status)
    ).toEqual([202, 401])
  })

  it("refuses deliveries to a paused automation", async () => {
    const { service } = makeService()
    const created = await service.create(webhookInput())
    service.setEnabled(created.id, false)
    expect(
      service.receiveWebhook({
        automationId: created.id,
        token: tokenOf(created.webhook?.path),
        body: json({}),
        contentType: "application/json",
        headers: headers(),
      })
    ).toMatchObject({ status: 409, code: "automation_paused" })
  })

  it("limits deliveries per automation", async () => {
    const { service, timers } = makeService()
    const created = await service.create(webhookInput())
    const deliver = () =>
      service.receiveWebhook({
        automationId: created.id,
        token: tokenOf(created.webhook?.path),
        body: json({}),
        contentType: "application/json",
        headers: headers(),
      })
    const statuses = Array.from({ length: 10 }, () => deliver().status)
    // The first starts a run; the rest are skipped while it goes.
    expect(statuses).toEqual([202, 200, 200, 200, 200, 200, 200, 200, 200, 200])
    const limited = deliver()
    expect(limited).toMatchObject({ status: 429, code: "rate_limited" })
    expect(
      "retryAfterMs" in limited ? limited.retryAfterMs : 0
    ).toBeGreaterThan(0)
    // Ten a minute: one more after six seconds.
    timers.advance(6_100)
    expect(deliver().status).toBe(200)
    expect(deliver().status).toBe(429)
  })

  it("stops accepting the old URL once it is rotated", async () => {
    const { service } = makeService()
    const created = await service.create(webhookInput())
    const oldToken = tokenOf(created.webhook?.path)
    const rotated = service.rotateWebhook(created.id)
    const newToken = tokenOf(rotated.webhook?.path)
    expect(newToken).not.toBe(oldToken)
    const deliver = (token: string) =>
      service.receiveWebhook({
        automationId: created.id,
        token,
        body: json({}),
        contentType: "application/json",
        headers: headers(),
      }).status
    expect(deliver(oldToken)).toBe(404)
    expect(deliver(newToken)).toBe(202)
  })

  it("refuses a body that claims to be JSON but is not", async () => {
    const { service } = makeService()
    const created = await service.create(webhookInput())
    expect(
      service.receiveWebhook({
        automationId: created.id,
        token: tokenOf(created.webhook?.path),
        body: new TextEncoder().encode("{broken"),
        contentType: "application/json",
        headers: headers(),
      })
    ).toMatchObject({ status: 400, code: "invalid_body" })
  })
})
