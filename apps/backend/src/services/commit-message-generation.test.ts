import { beforeEach, describe, expect, it, vi } from "vitest"
import { settingsSchema } from "@betterc0de/schema"
import { ChatLlmHelpers, resolveCommitMessageModelSelections } from "./chat"
import { runNativeTextGeneration } from "./native-text-generation"
import { HttpError } from "../errors"

vi.mock("./native-text-generation", () => ({
  runNativeTextGeneration: vi.fn(),
}))
vi.mock("../auth/keyResolution", () => ({
  resolveAnthropicKey: () => null,
  resolveOpenAiKey: () => null,
}))

beforeEach(() => vi.resetAllMocks())

const input = {
  branch: "main",
  stagedSummary: "- apps/shell/browser-preview-preload.cjs",
  stagedPatch: "diff --git a/preview.js b/preview.js\n+keepSelectionAligned()",
  includeBranch: false,
}

describe("commit generation service", () => {
  it("uses low-effort CLI models even with an outdated stored helper model", () => {
    expect(
      resolveCommitMessageModelSelections(
        settingsSchema.parse({
          text_generation_model_selection: {
            instanceId: "codex",
            model: "gpt-5.4-mini",
          },
          providers: { codex: { enabled: true }, claude: { enabled: true } },
        })
      )
    ).toEqual([
      {
        instanceId: "codex",
        model: "gpt-5.6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
      {
        instanceId: "claude",
        model: "claude-sonnet-5",
        options: [{ id: "effort", value: "low" }],
      },
    ])
  })

  it("keeps a custom CLI account and replaces expensive chat settings", () => {
    const candidates = resolveCommitMessageModelSelections(
      settingsSchema.parse({
        provider_instances: {
          "claude-work": { driver: "claude", enabled: true },
        },
      }),
      {
        instanceId: "claude-work",
        model: "claude-opus-4-7",
        options: [{ id: "effort", value: "max" }],
      }
    )
    expect(candidates[0]).toEqual({
      instanceId: "claude-work",
      model: "claude-sonnet-5",
      options: [{ id: "effort", value: "low" }],
    })
  })

  it.each([
    null,
    '{"subject":"Update files","body":""}',
    new Error("Codex unavailable"),
  ])("tries Claude when Codex returns %s", async (firstResult) => {
    const run = vi.mocked(runNativeTextGeneration)
    if (firstResult instanceof Error) run.mockRejectedValueOnce(firstResult)
    else run.mockResolvedValueOnce(firstResult)
    const message = {
      subject: "Keep selections aligned",
      body: "- Update the selection overlay",
    }
    run.mockResolvedValueOnce(JSON.stringify(message))
    const helpers = new ChatLlmHelpers({
      settings: () =>
        settingsSchema.parse({
          providers: { codex: { enabled: true }, claude: { enabled: true } },
          text_generation_model_selection: {
            instanceId: "betterc0de",
            model: "openai/gpt-5",
          },
        }),
    })
    await expect(helpers.generateCommitMessage(input)).resolves.toEqual(message)
    expect(run.mock.calls.map(([args]) => args.modelSelection?.model)).toEqual([
      "gpt-5.6-luna",
      "claude-sonnet-5",
    ])
    expect(run.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(90_000)
  })

  it("reports disabled CLIs without attempting an API-key provider", async () => {
    const helpers = new ChatLlmHelpers({
      settings: () =>
        settingsSchema.parse({
          providers: {
            codex: { enabled: false },
            claude: { enabled: false },
            betterc0de: { enabled: true },
          },
        }),
    })
    await expect(helpers.generateCommitMessage(input)).rejects.toMatchObject({
      code: "commit_generation_unavailable",
      message: expect.stringContaining("Enable Codex CLI or Claude CLI"),
    })
    expect(runNativeTextGeneration).not.toHaveBeenCalled()
  })

  it("returns an actionable failure instead of the first filename when the provider fails", async () => {
    vi.mocked(runNativeTextGeneration).mockRejectedValue(
      new Error("Provider unavailable")
    )
    const helpers = new ChatLlmHelpers({
      settings: () => settingsSchema.parse({}),
    })
    await expect(helpers.generateCommitMessage(input)).rejects.toMatchObject({
      statusCode: 422,
      code: "commit_generation_unavailable",
    })
  })

  it("returns a subject and detailed body from the configured provider", async () => {
    const message = {
      subject: "Keep browser selections aligned",
      body: "- Reposition the selection overlay when scrolling\n- Preserve element details while inspecting",
    }
    vi.mocked(runNativeTextGeneration).mockResolvedValue(
      JSON.stringify(message)
    )
    const helpers = new ChatLlmHelpers({
      settings: () => settingsSchema.parse({}),
    })
    await expect(helpers.generateCommitMessage(input)).resolves.toEqual(message)
    expect(
      vi.mocked(runNativeTextGeneration).mock.calls[0][0].prompt
    ).toContain("Always include a non-empty body")
  })

  it("rejects an empty generated body as a public error", async () => {
    vi.mocked(runNativeTextGeneration).mockResolvedValue(
      '{"subject":"Update files","body":""}'
    )
    const helpers = new ChatLlmHelpers({
      settings: () => settingsSchema.parse({}),
    })
    await expect(helpers.generateCommitMessage(input)).rejects.toBeInstanceOf(
      HttpError
    )
  })
})
