// @ts-check
/**
 * Main-process approval of commands that BetterC0de stores and runs later
 * (hooks, MCP servers) or that install code which runs later (CLI plugins).
 * A renderer can ask to save such a command, but only the
 * user, through a native dialog the main process shows, can approve it. The
 * stored entry then carries an approval marker: a MAC over the exact command,
 * keyed by a secret the renderer never sees. An unchanged command keeps its
 * marker and is not asked about again; any change needs a new approval.
 *
 * The key is derived from the settings encryption key the main process
 * already holds (and passes to the backend), so the backend can verify the
 * same marker. Without OS credential storage there is no secret; the marker
 * is then a plain digest that records what the user approved, and every
 * write to the store still goes through the main-process dialog.
 */

const crypto = require("crypto")

const APPROVAL_VERSION = 1
const MAX_DIALOG_COMMAND_CHARS = 4_096

/**
 * The marker stored next to an approved command.
 * @typedef {object} ApprovalMarker
 * @property {number} v Format version.
 * @property {"hmac-sha256" | "sha256"} alg Keyed MAC, or a plain digest when no key exists.
 * @property {string} digest Base64 digest of the canonical (kind, command) pair.
 */

/** @type {Buffer | null} */
let approvalKey = null

/**
 * Derive the approval key from the base64 settings key (or clear it).
 * @param {unknown} base64Key
 */
function setCommandApprovalKey(base64Key) {
  /** @type {Buffer | null} */
  let raw = null
  if (typeof base64Key === "string" && base64Key) {
    try {
      raw = Buffer.from(base64Key, "base64")
    } catch {
      raw = null
    }
  }
  approvalKey =
    raw && raw.length === 32
      ? crypto
          .createHmac("sha256", raw)
          .update("betterc0de/command-approval/v1")
          .digest()
      : null
}

/**
 * @param {unknown} kind
 * @param {unknown} command
 * @returns {string}
 */
function canonicalCommand(kind, command) {
  return JSON.stringify([String(kind), String(command)])
}

/**
 * The marker stored next to an approved command.
 * @param {unknown} kind
 * @param {unknown} command
 * @returns {ApprovalMarker}
 */
function createApprovalMarker(kind, command) {
  const payload = canonicalCommand(kind, command)
  if (approvalKey) {
    return {
      v: APPROVAL_VERSION,
      alg: "hmac-sha256",
      digest: crypto.createHmac("sha256", approvalKey).update(payload).digest("base64"),
    }
  }
  return {
    v: APPROVAL_VERSION,
    alg: "sha256",
    digest: crypto.createHash("sha256").update(payload).digest("base64"),
  }
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function digestsEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false
  const a = Buffer.from(left, "base64")
  const b = Buffer.from(right, "base64")
  return a.length === 32 && b.length === 32 && crypto.timingSafeEqual(a, b)
}

/**
 * True when `marker` approves exactly this command. A keyed marker is only
 * accepted while the key is available; an unkeyed marker only while no key
 * exists, so gaining a key re-asks once instead of trusting old digests.
 * @param {unknown} kind
 * @param {unknown} command
 * @param {{ v?: unknown, alg?: unknown, digest?: unknown } | null | undefined} marker
 *   As stored (parsed JSON), so every field is checked.
 * @returns {boolean}
 */
function isApprovalMarkerValid(kind, command, marker) {
  if (!marker || typeof marker !== "object" || marker.v !== APPROVAL_VERSION) {
    return false
  }
  const expected = createApprovalMarker(kind, command)
  return marker.alg === expected.alg && digestsEqual(marker.digest, expected.digest)
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clip(value, max) {
  const text = String(value ?? "")
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const DEFAULT_APPROVAL_NOTICE =
  "BetterC0de will run this command on your computer without asking again. " +
  "Only allow commands you wrote or trust."

/**
 * Ask the user, in a native main-process dialog, to approve `command`.
 * Resolves true only on an explicit "Allow" (or `allowLabel`). `parent` is
 * the BrowserWindow the request came from, when there is one. `commandLabel`
 * heads the command text (default "Command:"); `notice` replaces the closing
 * warning.
 *
 * @param {Pick<Electron.Dialog, "showMessageBox">} dialog
 * @param {Electron.BaseWindow | null | undefined} parent
 * @param {object} request
 * @param {string} [request.title]
 * @param {string} [request.message]
 * @param {unknown} request.command
 * @param {string} [request.context]
 * @param {string} [request.commandLabel]
 * @param {string} [request.notice]
 * @param {string} [request.allowLabel]
 * @returns {Promise<boolean>}
 */
async function confirmCommandApproval(
  dialog,
  parent,
  { title, message, command, context, commandLabel, notice, allowLabel },
) {
  const detail = [
    commandLabel || "Command:",
    clip(command, MAX_DIALOG_COMMAND_CHARS),
    "",
    ...(context ? [context, ""] : []),
    notice || DEFAULT_APPROVAL_NOTICE,
  ].join("\n")
  /** @type {Electron.MessageBoxOptions} */
  const options = {
    type: "warning",
    title: title || "Allow command?",
    message: message || "Allow BetterC0de to run this command?",
    detail,
    buttons: ["Cancel", allowLabel || "Allow"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const result =
    parent && typeof parent.isDestroyed === "function" && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  return result?.response === 1
}

module.exports = {
  MAX_DIALOG_COMMAND_CHARS,
  confirmCommandApproval,
  createApprovalMarker,
  isApprovalMarkerValid,
  setCommandApprovalKey,
}
