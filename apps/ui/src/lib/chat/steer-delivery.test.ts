import { describe, expect, it } from "vitest"
import {
  alternateDelivery,
  canSteerPayload,
  modifierEnterLabel,
  steerModeForProvider,
  steerTargetFor,
  whileWorkingDeliveryCopy,
} from "./steer-delivery"

describe("steering modes", () => {
  it("steers Codex natively and stops the turn for every other agent", () => {
    expect(steerModeForProvider("codex")).toBe("native")
    expect(steerModeForProvider("codex_cli")).toBe("native")
    expect(steerModeForProvider("Codex-CLI")).toBe("native")
    expect(steerModeForProvider("claude")).toBe("interrupt")
    expect(steerModeForProvider("cursor")).toBe("interrupt")
    expect(steerModeForProvider(null)).toBe("interrupt")
  })

  it("targets the composer's provider like Stop, then the chat's session", () => {
    expect(
      steerTargetFor(
        { id: "codex-work", providerKind: "codex", providerInstanceId: "work" },
        { providerKind: "claude", providerInstanceId: "claude" }
      )
    ).toEqual({ providerKind: "codex", providerInstanceId: "work" })
    expect(steerTargetFor({ id: "my-plugin" })).toEqual({
      providerKind: "my-plugin",
      providerInstanceId: null,
    })
    expect(
      steerTargetFor(undefined, {
        providerKind: "codex",
        providerInstanceId: "codex",
      })
    ).toEqual({ providerKind: "codex", providerInstanceId: "codex" })
  })
})

describe("what can be steered", () => {
  it("keeps commands and turn-changing drafts for the next turn", () => {
    expect(canSteerPayload({ text: "Use the v2 endpoint instead" })).toBe(true)
    expect(canSteerPayload({ text: "  /review" })).toBe(false)
    expect(canSteerPayload({ text: "Plan", chatModeOverride: "plan" })).toBe(
      false
    )
    expect(
      canSteerPayload({ text: "Implement", sourceProposedPlan: { id: "p" } })
    ).toBe(false)
    expect(canSteerPayload({ text: "Run", autonomy: { tasks: [] } })).toBe(
      false
    )
  })
})

describe("send button copy while a turn runs", () => {
  it("names Enter's action and what the modifier does instead", () => {
    expect(alternateDelivery("queue")).toBe("steer")
    expect(alternateDelivery("steer")).toBe("queue")
    expect(whileWorkingDeliveryCopy("queue", "native", "Win32")).toEqual({
      delivery: "queue",
      label: "Queue message",
      description: "Sends after the current turn",
      alternate: "Ctrl+Enter: steer now",
    })
    expect(whileWorkingDeliveryCopy("steer", "interrupt", "MacIntel")).toEqual({
      delivery: "steer",
      label: "Steer now",
      description: "Stops the current step and sends now",
      alternate: "⌘Enter: queue instead",
    })
    expect(
      whileWorkingDeliveryCopy("queue", "interrupt", "Linux").alternate
    ).toBe("Ctrl+Enter: stop the step and send now")
  })

  it("uses the Mac modifier only on a Mac", () => {
    expect(modifierEnterLabel("MacIntel")).toBe("⌘Enter")
    expect(modifierEnterLabel("Win32")).toBe("Ctrl+Enter")
  })
})
