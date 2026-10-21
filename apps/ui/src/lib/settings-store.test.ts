import { beforeEach, describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/lib/settings-store"
import { getSettings, updateSettings } from "@/services/backend"
import { handleError } from "@/lib/errors"

vi.mock("@/lib/errors", () => ({ handleError: vi.fn() }))

vi.mock("@/services/backend", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn().mockResolvedValue({}),
  getCliStatus: vi.fn(),
}))

describe("settings-store", () => {
  beforeEach(() => {
    vi.mocked(handleError).mockClear()
    vi.mocked(getSettings).mockReset().mockResolvedValue({})
    vi.mocked(updateSettings).mockReset().mockResolvedValue({})
    useSettingsStore.setState({
      loaded: false,
      enableAssistantStreaming: true,
      showMessageTimestamps: true,
      showThinkingBlocks: true,
      showReasoningSummaries: false,
      showToolDetails: false,
      showSessionProgressBar: true,
      shellToolPartsExpanded: false,
      editToolPartsExpanded: false,
      showChatScrollbar: false,
      showGenericToolOutput: false,
      concealCodeBlocks: false,
      autoSaveConversations: true,
      diffWordWrap: true,
      diffStyle: "auto",
      confirmArchive: true,
      confirmDelete: true,
      notificationAgent: true,
      notificationPermissions: true,
      notificationErrors: false,
      backendLogLevel: "info",
      backendLogFormat: "simple",
      backendTraceHttp: false,
      backendTraceProviderEvents: false,
      remoteAccessEnabled: false,
      remoteAccessCustomUrl: "",
      archivedThreadIds: [],
    })
  })

  it("retries settings initialization after a transient load failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(getSettings)
      .mockRejectedValueOnce(new Error("backend restarting"))
      .mockResolvedValueOnce({ theme: "light", auto_save_conversations: false })

    await useSettingsStore.getState().init()
    expect(useSettingsStore.getState().loaded).toBe(false)

    await useSettingsStore.getState().init()
    expect(getSettings).toHaveBeenCalledTimes(2)
    expect(useSettingsStore.getState()).toMatchObject({
      loaded: true,
      theme: "light",
      autoSaveConversations: false,
    })
  })

  it("deduplicates concurrent settings initialization", async () => {
    let resolveSettings!: (value: Record<string, unknown>) => void
    vi.mocked(getSettings).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve
        })
    )

    const first = useSettingsStore.getState().init()
    const second = useSettingsStore.getState().init()
    expect(getSettings).toHaveBeenCalledTimes(1)

    resolveSettings({ theme: "dark" })
    await Promise.all([first, second])
    expect(useSettingsStore.getState().loaded).toBe(true)
  })

  it("optimistically maps persisted snake_case patches to local camelCase state", async () => {
    await useSettingsStore.getState().update({
      enable_assistant_streaming: false,
      show_message_timestamps: false,
      show_thinking_blocks: false,
      show_reasoning_summaries: true,
      show_tool_details: true,
      show_session_progress_bar: false,
      shell_tool_parts_expanded: true,
      edit_tool_parts_expanded: true,
      show_chat_scrollbar: true,
      show_generic_tool_output: true,
      conceal_code_blocks: true,
      auto_save_conversations: false,
      diff_word_wrap: false,
      diff_style: "stacked",
      confirm_archive: false,
      confirm_delete: false,
      notification_agent: false,
      notification_permissions: false,
      notification_errors: true,
      backend_log_level: "debug",
      backend_log_format: "json",
      backend_trace_http: true,
      backend_trace_provider_events: true,
      remote_access_enabled: true,
      remote_access_custom_url: "https://code.example.com",
      archived_thread_ids: ["thread-1"],
    })

    const state = useSettingsStore.getState()
    expect(state.enableAssistantStreaming).toBe(false)
    expect(state.showMessageTimestamps).toBe(false)
    expect(state.showThinkingBlocks).toBe(false)
    expect(state.showReasoningSummaries).toBe(true)
    expect(state.showToolDetails).toBe(true)
    expect(state.showSessionProgressBar).toBe(false)
    expect(state.shellToolPartsExpanded).toBe(true)
    expect(state.editToolPartsExpanded).toBe(true)
    expect(state.showChatScrollbar).toBe(true)
    expect(state.showGenericToolOutput).toBe(true)
    expect(state.concealCodeBlocks).toBe(true)
    expect(state.autoSaveConversations).toBe(false)
    expect(state.diffWordWrap).toBe(false)
    expect(state.diffStyle).toBe("stacked")
    expect(state.confirmArchive).toBe(false)
    expect(state.confirmDelete).toBe(false)
    expect(state.notificationAgent).toBe(false)
    expect(state.notificationPermissions).toBe(false)
    expect(state.notificationErrors).toBe(true)
    expect(state.backendLogLevel).toBe("debug")
    expect(state.backendLogFormat).toBe("json")
    expect(state.backendTraceHttp).toBe(true)
    expect(state.backendTraceProviderEvents).toBe(true)
    expect(state.remoteAccessEnabled).toBe(true)
    expect(state.remoteAccessCustomUrl).toBe("https://code.example.com")
    expect(state.archivedThreadIds).toEqual(["thread-1"])
    expect(updateSettings).toHaveBeenCalledWith({
      enable_assistant_streaming: false,
      show_message_timestamps: false,
      show_thinking_blocks: false,
      show_reasoning_summaries: true,
      show_tool_details: true,
      show_session_progress_bar: false,
      shell_tool_parts_expanded: true,
      edit_tool_parts_expanded: true,
      show_chat_scrollbar: true,
      show_generic_tool_output: true,
      conceal_code_blocks: true,
      auto_save_conversations: false,
      diff_word_wrap: false,
      diff_style: "stacked",
      confirm_archive: false,
      confirm_delete: false,
      notification_agent: false,
      notification_permissions: false,
      notification_errors: true,
      backend_log_level: "debug",
      backend_log_format: "json",
      backend_trace_http: true,
      backend_trace_provider_events: true,
      remote_access_enabled: true,
      remote_access_custom_url: "https://code.example.com",
      archived_thread_ids: ["thread-1"],
    })
  })

  it("reconciles optimistic state from the authoritative server response", async () => {
    vi.mocked(updateSettings).mockResolvedValue({
      theme: "dark",
      diff_style: "auto",
    })

    await useSettingsStore.getState().update({
      theme: "light",
      diff_style: "stacked",
    })

    expect(useSettingsStore.getState()).toMatchObject({
      theme: "dark",
      diffStyle: "auto",
    })
  })

  it.each([true, false])(
    "initializes and updates automatic trust to %s",
    async (enabled) => {
      vi.mocked(getSettings).mockResolvedValue({
        auto_trust_workspaces: !enabled,
      })
      await useSettingsStore.getState().init()
      expect(useSettingsStore.getState().autoTrustWorkspaces).toBe(!enabled)
      vi.mocked(updateSettings).mockResolvedValue({
        auto_trust_workspaces: enabled,
      })
      const pending = useSettingsStore
        .getState()
        .update({ auto_trust_workspaces: enabled })
      expect(useSettingsStore.getState().autoTrustWorkspaces).toBe(enabled)
      await pending
      expect(useSettingsStore.getState().autoTrustWorkspaces).toBe(enabled)
      vi.mocked(updateSettings).mockRejectedValueOnce(
        new Error("storage failed")
      )
      await expect(
        useSettingsStore.getState().update({ auto_trust_workspaces: !enabled })
      ).rejects.toThrow("storage failed")
      expect(useSettingsStore.getState().autoTrustWorkspaces).toBe(enabled)
    }
  )

  it("ignores unknown response fields that collide with store actions and runtime state", async () => {
    const before = useSettingsStore.getState()
    vi.mocked(updateSettings).mockResolvedValue({
      theme: "light",
      update: "corrupted",
      init: null,
      refreshCli: false,
      loaded: true,
      cliStatus: "corrupted",
    })

    await before.update({ theme: "dark" })

    const after = useSettingsStore.getState()
    expect(after.theme).toBe("light")
    expect(after.update).toBe(before.update)
    expect(after.init).toBe(before.init)
    expect(after.refreshCli).toBe(before.refreshCli)
    expect(after.loaded).toBe(false)
    expect(after.cliStatus).toBeNull()
  })

  it("rolls back optimistic state when persistence fails", async () => {
    vi.mocked(updateSettings).mockRejectedValue(new Error("settings rejected"))

    await expect(
      useSettingsStore.getState().update({ diff_style: "stacked" })
    ).rejects.toThrow("settings rejected")

    expect(useSettingsStore.getState().diffStyle).toBe("auto")
  })

  it("handles fire-and-forget save failures once while still rejecting for awaited callers", async () => {
    const error = new Error("settings.json failed validation")
    vi.mocked(updateSettings).mockRejectedValue(error)
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)
    try {
      const pending = useSettingsStore
        .getState()
        .update({ diff_style: "stacked" })
      // Let Node perform its unhandled-rejection check before awaiting the save.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
      expect(handleError).toHaveBeenCalledExactlyOnceWith(error, {
        source: "settings-save",
      })
      expect(useSettingsStore.getState().diffStyle).toBe("auto")
      await expect(pending).rejects.toBe(error)
    } finally {
      process.off("unhandledRejection", unhandled)
    }
  })

  it("does not let an older failed update roll back a newer success", async () => {
    let rejectFirst!: (error: Error) => void
    let resolveSecond!: (value: Record<string, unknown>) => void
    vi.mocked(updateSettings)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      )

    const first = useSettingsStore.getState().update({ diff_style: "stacked" })
    const second = useSettingsStore.getState().update({ diff_style: "auto" })
    resolveSecond({ diff_style: "auto" })
    await second
    rejectFirst(new Error("older request failed late"))
    await expect(first).rejects.toThrow("older request failed late")

    expect(useSettingsStore.getState().diffStyle).toBe("auto")
  })
})
