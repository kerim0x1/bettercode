import type { AutomationView } from "@betterc0de/schema"
import { describe, expect, it } from "vitest"
import {
  RUN_STATUS_PRESENTATION,
  automationInputFromDraft,
  automationWebhookUrls,
  draftFromAutomation,
  draftProblems,
  draftSchedule,
  emptyAutomationDraft,
  formatAutomationMoment,
  formatNextRun,
  fromLocalDateTimeInput,
  generateWebhookSecret,
  projectFolderName,
  toLocalDateTimeInput,
  webhookReachableFromOutside,
  type AutomationDraft,
} from "./automations"

// Local dates away from daylight-saving changes, built and read locally.
const NOW = new Date(2026, 5, 15, 10, 0) // Monday 15 June 2026, 10:00

function readyDraft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    ...emptyAutomationDraft(NOW),
    name: "Nightly triage",
    projectPath: "/work/project",
    prompt: "Look at the open issues.",
    providerKind: "codex",
    providerInstanceId: "codex",
    modelId: "gpt-5.5",
    ...overrides,
  }
}

function view(overrides: Partial<AutomationView> = {}): AutomationView {
  return {
    id: "a1",
    name: "Nightly triage",
    projectPath: "/work/project",
    prompt: "Look at the open issues.",
    providerKind: "codex",
    providerInstanceId: "codex",
    modelId: "gpt-5.5",
    modelSelection: { instanceId: "codex", model: "gpt-5.5", options: [] },
    reasoningEffort: "High",
    permissionLevel: "allow-edits",
    runLocation: "worktree",
    trigger: {
      type: "schedule",
      schedule: { kind: "interval", every: 30, unit: "minutes" },
    },
    enabled: true,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    nextRunAt: null,
    running: false,
    lastRun: null,
    webhook: null,
    ...overrides,
  }
}

describe("datetime-local values", () => {
  it("round-trip through local time", () => {
    const value = toLocalDateTimeInput(new Date(2026, 5, 16, 9, 5))
    expect(value).toBe("2026-06-16T09:05")
    expect(fromLocalDateTimeInput(value)).toBe(
      new Date(2026, 5, 16, 9, 5).toISOString()
    )
    expect(fromLocalDateTimeInput("tomorrow")).toBeNull()
  })
})

describe("the editor draft", () => {
  it("starts on weekdays at 09:00 with Ask first", () => {
    const draft = emptyAutomationDraft(NOW)
    expect(draftSchedule(draft)).toEqual({
      kind: "daily",
      time: "09:00",
      weekdays: [1, 2, 3, 4, 5],
    })
    expect(draft.permissionLevel).toBe("ask-on-edit")
    expect(draft.onceAt).toBe("2026-06-16T09:00")
  })

  it("round-trips a saved automation", () => {
    const draft = draftFromAutomation(view(), NOW)
    expect(draft).toMatchObject({
      scheduleKind: "interval",
      intervalEvery: "30",
      runLocation: "worktree",
      permissionLevel: "allow-edits",
      reasoningEffort: "High",
    })
    expect(automationInputFromDraft(draft)).toEqual({
      name: "Nightly triage",
      projectPath: "/work/project",
      prompt: "Look at the open issues.",
      providerKind: "codex",
      providerInstanceId: "codex",
      modelId: "gpt-5.5",
      modelSelection: { instanceId: "codex", model: "gpt-5.5", options: [] },
      reasoningEffort: "High",
      permissionLevel: "allow-edits",
      runLocation: "worktree",
      trigger: {
        type: "schedule",
        schedule: { kind: "interval", every: 30, unit: "minutes" },
      },
      enabled: true,
      webhookSecret: null,
    })
  })

  it("reads a webhook automation", () => {
    const draft = draftFromAutomation(
      view({
        trigger: { type: "webhook", verifyGithubSignature: true },
        webhook: { path: "/hooks/automations/a1/x", secretConfigured: true },
      }),
      NOW
    )
    expect(draft).toMatchObject({
      triggerKind: "webhook",
      verifyGithubSignature: true,
      webhookSecret: "",
    })
    // An empty secret field keeps the stored secret.
    expect(automationInputFromDraft(draft)).not.toHaveProperty("webhookSecret")
    expect(
      automationInputFromDraft({ ...draft, webhookSecret: "new secret" })
        .webhookSecret
    ).toBe("new secret")
    expect(
      automationInputFromDraft({ ...draft, verifyGithubSignature: false })
        .webhookSecret
    ).toBeNull()
  })
})

