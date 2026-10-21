/**
 * Explicit, sender-checked IPC registration for the Electron main process.
 *
 * Every renderer-callable handler is registered through `registerHandler`
 * (invoke/handle) or `registerListener` (send/on). Both check the sender
 * against a named policy BEFORE the handler runs, then optionally validate
 * the arguments. The check is looked up when a message arrives, not when the
 * handler is registered, so a module that registers at require time is still
 * covered, and a message that arrives before `main.cjs` configured a policy is
 * refused rather than let through.
 *
 * `installIpcMainGuard()` is a safety net for code that still calls
 * `ipcMain.handle` / `handleOnce` / `on` / `once` directly (other modules,
 * plugins): those registrations are wrapped with the default policy. Handlers
 * that came through `registerHandler` are marked and not wrapped twice.
 *
 * Policies:
 *  - "trusted-renderer" (default): a registered BetterC0de window's main frame.
 *  - "preview-guest": the app's own preview preload inside a <webview> guest.
 *    Only handlers that exist for that preload opt into it.
 */

const { ipcMain } = require("electron")

const WRAPPED = Symbol.for("betterc0de.trustedIpc.wrapped")
const DEFAULT_SENDER_POLICY = "trusted-renderer"
const PREVIEW_GUEST_SENDER_POLICY = "preview-guest"

/**
 * Decides whether `event` may use `channel`; throws to refuse it.
 * @typedef {(event: any, channel: string) => void} SenderValidator
 */

/**
 * Checks the arguments of a message: throws to refuse it, returns a
 * replacement argument array, or returns nothing to keep them.
 * @typedef {(args: any[], channel: string) => any[] | void} ArgsValidator
 */

/**
 * @typedef {object} RegistrationOptions
 * @property {string} [sender] Sender policy name (default "trusted-renderer").
 * @property {ArgsValidator} [validate]
 */

/** @param {unknown} error */
function describeError(error) {
  return error && error.message ? error.message : String(error)
}

/**
 * @param {any} target `ipcMain`, or a fake with a subset of its methods.
 * @param {{ logger?: Pick<Console, "warn"> }} [options]
 */
