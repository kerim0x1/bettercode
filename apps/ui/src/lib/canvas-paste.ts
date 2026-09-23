/**
 * What a paste or a drop onto the canvas should become.
 *
 * The rules live here, away from the DOM, because this is where the guessing
 * happens: the same string can be a picture, a page to embed, a file in the
 * open project, or just words someone wanted on the board.
 */

export type CanvasDropSpec =
  /** Bytes we already hold — a pasted screenshot, a dropped file. */
  | { kind: "image-file"; file: File }
  /** A picture left on the web, referenced by its address. */
  | { kind: "image-url"; url: string }
  /** Any other page, shown in an embed. */
  | { kind: "embed-web"; url: string }
  /** An .html file on this machine, shown through the project grant. */
  | { kind: "embed-local"; path: string }
  /** A local file we are not allowed to read from the renderer. */
  | { kind: "local-file"; path: string }
  | { kind: "text"; text: string }

const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".bmp",
  ".ico",
]

export function isImageFile(file: { type?: string; name?: string }): boolean {
  if (file.type?.startsWith("image/")) return true
  const name = file.name?.toLowerCase() ?? ""
  return IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension))
}

function hasImageExtension(pathname: string): boolean {
  const clean = pathname.toLowerCase().split(/[?#]/)[0]
  return IMAGE_EXTENSIONS.some((extension) => clean.endsWith(extension))
}

function isHtmlPath(value: string): boolean {
  return /\.html?$/i.test(value.split(/[?#]/)[0])
}

/**
 * Windows drive paths, UNC shares and POSIX paths. A bare `/foo` is only read
 * as a path when it has a file extension, so a stray line of prose does not
 * turn into a broken file reference.
 */
export function asLocalPath(value: string): string | null {
  const trimmed = value.trim().replace(/^"(.*)"$/, "$1")
  if (!trimmed || /[\n\r]/.test(trimmed)) return null
  if (trimmed.toLowerCase().startsWith("file:///")) {
    try {
      const url = new URL(trimmed)
      const decoded = decodeURIComponent(url.pathname)
      // file:///C:/x -> C:/x, file:///home/x -> /home/x
      return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded
    } catch {
      return null
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed
  if (trimmed.startsWith("\\\\")) return trimmed
  if (trimmed.startsWith("/") && /\.[a-z0-9]{1,8}$/i.test(trimmed))
    return trimmed
  return null
}

/**
 * Hosts that genuinely cannot serve https: the machine itself and the local
 * network. Everything else on the open internet is upgraded.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host))
    return true
  return /^172\.(1[6-9]|2\d|3[01])\./.test(host)
}

/**
 * A pasted link is taken to https unless it points at this machine. Sites
 * are copied out of an address bar that long ago stopped showing the scheme,
 * and an embedded http page is both insecure and, on most hosts, a redirect
 * away from the page the person meant.
 */
export function preferHttps(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" || isLocalHost(parsed.hostname)) return url
    parsed.protocol = "https:"
    return parsed.href
  } catch {
    return url
  }
}

function asWebUrl(value: string): URL | null {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null
  try {
    return new URL(preferHttps(trimmed))
  } catch {
    return null
  }
}

/** One pasted or dropped string, decided. */
export function classifyCanvasText(value: string): CanvasDropSpec {
  const trimmed = value.trim()
  if (!trimmed) return { kind: "text", text: value }

  if (/^data:image\//i.test(trimmed)) {
    return { kind: "image-url", url: trimmed }
  }
  const web = asWebUrl(trimmed)
  if (web) {
    return hasImageExtension(web.pathname)
      ? { kind: "image-url", url: web.href }
      : { kind: "embed-web", url: web.href }
  }
  const local = asLocalPath(trimmed)
  if (local) {
    return isHtmlPath(local)
      ? { kind: "embed-local", path: local }
      : { kind: "local-file", path: local }
  }
  return { kind: "text", text: value }
}

export interface CanvasTransferInput {
  files: readonly File[]
  /** `text/plain` from the clipboard or the drag. */
  text?: string
  /** `text/uri-list`, which browsers set when dragging a link or an image. */
  uriList?: string
}

/**
 * Everything one paste or drop should put on the board.
 *
 * Files win: a screenshot on the clipboard usually travels with a filename in
 * the text flavour too, and the bytes are the better of the two.
 */
export function canvasDropSpecs(input: CanvasTransferInput): CanvasDropSpec[] {
  const images = input.files.filter(isImageFile)
  if (images.length > 0) {
    return images.map((file) => ({ kind: "image-file", file }) as const)
  }
  if (input.files.length > 0) {
    // A non-picture file: keep the name so the board can say what it was.
    return input.files.map(
      (file) => ({ kind: "local-file", path: file.name }) as const
    )
  }
  const lines = (input.uriList || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
  if (lines.length > 0) return lines.map(classifyCanvasText)
  const text = input.text ?? ""
  return text.trim() ? [classifyCanvasText(text)] : []
}

/** A short, human label for an address, used as an embed's caption. */
export function describeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const tail = parsed.pathname.replace(/\/$/, "").split("/").filter(Boolean)
    return tail.length ? `${parsed.host}/${tail.at(-1)}` : parsed.host
  } catch {
    return url.slice(0, 80)
  }
}

/** The file name at the end of a path, for a caption. */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

/**
 * A project-relative path, if the file sits inside that project. The main
 * process only grants files under a project root, and its IPC refuses an
 * absolute path, so the conversion has to happen before the ask.
 */
export function relativeToProject(
  projectPath: string,
  filePath: string
): string | null {
  const normalise = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "")
  const root = normalise(projectPath)
  const file = normalise(filePath)
  if (!root || !file) return null
  const prefix = `${root.toLowerCase()}/`
  if (!file.toLowerCase().startsWith(prefix)) return null
  const relative = file.slice(root.length + 1)
  return relative && !relative.startsWith("..") ? relative : null
}
