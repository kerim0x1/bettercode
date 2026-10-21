// An in-process stand-in for the backend's desktop configuration routes
// (apps/backend/src/http/routes/desktopConfig.ts over
// apps/backend/src/services/desktop-config/store.ts), for the shell tests.
//
// It is installed as the transport of apps/shell/shared/desktop-config-client.cjs,
// which every shell module that stores configuration goes through, and keeps
// the files exactly where the backend does (mcp-servers.json, hooks.json,
// rules.md, skills/<id>/, subagents/<id>/ in the runtime home), so a test can
// still look at what ended up on disk. Not a test file itself.

import crypto from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
// The same module instance the shell modules require (one CommonJS cache).
const client = require("../apps/shell/shared/desktop-config-client.cjs")

const ABSENT_REVISION = "absent"
const DOCUMENTS = {
  mcp: { file: "mcp-servers.json", maxEntries: 128, maxBytes: 4 * 1024 * 1024 },
  hooks: { file: "hooks.json", maxEntries: 1_000, maxBytes: 4 * 1024 * 1024 },
}
const DIRECTORIES = {
  skills: { dir: "skills", textFile: "content.md" },
  subagents: { dir: "subagents", textFile: "prompt.md" },
}
const MAX_TEXT_BYTES = 4 * 1024 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

class HttpFailure extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

