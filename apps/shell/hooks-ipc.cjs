/**
 * Hooks IPC — user-defined shell commands that fire on chat events.
 * Storage is a single JSON array, `hooks.json` in the runtime home, which
 * the backend owns: this process reads and writes it only through
 * `/api/v1/config/hooks` (shared/desktop-config-client.cjs), against the
 * revision it read.
 *
 * A hook's command runs later without anyone watching, so saving one is an
 * approval decision, not a settings write: a new or changed command is shown
 * to the user in a native main-process dialog, and only an explicit "Allow"
 * stores it, together with an approval marker (shared/command-approval.cjs).
 * Unchanged commands keep their marker and are not asked about again.
 *
 * Reads fail closed. A hooks.json that cannot be read or parsed rejects
 * `hook:list` instead of reporting "no hooks", because an empty list would
 * silently skip the user's blocking `on_message_send` hooks.
 */

const { BrowserWindow, dialog } = require("electron")
const { IpcChannel } = require("./shared/ipc-contract.cjs")
const { safeHandle } = require("./shared/ipc-handlers-factory.cjs")
const { registerHandler } = require("./shared/trusted-ipc.cjs")
const { createDocumentStore } = require("./shared/desktop-config-client.cjs")
const {
  confirmCommandApproval,
  createApprovalMarker,
  isApprovalMarkerValid,
} = require("./shared/command-approval.cjs")
const { assertHookRecord } = require("./shared/runtime-records.cjs")

const HOOK_APPROVAL_KIND = "hook"
const HOOK_EVENTS = new Set([
  "on_message_send",
  "on_response_complete",
  "on_file_change",
  "on_commit",
])
const HOOK_EVENT_LABELS = {
  on_message_send: "before each message is sent (a failure stops the message)",
  on_response_complete: "after each agent response",
  on_file_change: "whenever a file changes",
  on_commit: "after each git commit",
}
const HOOK_STATUSES = new Set(["idle", "running", "success", "error"])
// The same bounds as the shared record (`RUNTIME_HOOK_LIMITS` in
// @betterc0de/schema/runtime-records); scripts/runtime-records.test.mjs
// keeps them equal.
const MAX_HOOKS = 1_000
const MAX_HOOK_ID_LENGTH = 128
const MAX_HOOK_COMMAND_LENGTH = 4_096
const MAX_HOOK_ERROR_LENGTH = 8_192

// Created on first use; every method is async (a request to the backend).
let documentStore = null
function hooksDocumentStore() {
  documentStore ??= createDocumentStore("hooks", {
    maxItems: MAX_HOOKS,
    buildEntry: buildHookEntry,
  })
  return documentStore
}

const hooksStore = {
  read: () => hooksDocumentStore().read(),
  list: () => hooksDocumentStore().list(),
  get: (id) => hooksDocumentStore().get(id),
  save: (input) => hooksDocumentStore().save(input),
  update: (id, patcher) => hooksDocumentStore().update(id, patcher),
  remove: (id) => hooksDocumentStore().remove(id),
  replaceAll: (entries) => hooksDocumentStore().replaceAll(entries),
}

