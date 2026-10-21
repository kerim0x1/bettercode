import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Per-request diagnostic context.
 *
 * The HTTP logging middleware runs each `/api/*` request inside this store so
 * code that logs a failure deep in a handler (notably `sanitizeError`) can
 * attach the same request id the access log line carries, without every route
 * having to thread it through by hand.
 */
export interface RequestLogContext {
  readonly reqId: string
}

const storage = new AsyncLocalStorage<RequestLogContext>()

export function runWithRequestContext<T>(
  context: RequestLogContext,
  fn: () => T
): T {
  return storage.run(context, fn)
}

/** The id of the HTTP request currently being handled, if any. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.reqId
}
