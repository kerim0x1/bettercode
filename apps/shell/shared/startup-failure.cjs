"use strict"

/**
 * Turns a failed desktop start-up into a dialog a user can act on.
 *
 * The backend runs as a child process, and its stderr only reaches the main
 * process console, which an installed app never shows. Without this, a
 * backend that crashes while loading (a native module built for another ABI
 * or architecture, a missing file, an unwritable profile) surfaced as
 * "Failed to start backend: Node backend exited (code=1 signal=none)", with
 * no cause and no next step. The dialog now shows the lines that explain the
 * failure and what to do about it.
 */

const DEFAULT_LINKS = {
  releases: "https://github.com/kerim0x1/bettercode/releases",
  issues: "https://github.com/kerim0x1/bettercode/issues",
}
const MAX_DETAIL_LINES = 6
const MAX_LINE_LENGTH = 300
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g

const NATIVE_MODULE_MISMATCH =
  /NODE_MODULE_VERSION|compiled against a different Node\.js version|invalid ELF header|wrong ELF class|not a valid Win32 application|incompatible architecture|mach-o file, but is an incompatible/i
const MISSING_FILE = /Cannot find module|ERR_MODULE_NOT_FOUND|Could not load the backend/i
const NO_PERMISSION = /\b(?:EACCES|EPERM)\b|permission denied|operation not permitted/i
const DISK_FULL = /\bENOSPC\b|no space left/i
const DATABASE_BUSY = /SQLITE_BUSY|database is locked/i
const KNOWN_CAUSES = [NATIVE_MODULE_MISMATCH, MISSING_FILE, NO_PERMISSION, DISK_FULL, DATABASE_BUSY]
const ERROR_WORDS = /error|cannot|failed|denied|not found|unable/i
// errno codes such as ENOENT; case-sensitive so ordinary words do not match.
const ERRNO_CODE = /\bE[A-Z]{3,}\b/

/** Links derived from package.json so forks point at their own repository. */
function projectLinks(manifest) {
  const repository =
    typeof manifest?.repository === "string" ? manifest.repository : manifest?.repository?.url
  const repositoryUrl =
    typeof repository === "string"
      ? repository.replace(/^git\+/, "").replace(/\.git$/, "")
      : null
  return {
    releases: repositoryUrl ? `${repositoryUrl}/releases` : DEFAULT_LINKS.releases,
    issues: typeof manifest?.bugs?.url === "string" ? manifest.bugs.url : DEFAULT_LINKS.issues,
  }
}

/** Backend stderr attached to the error or to any error it aggregates. */
function collectBackendStderr(error) {
  const lines = []
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== "object") return
    if (Array.isArray(candidate.backendStderr)) lines.push(...candidate.backendStderr)
    if (Array.isArray(candidate.errors)) candidate.errors.forEach(visit)
  }
  visit(error)
  return lines
}

function cleanLines(lines) {
  return lines.map((line) => String(line).replace(ANSI_ESCAPE, "").trim()).filter(Boolean)
}

/**
 * The lines most likely to explain the failure: those naming a known cause
 * or looking like an error, else the last lines.
 */
function relevantLines(lines) {
  const explaining = lines.filter(
    (line) =>
      ERROR_WORDS.test(line) || ERRNO_CODE.test(line) || KNOWN_CAUSES.some((cause) => cause.test(line))
  )
  const picked = explaining.length > 0 ? explaining : lines
  return [...new Set(picked)]
    .slice(-MAX_DETAIL_LINES)
    .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line))
}

function errorMessage(error) {
  if (error instanceof Error) {
    const nested = Array.isArray(error.errors)
      ? error.errors.map((inner) => (inner instanceof Error ? inner.message : String(inner)))
      : []
    return [error.message, ...nested].filter(Boolean).join("\n")
  }
  return String(error)
}

function describeStartupFailure({ error, isPackaged, links = DEFAULT_LINKS }) {
  const reason = errorMessage(error)
  const stderr = cleanLines(collectBackendStderr(error))
  const detail = relevantLines(stderr)
  // Classify on everything the service printed, not just the lines shown.
  const evidence = [reason, ...stderr].join("\n")
  const reinstall = `Install the latest version from ${links.releases}; it replaces damaged or incomplete files.`

  const steps = []
  if (NATIVE_MODULE_MISMATCH.test(evidence)) {
    steps.push(
      isPackaged
        ? `A component was built for a different system or processor. ${reinstall} On a Mac, download the build that matches your processor (Apple silicon or Intel).`
        : "A native module was built for another Node.js or Electron version. Run `npm run backend:rebuild`, or `npm ci` after switching Node versions, then `npm run dev`."
    )
  } else if (MISSING_FILE.test(evidence)) {
    steps.push(
      isPackaged
        ? `The installation is incomplete. ${reinstall}`
        : "The backend is not built. Run `npm run build:backend`, then `npm run dev`."
    )
  } else if (NO_PERMISSION.test(evidence)) {
    steps.push(
      "BetterC0de cannot write its data folder. Check that your user owns it, or set BETTERC0DE_HOME to a folder you can write to."
    )
  } else if (DISK_FULL.test(evidence)) {
    steps.push("The disk is full. Free some space and start BetterC0de again.")
  } else if (DATABASE_BUSY.test(evidence)) {
    steps.push(
      "Another BetterC0de process is still using its database. Quit every BetterC0de process (Task Manager or Activity Monitor) and start it again."
    )
  } else {
    steps.push("Quit BetterC0de and start it again.")
    if (isPackaged) steps.push(`If that does not help, ${reinstall[0].toLowerCase()}${reinstall.slice(1)}`)
  }
  steps.push(`If it keeps failing, report it at ${links.issues} and include this message.`)

  const message = [
    "BetterC0de could not start its background service.",
    "",
    reason,
    ...(detail.length > 0
      ? ["", "Last messages from the service:", ...detail.map((line) => `  ${line}`)]
      : []),
    "",
    "What you can do:",
    ...steps.map((step) => `• ${step}`),
  ].join("\n")

  return { title: "BetterC0de could not start", message }
}

module.exports = { describeStartupFailure, projectLinks }
