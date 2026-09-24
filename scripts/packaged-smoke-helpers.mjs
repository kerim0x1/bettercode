import { rm, stat } from "node:fs/promises"

export async function findPackagedExecutableFiles(files, platform, readStat = stat) {
  const matches = []
  for (const file of files) {
    const value = file.replaceAll("\\", "/")
    const name = value.slice(value.lastIndexOf("/") + 1)
    if (platform === "win32") {
      if (/\/win[^/]*-unpacked\/[^/]+\.exe$/i.test(value) &&
          !/(uninstall|elevate|helper|crashpad)/i.test(name)) matches.push(file)
    } else if (platform === "darwin") {
      if (/\/mac[^/]*\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/i.test(value)) matches.push(file)
    } else if (
      /\/linux[^/]*-unpacked\/[^/]+$/i.test(value) &&
      !/(chrome-sandbox|crashpad|\.so(?:\.|$)|\.pak$|\.bin$|\.dat$)/i.test(name)
    ) {
      // LICENSE, LICENSES.chromium.html and version sit beside the binary.
      // Only executable files are application candidates on Linux.
      if (((await readStat(file)).mode & 0o111) !== 0) matches.push(file)
    }
  }
  return matches
}

const DEVTOOLS_ENDPOINT_PATTERN = /DevTools listening on (ws:\/\/[^\s]+)/g
const RETRYABLE_DIRECTORY_REMOVAL_CODES = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
])

export function parseDevToolsWebSocketUrl(diagnostics) {
  const text = String(diagnostics ?? "")
  let endpoint = null
  for (const match of text.matchAll(DEVTOOLS_ENDPOINT_PATTERN)) {
    endpoint = match[1] ?? endpoint
  }
  return endpoint
}

export function selectRendererTarget(targets) {
  if (!Array.isArray(targets)) return null
  const candidates = targets.filter((target) => {
    if (!target || typeof target !== "object") return false
    if (target.type !== "page") return false
    if (typeof target.webSocketDebuggerUrl !== "string") return false
    if (typeof target.url !== "string") return false
    return !/^(?:about:blank|chrome-error:|devtools:)/i.test(target.url)
  })
  return (
    candidates.find((target) => target.title === "BetterC0de") ??
    candidates.find((target) =>
      /(?:^|\/)apps\/ui\/dist\/index\.html(?:$|[?#])/i.test(target.url)
    ) ??
    candidates[0] ??
    null
  )
}

export function validateRendererSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, reason: "renderer snapshot is missing" }
  }
  if (
    /^(?:chrome-error:|about:blank|devtools:)/i.test(String(snapshot.url ?? ""))
  ) {
    return { ok: false, reason: "renderer is displaying a Chromium error page" }
  }
  if (
    snapshot.readyState !== "interactive" &&
    snapshot.readyState !== "complete"
  ) {
    return {
      ok: false,
      reason: `renderer document is not ready (${String(snapshot.readyState)})`,
    }
  }
  if (snapshot.title !== "BetterC0de") {
    return {
      ok: false,
      reason: `unexpected renderer title: ${String(snapshot.title)}`,
    }
  }
  if (
    !Number.isInteger(snapshot.rootChildCount) ||
    snapshot.rootChildCount < 1
  ) {
    return { ok: false, reason: "renderer React root has no mounted children" }
  }
  return { ok: true }
}

export async function removeDirectoryWithRetries(
  directory,
  {
    maxAttempts = 10,
    retryDelayMs = 100,
    remove = (target) => rm(target, { recursive: true, force: true }),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}
) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer")
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError("retryDelayMs must be a non-negative number")
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await remove(directory)
      return
    } catch (error) {
      const retryable =
        error &&
        typeof error === "object" &&
        RETRYABLE_DIRECTORY_REMOVAL_CODES.has(error.code)
      if (!retryable || attempt === maxAttempts) throw error
      await wait(retryDelayMs * attempt)
    }
  }
}

/**
 * What `taskkill /pid <app> /T /F` did to the packaged app's process tree,
 * by its exit code and whether it is the first pass or the second:
 *
 * - `ended`: 0, every process in the tree was ended; or 128 on the second
 *   pass, when the first pass had already ended the app itself;
 * - `exited-before`: 128 ("not found") on the first pass, the app had ended
 *   on its own before the kill;
 * - `retry`: 255 on the first pass. taskkill could not end every process in
 *   the tree, which happens when a process exits while taskkill works
 *   through the tree; a second pass ends what is left;
 * - `failed`: anything else.
 */
export function taskkillOutcome(code, pass) {
  if (code === 0) return "ended"
  if (code === 128) return pass === 1 ? "exited-before" : "ended"
  if (code === 255 && pass === 1) return "retry"
  return "failed"
}