function createTrustedIpc(target, { logger = console } = {}) {
  const bind = (name) =>
    target && typeof target[name] === "function" ? target[name].bind(target) : null
  // Captured before `installGuard` replaces them, so explicit registrations
  // never pass through the safety-net wrapper.
  const original = {
    handle: bind("handle"),
    handleOnce: bind("handleOnce"),
    on: bind("on"),
    once: bind("once"),
    removeListener: bind("removeListener"),
    off: bind("off"),
  }
  const senderPolicies = new Map()
  // listener -> Map<channel, wrapper[]> so removeListener/off keep working
  // for listeners the guard wrapped.
  const listenerWrappers = new WeakMap()
  let guardInstalled = false

  /**
   * @param {string} name
   * @param {SenderValidator} validator
   */
  function configureSenderPolicy(name, validator) {
    if (typeof name !== "string" || !name) {
      throw new TypeError("IPC sender policy name must be a nonempty string")
    }
    if (typeof validator !== "function") {
      throw new TypeError(`IPC sender policy ${name} must be a function`)
    }
    senderPolicies.set(name, validator)
  }

  /**
   * @param {any} event
   * @param {string} channel
   * @param {string} [policyName]
   */
  function assertSender(event, channel, policyName = DEFAULT_SENDER_POLICY) {
    const validator = senderPolicies.get(policyName)
    if (!validator) {
      // Fail closed: no policy means nobody decided who may call this.
      throw new Error(
        `Rejected IPC for ${channel}: sender policy "${policyName}" is not configured`,
      )
    }
    validator(event, channel)
  }

  function checkedArgs(validate, args, channel) {
    if (typeof validate !== "function") return args
    const result = validate(args, channel)
    if (result === undefined) return args
    if (!Array.isArray(result)) {
      throw new TypeError(`IPC argument validator for ${channel} must return an array or nothing`)
    }
    return result
  }

  function assertRegistration(channel, handler) {
    if (typeof channel !== "string" || channel.length === 0) {
      throw new TypeError("IPC channel must be a nonempty string")
    }
    if (typeof handler !== "function") {
      throw new TypeError(`IPC handler for ${channel} must be a function`)
    }
  }

  function guardInvokeHandler(channel, handler, { sender, validate } = {}) {
    assertRegistration(channel, handler)
    const policy = sender || DEFAULT_SENDER_POLICY
    const wrapped = async (event, ...args) => {
      assertSender(event, channel, policy)
      return handler(event, ...checkedArgs(validate, args, channel))
    }
    wrapped[WRAPPED] = true
    return wrapped
  }

  function guardListener(channel, listener, { sender, validate } = {}) {
    assertRegistration(channel, listener)
    const policy = sender || DEFAULT_SENDER_POLICY
    const wrapped = (event, ...args) => {
      let validated
      try {
        assertSender(event, channel, policy)
        validated = checkedArgs(validate, args, channel)
      } catch (error) {
        // A fire-and-forget message has nobody to reject to; drop it.
        logger.warn(`[ipc] dropped ${channel}: ${describeError(error)}`)
        return undefined
      }
      return listener(event, ...validated)
    }
    wrapped[WRAPPED] = true
    return wrapped
  }

  /**
   * Register an `ipcRenderer.invoke` handler. The sender is checked against
   * `options.sender` (default "trusted-renderer"); `options.validate(args)`
   * may throw to reject the call or return a replacement argument array.
   */
  /**
   * @param {string} channel
   * @param {(event: any, ...args: any[]) => unknown} handler
   * @param {RegistrationOptions} [options]
   */
  function registerHandler(channel, handler, options = {}) {
    if (!original.handle) throw new Error("ipcMain.handle is unavailable")
    original.handle(channel, guardInvokeHandler(channel, handler, options))
  }

  /** Register an `ipcRenderer.send` listener; returns an unsubscribe function. */
  /**
   * @param {string} channel
   * @param {(event: any, ...args: any[]) => unknown} listener
   * @param {RegistrationOptions} [options]
   * @returns {() => void}
   */
  function registerListener(channel, listener, options = {}) {
    if (!original.on || !original.removeListener) {
      throw new Error("ipcMain.on is unavailable")
    }
    const wrapped = guardListener(channel, listener, options)
    original.on(channel, wrapped)
    return () => original.removeListener(channel, wrapped)
  }

  function rememberWrapper(listener, channel, wrapper) {
    let channels = listenerWrappers.get(listener)
    if (!channels) {
      channels = new Map()
      listenerWrappers.set(listener, channels)
    }
    const wrappers = channels.get(channel) || []
    wrappers.push(wrapper)
    channels.set(channel, wrappers)
  }

  function takeWrapper(listener, channel) {
    const wrappers = listenerWrappers.get(listener)?.get(channel)
    return wrappers && wrappers.length > 0 ? wrappers.pop() : null
  }

  /**
   * Safety net: wrap direct ipcMain registrations with the default policy.
   * Idempotent. Methods the target does not have are left alone.
   */
  function installGuard() {
    if (guardInstalled || !target) return
    guardInstalled = true
    for (const name of ["handle", "handleOnce"]) {
      const register = original[name]
      if (!register) continue
      target[name] = (channel, handler) =>
        register(
          channel,
          handler && handler[WRAPPED] ? handler : guardInvokeHandler(channel, handler),
        )
    }
    for (const name of ["on", "once"]) {
      const register = original[name]
      if (!register) continue
      target[name] = (channel, listener) => {
        if (listener && listener[WRAPPED]) return register(channel, listener)
        const wrapped = guardListener(channel, listener)
        rememberWrapper(listener, channel, wrapped)
        return register(channel, wrapped)
      }
    }
    for (const name of ["removeListener", "off"]) {
      const remove = original[name]
      if (!remove) continue
      target[name] = (channel, listener) =>
        remove(channel, takeWrapper(listener, channel) || listener)
    }
  }

  return {
    assertSender,
    configureSenderPolicy,
    installGuard,
    registerHandler,
    registerListener,
    isGuardInstalled: () => guardInstalled,
  }
}

const mainProcessIpc = createTrustedIpc(ipcMain)

module.exports = {
  DEFAULT_SENDER_POLICY,
  PREVIEW_GUEST_SENDER_POLICY,
  createTrustedIpc,
  assertSender: mainProcessIpc.assertSender,
  configureIpcSenderPolicy: mainProcessIpc.configureSenderPolicy,
  installIpcMainGuard: mainProcessIpc.installGuard,
  isIpcMainGuardInstalled: mainProcessIpc.isGuardInstalled,
  registerHandler: mainProcessIpc.registerHandler,
  registerListener: mainProcessIpc.registerListener,
}