// `hook` is already normalized by `normalizeHookInput`; run status is owned
// by `hook:update-run` and never taken from a save request. The entry is
// checked against the shared hooks.json record before it is written.
function buildHookEntry(hook, existing, { now, id }) {
  return assertHookRecord({
    id,
    event: hook.event,
    command: hook.command,
    enabled: hook.enabled,
    approval: hook.approval ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt || null,
    lastStatus: existing?.lastStatus || "idle",
    lastExitCode: existing?.lastExitCode ?? null,
    lastError: existing?.lastError ?? null,
  })
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function validateHookId(id, { required }) {
  if (id === undefined || id === null || id === "") {
    if (required) throw new TypeError("Hook id is required.")
    return undefined
  }
  if (typeof id !== "string" || id.length > MAX_HOOK_ID_LENGTH || !id.trim()) {
    throw new TypeError("Hook id must be a short nonempty string.")
  }
  return id
}

/** Validate a renderer-supplied hook. Throws on anything malformed. */
function normalizeHookInput(hook) {
  if (!isPlainObject(hook)) throw new TypeError("Hook must be an object.")
  const event = hook.event === undefined || hook.event === null || hook.event === ""
    ? "on_message_send"
    : hook.event
  if (typeof event !== "string" || !HOOK_EVENTS.has(event)) {
    throw new TypeError("Hook event is not supported.")
  }
  const command = hook.command === undefined || hook.command === null ? "" : hook.command
  if (typeof command !== "string") throw new TypeError("Hook command must be text.")
  if (command.length > MAX_HOOK_COMMAND_LENGTH) {
    throw new RangeError(`Hook command must be at most ${MAX_HOOK_COMMAND_LENGTH} characters.`)
  }
  if (/[\0]/.test(command)) throw new TypeError("Hook command must not contain NUL.")
  if (hook.enabled !== undefined && typeof hook.enabled !== "boolean") {
    throw new TypeError("Hook enabled must be true or false.")
  }
  return {
    id: validateHookId(hook.id, { required: false }),
    event,
    command,
    enabled: hook.enabled !== false,
  }
}

function isHookCommandApproved(entry) {
  return (
    isPlainObject(entry) &&
    typeof entry.command === "string" &&
    entry.command.trim() !== "" &&
    isApprovalMarkerValid(HOOK_APPROVAL_KIND, entry.command, entry.approval)
  )
}

/**
 * Read hooks.json strictly: a missing file is "no hooks", anything else that
 * is not a valid array of hooks throws (the backend reports it as the
 * document's `problem`).
 */
async function readHooksStrict() {
  const document = await hooksStore.read()
  if (document.problem) throw new Error(document.problem)
  const items = document.entries
  if (!Array.isArray(items) || !items.every(isPlainObject)) {
    throw new Error("hooks.json is not a list of hooks.")
  }
  return items
}

/** The renderer's view: no approval marker, but whether one is valid. */
function publicHook(entry) {
  const { approval: _approval, ...rest } = entry
  return { ...rest, approved: isHookCommandApproved(entry) }
}

/**
 * True when an enabled hook stores exactly `command` with a valid approval.
 * The shell-capability handler uses this to let approved hooks run without a
 * fresh user gesture. Unreadable storage approves nothing.
 */
async function isApprovedHookCommand(command) {
  if (typeof command !== "string" || !command.trim()) return false
  let hooks
  try {
    hooks = await readHooksStrict()
  } catch {
    return false
  }
  return hooks.some(
    (hook) => hook.enabled !== false && hook.command === command && isHookCommandApproved(hook),
  )
}

let registered = false

function registerHooksHandlers() {
  if (registered) return
  registered = true

  // Not `rawHandle`: its silent `[]` fallback would let a corrupt file skip
  // blocking hooks. A read failure rejects the invoke instead.
  registerHandler(IpcChannel.HookList, async () => {
    try {
      return (await readHooksStrict()).map(publicHook)
    } catch (error) {
      // Only a broken file is the user's to fix; an unreachable backend is
      // not (it says so itself).
      const advice =
        error?.code === "backend_unavailable"
          ? "Hooks are not run until they can be read."
          : "Fix or remove the file; hooks are not run until it can be read."
      throw new Error(
        `Could not read your hooks (hooks.json): ${String(error?.message || error).replace(/\.$/, "")}. ${advice}`,
        { cause: error },
      )
    }
  })

  safeHandle(IpcChannel.HookSave, async (event, hook) => {
    const input = normalizeHookInput(hook)
    const existing = input.id ? await hooksStore.get(input.id) : null
    let approval = null
    if (input.command.trim()) {
      const unchanged =
        existing?.command === input.command && isHookCommandApproved(existing)
      if (unchanged) {
        approval = existing.approval
      } else {
        const parent = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null
        const allowed = await confirmCommandApproval(dialog, parent, {
          title: "Allow hook command?",
          message: "Save a hook that runs this command automatically?",
          command: input.command,
          context: `It runs ${HOOK_EVENT_LABELS[input.event]}.`,
        })
        if (!allowed) {
          throw new Error("The hook was not saved because its command was not allowed.")
        }
        approval = createApprovalMarker(HOOK_APPROVAL_KIND, input.command)
      }
    }
    const entry = await hooksStore.save({ ...input, approval })
    return { id: entry.id }
  })

  safeHandle(IpcChannel.HookDelete, async (_event, payload) => {
    const id = validateHookId(isPlainObject(payload) ? payload.id : undefined, {
      required: true,
    })
    await hooksStore.remove(id)
  })

  safeHandle(IpcChannel.HookUpdateRun, async (_event, payload) => {
    if (!isPlainObject(payload)) throw new TypeError("Hook run update must be an object.")
    const id = validateHookId(payload.id, { required: true })
    const status = payload.status ?? "idle"
    if (typeof status !== "string" || !HOOK_STATUSES.has(status)) {
      throw new TypeError("Hook run status is not supported.")
    }
    const exitCode = payload.exitCode ?? null
    if (
      exitCode !== null &&
      (!Number.isInteger(exitCode) || Math.abs(exitCode) > 2 ** 32)
    ) {
      throw new TypeError("Hook exit code must be an integer.")
    }
    const error = payload.error ?? null
    if (error !== null && typeof error !== "string") {
      throw new TypeError("Hook error must be text.")
    }
    await hooksStore.update(id, (stored) => assertHookRecord({
      ...stored,
      lastRunAt: new Date().toISOString(),
      lastStatus: status,
      lastExitCode: exitCode,
      lastError: error === null ? null : error.slice(0, MAX_HOOK_ERROR_LENGTH),
    }))
  })

  console.log("[hooks-ipc] Handlers registered")
}

module.exports = {
  registerHooksHandlers,
  isApprovedHookCommand,
  normalizeHookInput,
  // Back-compat exports for any callers outside this module that read or
  // overwrite the hooks list directly (async: they go through the backend).
  // Entries written this way carry no approval and are treated like
  // unapproved hooks.
  readHooks: () => hooksStore.list(),
  writeHooks: (hooks) => hooksStore.replaceAll(hooks),
}
