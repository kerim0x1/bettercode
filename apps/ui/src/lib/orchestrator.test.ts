import { beforeEach, describe, expect, it, vi } from "vitest"
import { orchestratorSessionSchema } from "@betterc0de/schema"
import {
  restoreOrchestrationSelection,
  openOrchestratorChat,
  teamModelChoices,
} from "./orchestrator"
import { useChatStore } from "./chat-store"
import { usePreferencesStore } from "./preferences-store"
import { resolveComposerPreferences } from "./composer-settings"
import { selectComposerModel } from "./composer-preferences"
import type { UiProvider } from "./provider-types"

vi.mock("@/services/backend/coreApi", () => ({
  loadMessages: vi.fn(async () => []),
}))
vi.mock("@/services/backend/chatApi", () => ({
  loadThreadActivities: vi.fn(async () => []),
  saveThreadModelSwitchActivity: vi.fn(async () => undefined),
}))
const providers: UiProvider[] = [
  {
    id: "claude-ui",
    name: "Claude",
    logo: "",
    providerKind: "claude",
    providerInstanceId: "claude-account",
    models: [{ id: "fable", name: "Fable", context: "200k", tier: "Main" }],
  },
  {
    id: "codex-ui",
    name: "Codex",
    logo: "",
    providerKind: "codex",
    providerInstanceId: "codex-account",
    models: [{ id: "gpt-6-astra", name: "Astra", context: "1m", tier: "Main" }],
  },
  {
    id: "api",
    name: "API",
    logo: "",
    providerKind: "openai",
    models: [{ id: "gpt-6-astra", name: "Astra", context: "1m", tier: "Main" }],
  },
]
const session = orchestratorSessionSchema.parse({
  threadId: "main",
  projectPath: "C:\\project",
  status: "ready",
  permissionLevel: "ask-on-edit",
  createdAt: "2026-09-20T00:00:00Z",
  team: {
    main: {
      providerKind: "claude",
      providerInstanceId: "claude-account",
      modelId: "fable",
    },
    members: [
      {
        id: "builder",
        name: "Builder",
        role: "Implement",
        providerKind: "codex",
        providerInstanceId: "codex-account",
        modelId: "gpt-6-astra",
      },
    ],
  },
  jobs: [
    {
      id: "one",
      threadId: "worker",
      memberId: "builder",
      task: "Implement auth",
      status: "running",
      output: "",
      truncated: false,
      error: null,
      createdAt: "2026-09-20T00:00:00Z",
      finishedAt: null,
    },
  ],
})
beforeEach(() => {
  useChatStore.setState({
    threads: [],
    settingsByThread: {},
    activeThreadId: null,
    messagesLoadedByThread: {},
    activitiesLoadedByThread: {},
  })
})

describe("orchestrator chat navigation", () => {
  it("restores exact model grants instead of widening a saved chat to the whole provider", () => {
    const selectedModels = [
      {
        providerKind: "codex" as const,
        providerInstanceId: "codex-account",
        modelId: "gpt-6-astra",
      },
    ]
    restoreOrchestrationSelection({
      ...session,
      mode: "chat",
      allowedProviders: ["codex"],
      selectedModels,
    })
    expect(
      useChatStore.getState().settingsByThread.main?.orchestration
    ).toEqual({ enabled: true, providers: ["codex"], models: selectedModels })
  })
  it("offers only supported CLI providers and preserves exact account/model IDs", () => {
    expect(teamModelChoices(providers).map((choice) => choice.value)).toEqual([
      session.team.main,
      {
        providerKind: "codex",
        providerInstanceId: "codex-account",
        modelId: "gpt-6-astra",
      },
    ])
  })
  it("adopts a coordinator chat once and lets the user change its model", async () => {
    const prefs = usePreferencesStore.getState()
    const before = prefs.selectedModel
    openOrchestratorChat(session, providers)
    await Promise.resolve()
    openOrchestratorChat(session, providers)
    expect(useChatStore.getState().threads).toHaveLength(1)
    expect(useChatStore.getState().activeThreadId).toBe("main")
    const settings = useChatStore.getState().settingsByThread.main
    expect(usePreferencesStore.getState().selectedModel).toBe(before)
    expect(resolveComposerPreferences(prefs, settings)).toMatchObject({
      selectedProviderId: "claude-ui",
      selectedModel: "fable",
      chatMode: "agent",
      permissionLevel: "ask-on-edit",
    })
    selectComposerModel("main", "gpt-6-astra", "codex-ui")
    expect(useChatStore.getState().settingsByThread.main?.selectedModel).toBe(
      "gpt-6-astra"
    )
    openOrchestratorChat(session, providers)
    expect(useChatStore.getState().settingsByThread.main?.selectedModel).toBe(
      "gpt-6-astra"
    )
  })
  it("opens worker approvals and restores the provider pool without locking the main model", async () => {
    openOrchestratorChat(session, providers, "worker")
    await Promise.resolve()
    expect(useChatStore.getState().threads[0]).toMatchObject({
      id: "worker",
      parentThreadId: "main",
    })
    expect(useChatStore.getState().settingsByThread.worker).toMatchObject({
      selectedProviderId: "codex-ui",
      selectedModel: "gpt-6-astra",
    })
    expect(
      useChatStore.getState().settingsByThread.worker?.orchestration
    ).toBeUndefined()
    restoreOrchestrationSelection(session)
    expect(
      useChatStore.getState().settingsByThread.main?.orchestration
    ).toEqual({ enabled: true, providers: ["codex"] })
    useChatStore
      .getState()
      .setThreadSetting("main", "orchestration", { enabled: false })
    restoreOrchestrationSelection(session)
    expect(
      useChatStore.getState().settingsByThread.main?.orchestration
    ).toEqual({ enabled: false })
    expect(() => openOrchestratorChat(session, providers, "unrelated")).toThrow(
      "no longer belongs"
    )
  })
})
