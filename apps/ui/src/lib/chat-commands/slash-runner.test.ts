import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/services/backend/coreApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/backend/coreApi")>()
  return {
    ...actual,
    saveThread: vi.fn().mockResolvedValue(undefined),
    upsertThreadMeta: vi.fn().mockResolvedValue(undefined),
    saveThreadMessage: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock("@/services/backend/chatApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/backend/chatApi")>()
  return {
    ...actual,
    setChatPermissionMode: vi
      .fn()
      .mockResolvedValue({ status: "acknowledged", applied: "live" }),
  }
})

import { useChatStore } from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { setChatPermissionMode } from "@/services/backend/chatApi"
import {
  runRegisteredSlashCommand,
  type SlashRuntimeContext,
} from "@/lib/slash-command-runtime"

function slashContext(
  overrides: Partial<SlashRuntimeContext> & Pick<SlashRuntimeContext, "cmd">
): SlashRuntimeContext {
  const cmd = overrides.cmd
  return {
    args: [],
    trimmedText: cmd,
    rawText: cmd,
    threadId: null,
    selectedProvider: undefined,
    selectedModel: "test-model",
    thinkingMode: null,
    chatMode: "agent",
    setChatMode: () => {},
    specialMode: null,
    permissionLevel: "ask",
    contextWindow: "default",
    fastMode: false,
    appMode: "agent",
    closeSlash: () => {},
    activeThread: null,
    effectiveChatMode: "agent",
    ...overrides,
  }
}

describe("runRegisteredSlashCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      threads: [],
      activeThreadId: null,
      messagesLoadedByThread: {},
    })
  })

  it("applies /autoaccept to the invoking chat's live provider session", async () => {
    const result = await runRegisteredSlashCommand(
      slashContext({
        cmd: "/autoaccept",
        args: ["on"],
        threadId: "owner",
        selectedProvider: {
          id: "codex",
          providerKind: "codex",
          providerInstanceId: "owner-instance",
        } as SlashRuntimeContext["selectedProvider"],
      })
    )
    expect(result?.handled).toBe(true)
    expect(
      useChatStore.getState().settingsByThread.owner?.permissionLevel
    ).toBe("bypass")
    expect(setChatPermissionMode).toHaveBeenCalledExactlyOnceWith(
      "owner",
      "codex",
      "bypass",
      "owner-instance"
    )
  })

  it("handles /new without producing output that would be sent to the model", async () => {
    const before = useChatStore.getState().threads.length
    const result = await runRegisteredSlashCommand(
      slashContext({ cmd: "/new" })
    )

    expect(result?.handled).toBe(true)
    expect(result?.output).toBe("")
    expect(useChatStore.getState().threads.length).toBe(before + 1)
    expect(useChatStore.getState().activeThreadId).toBeTruthy()
  })

  it("handles /model by opening the picker instead of sending a chat turn", async () => {
    const closeSlash = vi.fn()
    const openModelPicker = vi.fn()
    const result = await runRegisteredSlashCommand(
      slashContext({
        cmd: "/model",
        closeSlash,
        openModelPicker,
      })
    )

    expect(result?.handled).toBe(true)
    expect(result?.output).toBe("")
    expect(closeSlash).toHaveBeenCalledTimes(1)
    expect(openModelPicker).toHaveBeenCalledTimes(1)
  })

  it("targets session commands at the invoking chat even when another pane has focus", async () => {
    const threads = ["owner", "other"].map((id) => ({
      id,
      title: `${id} title`,
      projectName: id,
      projectPath: `C:/${id}`,
      messages: [],
      createdAt: "2026-09-06",
      updatedAt: "2026-09-06",
    }))
    useChatStore.setState({ threads, activeThreadId: "other" })
    const result = await runRegisteredSlashCommand(
      slashContext({
        cmd: "/delete-session",
        threadId: "owner",
        activeThread: threads[0],
      })
    )
    expect(result?.output).toContain("owner title")
    expect(result?.output).not.toContain("other title")
    expect(useChatStore.getState().threads).toHaveLength(2)
  })

  it("returns help output for /help", async () => {
    const result = await runRegisteredSlashCommand(
      slashContext({ cmd: "/help" })
    )

    expect(result?.handled).toBe(true)
    expect(result?.output).toContain("# BetterC0de Commands")
    expect(result?.output).toContain("| `/model`, `/models` |")
  })

  it("cycles model options in the invoking chat even if another chat has focus", async () => {
    usePreferencesStore.setState({ modelSelectionByProvider: {} })
    useChatStore.setState({
      activeThreadId: "b",
      settingsByThread: {
        a: {
          modelSelectionByProvider: {
            compat: { optionSelections: [{ id: "variant", value: "low" }] },
          },
        },
        b: {
          modelSelectionByProvider: {
            compat: { optionSelections: [{ id: "variant", value: "high" }] },
          },
        },
      },
    })
    const otherSettings = useChatStore.getState().settingsByThread.b
    const result = await runRegisteredSlashCommand(
      slashContext({
        cmd: "/variant.cycle",
        threadId: "a",
        selectedModel: "model",
        selectedProvider: {
          id: "compat",
          name: "Compatibility",
          logo: "",
          models: [
            {
              id: "model",
              name: "Model",
              context: "runtime",
              tier: "Runtime",
              capabilities: {
                optionDescriptors: [
                  {
                    id: "variant",
                    label: "Variant",
                    type: "select",
                    options: [
                      { id: "low", label: "Low" },
                      { id: "high", label: "High" },
                    ],
                  },
                ],
              },
            },
          ],
        },
      })
    )
    expect(result?.handled).toBe(true)
    expect(
      useChatStore.getState().settingsByThread.a?.modelSelectionByProvider
        ?.compat.optionSelections
    ).toEqual([{ id: "variant", value: "high" }])
    expect(useChatStore.getState().settingsByThread.b).toBe(otherSettings)
  })

  it("handles /import without throwing when no workspace or file is provided", async () => {
    await expect(
      runRegisteredSlashCommand(slashContext({ cmd: "/import" }))
    ).resolves.toMatchObject({
      handled: true,
      output: expect.stringContaining("Import Session"),
    })
  })

  it("leaves unknown slash commands unhandled so submit can fall through", async () => {
    const result = await runRegisteredSlashCommand(
      slashContext({ cmd: "/definitely-not-a-builtin-slash" })
    )

    expect(result).toBeNull()
  })

  it("handles /fork on an existing thread without sending a chat turn", async () => {
    const store = useChatStore.getState()
    const sourceId = store.createThread("Source", "BetterC0de", "/repo")
    store.addMessage(sourceId, {
      id: "msg-1",
      role: "user",
      content: "hello",
      createdAt: "2026-05-19T10:00:00.000Z",
    })

    const result = await runRegisteredSlashCommand(
      slashContext({
        cmd: "/fork",
        threadId: sourceId,
        rawText: "/fork",
        trimmedText: "/fork",
      })
    )

    expect(result?.handled).toBe(true)
    expect(result?.output).toBe("")
    const state = useChatStore.getState()
    expect(state.threads).toHaveLength(2)
    expect(state.activeThreadId).toBe(result?.threadId)
    expect(state.activeThreadId).not.toBe(sourceId)
    expect(
      state.threads.find((thread) => thread.id === state.activeThreadId)
        ?.parentThreadId
    ).toBe(sourceId)
  })
})
