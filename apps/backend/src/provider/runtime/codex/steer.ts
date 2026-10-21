import type { ProviderSteerTurnResult } from "../contracts"

/** A `turn/steer` that did not reach the turn, and why. */
export type CodexSteerRefusal = Exclude<
  ProviderSteerTurnResult,
  { readonly status: "steered" }
>

/**
 * Reads the error of a refused `turn/steer` call (app-server v2). `null`
 * for an error that is not a refusal, such as a lost connection or a
 * timeout: the caller reports that as a failure.
 *
 * - The turn ended meanwhile: "no active turn to steer", or the request's
 *   `expectedTurnId` no longer matches the active turn.
 * - Review and compaction turns take no input.
 * - An app-server older than the method answers "method not found", or
 *   cannot parse the request as a method it knows.
 */
export function classifyCodexSteerError(
  message: string
): CodexSteerRefusal | null {
  if (/no active turn to steer|expected active turn id/i.test(message)) {
    return {
      status: "not_running",
      reason: "The turn ended before the message arrived.",
    }
  }
  if (
    /cannot steer a (?:review|compact) turn|not[- ]steerable/i.test(message)
  ) {
    return {
      status: "not_steerable",
      reason: "The current step takes no messages.",
    }
  }
  if (
    /-32601|method not found|unknown (?:variant|method)[\s\S]*?turn\/steer|requires? (?:the )?experimental/i.test(
      message
    )
  ) {
    return {
      status: "unsupported",
      reason: "This Codex version cannot take messages during a turn.",
    }
  }
  return null
}
