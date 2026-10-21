/**
 * The main process's access to the desktop configuration, which the backend
 * owns: `mcp-servers.json`, `hooks.json`, `rules.md`, `skills/<id>/` and
 * `subagents/<id>/` in the runtime home (shared/runtime-paths.cjs
 * `getBaseDir()`, passed to the backend as `BETTERC0DE_RUNTIME_HOME`).
 *
 * This process no longer writes those files. It decides what is stored
 * (native approval dialogs, approval markers, encryption of MCP secrets with
 * the settings key) and hands the result to `/api/v1/config/*`
 * (apps/backend/src/http/routes/desktopConfig.ts), which writes each file
 * atomically under a per-file lock. Requests carry the backend bearer twice:
 * as the bearer, and in the capability header that only this process can
 * send (renderer code never sees the token), so the renderer and paired
 * devices cannot write a command or an approval marker themselves.
 *
 * Read-modify-write goes through `mutateDocument`: the document is written
 * against the revision it was read at and retried on a conflict, so two
 * handlers that await at the same time cannot drop each other's change.
 */

const crypto = require("crypto")
const { getBackendConnection } = require("./backend-endpoint.cjs")

/** `DESKTOP_SHELL_CAPABILITY_HEADER` in @betterc0de/schema desktop-config.ts. */
const DESKTOP_SHELL_CAPABILITY_HEADER = "X-BetterC0de-Desktop-Shell"
const REQUEST_TIMEOUT_MS = 15_000
/** The MCP store alone may hold 4 MB; responses are bounded above that. */
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024
const MAX_MUTATION_ATTEMPTS = 6

/**
 * @typedef {{ status: number, body: any }} ConfigResponse
 * @typedef {(request: { method: string, path: string, body?: unknown }) => Promise<ConfigResponse>} ConfigTransport
 * @typedef {{ id: string, [key: string]: unknown }} StoredEntry
 * @typedef {{ entries: StoredEntry[], revision: string, problem?: string }} StoredDocument
 * @typedef {{ id: string, manifest: Record<string, unknown>, text: string }} DirectoryEntry
 */

class DesktopConfigError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string }} [details]
   */
  constructor(message, { status, code } = {}) {
    super(message)
    this.name = "DesktopConfigError"
    this.status = status
    this.code = code
  }
}

