/**
 * What sending does while the agent works, as plain decisions and copy for
 * the composer, the queue and Settings. The steering itself (stores and
 * requests) is `steer-turn.ts`.
 *
 * Steering puts a message into the running turn so the agent changes course.
 * Codex takes it natively (`turn/steer`). Other agents cannot take input in
 * the middle of a turn: for them steering stops the current step and sends
 * the message as the next turn, and the copy says so.
 */

/** What Enter does while a turn runs (`settings.while_working_enter`). */
export type WhileWorkingDelivery = "queue" | "steer"

/** `native`: the turn takes the message; `interrupt`: the turn is stopped first. */
export type SteerMode = "native" | "interrupt"

/** Which provider a steer (or its fallback interrupt) goes to. */
export interface SteerTarget {
  providerKind: string
  providerInstanceId: string | null
}

/** Provider kinds whose running turn takes a message directly. */
const NATIVE_STEER_PROVIDER_KINDS = new Set(["codex", "codexcli"])

export function steerModeForProvider(
  providerKind: string | null | undefined
): SteerMode {
  const key = (providerKind ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "")
  return NATIVE_STEER_PROVIDER_KINDS.has(key) ? "native" : "interrupt"
}

/**
 * The provider of the chat's running turn, resolved the way Stop resolves
 * it (the composer's provider), with the backend session as the fallback.
 */
export function steerTargetFor(
  provider:
    | {
        id?: string
        providerKind?: string
        providerInstanceId?: string
      }
    | null
    | undefined,
  session?: {
    providerKind?: string | null
    providerInstanceId?: string | null
  } | null
): SteerTarget {
  return {
    providerKind:
      provider?.providerKind ??
      provider?.id ??
      session?.providerKind ??
      "openai",
    providerInstanceId:
      provider?.providerInstanceId ?? session?.providerInstanceId ?? null,
  }
}

/**
 * Whether a queued message can go into a running turn. Commands and
 * messages that change the turn itself (a mode, a plan to implement, an
 * Autonomous Work run) wait for the next turn instead.
 */
export function canSteerPayload(payload: {
  text: string
  chatModeOverride?: string | null
  sourceProposedPlan?: unknown
  autonomy?: unknown
}): boolean {
  return (
    !payload.text.trim().startsWith("/") &&
    !payload.chatModeOverride &&
    !payload.sourceProposedPlan &&
    !payload.autonomy
  )
}

/** The delivery Ctrl/Cmd+Enter picks: the one Enter does not. */
export function alternateDelivery(
  delivery: WhileWorkingDelivery
): WhileWorkingDelivery {
  return delivery === "steer" ? "queue" : "steer"
}

/** Ctrl+Enter, or ⌘Enter on a Mac. */
export function modifierEnterLabel(
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform
): string {
  return /mac|iphone|ipad/i.test(platform) ? "⌘Enter" : "Ctrl+Enter"
}

/** One line on what steering does with this provider. */
export function steerDescription(mode: SteerMode): string {
  return mode === "native"
    ? "Sends into the running turn now"
    : "Stops the current step and sends now"
}

export interface DeliveryCopy {
  delivery: WhileWorkingDelivery
  /** Accessible name of the send button. */
  label: string
  /** What the button (and Enter) does. */
  description: string
  /** What Ctrl/Cmd+Enter does instead. */
  alternate: string
}

/** Copy for the send button while a turn runs. */
export function whileWorkingDeliveryCopy(
  delivery: WhileWorkingDelivery,
  mode: SteerMode,
  platform?: string
): DeliveryCopy {
  const other = alternateDelivery(delivery)
  return {
    delivery,
    label: delivery === "steer" ? "Steer now" : "Queue message",
    description:
      delivery === "steer"
        ? steerDescription(mode)
        : "Sends after the current turn",
    alternate: `${modifierEnterLabel(platform)}: ${
      other === "steer"
        ? mode === "native"
          ? "steer now"
          : "stop the step and send now"
        : "queue instead"
    }`,
  }
}
