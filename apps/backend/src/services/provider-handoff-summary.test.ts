import { beforeEach, describe, expect, it, vi } from "vitest"
import { defaultSettings } from "@betterc0de/schema"
import { ChatLlmHelpers } from "./chat"
import type { NativeTextGenerator } from "./native-text-generation"

/** The backend's native text generations: a fake the tests drive. */
const runNativeTextGeneration = vi.fn<NativeTextGenerator["run"]>()
const nativeTextGeneration = { run: runNativeTextGeneration }
beforeEach(() => vi.clearAllMocks())

describe("provider handoff summary routing", () => {
  const input = {
    transcript: "Keep API stable. Tests passed. Next: fix retries.",
    targetProvider: "grok_cli",
    projectPath: "/private/repository",
    modelSelection: {
      instanceId: "codex-personal",
      model: "last-selected-model",
    },
  }

  it("uses exactly the source instance/model, in isolation, and names the actual target", async () => {
    vi.mocked(runNativeTextGeneration).mockResolvedValue(
      '{"summary":"Keep API stable; implement retries next."}'
    )
    const helper = new ChatLlmHelpers({
      settings: defaultSettings,
      nativeTextGeneration,
    })
    await expect(helper.generateProviderHandoffSummary(input)).resolves.toEqual(
      { summary: "Keep API stable; implement retries next." }
    )
    expect(runNativeTextGeneration).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        modelSelection: input.modelSelection,
        cwd: null,
        schemaName: "threadContextSummary",
        prompt: expect.stringContaining("so grok_cli can continue"),
      })
    )
    expect(
      vi.mocked(runNativeTextGeneration).mock.calls[0]?.[0].prompt
    ).not.toContain("fresh Claude Terminal")
  })

  it.each([null, "", '{"summary":""}'])(
    "rejects empty/unavailable output without switching to a fallback model",
    async (output) => {
      vi.mocked(runNativeTextGeneration).mockResolvedValue(output)
      await expect(
        new ChatLlmHelpers({
          settings: defaultSettings,
          nativeTextGeneration,
        }).generateProviderHandoffSummary(input)
      ).rejects.toThrow("no handoff summary")
      expect(runNativeTextGeneration).toHaveBeenCalledTimes(1)
    }
  )

  it("propagates source-provider failure without retrying another provider", async () => {
    vi.mocked(runNativeTextGeneration).mockRejectedValue(
      new Error("source unavailable")
    )
    await expect(
      new ChatLlmHelpers({
        settings: defaultSettings,
        nativeTextGeneration,
      }).generateProviderHandoffSummary(input)
    ).rejects.toThrow("source unavailable")
    expect(runNativeTextGeneration).toHaveBeenCalledTimes(1)
  })
})
