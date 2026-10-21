import { HttpError } from "../../errors"
import type { ProviderKind } from "./contracts"
import { ProviderUpdateError } from "./ProviderMaintenanceCoordinator"
import { isProviderChatModeUnsupportedError } from "./providerChatModeErrors"

// Errors the provider hub and the modules it is split into raise. The public
// ones keep their identity: ProviderHub.ts re-exports these same classes.

export class ProviderTurnConflictError extends Error {
  readonly statusCode = 409
  readonly code = "turn_active"
  readonly activeTurnId: string

  constructor(threadId: string, activeTurnId: string) {
    super(`Thread '${threadId}' already has an active provider turn.`)
    this.name = "ProviderTurnConflictError"
    this.activeTurnId = activeTurnId
  }
}

export type ProviderCapacityScope = "global" | "provider" | "instance"

export class ProviderTurnCapacityError extends Error {
  readonly statusCode = 503
  readonly code = "provider_turn_capacity"

  constructor(
    readonly scope: ProviderCapacityScope,
    readonly limit: number
  ) {
    super(`Provider ${scope} active-turn capacity of ${limit} is exhausted.`)
    this.name = "ProviderTurnCapacityError"
  }
}

export class ProviderSessionCapacityError extends Error {
  readonly statusCode = 503
  readonly code = "provider_session_capacity"

  constructor(
    readonly scope: "global" | "instance" | "retained_backend",
    readonly limit: number | null = null
  ) {
    super(
      scope === "retained_backend"
        ? "Cannot create a provider session while a backend is quarantined or retiring."
        : `Provider ${scope} live-session capacity of ${limit} is exhausted.`
    )
    this.name = "ProviderSessionCapacityError"
  }
}

export class ProviderSessionInspectionError extends Error {
  readonly statusCode = 503
  readonly code = "provider_session_inspection_failed"
  readonly inspectionCause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "ProviderSessionInspectionError"
    this.inspectionCause = cause
  }
}

export class ProviderSessionAdmissionCapacityError extends Error {
  readonly statusCode = 503
  readonly code = "provider_session_admission_capacity"

  constructor(readonly limit: number) {
    super(`Provider session-admission queue capacity of ${limit} is exhausted.`)
    this.name = "ProviderSessionAdmissionCapacityError"
  }
}

export class ProviderStaleSessionCleanupError extends Error {
  readonly statusCode = 503
  readonly code = "provider_stale_session_cleanup_failed"
  readonly cleanupCause: unknown

  constructor(
    readonly instanceId: string,
    readonly threadId: string,
    cause: unknown
  ) {
    super("Provider session cleanup could not be completed.")
    this.name = "ProviderStaleSessionCleanupError"
    this.cleanupCause = cause
  }
}

export class ProviderInstanceUnavailableError extends Error {
  readonly statusCode = 404
  readonly code = "provider_instance_not_found"

  constructor(provider: ProviderKind, instanceId?: string | null) {
    super(
      instanceId
        ? `Provider instance '${instanceId}' is not available for '${provider}'.`
        : `Provider '${provider}' is not available.`
    )
    this.name = "ProviderInstanceUnavailableError"
  }
}

export class ProviderBackendQuarantinedError extends Error {
  readonly statusCode = 503
  readonly code = "provider_backend_quarantined"

  constructor(
    readonly instanceId: string,
    readonly quarantinedAt: number,
    _reason: string
  ) {
    super("Provider backend is temporarily unavailable.")
    this.name = "ProviderBackendQuarantinedError"
  }
}

export class ProviderOperationDeadlineError extends Error {
  readonly code = "provider_operation_deadline"

  constructor(message: string) {
    super(message)
    this.name = "ProviderOperationDeadlineError"
  }
}

export class ProviderTurnDispatchCancelledError extends Error {
  constructor(readonly turnId: string) {
    super(`Provider turn '${turnId}' was cancelled before dispatch completed.`)
    this.name = "ProviderTurnDispatchCancelledError"
  }
}

export class ProviderTurnDispatchInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderTurnDispatchInputError"
  }
}

export function promiseWithDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const pending = Promise.resolve().then(operation)
  return new Promise<T>((resolve, reject) => {
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      settle()
    }
    timer = setTimeout(() => {
      finish(() => reject(new ProviderOperationDeadlineError(message)))
    }, timeoutMs)
    timer.unref?.()
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

export function publicProviderDispatchErrorMessage(error: unknown): string {
  if (
    error instanceof HttpError ||
    error instanceof ProviderSessionInspectionError ||
    error instanceof ProviderSessionCapacityError ||
    error instanceof ProviderSessionAdmissionCapacityError ||
    error instanceof ProviderTurnDispatchInputError ||
    error instanceof ProviderStaleSessionCleanupError ||
    error instanceof ProviderBackendQuarantinedError ||
    error instanceof ProviderUpdateError ||
    // A provider that cannot honor the selected chat mode is the user's to
    // resolve — they can switch mode or provider — so the explanation must
    // reach them instead of the generic fault message.
    isProviderChatModeUnsupportedError(error)
  ) {
    return (error as Error).message
  }
  return "Provider turn dispatch failed."
}
