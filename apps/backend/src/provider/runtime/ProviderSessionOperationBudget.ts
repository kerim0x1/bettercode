import { logger } from "../../observability/logger"

// ACP startup includes a child spawn, authentication and session setup. Its
// RPC calls can each wait longer than the short turn-interruption budget.
const ACP_SESSION_START_TIMEOUT_MS = 75_000
const ACP_SESSION_STOP_TIMEOUT_MS = 15_000

export function get(
  instance: { readonly driver: string },
  label: string,
  interruptTimeoutMs: number
): number {
  const acp = instance.driver === "cursor" || instance.driver === "grok-cli"
  if (acp && label === "startSession") {
    return Math.max(interruptTimeoutMs, ACP_SESSION_START_TIMEOUT_MS)
  }
  if (acp && label === "stopSession") {
    return Math.max(interruptTimeoutMs, ACP_SESSION_STOP_TIMEOUT_MS)
  }
  return interruptTimeoutMs
}

export function logDeadline(
  instance: { readonly instanceId: string; readonly driver: string },
  operation: string,
  timeoutMs: number
): void {
  logger.warn(
    {
      providerInstanceId: instance.instanceId,
      driver: instance.driver,
      operation,
      timeoutMs,
    },
    "provider session operation exceeded its deadline"
  )
}