/** @type {ConfigTransport} */
async function fetchTransport({ method, path, body }) {
  const connection = getBackendConnection()
  if (!connection) {
    throw new DesktopConfigError(
      "BetterC0de's backend is not running yet, so your configuration cannot be read or saved. Try again in a moment.",
      { code: "backend_unavailable" },
    )
  }
  const response = await fetch(`http://127.0.0.1:${connection.port}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      [DESKTOP_SHELL_CAPABILITY_HEADER]: connection.token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const declared = Number(response.headers.get("content-length") || 0)
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new DesktopConfigError("The backend's configuration response is too large.")
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new DesktopConfigError("The backend's configuration response is too large.")
  }
  let parsed = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  return { status: response.status, body: parsed }
}

/** @type {ConfigTransport} */
let transport = fetchTransport

/**
 * Replace how requests reach the backend (tests use an in-process fake).
 * Pass nothing to restore the real one.
 * @param {ConfigTransport} [next]
 */
function setDesktopConfigTransport(next) {
  transport = typeof next === "function" ? next : fetchTransport
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function request(method, path, body) {
  const { status, body: payload } = await transport({ method, path, body })
  if (status >= 200 && status < 300) return payload
  const message =
    payload && typeof payload.error === "string" && payload.error
      ? payload.error
      : `The backend refused the configuration request (HTTP ${status}).`
  throw new DesktopConfigError(message, {
    status,
    code: payload && typeof payload.code === "string" ? payload.code : undefined,
  })
}

const DOCUMENT_PATHS = { mcp: "/config/mcp", hooks: "/config/hooks" }
const DIRECTORY_PATHS = { skills: "/config/skills", subagents: "/config/subagents" }

/**
 * @param {string} kind
 * @param {Record<string, string>} table
 */
function pathOf(kind, table) {
  const value = Object.prototype.hasOwnProperty.call(table, kind) ? table[kind] : null
  if (!value) throw new TypeError(`Unknown desktop configuration: ${kind}`)
  return value
}

/**
 * `mcp-servers.json` or `hooks.json` as stored. `problem` is set when the
 * file exists but is not a readable list (then `entries` is empty).
 * @param {"mcp" | "hooks"} kind
 * @returns {Promise<StoredDocument>}
 */
async function readDocument(kind) {
  const payload = await request("GET", pathOf(kind, DOCUMENT_PATHS))
  if (!payload || !Array.isArray(payload.entries) || typeof payload.revision !== "string") {
    throw new DesktopConfigError("The backend returned an invalid configuration document.")
  }
  return payload
}

/**
 * Replace a document; with `expectedRevision`, only if it is unchanged.
 * @param {"mcp" | "hooks"} kind
 * @param {StoredEntry[]} entries
 * @param {string | null} [expectedRevision]
 * @returns {Promise<StoredDocument>}
 */
async function writeDocument(kind, entries, expectedRevision) {
  return request("PUT", pathOf(kind, DOCUMENT_PATHS), {
    entries,
    ...(expectedRevision ? { expectedRevision } : {}),
  })
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {unknown} error */
function isRetryable(error) {
  const code = error?.code
  return code === "desktop_config_conflict" || code === "desktop_config_busy"
}

/**
 * Read a document, let `mutate` compute the next entries from the stored
 * ones, and write them against the revision that was read. `mutate` may run
 * more than once (after a conflicting write) and must not have side effects;
 * returning `null`/`undefined` leaves the document unchanged. Resolves to
 * what `mutate` last returned as `result` (or the entries).
 *
 * @template T
 * @param {"mcp" | "hooks"} kind
 * @param {(entries: StoredEntry[], document: StoredDocument) => ({ entries: StoredEntry[], result?: T } | null | undefined)} mutate
 * @returns {Promise<T | undefined>}
 */
async function mutateDocument(kind, mutate) {
  let lastError = null
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const document = await readDocument(kind)
    const next = mutate(structuredClone(document.entries), document)
    if (!next) return undefined
    try {
      await writeDocument(kind, next.entries, document.revision)
      return next.result
    } catch (error) {
      if (!isRetryable(error)) throw error
      lastError = error
      await delay(25 * (attempt + 1))
    }
  }
  throw new DesktopConfigError(
    "Your configuration kept changing while it was being saved; try again.",
    { code: lastError?.code },
  )
}

/**
 * The array store a `*-ipc.cjs` module keeps its entries in, with the
 * semantics the file-backed adapter had: `save` upserts by id (building the
 * entry with `buildEntry`), `update` patches one entry and stamps
 * `updatedAt`, `remove` drops one, `replaceAll` writes a whole list. Every
 * method is async and each mutation is a single revision-checked write.
 *
 * @param {"mcp" | "hooks"} kind
 * @param {object} [options]
 * @param {(input: any, existing: any, ctx: { now: string, id: string }) => StoredEntry} [options.buildEntry]
 * @param {number} [options.maxItems]
 * @param {number} [options.maxBytes] Largest serialized list it writes.
 * @param {(entries: StoredEntry[]) => StoredEntry[]} [options.toStored] Applied to every list before it is written.
 * @param {(entries: StoredEntry[]) => StoredEntry[]} [options.fromStored] Applied to every list after it is read.
 */
function createDocumentStore(kind, options = {}) {
  const maxItems =
    Number.isInteger(options.maxItems) && Number(options.maxItems) > 0
      ? Number(options.maxItems)
      : 1_000
  const maxBytes =
    Number.isInteger(options.maxBytes) && Number(options.maxBytes) > 0
      ? Number(options.maxBytes)
      : Infinity
  const toStored = options.toStored || ((entries) => entries)
  const fromStored = options.fromStored || ((entries) => entries)
  const buildEntry =
    options.buildEntry ||
    ((input, existing, { now, id }) => ({
      ...(existing ?? {}),
      ...input,
      id,
      createdAt: input.createdAt || existing?.createdAt || now,
      updatedAt: now,
    }))

  /** @param {StoredEntry[]} entries */
  function checkCount(entries) {
    if (entries.length > maxItems) {
      throw new Error(`Refusing to persist more than ${maxItems} entries`)
    }
    return entries
  }

  /** @param {StoredEntry[]} entries */
  function checkSize(entries) {
    if (
      maxBytes !== Infinity &&
      Buffer.byteLength(JSON.stringify(entries, null, 2), "utf8") > maxBytes
    ) {
      throw new Error(`File output exceeds ${maxBytes} bytes`)
    }
    return entries
  }

  async function list() {
    const document = await readDocument(kind)
    if (document.problem) {
      console.warn(`[desktop-config] ${document.problem}`)
    }
    return fromStored(document.entries)
  }

  return {
    /** The stored document, `problem` included. */
    read: () => readDocument(kind),
    list,
    /** @param {string} id */
    async get(id) {
      return (await list()).find((entry) => entry.id === id) ?? null
    },
    /** @param {any} input */
    async save(input) {
      return mutateDocument(kind, (stored) => {
        const items = fromStored(stored)
        const id = input.id || crypto.randomUUID()
        const now = new Date().toISOString()
        const index = items.findIndex((item) => item.id === id)
        const entry = buildEntry(input, index >= 0 ? items[index] : null, { now, id })
        if (index >= 0) items[index] = entry
        else items.push(entry)
        return { entries: checkSize(toStored(checkCount(items))), result: entry }
      })
    },
    /**
     * @param {string} id
     * @param {(entry: StoredEntry) => StoredEntry} patcher
     */
    async update(id, patcher) {
      return (
        (await mutateDocument(kind, (stored) => {
          const items = fromStored(stored)
          const index = items.findIndex((item) => item.id === id)
          if (index < 0) return null
          items[index] = {
            ...patcher(items[index]),
            id,
            updatedAt: new Date().toISOString(),
          }
          return { entries: checkSize(toStored(items)), result: items[index] }
        })) ?? null
      )
    },
    /**
     * Remove one entry; the others are written back exactly as stored.
     * @param {string} id
     */
    async remove(id) {
      return (
        (await mutateDocument(kind, (stored) => {
          const next = stored.filter((item) => item.id !== id)
          return next.length === stored.length ? null : { entries: next, result: true }
        })) ?? false
      )
    },
    /**
     * Compute the next list from the current one (`null` keeps it).
     * @param {(entries: StoredEntry[]) => StoredEntry[] | null | undefined} compute
     */
    async replaceWith(compute) {
      return mutateDocument(kind, (stored) => {
        const next = compute(fromStored(stored))
        return next ? { entries: checkSize(toStored(checkCount(next))), result: next } : null
      })
    },
    /** @param {StoredEntry[]} entries */
    async replaceAll(entries) {
      await writeDocument(kind, checkSize(toStored(checkCount(entries))))
    },
  }
}

/** `rules.md` (empty when there is none). */
async function readRules() {
  const payload = await request("GET", "/config/rules")
  return typeof payload?.content === "string" ? payload.content : ""
}

/** @param {string} content */
async function writeRules(content) {
  await request("PUT", "/config/rules", { content })
}

/**
 * Every readable skill or subagent: `{ id, manifest, text }`.
 * @param {"skills" | "subagents"} kind
 * @returns {Promise<DirectoryEntry[]>}
 */
async function listDirectory(kind) {
  const payload = await request("GET", pathOf(kind, DIRECTORY_PATHS))
  return Array.isArray(payload?.entries) ? payload.entries : []
}

/**
 * @param {"skills" | "subagents"} kind
 * @param {string} id
 * @returns {Promise<DirectoryEntry | null>}
 */
async function getDirectoryEntry(kind, id) {
  const payload = await request(
    "GET",
    `${pathOf(kind, DIRECTORY_PATHS)}/${encodeURIComponent(id)}`,
  )
  return payload?.entry ?? null
}

/**
 * @param {"skills" | "subagents"} kind
 * @param {string} id
 * @param {Record<string, unknown>} manifest
 * @param {string} text
 */
async function putDirectoryEntry(kind, id, manifest, text) {
  return request("PUT", `${pathOf(kind, DIRECTORY_PATHS)}/${encodeURIComponent(id)}`, {
    manifest,
    text,
  })
}

/**
 * @param {"skills" | "subagents"} kind
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function removeDirectoryEntry(kind, id) {
  const payload = await request(
    "DELETE",
    `${pathOf(kind, DIRECTORY_PATHS)}/${encodeURIComponent(id)}`,
  )
  return payload?.removed === true
}

module.exports = {
  DESKTOP_SHELL_CAPABILITY_HEADER,
  DesktopConfigError,
  createDocumentStore,
  getDirectoryEntry,
  listDirectory,
  mutateDocument,
  putDirectoryEntry,
  readDocument,
  readRules,
  removeDirectoryEntry,
  setDesktopConfigTransport,
  writeDocument,
  writeRules,
}
