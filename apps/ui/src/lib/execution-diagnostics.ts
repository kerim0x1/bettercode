// Shared with the phone app's live tool steps.
export { toolFailureText } from "@betterc0de/schema/activity-tools"

/** Read the provider's documented error fields, never stringify an entire payload. */
/** Runtime payloads deliberately omit raw diagnostics, which can contain credentials. */
export function runtimeFailurePresentation(payload: Record<string, unknown>): {
  label: string
  detail: string
  diagnostics?: string
} {
  const labels: Record<string, string> = {
    transport_error: "Connection to provider failed",
    provider_error: "Provider could not complete the request",
    auth_error: "Provider authentication failed",
    authentication_error: "Provider authentication failed",
    rate_limit: "Provider rate limit reached",
    timeout: "Provider request timed out",
  }
  const category =
    typeof payload.class === "string" &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(payload.class)
      ? payload.class
      : undefined
  const eventId =
    typeof payload.event_id === "string" ? payload.event_id : undefined
  const detail =
    payload.willRetry === true
      ? "The provider is retrying this request."
      : payload.willRetry === false
        ? "The provider will not retry automatically. Check its connection and settings before trying again."
        : "Check the provider connection and settings. No further public error details were supplied."
  return {
    label: (category && labels[category]) || "Provider reported an error",
    detail,
    diagnostics:
      [category && `Type: ${category}`, eventId && `Event: ${eventId}`]
        .filter(Boolean)
        .join("\n") || undefined,
  }
}
