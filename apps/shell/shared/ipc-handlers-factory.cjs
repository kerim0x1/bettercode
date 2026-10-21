/**
 * IPC handler factory — wraps the boilerplate try/catch + ok/fail envelope
 * that every shell/*-ipc.cjs file used to hand-roll. ~6 modules each had
 * 4–7 handlers wrapping the same pattern; centralizing removes ~150 LoC of
 * `try { ... return ok({...}) } catch (e) { return fail(e) }` repetition.
 *
 * Both helpers register through `registerHandler` (shared/trusted-ipc.cjs),
 * which checks the sender before the handler runs. A rejected sender gets a
 * rejected invoke, never an envelope. The factory only owns the post-call
 * envelope.
 *
 * The pure `makeSafeWrapper` / `makeRawWrapper` functions are exported so
 * unit tests can exercise the envelope behavior without mocking the
 * electron module.
 */

const { ok, fail } = require("./ipc-envelope.cjs")
const { registerHandler } = require("./trusted-ipc.cjs")

/**
 * Wrap a user-provided handler so its result is normalized to the standard
 * `{ok, error?, ...}` envelope:
 *  - handler returns `undefined`        → `{ok: true}`
 *  - handler returns plain object       → `{ok: true, ...obj}`
 *  - handler returns object with `ok`   → passed through unchanged (lets
 *                                          callers signal `{ok: false, ...}`
 *                                          for non-throw failures)
 *  - handler throws                     → `{ok: false, error}` via `fail`
 */
function makeSafeWrapper(handler) {
  return async (event, ...args) => {
    try {
      const result = await handler(event, ...args)
      if (result && typeof result === "object" && !Array.isArray(result) && "ok" in result) {
        return result
      }
      return ok(result)
    } catch (e) {
      return fail(e)
    }
  }
}

/**
 * Wrap a handler that returns a raw value (array, scalar, plain object).
 * On error, returns `fallback` rather than an envelope; this matches the
 * legacy "list returns []" semantic used by *List handlers across skills /
 * subagents / mcp. Never use it for data that gates execution (hooks): a
 * silent fallback there fails open.
 */
function makeRawWrapper(handler, opts = {}) {
  const { fallback = null, warnTag, channel } = opts
  return async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (err) {
      if (warnTag) {
        const tag = channel ? `${warnTag}] ${channel}` : warnTag
        console.warn(`[${tag} handler threw:`, err?.message || err)
      }
      return fallback
    }
  }
}

/** Register a `safeHandle`-wrapped IPC handler under `channel`. */
function safeHandle(channel, handler, options) {
  registerHandler(channel, makeSafeWrapper(handler), options)
}

/** Register a `rawHandle`-wrapped IPC handler under `channel`. */
function rawHandle(channel, handler, opts = {}) {
  registerHandler(channel, makeRawWrapper(handler, { ...opts, channel }))
}

module.exports = {
  safeHandle,
  rawHandle,
  makeSafeWrapper,
  makeRawWrapper,
}
