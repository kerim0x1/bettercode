import path from "node:path"
import fs from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  chatSendSchema,
  orchestratorTeamSchema,
  providerRuntimeEventSchema,
  type OrchestratorSession,
} from "@betterc0de/schema"
import { OrchestratorService, type OrchestratorDependencies } from "./service"

const services: OrchestratorService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  vi.useRealTimers()
})
async function fixture(patch: Partial<OrchestratorDependencies> = {}) {
  const root = await fs.realpath(process.cwd())
  const settings = {
    orchestrator_enabled: true,
    orchestrator_team: orchestratorTeamSchema.parse({
      main: {
        providerKind: "claude",
        providerInstanceId: "claude",
        modelId: "fable-test",
      },
      members: [
        {
          id: "grok",
          name: "Researcher",
          role: "Research",
          providerKind: "grok_cli",
          providerInstanceId: "grok_cli",
          modelId: "grok-test",
        },
        {
          id: "codex",
          name: "Builder",
          role: "Implement",
          providerKind: "codex",
          providerInstanceId: "codex-work",
          modelId: "gpt-6-astra",
        },
      ],
      maxConcurrent: 1,
      maxTasks: 3,
    }),
  }
  const stored = new Map<string, OrchestratorSession>()
  const dispatch = vi.fn<OrchestratorDependencies["dispatch"]>(async () => ({
    status: "accepted",
  }))
  const interrupt = vi.fn<OrchestratorDependencies["interrupt"]>(async () => ({
    status: "interrupted",
  }))
  const deps: OrchestratorDependencies = {
    settings: () => settings,
    allowed: () => true,
    load: (id) => stored.get(id),
    persist: (session) => {
      stored.set(session.threadId, structuredClone(session))
    },
    createThread: vi.fn(),
    modelCatalog: async (_cwd, providers) =>
      settings.orchestrator_team.members.filter((member) =>
        providers.some((provider) => provider === member.providerKind)
      ),
    readContextSource: (source) => ({
      source,
      title: "Auth plan",
      body: "Use a short-lived session token.",
      truncated: false,
    }),
    dispatch,
    interrupt,
    reportError: vi.fn(),
    ...patch,
  }
  const service = new OrchestratorService(deps)
  services.push(service)
  const session = await service.start(root)
  const message = (permissionLevel = "ask-on-edit") =>
    chatSendSchema.parse({
      threadId: session.threadId,
      projectPath: root,
      providerKind: "claude",
      providerInstanceId: "claude",
      modelId: "fable-test",
      chatMode: "agent",
      permissionLevel,
      message: "Build the requested feature.",
    })
  const prepare = (permission?: string) =>
    service.prepareTurn(message(permission))
  const complete = (threadId: string, status = "completed") =>
    service.onEvent(
      providerRuntimeEventSchema.parse({
        type: "turn.completed",
        eventId: crypto.randomUUID(),
        threadId,
        at: Date.now(),
        status,
      })
    )
  return {
    service,
    session,
    settings,
    root,
    deps,
    dispatch,
    interrupt,
    stored,
    prepare,
    message,
    complete,
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("experimental orchestrator", () => {
  it.each([
    { kind: "claude", optionId: "effort" },
    { kind: "codex", optionId: "reasoningEffort" },
    { kind: "grok_cli", optionId: "reasoningEffort" },
  ] as const)(
    "forwards the selected $kind thinking level, persists it, and resets to provider defaults for Auto",
    async ({ kind, optionId }) => {
      const f = await fixture()
      const member = {
        id: "worker",
        name: "Worker model",
        role: "Implement",
        providerKind: kind,
        providerInstanceId: "worker-account",
        modelId: "worker-model",
        capabilities: {
          optionDescriptors: [
            {
              id: optionId,
              type: "select" as const,
              label: "Thinking",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      }
      f.deps.modelCatalog = async () => [
        member,
        { ...member, id: "second-account", providerInstanceId: "personal" },
      ]
      const selected = {
        providerKind: kind,
        providerInstanceId: member.providerInstanceId,
        modelId: member.modelId,
        reasoningEffort: "high",
      }
      const body = chatSendSchema.parse({
        ...f.message(),
        thread_id: "thinking-chat",
        provider_kind: kind === "claude" ? "codex" : "claude",
        orchestration: { enabled: true, providers: [kind], models: [selected] },
      })
      await f.service.prepareForTurn(body)
      expect(f.service.availableModels(body.thread_id).models).toEqual([
        expect.objectContaining(selected),
      ])
      const job = f.service.spawn(
        body.thread_id,
        member.id,
        "Build it",
        "manual"
      )
      await flush()
      expect(f.dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          reasoning_effort: "high",
          model_selection: {
            instanceId: "worker-account",
            model: "worker-model",
            options: [{ id: optionId, value: "high" }],
          },
        })
      )
      f.complete(job.threadId)
      const resumed = new OrchestratorService(f.deps)
      services.push(resumed)
      await resumed.prepareForTurn({ ...body, orchestration: undefined })
      expect(resumed.status(body.thread_id)?.selectedModels).toEqual([selected])
      expect(
        resumed.availableModels(body.thread_id).models[0]?.reasoningEffort
      ).toBe("high")
      await expect(
        resumed.prepareForTurn({
          ...body,
          orchestration: {
            enabled: true,
            providers: [kind],
            models: [{ ...selected, reasoningEffort: "ultra" }],
          },
        })
      ).rejects.toThrow('Thinking level "ultra" is no longer supported')
      expect(resumed.status(body.thread_id)?.selectedModels).toEqual([selected])
      await resumed.prepareForTurn({
        ...body,
        orchestration: {
          enabled: true,
          providers: [kind],
          models: [{ ...selected, reasoningEffort: null }],
        },
      })
      resumed.spawn(body.thread_id, member.id, "Check it", "auto")
      await flush()
      expect(f.dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          reasoning_effort: null,
          model_selection: {
            instanceId: "worker-account",
            model: "worker-model",
            options: [],
          },
        })
      )
      // Preparing and selecting defaults never mutates the shared discovery catalog.
      expect(member).not.toHaveProperty("reasoningEffort")
    }
  )

  it("never runs a Claude worker in Ultracode and treats a saved Ultracode as Auto", async () => {
    const f = await fixture()
    const member = {
      id: "worker",
      name: "Claude worker",
      role: "Implement",
      providerKind: "claude" as const,
      providerInstanceId: "worker-account",
      modelId: "worker-model",
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            type: "select" as const,
            label: "Effort",
            options: [
              { id: "high", label: "High" },
              { id: "ultracode", label: "Ultracode" },
            ],
            promptInjectedValues: ["ultracode"],
          },
        ],
      },
    }
    f.deps.modelCatalog = async () => [member]
    const selected = {
      providerKind: "claude" as const,
      providerInstanceId: member.providerInstanceId,
      modelId: member.modelId,
    }
    const body = chatSendSchema.parse({
      ...f.message(),
      thread_id: "ultracode-chat",
      provider_kind: "codex",
      orchestration: {
        enabled: true,
        providers: ["claude"],
        models: [{ ...selected, reasoningEffort: "Ultra Code" }],
      },
    })
    await f.service.prepareForTurn(body)
    expect(f.service.status(body.thread_id)?.selectedModels).toEqual([
      { ...selected, reasoningEffort: null },
    ])
    expect(
      f.service.availableModels(body.thread_id).models[0]?.reasoningEffort
    ).toBeNull()
    const job = f.service.spawn(body.thread_id, member.id, "Build it", "manual")
    await flush()
    expect(f.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reasoning_effort: null,
        model_selection: {
          instanceId: "worker-account",
          model: "worker-model",
          options: [],
        },
      })
    )
    f.complete(job.threadId)
    // The rest of the same ladder still reaches the worker.
    await f.service.prepareForTurn({
      ...body,
      orchestration: {
        enabled: true,
        providers: ["claude"],
        models: [{ ...selected, reasoningEffort: "high" }],
      },
    })
    f.service.spawn(body.thread_id, member.id, "Check it", "manual")
    await flush()
    expect(f.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reasoning_effort: "high",
        model_selection: {
          instanceId: "worker-account",
          model: "worker-model",
          options: [{ id: "effort", value: "high" }],
        },
      })
    )
  })

  it("rejects guessed thinking levels when the account's catalog provides no capabilities", async () => {
    const f = await fixture()
    await expect(
      f.service.prepareForTurn({
        ...f.message(),
        thread_id: "unknown-capabilities",
        orchestration: {
          enabled: true,
          providers: ["codex"],
          models: [
            {
              providerKind: "codex",
              providerInstanceId: "codex-work",
              modelId: "gpt-6-astra",
              reasoningEffort: "high",
            },
          ],
        },
      })
    ).rejects.toThrow("no longer supported")
    expect(f.service.status("unknown-capabilities")).toBeNull()
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it("grants only the selected account/model pairs and keeps restrictions across continuations and reloads", async () => {
    const f = await fixture()
    const codex = f.settings.orchestrator_team.members.find(
      (member) => member.id === "codex"
    )!
    const secondAccount = {
      ...codex,
      id: "codex-personal",
      providerInstanceId: "personal-account",
    }
    f.settings.orchestrator_team.members.push(secondAccount, {
      ...codex,
      id: "sol",
      modelId: "gpt-6-sol",
    })
    const chosen = {
      providerKind: codex.providerKind,
      providerInstanceId: codex.providerInstanceId,
      modelId: codex.modelId,
    }
    const body = {
      ...f.message(),
      thread_id: "selective-chat",
      orchestration: {
        enabled: true as const,
        providers: ["codex" as const],
        models: [chosen],
      },
    }
    await f.service.prepareForTurn(body)
    expect(f.service.availableModels(body.thread_id).models).toEqual([
      expect.objectContaining(chosen),
    ])
    expect(() =>
      f.service.spawn(body.thread_id, "sol", "Wrong model", "sol")
    ).toThrow()
    expect(() =>
      f.service.spawn(
        body.thread_id,
        "codex-personal",
        "Wrong account",
        "personal"
      )
    ).toThrow()
    const job = f.service.spawn(body.thread_id, "codex", "Implement", "valid")
    await flush()
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_instance_id: "codex-work",
        model_id: "gpt-6-astra",
      })
    )
    f.complete(job.threadId)
    const resumed = new OrchestratorService(f.deps)
    services.push(resumed)
    await resumed.prepareForTurn({ ...body, orchestration: undefined })
    expect(resumed.availableModels(body.thread_id).models).toEqual([
      expect.objectContaining(chosen),
    ])
    expect(resumed.status(body.thread_id)?.selectedModels).toEqual([chosen])
    await expect(
      resumed.prepareForTurn({
        ...body,
        orchestration: {
          ...body.orchestration,
          models: [{ ...chosen, modelId: "removed-model" }],
        },
      })
    ).rejects.toThrow("no longer available")
    expect(resumed.availableModels(body.thread_id).models).toHaveLength(1)
    f.settings.orchestrator_team.members.splice(
      f.settings.orchestrator_team.members.indexOf(codex),
      1
    )
    await expect(resumed.prepareForTurn(body)).rejects.toThrow(
      "no longer available"
    )
  })

  it("applies the model count limit after narrowing a large provider catalog", async () => {
    const f = await fixture()
    const catalog = Array.from({ length: 129 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
      role: "Task",
      providerKind: "codex" as const,
      providerInstanceId: "account",
      modelId: `native-${i}`,
    }))
    f.deps.modelCatalog = async () => catalog
    const body = {
      ...f.message(),
      thread_id: "large-catalog",
      orchestration: { enabled: true as const, providers: ["codex" as const] },
    }
    await expect(f.service.prepareForTurn(body)).rejects.toThrow(
      "128 subagent models"
    )
    await f.service.prepareForTurn({
      ...body,
      orchestration: {
        ...body.orchestration,
        models: [
          {
            providerKind: "codex",
            providerInstanceId: "account",
            modelId: "native-128",
          },
        ],
      },
    })
    expect(
      f.service
        .availableModels(body.thread_id)
        .models.map((model) => model.modelId)
    ).toEqual(["native-128"])
  })

  it("enables the provider pool in an existing chat without creating a team and lets the main choose roles and models", async () => {
    const f = await fixture()
    const creates = vi.mocked(f.deps.createThread).mock.calls.length
    const body = {
      ...f.message(),
      thread_id: "normal-chat",
      orchestration: {
        enabled: true as const,
        providers: ["codex" as const, "grok_cli" as const],
      },
    }
    const prepared = await f.service.prepareForTurn(body)
    expect(vi.mocked(f.deps.createThread).mock.calls).toHaveLength(creates)
    expect(prepared.message).toContain("spawn_agent")
    expect(prepared.user_message_content).toBe(body.message)
    expect(
      f.service
        .availableModels(body.thread_id)
        .models.map((model) => model.modelId)
    ).toEqual(["grok-test", "gpt-6-astra"])
    const reviewer = f.service.spawn(
      body.thread_id,
      "codex",
      "Review IPC",
      "review",
      { name: "Security reviewer", role: "Audit IPC boundaries" }
    )
    const builder = f.service.spawn(
      body.thread_id,
      "codex",
      "Fix validation",
      "build",
      { name: "Validation builder", role: "Implement boundary validation" }
    )
    await flush()
    expect(f.dispatch.mock.calls.map((call) => call[0].model_id)).toEqual([
      "gpt-6-astra",
      "gpt-6-astra",
    ])
    expect(f.dispatch.mock.calls[0]?.[0].message).toContain("Security reviewer")
    expect(f.dispatch.mock.calls[1]?.[0].message).toContain(
      "Implement boundary validation"
    )
    const note = f.service.grantContext({
      threadId: body.thread_id,
      requestId: "direct",
      recipient: { kind: "agent", threadId: reviewer.threadId },
      content: {
        kind: "note",
        title: "Private review scope",
        body: "Check IPC routes",
      },
    })
    expect(f.service.readContext(reviewer.threadId, note.id).body).toBe(
      "Check IPC routes"
    )
    expect(() => f.service.readContext(builder.threadId, note.id)).toThrow(
      "unavailable"
    )
    const forwarded = f.service.shareContext(reviewer.threadId, {
      requestId: "pass",
      recipient: { kind: "agent", threadId: builder.threadId },
      content: { kind: "forward", contextId: note.id },
    })
    expect(f.service.readContext(builder.threadId, forwarded.id).body).toBe(
      "Check IPC routes"
    )
    await expect(f.service.prepareForTurn(body)).rejects.toThrow(
      "current workers"
    )
    f.complete(reviewer.threadId)
    f.complete(builder.threadId)
    f.settings.orchestrator_team.members.push({
      ...f.settings.orchestrator_team.main,
      id: "claude",
      name: "Claude",
      role: "Review",
    })
    await f.service.prepareForTurn({
      ...body,
      provider_kind: "grok_cli",
      provider_instance_id: "grok_cli",
      model_id: "grok-test",
      orchestration: { enabled: true, providers: ["claude"] },
    })
    expect(f.service.status(body.thread_id)).toMatchObject({
      mode: "chat",
      currentTaskCount: 0,
      team: { main: { modelId: "grok-test" } },
    })
    expect(() =>
      f.service.spawn(body.thread_id, "codex", "Forbidden", "outside-pool")
    ).toThrow("enabled provider pool")
    expect(
      f.service
        .availableModels(body.thread_id)
        .models.map((model) => model.modelId)
    ).toEqual(["fable-test"])
  })

  it("keeps the dropdown model as main, delegates to Claude/OpenAI, and excludes the main provider after a switch", async () => {
    const f = await fixture()
    f.settings.orchestrator_team.members.push({
      ...f.settings.orchestrator_team.main,
      id: "claude",
      name: "Claude",
      role: "Review",
    })
    const modelCatalog = vi.fn(f.deps.modelCatalog)
    f.deps.modelCatalog = modelCatalog
    const body = chatSendSchema.parse({
      threadId: "grok-led-chat",
      projectPath: f.root,
      providerKind: "grok_cli",
      providerInstanceId: "grok-personal",
      modelId: "grok-4.6",
      message: "Implement and review",
      chatMode: "agent",
      orchestration: {
        enabled: true,
        providers: ["claude", "codex", "grok_cli"],
      },
    })
    await f.service.prepareForTurn(body)
    expect(modelCatalog).toHaveBeenLastCalledWith(f.root, ["claude", "codex"])
    expect(f.service.status(body.thread_id)).toMatchObject({
      allowedProviders: ["claude", "codex"],
      team: {
        main: {
          providerKind: "grok_cli",
          providerInstanceId: "grok-personal",
          modelId: "grok-4.6",
        },
      },
    })
    expect(() =>
      f.service.spawn(body.thread_id, "grok", "Own provider", "excluded")
    ).toThrow()
    const reviewer = f.service.spawn(
      body.thread_id,
      "claude",
      "Review the implementation",
      "review",
      { name: "Reviewer", role: "Audit correctness" }
    )
    const builder = f.service.spawn(
      body.thread_id,
      "codex",
      "Implement the plan",
      "build",
      { name: "Builder", role: "Implement" }
    )
    await flush()
    expect(
      f.dispatch.mock.calls.map(([request]) => [
        request.provider_kind,
        request.provider_instance_id,
        request.model_id,
      ])
    ).toEqual([
      ["claude", "claude", "fable-test"],
      ["codex", "codex-work", "gpt-6-astra"],
    ])
    f.complete(reviewer.threadId)
    f.complete(builder.threadId)
    await f.service.prepareForTurn({
      ...body,
      provider_kind: "codex",
      provider_instance_id: "codex-work",
      model_id: "gpt-6-astra",
      orchestration: { enabled: true, providers: ["claude", "codex"] },
    })
    expect(modelCatalog).toHaveBeenLastCalledWith(f.root, ["claude"])
    expect(f.service.status(body.thread_id)?.team.main.modelId).toBe(
      "gpt-6-astra"
    )
    expect(
      f.service
        .availableModels(body.thread_id)
        .models.map((model) => model.providerKind)
    ).toEqual(["claude"])
    expect(() =>
      f.service.spawn(
        body.thread_id,
        "codex",
        "Hidden old selection",
        "forbidden"
      )
    ).toThrow("enabled provider pool")
    const calls = modelCatalog.mock.calls.length
    const ordinary = {
      ...body,
      orchestration: {
        enabled: true as const,
        providers: ["grok_cli" as const],
      },
    }
    expect((await f.service.prepareForTurn(ordinary)).message).toBe(
      body.message
    )
    expect(modelCatalog).toHaveBeenCalledTimes(calls)
    expect(f.service.canUseTools(body.thread_id, f.root)).toBe(false)
  })

  it("resets the budget per message, retains bounded history, and returns to ordinary chat when disabled", async () => {
    const f = await fixture()
    const body = {
      ...f.message(),
      thread_id: "normal-chat",
      orchestration: {
        enabled: true as const,
        providers: ["grok_cli" as const],
      },
    }
    for (let turn = 0; turn < 3; turn++) {
      await f.service.prepareForTurn(body)
      for (let task = 0; task < 12; task++) {
        const job = f.service.spawn(
          body.thread_id,
          "grok",
          "Research",
          `turn-${turn}-task-${task}`
        )
        await flush()
        f.complete(job.threadId)
      }
      expect(() =>
        f.service.spawn(body.thread_id, "grok", "Overflow", `overflow-${turn}`)
      ).toThrow("Task limit")
    }
    expect(f.service.status(body.thread_id)?.jobs).toHaveLength(32)
    const disabled = { ...body, orchestration: { enabled: false as const } }
    expect(await f.service.prepareForTurn(disabled)).toEqual(disabled)
    expect(f.service.canUseTools(body.thread_id, f.root)).toBe(false)
    expect(() => f.service.assertDispatchAllowed(body.thread_id)).not.toThrow()
    expect(f.service.status(body.thread_id)?.jobs).toHaveLength(32)
    await f.service.prepareForTurn(body)
    expect(f.service.availableModels(body.thread_id).models).toHaveLength(1)
  })

  it("fences a slow catalog lookup against stop and rejects worker delegation", async () => {
    const f = await fixture()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = vi.fn()
    f.deps.modelCatalog = async () => {
      entered()
      await pending
      return f.settings.orchestrator_team.members
    }
    const body = {
      ...f.message(),
      thread_id: "normal-chat",
      orchestration: {
        enabled: true as const,
        providers: ["codex" as const, "grok_cli" as const],
      },
    }
    const preparing = f.service.prepareForTurn(body)
    const rejected = expect(preparing).rejects.toThrow(
      "stopped during preparation"
    )
    await vi.waitFor(() => expect(entered).toHaveBeenCalled())
    await f.service.withInterruptedChildren(
      body.thread_id,
      async () => undefined
    )
    release()
    await rejected
    expect(f.service.status(body.thread_id)).toBeNull()
    f.prepare()
    const job = f.service.spawn(
      f.session.threadId,
      "grok",
      "Research",
      "worker"
    )
    await expect(
      f.service.prepareForTurn({ ...body, thread_id: job.threadId })
    ).rejects.toThrow("Workers cannot")
  })

  it("disables a legacy team without locking the user's normal chat", async () => {
    const f = await fixture()
    f.prepare()
    const body = { ...f.message(), orchestration: { enabled: false as const } }
    expect(await f.service.prepareForTurn(body)).toEqual(body)
    expect(() =>
      f.service.assertDispatchAllowed(f.session.threadId)
    ).not.toThrow()
    expect(f.service.status(f.session.threadId)).toMatchObject({
      mode: "chat",
      status: "stopped",
    })
  })
  it("routes granted snapshots to the selected member, forwards within this team and records actual reads", async () => {
    const f = await fixture()
    f.settings.orchestrator_team.maxConcurrent = 2
    // Team configuration is snapshotted on creation; start with the new limit.
    const team = await f.service.start(f.root)
    f.service.prepareTurn({ ...f.message(), thread_id: team.threadId })
    const grok = f.service.spawn(
      team.threadId,
      "grok",
      "Read the plan",
      "reader"
    )
    const codex = f.service.spawn(
      team.threadId,
      "codex",
      "Implement it",
      "builder"
    )
    await flush()
    const grant = f.service.grantContext({
      threadId: team.threadId,
      requestId: "grant",
      recipient: { kind: "member", memberId: "grok" },
      content: { kind: "plan", threadId: "source" },
    })
    expect(
      f.service.contextInbox(grok.threadId).items.map((item) => item.id)
    ).toEqual([grant.id])
    expect(f.service.contextInbox(codex.threadId).items).toEqual([])
    expect(f.service.contextInbox(team.threadId).items).toEqual([])
    expect(() => f.service.readContext(codex.threadId, grant.id)).toThrow(
      "unavailable"
    )
    expect(() =>
      f.service.shareContext(codex.threadId, {
        requestId: "steal",
        recipient: { kind: "team" },
        content: { kind: "forward", contextId: grant.id },
      })
    ).toThrow("unavailable")
    expect(f.service.readContext(grok.threadId, grant.id).body).toContain(
      "session token"
    )
    f.service.readContext(grok.threadId, grant.id)
    expect(
      f.service.inspectContext(team.threadId, grant.id).readBy
    ).toHaveLength(1)
    const forwarded = f.service.shareContext(grok.threadId, {
      requestId: "forward",
      recipient: { kind: "member", memberId: "codex" },
      content: { kind: "forward", contextId: grant.id },
    })
    expect(f.service.readContext(codex.threadId, forwarded.id)).toMatchObject({
      body: grant.body,
      originId: grant.id,
      source: grant.source,
    })
    expect(
      f.service
        .status(team.threadId, false)
        ?.context.every((item) => item.body === "")
    ).toBe(true)
    f.service.removeContext(team.threadId, forwarded.id)
    expect(f.service.contextInbox(grok.threadId).items).toEqual([])
    expect(() => f.service.readContext(codex.threadId, forwarded.id)).toThrow(
      "unavailable"
    )
  })

  it("keeps grants idempotent, validates recipients and rejects cross-team reads", async () => {
    const f = await fixture()
    f.prepare()
    const input = {
      threadId: f.session.threadId,
      requestId: "note",
      recipient: { kind: "team" as const },
      content: {
        kind: "note" as const,
        title: "Contract",
        body: "Use explicit model IDs.",
      },
    }
    const note = f.service.grantContext(input)
    expect(f.service.grantContext(input).id).toBe(note.id)
    expect(() =>
      f.service.grantContext({
        ...input,
        content: { ...input.content, body: "changed" },
      })
    ).toThrow("already used")
    expect(() =>
      f.service.grantContext({
        ...input,
        requestId: "invalid",
        recipient: { kind: "member", memberId: "missing" },
      })
    ).toThrow("Unknown context recipient")
    const other = await f.service.start(f.root)
    f.service.prepareTurn({ ...f.message(), thread_id: other.threadId })
    expect(() => f.service.readContext(other.threadId, note.id)).toThrow(
      "unavailable"
    )
    f.settings.orchestrator_enabled = false
    expect(() => f.service.contextInbox(f.session.threadId)).toThrow("revoked")
    expect(() =>
      f.service.grantContext({ ...input, requestId: "disabled" })
    ).toThrow("disabled")
  })

  it("persists context across restart without replaying work and rolls back failed writes", async () => {
    const f = await fixture()
    f.prepare()
    const input = {
      threadId: f.session.threadId,
      requestId: "note",
      recipient: { kind: "main" as const },
      content: {
        kind: "note" as const,
        title: "Plan",
        body: "Check authorization.",
      },
    }
    const entry = f.service.grantContext(input)
    const restored = new OrchestratorService(f.deps)
    services.push(restored)
    expect(restored.readContext(f.session.threadId, entry.id).body).toBe(
      "Check authorization."
    )
    expect(f.dispatch).not.toHaveBeenCalled()
    const persist = f.deps.persist
    f.deps.persist = () => {
      throw new Error("Disk full")
    }
    expect(() =>
      f.service.grantContext({ ...input, requestId: "new" })
    ).toThrow("Disk full")
    expect(() => f.service.removeContext(f.session.threadId, entry.id)).toThrow(
      "Disk full"
    )
    expect(() => f.service.readContext(f.session.threadId, entry.id)).toThrow(
      "Disk full"
    )
    expect(f.service.status(f.session.threadId)?.context).toHaveLength(1)
    expect(
      f.service.inspectContext(f.session.threadId, entry.id).readBy
    ).toEqual([])
    f.deps.persist = persist
  })

  it("bounds shared notes and revokes worker tools after cancellation", async () => {
    const f = await fixture()
    f.prepare()
    const job = f.service.spawn(f.session.threadId, "grok", "Research", "one")
    await flush()
    const input = {
      requestId: "finding",
      recipient: { kind: "main" as const },
      content: {
        kind: "note" as const,
        title: "Finding",
        body: "Boundary validated.",
      },
    }
    const entry = f.service.shareContext(job.threadId, input)
    expect(f.service.readContext(f.session.threadId, entry.id).body).toBe(
      "Boundary validated."
    )
    expect(() =>
      f.service.shareContext(job.threadId, {
        ...input,
        requestId: "large",
        content: { ...input.content, body: "x".repeat(12001) },
      })
    ).toThrow()
    for (let i = 1; i < 64; i++)
      f.service.shareContext(job.threadId, { ...input, requestId: `note-${i}` })
    expect(() =>
      f.service.shareContext(job.threadId, { ...input, requestId: "overflow" })
    ).toThrow("limit")
    expect(f.service.shareContext(job.threadId, input).id).toBe(entry.id)
    await f.service.cancelTask(f.session.threadId, job.id)
    expect(f.service.canUseTools(job.threadId, f.root)).toBe(false)
    expect(() =>
      f.service.shareContext(job.threadId, { ...input, requestId: "late" })
    ).toThrow("revoked")
  })
  it("opts in explicitly, binds the coordinator, preserves user text and caps worker permissions", async () => {
    const f = await fixture()
    expect(f.service.canUseTools(f.session.threadId, f.root)).toBe(false)
    const body = f.prepare("bypass")
    expect(body.user_message_content).toBe("Build the requested feature.")
    expect(body.message).toContain("spawn_agent")
    expect(f.service.status(f.session.threadId)?.permissionLevel).toBe(
      "ask-on-edit"
    )
    expect(() =>
      f.service.prepareTurn({ ...f.message(), model_id: "other" })
    ).toThrow("main model")
    expect(() =>
      f.service.prepareTurn({
        ...f.message(),
        project_path: path.dirname(f.root),
      })
    ).toThrow("original project")
    f.settings.orchestrator_enabled = false
    expect(f.service.canUseTools(f.session.threadId, f.root)).toBe(false)
    await expect(f.service.start(f.root)).rejects.toThrow("disabled")
    expect(() =>
      f.service.spawn(f.session.threadId, "grok", "Do work", "one")
    ).toThrow("disabled")
  })

  it("dispatches the exact worker model once, queues at the limit and isolates task ownership", async () => {
    const f = await fixture()
    f.prepare("read-only")
    const first = f.service.spawn(
      f.session.threadId,
      "grok",
      "Investigate auth",
      "one"
    )
    const second = f.service.spawn(
      f.session.threadId,
      "codex",
      "Implement auth",
      "two"
    )
    await flush()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.dispatch.mock.calls[0]?.[0]).toMatchObject({
      thread_id: first.threadId,
      provider_kind: "grok_cli",
      provider_instance_id: "grok_cli",
      model_id: "grok-test",
      permission_level: "read-only",
      user_message_content: "Investigate auth",
    })
    expect(f.service.task(f.session.threadId, second.id).status).toBe("queued")
    expect(
      f.service.spawn(f.session.threadId, "grok", "Investigate auth", "one")
        .threadId
    ).toBe(first.threadId)
    expect(() =>
      f.service.spawn(f.session.threadId, "grok", "Different", "one")
    ).toThrow("different work")
    expect(() =>
      f.service.spawn(f.session.threadId, "unknown", "Do work", "three")
    ).toThrow("Unknown team member")
    expect(f.service.canUseTools(first.threadId, f.root)).toBe(true)
    expect(f.service.isCoordinator(first.threadId)).toBe(false)
    expect(() => f.service.task(first.threadId, "one")).toThrow(
      "Unknown orchestrator"
    )
    f.complete(first.threadId)
    await flush()
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(f.dispatch.mock.calls[1]?.[0]).toMatchObject({
      provider_instance_id: "codex-work",
      model_id: "gpt-6-astra",
    })
  })

  it("keeps a cancelling task in its concurrency slot until the provider acknowledges interruption", async () => {
    let release = () => {}
    const stopped = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = await fixture({ interrupt: async () => stopped })
    f.prepare()
    const first = f.service.spawn(f.session.threadId, "grok", "One", "one")
    f.service.spawn(f.session.threadId, "codex", "Two", "two")
    await flush()
    const cancellation = f.service.cancelTask(f.session.threadId, first.id)
    await flush()
    expect(f.service.task(f.session.threadId, first.id).status).toBe(
      "cancelling"
    )
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    release()
    await cancellation
    await flush()
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })

  it("waits for admission before cancelling and never dispatches the queue after stop", async () => {
    let admit = () => {}
    const admission = new Promise<void>((resolve) => {
      admit = resolve
    })
    const dispatch = vi.fn(async () => admission)
    const f = await fixture({ dispatch })
    f.prepare()
    f.service.spawn(f.session.threadId, "grok", "One", "one")
    f.service.spawn(f.session.threadId, "codex", "Two", "two")
    await flush()
    const stopping = f.service.stop(f.session.threadId)
    await flush()
    expect(() => f.service.assertDispatchAllowed(f.session.threadId)).toThrow(
      "stopped"
    )
    expect(f.interrupt).not.toHaveBeenCalled()
    admit()
    await stopping
    await flush()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(f.interrupt).toHaveBeenCalledOnce()
    expect(
      f.service.status(f.session.threadId)?.jobs.map((job) => job.status)
    ).toEqual(["cancelled", "cancelled"])
  })

  it("reports cancellation failure and leaves the occupied slot unavailable for new work", async () => {
    const interrupt = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined)
    const f = await fixture({ interrupt })
    f.prepare()
    f.service.spawn(f.session.threadId, "grok", "One", "one")
    f.service.spawn(f.session.threadId, "codex", "Two", "two")
    await flush()
    await expect(
      f.service.cancelTask(f.session.threadId, "one")
    ).rejects.toThrow("offline")
    expect(f.service.task(f.session.threadId, "one")).toMatchObject({
      status: "running",
      error: expect.stringContaining("Cancellation failed"),
    })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it("captures bounded assistant output, marks failed turns honestly and does not replay work after restart", async () => {
    const f = await fixture()
    f.prepare()
    const job = f.service.spawn(f.session.threadId, "grok", "One", "one")
    await flush()
    f.service.onEvent(
      providerRuntimeEventSchema.parse({
        eventId: "output",
        threadId: job.threadId,
        at: Date.now(),
        type: "content.delta",
        streamKind: "assistant_text",
        delta: "x".repeat(25000),
      })
    )
    f.complete(job.threadId, "failed")
    expect(f.service.task(f.session.threadId, "one")).toMatchObject({
      status: "failed",
      truncated: true,
      output: "x".repeat(24000),
    })
    expect(f.service.status(f.session.threadId, false)?.jobs[0]?.output).toBe(
      ""
    )
    f.service.spawn(f.session.threadId, "codex", "Two", "two")
    await flush()
    const recovered = new OrchestratorService(f.deps)
    services.push(recovered)
    expect(recovered.status(f.session.threadId)?.jobs[1]).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("not resumed"),
    })
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })

  it("revokes tools and cancels queued/running workers when the setting is disabled", async () => {
    const f = await fixture()
    f.prepare()
    f.service.spawn(f.session.threadId, "grok", "One", "one")
    f.service.spawn(f.session.threadId, "codex", "Two", "two")
    await flush()
    f.settings.orchestrator_enabled = false
    f.service.settingsChanged()
    await flush()
    expect(f.service.canUseTools(f.session.threadId, f.root)).toBe(false)
    expect(f.service.status(f.session.threadId)).toMatchObject({
      status: "stopped",
      jobs: [{ status: "cancelled" }, { status: "cancelled" }],
    })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it("enforces the lifetime task limit even when tasks complete immediately", async () => {
    const f = await fixture()
    f.prepare()
    for (let index = 0; index < 3; index++) {
      const job = f.service.spawn(
        f.session.threadId,
        "grok",
        "One",
        String(index)
      )
      await flush()
      f.complete(job.threadId)
    }
    expect(() =>
      f.service.spawn(f.session.threadId, "grok", "Fourth", "four")
    ).toThrow("Task limit")
  })

  it("holds the delegation fence until the main turn has actually been interrupted", async () => {
    const f = await fixture()
    f.prepare()
    f.service.spawn(f.session.threadId, "grok", "One", "one")
    f.service.spawn(f.session.threadId, "codex", "Two", "two")
    await flush()
    await f.service.withInterruptedChildren(f.session.threadId, async () => {
      expect(f.service.canUseTools(f.session.threadId, f.root)).toBe(false)
      expect(() =>
        f.service.spawn(f.session.threadId, "grok", "Late", "late")
      ).toThrow("being stopped")
      expect(
        f.service
          .status(f.session.threadId)
          ?.jobs.every((job) => job.status === "cancelled")
      ).toBe(true)
    })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.service.canUseTools(f.session.threadId, f.root)).toBe(true)
  })

  it("times out tasks after fifteen minutes and quiesces dependent jobs before thread teardown", async () => {
    const f = await fixture()
    f.prepare()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const job = f.service.spawn(f.session.threadId, "grok", "One", "one")
    await flush()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(f.interrupt).toHaveBeenCalledWith(
      job.threadId,
      "grok_cli",
      "grok_cli"
    )
    expect(f.service.task(f.session.threadId, "one").status).toBe("cancelled")
    f.service.spawn(f.session.threadId, "codex", "Two", "two")
    await flush()
    await f.service.quiesceThread(f.session.threadId)
    expect(
      f.service
        .status(f.session.threadId)
        ?.jobs.every((item) => item.status === "cancelled")
    ).toBe(true)
    f.stored.delete(f.session.threadId)
    f.service.forgetThread(f.session.threadId)
    expect(f.service.status(f.session.threadId)).toBeNull()
  })

  it("refuses a permission change during active work and fails closed on a corrupted stored team", async () => {
    const f = await fixture()
    f.prepare()
    f.service.spawn(f.session.threadId, "grok", "One", "one")
    await flush()
    expect(() => f.prepare("read-only")).toThrow(
      "changing the team's permission"
    )
    const corrupted = new OrchestratorService({
      ...f.deps,
      load: () => ({ threadId: "broken" }),
    })
    services.push(corrupted)
    expect(() => corrupted.prepareTurn(f.message())).toThrow(
      "Stored team configuration is invalid"
    )
  })
})
