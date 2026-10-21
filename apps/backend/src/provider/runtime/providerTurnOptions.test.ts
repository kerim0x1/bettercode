import { describe, expect, it } from "vitest"
import {
  resolveTurnBooleanOption,
  resolveTurnModelId,
  resolveTurnStringOption,
  runtimeModeForTurn,
} from "./providerTurnOptions"
import type { ProviderSendTurnInput } from "./contracts"

function input(patch: Partial<ProviderSendTurnInput>): ProviderSendTurnInput {
  return {
    threadId: "thread-1",
    message: "Build it",
    modelId: "legacy-model",
    history: [],
    ...patch,
  }
}

describe("provider turn option resolution", () => {
  it("prefers modelSelection.model over legacy modelId", () => {
    expect(
      resolveTurnModelId(
        input({
          modelSelection: { instanceId: "codex", model: "selected-model" },
        })
      )
    ).toBe("selected-model")
  })

  it("normalizes legacy model aliases before dispatch", () => {
    expect(
      resolveTurnModelId(
        input({
          modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
        })
      )
    ).toBe("gpt-5.4")
    expect(
      resolveTurnModelId(
        input({
          modelSelection: { instanceId: "claude", model: "opus-4.7" },
        })
      )
    ).toBe("claude-opus-4-7")
  })

  it("prefers modelSelection string options over legacy fields", () => {
    expect(
      resolveTurnStringOption(
        input({
          reasoningEffort: "low",
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.5",
            options: [{ id: "effort", value: "xhigh" }],
          },
        }),
        "effort",
        "low"
      )
    ).toBe("xhigh")
  })

  it("tries BetterC0de option ids before legacy aliases", () => {
    expect(
      resolveTurnStringOption(
        input({
          reasoningEffort: "low",
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.5",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        }),
        ["reasoningEffort", "effort"],
        "low"
      )
    ).toBe("high")
  })

  it("preserves explicit false boolean selections instead of falling back", () => {
    expect(
      resolveTurnBooleanOption(
        input({
          fastMode: true,
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.5",
            options: [{ id: "fastMode", value: false }],
          },
        }),
        "fastMode",
        true
      )
    ).toBe(false)
  })
})

describe("runtimeModeForTurn", () => {
  it("maps permission levels through the shared alias table", () => {
    // The old "Full Access" picker label means allow-edits, never bypass.
    expect(runtimeModeForTurn({ permissionLevel: "full-access" })).toBe(
      "auto-accept-edits"
    )
    expect(runtimeModeForTurn({ permissionLevel: "full" })).toBe(
      "auto-accept-edits"
    )
    expect(runtimeModeForTurn({ permissionLevel: "bypass" })).toBe(
      "full-access"
    )
    expect(runtimeModeForTurn({ permissionLevel: "read" })).toBe("read-only")
    expect(runtimeModeForTurn({ permissionLevel: "ask" })).toBe(
      "approval-required"
    )
  })

  it("fails closed for unknown spellings and keeps the caller default when unset", () => {
    expect(runtimeModeForTurn({ permissionLevel: "everything" })).toBe(
      "approval-required"
    )
    expect(runtimeModeForTurn({})).toBeUndefined()
    expect(runtimeModeForTurn({ permissionLevel: "default" })).toBeUndefined()
  })

  it("lets interaction modes win over the level", () => {
    expect(
      runtimeModeForTurn({ chatMode: "plan", permissionLevel: "bypass" })
    ).toBe("plan")
    expect(
      runtimeModeForTurn({ chatMode: "ask", permissionLevel: "bypass" })
    ).toBe("read-only")
  })
})
