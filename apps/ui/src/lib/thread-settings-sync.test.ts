import type { ThreadSettings as StoredThreadSettings } from "@betterc0de/schema"
import { describe, expect, it, vi } from "vitest"
import type { ThreadSettings } from "@/lib/chat/types"
import { updateThreadSettings } from "@/services/backend/coreApi"
import {
  applyThreadSettingsChange,
  mergeStoredThreadSettings,
  queueThreadSettingsChange,
  storedThreadSettingsChange,
  threadSettingsChange,
  unsettledThreadSettingKeys,
} from "./thread-settings-sync"

vi.mock("@/services/backend/coreApi", () => ({
  updateThreadSettings: vi.fn().mockResolvedValue(undefined),
}))

describe("the change the backend hears", () => {
  it("covers only the settings the backend keeps with a chat", () => {
    expect(
      threadSettingsChange(
        { chatMode: "agent", permissionLevel: "ask-on-edit" },
        { chatMode: "plan", permissionLevel: "ask-on-edit" }
      )
    ).toBeNull()
  })

  it("sets changed keys and clears removed or emptied ones", () => {
    expect(
      threadSettingsChange(
        {
          permissionLevel: "ask-on-edit",
          selectedModel: "gpt-5.5",
          selectedProviderId: "codex-main",
        },
        {
          permissionLevel: "bypass",
          selectedModel: "",
          orchestration: { enabled: false },
        }
      )
    ).toEqual({
      permissionLevel: "bypass",
      selectedModel: null,
      selectedProviderId: null,
      orchestration: { enabled: false },
    })
  })

  it("sees an equal model selection as unchanged", () => {
    const selection = {
      "codex-main": { selectedModel: "gpt-5.5", fastMode: true },
    }
    expect(
      threadSettingsChange(
        { modelSelectionByProvider: selection },
        { modelSelectionByProvider: { ...selection } }
      )
    ).toBeNull()
  })

  it("keeps a chat's compare group with the chat", () => {
    expect(
      threadSettingsChange(
        { selectedModel: "gpt-5.5" },
        { selectedModel: "gpt-5.5", compareGroupId: "group-1" }
      )
    ).toEqual({ compareGroupId: "group-1" })
  })
})

describe("the backend's copy on load", () => {
  const listed = (
    id: string,
    settings?: StoredThreadSettings | null
  ): { id: string; settings?: StoredThreadSettings | null } => ({
    id,
    ...(settings !== undefined ? { settings } : {}),
  })

  it("wins over the cache, and moves what only the cache has to the backend", () => {
    const local: Record<string, ThreadSettings> = {
      "thread-1": {
        chatMode: "plan",
        permissionLevel: "ask-on-edit",
        selectedModel: "gpt-5.5",
      },
    }
    const { settingsByThread, migrations } = mergeStoredThreadSettings(
      local,
      [listed("thread-1", { permissionLevel: "allow-edits" })],
      local
    )
    expect(settingsByThread["thread-1"]).toEqual({
      chatMode: "plan",
      permissionLevel: "allow-edits",
      selectedModel: "gpt-5.5",
    })
    expect(migrations).toEqual([["thread-1", { selectedModel: "gpt-5.5" }]])
  })

  it("moves a chat's cached settings to the backend when it keeps none yet", () => {
    const local: Record<string, ThreadSettings> = {
      "thread-1": { permissionLevel: "read-only", designPreviewUrl: "x" },
    }
    const { settingsByThread, migrations } = mergeStoredThreadSettings(
      local,
      [listed("thread-1")],
      local
    )
    expect(settingsByThread).toBe(local)
    expect(migrations).toEqual([["thread-1", { permissionLevel: "read-only" }]])
  })

  it("leaves a chat changed while the list was loading to its own write", () => {
    const before: Record<string, ThreadSettings> = {
      "thread-1": { permissionLevel: "ask-on-edit" },
    }
    const current: Record<string, ThreadSettings> = {
      "thread-1": { permissionLevel: "bypass" },
    }
    const { settingsByThread, migrations } = mergeStoredThreadSettings(
      current,
      [listed("thread-1", { permissionLevel: "read-only" })],
      before
    )
    expect(settingsByThread).toBe(current)
    expect(migrations).toEqual([])
  })

  it("takes the backend's settings for a chat the cache does not know", () => {
    const { settingsByThread, migrations } = mergeStoredThreadSettings(
      {},
      [listed("thread-2", { selectedProviderId: "claude-main" })],
      {}
    )
    expect(settingsByThread).toEqual({
      "thread-2": { selectedProviderId: "claude-main" },
    })
    expect(migrations).toEqual([])
  })
})

describe("a change from another client", () => {
  const selection = {
    "codex-main": { selectedModel: "gpt-5.5", fastMode: true },
  }

  it("sets the keys the backend keeps, clears the ones it dropped, and keeps the rest", async () => {
    const change = await storedThreadSettingsChange({
      permissionLevel: "allow-edits",
      selectedModel: "gpt-5.5",
      modelSelectionByProvider: selection,
    })
    expect(change).toEqual({
      permissionLevel: "allow-edits",
      selectedModel: "gpt-5.5",
      modelSelectionByProvider: selection,
      selectedProviderId: null,
      orchestration: null,
      compareGroupId: null,
    })
    expect(
      applyThreadSettingsChange(
        {
          chatMode: "plan",
          permissionLevel: "ask-on-edit",
          selectedProviderId: "codex-main",
        },
        change,
        new Set()
      )
    ).toEqual({
      chatMode: "plan",
      permissionLevel: "allow-edits",
      selectedModel: "gpt-5.5",
      modelSelectionByProvider: selection,
    })
  })

  it("leaves out a value this window cannot read", async () => {
    const change = await storedThreadSettingsChange({
      permissionLevel: "",
      modelSelectionByProvider: "not a selection",
    })
    expect(change).not.toHaveProperty("permissionLevel")
    expect(change).not.toHaveProperty("modelSelectionByProvider")
    expect(
      applyThreadSettingsChange(
        { permissionLevel: "read-only", modelSelectionByProvider: selection },
        change,
        new Set()
      )
    ).toBeNull()
  })

  it("changes nothing when this copy already matches", () => {
    expect(
      applyThreadSettingsChange(
        { permissionLevel: "bypass", modelSelectionByProvider: selection },
        {
          permissionLevel: "bypass",
          modelSelectionByProvider: { ...selection },
          selectedModel: null,
        },
        new Set()
      )
    ).toBeNull()
  })

  it("keeps this window's own change until its write is done", async () => {
    vi.useFakeTimers()
    try {
      queueThreadSettingsChange("thread-own", { permissionLevel: "bypass" })
      const unsettled = unsettledThreadSettingKeys("thread-own")
      expect([...unsettled]).toEqual(["permissionLevel"])
      expect(
        applyThreadSettingsChange(
          { permissionLevel: "bypass" },
          { permissionLevel: "read-only", selectedModel: "gpt-5.5" },
          unsettled
        )
      ).toEqual({ permissionLevel: "bypass", selectedModel: "gpt-5.5" })
      await vi.advanceTimersByTimeAsync(500)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() =>
      expect(unsettledThreadSettingKeys("thread-own").size).toBe(0)
    )
    expect(updateThreadSettings).toHaveBeenCalledWith("thread-own", {
      permissionLevel: "bypass",
    })
  })
})