describe("draftProblems", () => {
  const options = { now: NOW, secretConfigured: false }

  it("is empty for a ready draft", () => {
    expect(draftProblems(readyDraft(), options)).toEqual({})
  })

  it("names every missing field", () => {
    expect(
      draftProblems(
        readyDraft({ name: " ", projectPath: "", prompt: "", modelId: "" }),
        options
      )
    ).toEqual({
      name: "Give the automation a name.",
      projectPath: "Choose a project.",
      prompt: "Write what the agent should do.",
      model: "Choose a model.",
    })
  })

  it("checks the schedule", () => {
    expect(
      draftProblems(
        readyDraft({ scheduleKind: "interval", intervalEvery: "3" }),
        options
      ).schedule
    ).toContain("5 minutes")
    expect(
      draftProblems(
        readyDraft({ scheduleKind: "interval", intervalEvery: "1.5" }),
        options
      ).schedule
    ).toBe("Enter a whole number.")
    expect(
      draftProblems(
        readyDraft({ scheduleKind: "once", onceAt: "2026-06-15T09:00" }),
        options
      ).schedule
    ).toBe("Choose a time in the future.")
    expect(
      draftProblems(
        readyDraft({ scheduleKind: "cron", cronExpression: "* * *" }),
        options
      ).schedule
    ).toContain("5 fields")
    expect(
      draftProblems(readyDraft({ dailyWeekdays: [] }), options).schedule
    ).toBe("Choose at least one day.")
  })

  it("asks for a GitHub secret unless one is stored", () => {
    const webhook = readyDraft({
      triggerKind: "webhook",
      verifyGithubSignature: true,
    })
    expect(draftProblems(webhook, options).webhookSecret).toBe(
      "Add the secret you set in GitHub."
    )
    expect(
      draftProblems(webhook, { ...options, secretConfigured: true })
    ).toEqual({})
    expect(
      draftProblems({ ...webhook, webhookSecret: "short" }, options)
        .webhookSecret
    ).toContain("8 characters")
  })
})

describe("times in words", () => {
  it("says today, tomorrow, yesterday or the weekday", () => {
    expect(
      formatAutomationMoment(new Date(2026, 5, 15, 18, 30).toISOString(), NOW)
    ).toBe("Today at 18:30")
    expect(
      formatAutomationMoment(new Date(2026, 5, 16, 9, 0).toISOString(), NOW)
    ).toBe("Tomorrow at 09:00")
    expect(
      formatAutomationMoment(new Date(2026, 5, 14, 9, 0).toISOString(), NOW)
    ).toBe("Yesterday at 09:00")
    expect(
      formatAutomationMoment(new Date(2026, 5, 19, 9, 0).toISOString(), NOW)
    ).toBe("Fri at 09:00")
    expect(
      formatAutomationMoment(new Date(2026, 6, 1, 9, 0).toISOString(), NOW)
    ).toBe("2026-07-01 09:00")
  })

  it("describes the next run", () => {
    expect(formatNextRun(view({ enabled: false }), NOW)).toBe("Paused")
    expect(
      formatNextRun(
        view({ trigger: { type: "webhook", verifyGithubSignature: false } }),
        NOW
      )
    ).toBe("When the webhook is called")
    expect(formatNextRun(view({ nextRunAt: null }), NOW)).toBe(
      "No upcoming run"
    )
    expect(
      formatNextRun(
        view({ nextRunAt: new Date(2026, 5, 15, 9, 59).toISOString() }),
        NOW
      )
    ).toBe("Due now")
  })
})

describe("webhook URLs", () => {
  const endpoints = [
    {
      id: "loopback",
      label: "This computer",
      baseUrl: "http://127.0.0.1:3773",
      reachability: "loopback" as const,
      isDefault: false,
    },
    {
      id: "tailscale",
      label: "Tailscale HTTPS",
      baseUrl: "https://desk.tail1234.ts.net/",
      reachability: "private-network" as const,
      isDefault: true,
    },
  ]

  it("joins each address with the path, the recommended one first", () => {
    expect(
      automationWebhookUrls(endpoints, "/hooks/automations/a1/tok").map(
        (entry) => entry.url
      )
    ).toEqual([
      "https://desk.tail1234.ts.net/hooks/automations/a1/tok",
      "http://127.0.0.1:3773/hooks/automations/a1/tok",
    ])
    expect(automationWebhookUrls(endpoints, null)).toEqual([])
  })

  it("knows whether anything outside this computer can call it", () => {
    expect(webhookReachableFromOutside(endpoints)).toBe(true)
    expect(webhookReachableFromOutside([endpoints[0]!])).toBe(false)
  })
})

describe("small helpers", () => {
  it("label every run status", () => {
    for (const presentation of Object.values(RUN_STATUS_PRESENTATION)) {
      expect(presentation.label).not.toBe("")
    }
  })

  it("generate 32-character hex secrets", () => {
    expect(generateWebhookSecret()).toMatch(/^[0-9a-f]{32}$/)
  })

  it("name the project folder", () => {
    expect(projectFolderName("/work/my-app/")).toBe("my-app")
    expect(projectFolderName("C:\\Users\\me\\repo")).toBe("repo")
  })
})
