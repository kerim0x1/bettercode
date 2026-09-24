export interface PairingTarget {
  baseUrl: string
  credential: string
}

export class PairingInputError extends Error {}

export function normalizeBaseUrl(value: string): string {
  let raw = value.trim()
  if (!raw) throw new PairingInputError("Desktop-Adresse fehlt.")
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `http://${raw}`

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PairingInputError("Desktop address is invalid.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PairingInputError("Only HTTP or HTTPS addresses are supported.")
  }
  if (url.username || url.password) {
    throw new PairingInputError(
      "Credentials do not belong in the desktop address."
    )
  }

  url.pathname = url.pathname.replace(/\/?api\/v1\/?$/i, "/")
  if (url.pathname !== "/") url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

export function parsePairingInput(
  value: string,
  manualBaseUrl?: string
): PairingTarget {
  const raw = value.trim()
  if (!raw) throw new PairingInputError("Pairing link or code is missing.")

  if (manualBaseUrl?.trim()) {
    return {
      baseUrl: normalizeBaseUrl(manualBaseUrl),
      credential: normalizeCredential(raw),
    }
  }

  const candidate = raw
  if (/^betterc0de:/i.test(candidate)) {
    const deepLink = new URL(candidate)
    const endpoint =
      deepLink.searchParams.get("endpoint") ??
      deepLink.searchParams.get("baseUrl") ??
      deepLink.searchParams.get("host")
    const credential =
      deepLink.searchParams.get("token") ?? deepLink.searchParams.get("code")
    if (!endpoint || !credential) {
      throw new PairingInputError("The BetterC0de link is incomplete.")
    }
    return {
      baseUrl: normalizeBaseUrl(endpoint),
      credential: normalizeCredential(credential),
    }
  }

  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
    throw new PairingInputError("A bare code also needs the desktop address.")
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new PairingInputError("Pairing link is invalid.")
  }
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""))
  const credential =
    hash.get("token") ??
    hash.get("code") ??
    url.searchParams.get("token") ??
    url.searchParams.get("code")
  if (!credential) {
    throw new PairingInputError("No pairing code found in the link.")
  }
  return {
    baseUrl: normalizeBaseUrl(url.origin),
    credential: normalizeCredential(credential),
  }
}

export function websocketUrl(baseUrl: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl))
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/ws"
  return url.toString()
}

export function effectiveThreadRoot(thread: {
  projectPath: string
  worktreePath?: string | null
}): string {
  return thread.worktreePath?.trim() || thread.projectPath.trim()
}

export function relativePathWithinRoot(
  root: string,
  absolutePath: string
): string {
  const normalizedRoot = normalizeFsPath(root).replace(/\/$/, "")
  const normalizedPath = normalizeFsPath(absolutePath)
  if (
    [normalizedRoot, normalizedPath].some((value) =>
      value.split("/").includes("..")
    )
  ) {
    throw new Error("File is outside the chat's project.")
  }
  const caseInsensitive = /^[a-z]:/i.test(normalizedRoot)
  const comparableRoot = caseInsensitive
    ? normalizedRoot.toLowerCase()
    : normalizedRoot
  const comparablePath = caseInsensitive
    ? normalizedPath.toLowerCase()
    : normalizedPath
  if (comparablePath === comparableRoot) return ""
  if (!comparablePath.startsWith(`${comparableRoot}/`)) {
    throw new Error("File is outside the chat's project.")
  }
  return normalizedPath.slice(normalizedRoot.length + 1)
}

export function isSecureEndpoint(baseUrl: string): boolean {
  return normalizeBaseUrl(baseUrl).startsWith("https://")
}

function normalizeCredential(value: string): string {
  const credential = value.trim()
  if (!credential) throw new PairingInputError("Pairing code is missing.")
  if (credential.length > 512) {
    throw new PairingInputError("Pairing code is too long.")
  }
  return credential
}

function normalizeFsPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "")
}
