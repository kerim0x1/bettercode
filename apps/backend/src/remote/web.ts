import { randomBytes } from "node:crypto"
import fs, { type Stats } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { Readable } from "node:stream"
import path from "node:path"
import type { Hono } from "hono"
import type { ServerConfig } from "../config"

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}
const MAX_INDEX_HTML_BYTES = 2 * 1024 * 1024
const MAX_STATIC_ASSET_BYTES = 512 * 1024 * 1024
const NO_FOLLOW_FLAG =
  typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0

function safeAssetPath(root: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  if (decoded.includes("\0")) return null
  const relative = decoded.replace(/^[/\\]+/, "")
  const candidate = path.resolve(root, relative)
  const relation = path.relative(root, candidate)
  if (relation.startsWith("..") || path.isAbsolute(relation)) return null
  return candidate
}

function isFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function runtimeScript(config: ServerConfig, nonce: string): string {
  const payload = JSON.stringify({
    port: config.port,
    mode: "remote_http",
  }).replace(/</g, "\\u003c")
  return `<script nonce="${nonce}">window.__BETTERC0DE__={...${payload},baseUrl:window.location.origin};</script>`
}

const CSP_META_RE =
  /(<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=")([^"]*)(")/gi

/**
 * Allow exactly the script carrying `nonce` in a policy: the nonce is added
 * to `script-src` (or to `default-src` when the policy has no `script-src`).
 * Everything else in the policy, including the absence of `'unsafe-inline'`,
 * is left as it is.
 */
export function addScriptNonceToPolicy(policy: string, nonce: string): string {
  const directives = policy.split(";")
  const nonceSource = `'nonce-${nonce}'`
  for (const name of ["script-src", "default-src"]) {
    const index = directives.findIndex(
      (directive) => directive.trim().split(/\s+/)[0]?.toLowerCase() === name
    )
    if (index < 0) continue
    directives[index] = `${directives[index]!.trimEnd()} ${nonceSource}`
    return directives.join(";")
  }
  return policy
}

/**
 * Inject the runtime config as an inline script with a fresh nonce, and add
 * that nonce to the page's Content-Security-Policy meta tags. The bundle's
 * policy allows no inline script (apps/ui/index.html); only this one, for
 * this response, is let through.
 */
export function injectRuntimeConfig(
  indexHtml: string,
  config: ServerConfig,
  nonce: string = randomBytes(16).toString("base64")
): string {
  const script = runtimeScript(config, nonce)
  const withNonce = indexHtml.replace(
    CSP_META_RE,
    (_match, start: string, policy: string, end: string) =>
      `${start}${addScriptNonceToPolicy(policy, nonce)}${end}`
  )
  return withNonce.includes("</head>")
    ? withNonce.replace("</head>", `${script}\n  </head>`)
    : `${script}${withNonce}`
}

/**
 * Serves the built Vite client from the backend itself. This keeps browser
 * HTTP, WebSocket, cookies, and CSP same-origin, which is the safe path for a
 * phone opening a LAN/Tailnet URL and avoids shipping the Electron process
 * bearer to renderer JavaScript.
 */
export function registerRemoteWebRoutes(
  app: Hono,
  config: ServerConfig,
  webRoot: string | undefined
): void {
  if (!webRoot) return
  let root: string
  try {
    root = fs.realpathSync(path.resolve(webRoot))
  } catch {
    return
  }
  const indexPath = path.join(root, "index.html")
  if (!isFile(indexPath)) return

  app.get("*", async (c, next) => {
    const requestPath = c.req.path
    if (
      requestPath === "/health" ||
      requestPath === "/ws" ||
      requestPath.startsWith("/api/")
    ) {
      return next()
    }

    const requested =
      requestPath === "/" ? indexPath : safeAssetPath(root, requestPath)
    if (!requested) return c.text("Not found", 404)

    let filePath = requested
    if (!isFile(filePath)) {
      // Extension-less routes are SPA navigation; missing asset requests are
      // real 404s so a typo never receives HTML under a JavaScript MIME type.
      if (path.extname(requestPath)) return c.text("Not found", 404)
      filePath = indexPath
    }

    c.header("Referrer-Policy", "no-referrer")
    c.header("X-Content-Type-Options", "nosniff")
    if (filePath === indexPath) {
      c.header("Cache-Control", "no-store")
      const opened = await openRegularFileNoFollow(
        indexPath,
        MAX_INDEX_HTML_BYTES
      )
      if (!opened) return c.text("Remote client entrypoint is unavailable", 500)
      try {
        const html = await opened.handle.readFile("utf8")
        return c.html(injectRuntimeConfig(html, config))
      } finally {
        await opened.handle.close()
      }
    }

    const realFilePath = await fs.promises.realpath(filePath)
    const relation = path.relative(root, realFilePath)
    if (relation.startsWith("..") || path.isAbsolute(relation)) {
      return c.text("Not found", 404)
    }
    const opened = await openRegularFileNoFollow(
      realFilePath,
      MAX_STATIC_ASSET_BYTES
    )
    if (!opened) return c.text("Not found", 404)
    const extension = path.extname(filePath).toLowerCase()
    c.header(
      "Cache-Control",
      filePath.includes(`${path.sep}assets${path.sep}`)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600"
    )
    c.header(
      "Content-Type",
      CONTENT_TYPES[extension] ?? "application/octet-stream"
    )
    c.header("Content-Length", String(opened.size))
    const stream = opened.handle.createReadStream({ autoClose: true })
    return c.body(Readable.toWeb(stream) as ReadableStream)
  })
}

async function openRegularFileNoFollow(
  filePath: string,
  maxBytes: number
): Promise<{
  readonly handle: FileHandle
  readonly size: number
} | null> {
  let handle: FileHandle | null = null
  try {
    const before = await fs.promises.lstat(filePath)
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
      return null
    }
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | NO_FOLLOW_FLAG
    )
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      !sameFileIdentity(before, opened)
    ) {
      await handle.close()
      return null
    }
    return { handle, size: opened.size }
  } catch {
    await handle?.close().catch(() => undefined)
    return null
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  // Windows file-index values are not stable across a lstat/open pair on all
  // hosted filesystems (notably the Actions workspace). The size and times
  // still protect against a replacement while avoiding false 404s for valid
  // static assets.
  if (process.platform === "win32") {
    return left.size === right.size && left.mtimeMs === right.mtimeMs
  }
  if (left.ino !== 0 || right.ino !== 0) {
    return left.ino === right.ino && left.dev === right.dev
  }
  return (
    left.size === right.size &&
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs
  )
}