function revisionOf(bytes) {
  return bytes === null
    ? ABSENT_REVISION
    : `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** The bytes of a regular file, null when missing; throws for anything else. */
function readRegularFile(file, maxBytes) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null
    throw error
  }
  const name = path.basename(file)
  if (stat.isSymbolicLink()) {
    throw new HttpFailure(409, `${name} cannot be used: it is a symbolic link. Move it aside and try again.`, "desktop_config_unsafe")
  }
  if (!stat.isFile()) {
    throw new HttpFailure(409, `${name} cannot be used: it is not a regular file. Move it aside and try again.`, "desktop_config_unsafe")
  }
  if (stat.size > maxBytes) {
    throw new HttpFailure(409, `${name} cannot be used: it is larger than ${maxBytes} bytes. Move it aside and try again.`, "desktop_config_unsafe")
  }
  return fs.readFileSync(file)
}

function validateEntries(value, maxEntries) {
  if (!Array.isArray(value)) return { problem: "it is not a list of entries" }
  if (value.length > maxEntries) return { problem: `it lists more than ${maxEntries} entries` }
  const ids = new Set()
  for (const entry of value) {
    if (!isPlainRecord(entry)) return { problem: "an entry is not an object" }
    if (typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id)) {
      return { problem: "an entry has no unique id" }
    }
    ids.add(entry.id)
  }
  return { entries: value }
}

function parseEntries(bytes, maxEntries) {
  let parsed
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    return { problem: "it is not valid JSON", json: false }
  }
  return { ...validateEntries(parsed, maxEntries), json: true }
}

function writeFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
}

/**
 * Install the fake for `home` (the runtime home). Returns:
 * - `requests`: every request, in order (`{ method, path, body }`);
 * - `beforeNextWrite(kind, run)`: run `run()` just before the next write to
 *   `mcp` or `hooks` is checked, as another writer would (to provoke a
 *   revision conflict);
 * - `respondOnce(response)`: answer the next request with `{ status, body }`
 *   instead of handling it;
 * - `restore()`: put the real transport back.
 */
export function installFakeDesktopConfigBackend(home) {
  const requests = []
  const pendingWrites = { mcp: [], hooks: [] }
  const pendingResponses = []

  function readDocument(kind) {
    const { file, maxEntries, maxBytes } = DOCUMENTS[kind]
    let bytes
    try {
      bytes = readRegularFile(path.join(home, file), maxBytes)
    } catch (error) {
      return { entries: [], revision: ABSENT_REVISION, problem: error.message }
    }
    if (bytes === null) return { entries: [], revision: ABSENT_REVISION }
    const parsed = parseEntries(bytes, maxEntries)
    const revision = revisionOf(bytes)
    return parsed.problem
      ? { entries: [], revision, problem: `${file}: ${parsed.problem}` }
      : { entries: parsed.entries, revision }
  }

  function writeDocument(kind, body) {
    const { file, maxEntries, maxBytes } = DOCUMENTS[kind]
    if (!isPlainRecord(body)) throw new HttpFailure(400, "invalid body")
    const checked = validateEntries(body.entries, maxEntries)
    if (checked.problem) {
      throw new HttpFailure(400, `${file}: ${checked.problem}`, "desktop_config_invalid")
    }
    const bytes = Buffer.from(JSON.stringify(checked.entries, null, 2), "utf8")
    if (bytes.length > maxBytes) {
      throw new HttpFailure(413, `${file} would exceed ${maxBytes} bytes`, "desktop_config_too_large")
    }
    const interleaved = pendingWrites[kind].shift()
    if (interleaved) interleaved()
    const target = path.join(home, file)
    const current = readRegularFile(target, maxBytes)
    const expected = body.expectedRevision
    if (expected !== undefined && expected !== null && expected !== revisionOf(current)) {
      throw new HttpFailure(409, `${file} changed since it was read; read it again and retry.`, "desktop_config_conflict")
    }
    if (current !== null) {
      const stored = parseEntries(current, maxEntries)
      if (stored.problem) {
        if (stored.json) {
          throw new HttpFailure(409, `${file} cannot be used: ${stored.problem}. Move it aside and try again.`, "desktop_config_unsafe")
        }
        fs.writeFileSync(`${target}.corrupt-${crypto.randomUUID()}`, current, { mode: 0o600 })
      }
    }
    writeFile(target, bytes)
    return { entries: checked.entries, revision: revisionOf(bytes) }
  }

  function readDirectoryEntry(kind, name) {
    const { dir, textFile } = DIRECTORIES[kind]
    const entryDir = path.join(home, dir, name)
    try {
      const stat = fs.lstatSync(entryDir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    } catch {
      return null
    }
    let manifest
    try {
      const bytes = readRegularFile(path.join(entryDir, "manifest.json"), MAX_MANIFEST_BYTES)
      if (bytes === null) return null
      manifest = JSON.parse(bytes.toString("utf8"))
    } catch {
      return null
    }
    if (!isPlainRecord(manifest)) return null
    let text = ""
    try {
      text = readRegularFile(path.join(entryDir, textFile), MAX_TEXT_BYTES)?.toString("utf8") ?? ""
    } catch {
      text = ""
    }
    return { id: name, manifest, text }
  }

  function listDirectory(kind) {
    const directory = path.join(home, DIRECTORIES[kind].dir)
    let names
    try {
      names = fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return []
      throw error
    }
    return names.flatMap((name) => {
      const entry = readDirectoryEntry(kind, name)
      return entry ? [entry] : []
    })
  }

  function entryId(raw) {
    const id = decodeURIComponent(raw ?? "")
    if (!SLUG_RE.test(id) || id.length > 120) {
      throw new HttpFailure(400, "Invalid entry id", "desktop_config_invalid_id")
    }
    return id
  }

  function handle(method, route, body) {
    const [, root, kind, rawId, ...rest] = route.split("/")
    if (root !== "config" || rest.length > 0) throw new HttpFailure(404, "Not found")
    if (Object.hasOwn(DOCUMENTS, kind) && rawId === undefined) {
      if (method === "GET") return readDocument(kind)
      if (method === "PUT") return writeDocument(kind, body)
    }
    if (kind === "rules" && rawId === undefined) {
      const file = path.join(home, "rules.md")
      if (method === "GET") {
        const bytes = readRegularFile(file, MAX_TEXT_BYTES)
        return { content: bytes === null ? "" : bytes.toString("utf8"), revision: revisionOf(bytes) }
      }
      if (method === "PUT") {
        if (!isPlainRecord(body) || typeof body.content !== "string") {
          throw new HttpFailure(400, "invalid body")
        }
        const bytes = Buffer.from(body.content, "utf8")
        writeFile(file, bytes)
        return { content: body.content, revision: revisionOf(bytes) }
      }
    }
    if (Object.hasOwn(DIRECTORIES, kind)) {
      if (rawId === undefined && method === "GET") return { entries: listDirectory(kind) }
      if (rawId !== undefined) {
        const id = entryId(rawId)
        const entryDir = path.join(home, DIRECTORIES[kind].dir, id)
        if (method === "GET") return { entry: readDirectoryEntry(kind, id) }
        if (method === "PUT") {
          if (!isPlainRecord(body) || !isPlainRecord(body.manifest) || typeof body.text !== "string") {
            throw new HttpFailure(400, "invalid body")
          }
          writeFile(path.join(entryDir, "manifest.json"), Buffer.from(JSON.stringify(body.manifest, null, 2)))
          writeFile(path.join(entryDir, DIRECTORIES[kind].textFile), Buffer.from(body.text, "utf8"))
          return { id }
        }
        if (method === "DELETE") {
          if (!fs.existsSync(entryDir)) return { removed: false }
          fs.rmSync(entryDir, { recursive: true, force: true })
          return { removed: true }
        }
      }
    }
    throw new HttpFailure(404, "Not found")
  }

  // Bodies cross a JSON boundary both ways, as over HTTP (undefined fields
  // vanish, and objects built in another realm become plain objects here).
  const wire = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  client.setDesktopConfigTransport(async ({ method, path: route, body: sent }) => {
    const body = wire(sent)
    requests.push({ method, path: route, body: wire(body) })
    const canned = pendingResponses.shift()
    if (canned) return canned
    try {
      return { status: 200, body: wire(handle(method, route, body)) }
    } catch (error) {
      if (!(error instanceof HttpFailure)) throw error
      return {
        status: error.status,
        body: error.code ? { error: error.message, code: error.code } : { error: error.message },
      }
    }
  })

  return {
    requests,
    beforeNextWrite(kind, run) {
      pendingWrites[kind].push(run)
    },
    respondOnce(response) {
      pendingResponses.push(response)
    },
    restore() {
      client.setDesktopConfigTransport()
    },
  }
}
