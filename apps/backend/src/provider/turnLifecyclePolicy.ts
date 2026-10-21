import type { ProviderRuntimeEvent } from "./runtime/contracts"
import { canonicalToLegacy } from "./runtime/legacyBridge"
import type { LegacyProviderEvent } from "./types"

/** What the trust gate sees immediately before a provider receives a turn. */
export interface TurnLifecycleDispatchInput {
  readonly threadId: string
  readonly turnId: string
  readonly projectPath?: string | null
  readonly appMode?: string | null
  /** A legacy (`anthropic`, …) or a hub (`claude`, …) provider kind. */
  readonly providerKind: string
  /** Set by the provider hub; the direct-API stack has no instances. */
  readonly providerInstanceId?: string
}

/** A denial is emitted as `tool.denied` and completes the turn normally. */
export type TurnLifecycleDispatchDecision =
  | { readonly decision: "allow" }
  | {
      readonly decision: "deny"
      readonly reason: string
      readonly toolName?: string
    }

/**
 * The hooks every provider turn runs, whichever stack owns it: the
 * checkpoint baseline and turn-slot admission before dispatch, the workspace
 * trust gate right before the adapter, and checkpoint finalization after the
 * terminal event. Bootstrap builds one of these and hands the same object to
 * the provider hub and to the direct-API `ProviderService`, so the two stacks
 * can no longer be wired with different hooks.
 *
 * It speaks the legacy event shape because its consumer, the checkpoint
 * reactor, does. Each stack adapts its own vocabulary: `ProviderService`
 * already produces legacy events; the hub goes through
 * {@link hubTurnLifecycleHooks}.
 */
export interface TurnLifecyclePolicy {
  /**
   * Runs before the provider sees the turn, with the synthetic legacy
   * `turn_started` event. A rejection refuses the turn.
   */
  readonly beforeTurn: (event: LegacyProviderEvent) => Promise<void>
  /** Workspace trust gate, immediately before the adapter dispatch. */
  readonly preDispatchPolicy: (
    input: TurnLifecycleDispatchInput
  ) => TurnLifecycleDispatchDecision | Promise<TurnLifecycleDispatchDecision>
  /** Runs once per terminal event (completed, error, interrupted). */
  readonly afterTurn: (event: LegacyProviderEvent) => Promise<void>
}

/** The hub's view of a turn that is about to be dispatched. */
export interface HubTurnLifecycleStart {
  readonly threadId: string
  readonly turnId: string
  readonly projectPath?: string | null
  readonly providerKind: string
  readonly providerInstanceId: string
}

/**
 * The policy in the provider hub's own vocabulary: a structured start input
 * instead of the legacy `turn_started` event, and the canonical terminal
 * event, bridged to the legacy shape here. A canonical event without a
 * legacy counterpart has nothing to finalize and is skipped.
 */
export function hubTurnLifecycleHooks(policy: TurnLifecyclePolicy): {
  readonly beforeTurn: (input: HubTurnLifecycleStart) => Promise<void>
  readonly preDispatchPolicy: TurnLifecyclePolicy["preDispatchPolicy"]
  readonly afterTurn: (event: ProviderRuntimeEvent) => Promise<void>
} {
  return {
    beforeTurn: (input) =>
      policy.beforeTurn({
        event_type: "turn_started",
        thread_id: input.threadId,
        payload: {
          turn_id: input.turnId,
          dispatchTurnId: input.turnId,
          provider_kind: input.providerKind,
          provider_instance_id: input.providerInstanceId,
          ...(input.projectPath ? { project_path: input.projectPath } : {}),
        },
      }),
    preDispatchPolicy: (input) => policy.preDispatchPolicy(input),
    afterTurn: async (event) => {
      const legacy = canonicalToLegacy(event)
      if (legacy) await policy.afterTurn(legacy)
    },
  }
}
