import { describe, expect, it } from "vitest"
import type { ProviderRuntimeEvent } from "./runtime/contracts"
import { canonicalToLegacy } from "./runtime/legacyBridge"
import {
  hubTurnLifecycleHooks,
  type TurnLifecycleDispatchInput,
  type TurnLifecyclePolicy,
} from "./turnLifecyclePolicy"
import type { LegacyProviderEvent } from "./types"

function recordingPolicy(): {
  readonly policy: TurnLifecyclePolicy
  readonly before: LegacyProviderEvent[]
  readonly dispatch: TurnLifecycleDispatchInput[]
  readonly after: LegacyProviderEvent[]
} {
  const before: LegacyProviderEvent[] = []
  const dispatch: TurnLifecycleDispatchInput[] = []
  const after: LegacyProviderEvent[] = []
  return {
    before,
    dispatch,
    after,
    policy: {
      beforeTurn: async (event) => {
        before.push(event)
      },
      preDispatchPolicy: (input) => {
        dispatch.push(input)
        return { decision: "deny", reason: "untrusted", toolName: "AgentMode" }
      },
      afterTurn: async (event) => {
        after.push(event)
      },
    },
  }
}

function canonical(event: Record<string, unknown>): ProviderRuntimeEvent {
  return {
    threadId: "thread-1",
    providerKind: "codex",
    providerInstanceId: "codex-work",
    eventId: "event-1",
    at: 1,
    ...event,
  } as unknown as ProviderRuntimeEvent
}

describe("hubTurnLifecycleHooks", () => {
  it("hands the policy the synthetic legacy turn_started the hub used to build", async () => {
    const recorded = recordingPolicy()
    const hooks = hubTurnLifecycleHooks(recorded.policy)

    await hooks.beforeTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      projectPath: "/repo",
      providerKind: "codex",
      providerInstanceId: "codex-work",
    })
    await hooks.beforeTurn({
      threadId: "thread-2",
      turnId: "turn-2",
      projectPath: null,
      providerKind: "claude",
      providerInstanceId: "claude",
    })

    expect(recorded.before).toEqual([
      {
        event_type: "turn_started",
        thread_id: "thread-1",
        payload: {
          turn_id: "turn-1",
          dispatchTurnId: "turn-1",
          provider_kind: "codex",
          provider_instance_id: "codex-work",
          project_path: "/repo",
        },
      },
      {
        event_type: "turn_started",
        thread_id: "thread-2",
        payload: {
          turn_id: "turn-2",
          dispatchTurnId: "turn-2",
          provider_kind: "claude",
          provider_instance_id: "claude",
        },
      },
    ])
  })

  it("passes the dispatch gate through unchanged", () => {
    const recorded = recordingPolicy()
    const hooks = hubTurnLifecycleHooks(recorded.policy)
    const input = {
      threadId: "thread-1",
      turnId: "turn-1",
      projectPath: "/repo",
      appMode: "agent",
      providerKind: "codex",
      providerInstanceId: "codex-work",
    } as const

    expect(hooks.preDispatchPolicy(input)).toEqual({
      decision: "deny",
      reason: "untrusted",
      toolName: "AgentMode",
    })
    expect(recorded.dispatch).toEqual([input])
  })

  it("bridges the canonical terminal event and skips events with no legacy form", async () => {
    const recorded = recordingPolicy()
    const hooks = hubTurnLifecycleHooks(recorded.policy)
    const completed = canonical({
      type: "turn.completed",
      turnId: "turn-1",
      payload: { state: "completed", dispatchTurnId: "turn-1" },
    })
    const unbridged = canonical({
      type: "content.replace",
      turnId: "turn-1",
      streamKind: "plan_text",
      text: "plan",
    })
    expect(canonicalToLegacy(unbridged)).toBeNull()

    await hooks.afterTurn(completed)
    await hooks.afterTurn(unbridged)

    expect(recorded.after).toEqual([canonicalToLegacy(completed)])
    expect(recorded.after[0]?.event_type).toBe("turn_completed")
  })
})
