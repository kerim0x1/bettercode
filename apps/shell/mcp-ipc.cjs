/**
 * MCP server IPC handlers. Installs, enables, removes, and probe-spawns
 * Model-Context-Protocol servers configured by the user.
 *
 * SECURITY: `probeMcp` spawns an arbitrary binary chosen by the renderer,
 * so it always shows a confirmation dialog (unless `requireConfirm: false`)
 * with the command + args preview. `shell: false` prevents shell expansion
 * but does not validate the binary — that's the user's call.
 *
 * Storage: `mcp-servers.json` belongs to the backend, which writes it under a
 * lock; this process reads and writes it only through `/api/v1/config/mcp`
 * (shared/desktop-config-client.cjs), against the revision it read.
 *
 * Secrets: `env` values and static HTTP `headers` routinely hold long-lived
 * credentials (GITHUB_TOKEN, `Authorization: Bearer …`). At rest they are
 * encrypted with the same OS-protected settings key the backend uses for
 * settings.json (`enc:v1:` AES-256-GCM, readable by the backend's
 * `decryptSecret`) once `setMcpEncryptionKey` has been called: this process
 * encrypts before it sends a list and decrypts what it reads. Plaintext an
 * older version left in the file is encrypted by the backend when it starts
 * (services/desktop-config/migration.ts). The renderer never
 * receives a value: `mcp:list` returns `MCP_SECRET_PLACEHOLDER` for every
 * non-empty value, and a save/probe that sends the placeholder back keeps the
 * stored value for that key.
 *
 * Approval: a stored command server is started later for agent turns without
 * anyone watching, so a save that introduces a new or changed command line
 * (`command` + `args`) is confirmed by the user in a native main-process
 * dialog that lists it (shared/command-approval.cjs), and the entry keeps the
 * approval marker. An unchanged command line keeps what it had and is not
 * asked about again; env and enabled-state edits never change it.
 */

const { BrowserWindow, dialog } = require("electron")
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { IpcChannel } = require("./shared/ipc-contract.cjs")
const { safeHandle, rawHandle } = require("./shared/ipc-handlers-factory.cjs")
const { createDocumentStore } = require("./shared/desktop-config-client.cjs")
const appConfig = require("./shared/appConfig.cjs")
const { runCli } = require("./shared/spawn-cli.cjs")
const {
  MAX_DIALOG_COMMAND_CHARS,
  confirmCommandApproval,
  createApprovalMarker,
  isApprovalMarkerValid,
} = require("./shared/command-approval.cjs")
const {
  getBaseDir,
  slugify,
  getFocusedWindow,
} = require("./shared/runtime-paths.cjs")
const { assertMcpServerRecord } = require("./shared/runtime-records.cjs")

// The same bounds as the shared record (`RUNTIME_MCP_LIMITS` in
// @betterc0de/schema/runtime-records), which the backend's reader
// (AcpMcpServers.ts) also uses; scripts/runtime-records.test.mjs keeps them
// equal.
const MAX_MCP_ENTRIES = 128
const MAX_MCP_NAME_CHARS = 256
const MAX_MCP_COMMAND_CHARS = 4_096
const MAX_MCP_ARGS = 32
const MAX_MCP_ARG_CHARS = 2_048
const MAX_MCP_ARGS_CHARS = 16_384
const MAX_MCP_ENV_ENTRIES = 64
const MAX_MCP_ENV_VALUE_CHARS = 8_192
const MAX_MCP_ENV_CHARS = 65_536
const MAX_MCP_STORE_BYTES = 4 * 1024 * 1024
// Ciphertext of a maximal value (base64 of iv + tag + bytes, plus prefix).
// Only reachable when the key is unavailable and values stay opaque.
const MAX_MCP_ENCRYPTED_VALUE_CHARS = 16_384
const MCP_SECRET_PREFIX = "enc:v1:"
/** What the renderer sees instead of a stored secret value. */
const MCP_SECRET_PLACEHOLDER = "••••••••"
const MCP_SCOPES = new Set(["user", "project", "local"])
const MCP_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MCP_HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/
const MCP_FORBIDDEN_ENV_KEYS = new Set([
  "BETTERC0DE_SETTINGS_KEY",
  "BASH_ENV",
  "ENV",
  "ELECTRON_RUN_AS_NODE",
  "LD_AUDIT",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
])

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedString(value, label, maxChars, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required`)
    return ""
  }
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if (required && normalized.length === 0) {
    throw new Error(`${label} is required`)
  }
  if (normalized.length > maxChars) {
    throw new Error(`${label} exceeds ${maxChars} characters`)
  }
  return normalized
}

function normalizeMcpArgs(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("MCP args must be an array")
  if (value.length > MAX_MCP_ARGS) {
    throw new Error(`MCP args exceed ${MAX_MCP_ARGS} entries`)
  }
  let total = 0
  return value.map((arg, index) => {
    if (typeof arg !== "string") {
      throw new Error(`MCP arg ${index + 1} must be a string`)
    }
    if (arg.length > MAX_MCP_ARG_CHARS) {
      throw new Error(
        `MCP arg ${index + 1} exceeds ${MAX_MCP_ARG_CHARS} characters`,
      )
    }
    total += arg.length
    if (total > MAX_MCP_ARGS_CHARS) {
      throw new Error(`MCP args exceed ${MAX_MCP_ARGS_CHARS} characters total`)
    }
    return arg
  })
}

function normalizeMcpEnv(value) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) throw new Error("MCP env must be an object")
  const entries = Object.entries(value)
  if (entries.length > MAX_MCP_ENV_ENTRIES) {
    throw new Error(`MCP env exceeds ${MAX_MCP_ENV_ENTRIES} entries`)
  }
  let total = 0
  const normalized = {}
  for (const [key, rawValue] of entries) {
    const upper = key.toUpperCase()
    if (
      !MCP_ENV_KEY_RE.test(key) ||
      MCP_FORBIDDEN_ENV_KEYS.has(upper) ||
      upper.startsWith("DYLD_")
    ) {
      throw new Error(`Unsafe MCP environment key: ${key}`)
    }
    if (typeof rawValue !== "string") {
      throw new Error(`MCP environment value for ${key} must be a string`)
    }
    const encrypted = isEncryptedMcpSecret(rawValue)
    const maxValueChars = encrypted
      ? MAX_MCP_ENCRYPTED_VALUE_CHARS
      : MAX_MCP_ENV_VALUE_CHARS
    if (rawValue.length > maxValueChars) {
      throw new Error(
        `MCP environment value for ${key} exceeds ${maxValueChars} characters`,
      )
    }
    // Opaque ciphertext (key unavailable) was bounded when it was plaintext.
    total += key.length + (encrypted ? 0 : rawValue.length)
    if (total > MAX_MCP_ENV_CHARS) {
      throw new Error(`MCP env exceeds ${MAX_MCP_ENV_CHARS} characters total`)
    }
    normalized[key] = rawValue
  }
  return normalized
}

function normalizeMcpHeaders(value, { environmentReferences = false } = {}) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new Error(
      environmentReferences
        ? "MCP environment-backed headers must be an object"
        : "MCP headers must be an object",
    )
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_MCP_ENV_ENTRIES) {
    throw new Error(`MCP headers exceed ${MAX_MCP_ENV_ENTRIES} entries`)
  }
  let total = 0
  const normalizedEntries = []
  for (const [name, rawValue] of entries) {
    if (!MCP_HTTP_HEADER_NAME_RE.test(name)) {
      throw new Error(`Invalid MCP HTTP header name: ${name}`)
    }
    if (typeof rawValue !== "string") {
      throw new Error(`MCP HTTP header value for ${name} must be a string`)
    }
    if (environmentReferences && !MCP_ENV_KEY_RE.test(rawValue)) {
      throw new Error(
        `MCP HTTP header environment reference for ${name} must be an environment variable name`,
      )
    }
    if (!environmentReferences && /[\0\r\n]/.test(rawValue)) {
      throw new Error(`MCP HTTP header value for ${name} contains a newline`)
    }
    const encrypted = !environmentReferences && isEncryptedMcpSecret(rawValue)
    const maxValueChars = encrypted
      ? MAX_MCP_ENCRYPTED_VALUE_CHARS
      : MAX_MCP_ENV_VALUE_CHARS
    if (rawValue.length > maxValueChars) {
      throw new Error(
        `MCP HTTP header value for ${name} exceeds ${maxValueChars} characters`,
      )
    }
    total += name.length + (encrypted ? 0 : rawValue.length)
    if (total > MAX_MCP_ENV_CHARS) {
      throw new Error(
        `MCP headers exceed ${MAX_MCP_ENV_CHARS} characters total`,
      )
    }
    normalizedEntries.push([name, rawValue])
  }
  return Object.fromEntries(normalizedEntries)
}

/**
 * S2: resolve a renderer-supplied `command` to an absolute file path before
 * we hand it to `spawn`. Without this, a relative name like `node` is looked
 * up via `PATH` at spawn time — a planted shim earlier in the user's PATH
 * gets RCE on every probe. We resolve once, show the resolved path in the
 * confirmation dialog, and refuse to launch if the resolution fails.
 *
 * Returns null if the command cannot be resolved to a real file.
 */
function resolveCommandToAbsolute(command) {
  if (typeof command !== "string" || command.trim().length === 0) return null
  const trimmed = command.trim()

  // Absolute paths are vetted with a stat call below.
  if (path.isAbsolute(trimmed)) {
    return canonicalRegularExecutable(trimmed)
  }

  // Reject paths with separators that aren't absolute — those are relative
  // file references, which are even more dangerous than bare names because
  // they depend on the current working directory.
  if (trimmed.includes("/") || trimmed.includes("\\")) return null

  // Walk PATH manually so we can be deterministic (Node's spawn does this
  // implicitly, but we need to know the resolved path for the dialog).
  const isWin = process.platform === "win32"
  const pathSep = isWin ? ";" : ":"
  const pathExt = isWin
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
    : [""]
  const dirs = (process.env.PATH || "")
    .split(pathSep)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .slice(0, 256)
  for (const dir of dirs) {
    for (const ext of pathExt) {
      const candidate = path.join(dir, trimmed + ext)
      const canonical = canonicalRegularExecutable(candidate)
      if (canonical) return canonical
    }
  }
  return null
}

function canonicalRegularExecutable(p) {
  try {
    const canonical = fs.realpathSync.native(p)
    const st = fs.lstatSync(canonical)
    if (!st.isFile() || st.isSymbolicLink()) return null
    if (process.platform !== "win32") {
      fs.accessSync(canonical, fs.constants.X_OK)
    }
    return path.normalize(canonical)
  } catch {
    return null
  }
}

function normalizeMcpConfig(config, { requireIdentity = true } = {}) {
  if (!isPlainObject(config)) throw new Error("MCP config must be an object")
  const rawName =
    config.name ??
    config.id ??
    (requireIdentity ? undefined : config.command)
  const name = boundedString(
    rawName,
    "MCP name",
    MAX_MCP_NAME_CHARS,
    { required: requireIdentity },
  )
  const id = slugify(config.id || name || "mcp-probe")
  if (!id) throw new Error("MCP id/name must contain letters or numbers")
  const type = boundedString(config.type ?? "command", "MCP type", 32, {
    required: true,
  })
  const command = boundedString(
    config.command,
    "MCP command",
    MAX_MCP_COMMAND_CHARS,
  )
  const url = boundedString(config.url, "MCP URL", 4_096)
  if (type === "command" && !command) {
    throw new Error("MCP command is required for command servers")
  }
  if (type !== "command" && !command && !url) {
    throw new Error("MCP command or URL is required")
  }
  // Older runtime stores used `env` for remote static headers. Keep that
  // representation readable while new imports use the explicit `headers`.
  const env =
    type === "command"
      ? normalizeMcpEnv(config.env)
      : normalizeMcpHeaders(config.env)
  const headers =
    config.headers === undefined
      ? undefined
      : normalizeMcpHeaders(config.headers)
  const headerEnv =
    config.headerEnv === undefined
      ? undefined
      : normalizeMcpHeaders(config.headerEnv, {
          environmentReferences: true,
        })
  if (
    type === "command" &&
    ((headers && Object.keys(headers).length > 0) ||
      (headerEnv && Object.keys(headerEnv).length > 0))
  ) {
    throw new Error("MCP HTTP headers require a remote MCP transport")
  }
  const origin = normalizeMcpOrigin(config)
  const approval = normalizeApprovalMarker(config.approval)
  const source = normalizeMcpSource(config.source)
  return {
    id,
    name,
    command,
    args: normalizeMcpArgs(config.args),
    env,
    ...(headers === undefined ? {} : { headers }),
    ...(headerEnv === undefined ? {} : { headerEnv }),
    enabled: config.enabled !== false,
    installedAt:
      boundedString(config.installedAt, "MCP installedAt", 128) ||
      new Date().toISOString(),
    type,
    url: url || null,
    authenticated: !!config.authenticated,
    ...origin,
    ...(source ? { source } : {}),
    ...(approval ? { approval } : {}),
  }
}

/**
 * The CLI an imported server came from (`claude`, `codex`), as the scanner
 * names it, so Settings can say where it was imported from. Display only:
 * nothing decides how a server runs by it. Anything that is not a short
 * lowercase name is dropped rather than refused, and an edit that sends no
 * source keeps the stored one (`mcpStore.save` merges).
 */
function normalizeMcpSource(value) {
  if (typeof value !== "string") return ""
  const source = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(source) ? source : ""
}

/**
 * The stored shape of an approval marker (shared/command-approval.cjs), or
 * null. Only main-process code sets one; renderer input has it stripped
 * (`withoutApprovalMarker`) before it gets here.
 */
function normalizeApprovalMarker(value) {
  if (!isPlainObject(value)) return null
  const { v, alg, digest } = value
  if (
    !Number.isInteger(v) ||
    typeof alg !== "string" ||
    alg.length === 0 ||
    alg.length > 32 ||
    typeof digest !== "string" ||
    digest.length === 0 ||
    digest.length > 128
  ) {
    return null
  }
  return { v, alg, digest }
}

function withoutApprovalMarker(config) {
  if (!isPlainObject(config)) return config
  const { approval: _ignored, ...rest } = config
  return rest
}

/**
 * Where an entry came from. A server declared by a repository (`project`) or
 * by a per-project Claude entry (`local`) must never become a global server:
 * the backend applies only those to their own, explicitly trusted workspace
 * (`projectRoot`) and ignores them everywhere else. Dropping this on a
 * rewrite used to make an imported repository server indistinguishable from
 * one the user configured, so it ran in every workspace. User-level entries
 * carry no origin fields.
 */
function normalizeMcpOrigin(config) {
  const scope = typeof config.scope === "string" ? config.scope.trim() : ""
  if (!scope || scope === "user") return {}
  if (!MCP_SCOPES.has(scope)) throw new Error(`Unsupported MCP scope: ${scope}`)
  const rawRoot = boundedString(config.projectRoot, "MCP projectRoot", 4_096)
  const projectRoot =
    rawRoot && !rawRoot.includes("\0") && path.isAbsolute(rawRoot)
      ? path.resolve(rawRoot)
      : null
  return { scope, projectRoot }
}

// ── Secrets at rest ─────────────────────────────────────────────────────────

/** 32-byte settings key from main (`settingsEncryptionKey`), or null. */
let mcpSecretKey = null

function parseMcpSecretKey(base64Key) {
  if (typeof base64Key !== "string" || !base64Key) return null
  try {
    const key = Buffer.from(base64Key, "base64")
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

function isEncryptedMcpSecret(value) {
  return typeof value === "string" && value.startsWith(MCP_SECRET_PREFIX)
}

/** Same wire format as the backend's `settings/crypto.ts` `encryptSecret`. */
function encryptMcpSecret(value, key = mcpSecretKey) {
  if (!key || typeof value !== "string" || !value || isEncryptedMcpSecret(value)) {
    return value
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return (
    MCP_SECRET_PREFIX +
    Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")
  )
}

/**
 * Plaintext for a value this key encrypted. Without the key, or for a value
 * another key wrote (profile copied between machines), the ciphertext stays
 * opaque: it round-trips unchanged and is never handed to a child process.
 */
function decryptMcpSecret(value, key = mcpSecretKey) {
  if (!isEncryptedMcpSecret(value) || !key) return value
  try {
    const payload = Buffer.from(value.slice(MCP_SECRET_PREFIX.length), "base64")
    if (payload.length < 28) return value
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      payload.subarray(0, 12),
    )
    decipher.setAuthTag(payload.subarray(12, 28))
    return Buffer.concat([
      decipher.update(payload.subarray(28)),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    return value
  }
}

function mapStringRecord(record, transform) {
  if (!isPlainObject(record)) return record
  const output = {}
  for (const [name, value] of Object.entries(record)) {
    output[name] = typeof value === "string" ? transform(value) : value
  }
  return output
}

/**
 * Applies `transform` to every secret-bearing value of an entry: `env` (for a
 * remote server in older stores this held its static headers) and `headers`.
 * `headerEnv` holds environment variable *names* and is left alone.
 */
function mapMcpSecrets(entry, transform) {
  if (!isPlainObject(entry)) return entry
  return {
    ...entry,
    ...(entry.env !== undefined ? { env: mapStringRecord(entry.env, transform) } : {}),
    ...(entry.headers !== undefined
      ? { headers: mapStringRecord(entry.headers, transform) }
      : {}),
  }
}

function hasOpaqueMcpSecret(entry) {
  return [entry?.env, entry?.headers].some(
    (record) =>
      isPlainObject(record) &&
      Object.values(record).some((value) => isEncryptedMcpSecret(value)),
  )
}

// ── Renderer projection ─────────────────────────────────────────────────────

function redactRecord(record) {
  return mapStringRecord(record, (value) => (value ? MCP_SECRET_PLACEHOLDER : ""))
}

/**
 * What the renderer may see of a stored entry: every non-empty env/header
 * value becomes `MCP_SECRET_PLACEHOLDER`; key names stay so the user can see
 * and edit which variables are configured.
 */
function redactMcpForRenderer(entry) {
  if (!isPlainObject(entry)) return entry
  const env = isPlainObject(entry.env) ? redactRecord(entry.env) : {}
  const headers = isPlainObject(entry.headers) ? redactRecord(entry.headers) : undefined
  return {
    // The approval marker is main-process bookkeeping; a save never takes
    // one from the renderer.
    ...withoutApprovalMarker(entry),
    env,
    ...(headers === undefined ? {} : { headers }),
    envKeys: Object.keys(env),
    headerKeys: headers ? Object.keys(headers) : [],
    secretsRedacted: true,
  }
}

function resolvePlaceholderRecord(record, stored, label) {
  if (!isPlainObject(record)) return record
  const output = {}
  for (const [name, value] of Object.entries(record)) {
    if (value !== MCP_SECRET_PLACEHOLDER) {
      output[name] = value
      continue
    }
    const kept =
      isPlainObject(stored) && Object.prototype.hasOwnProperty.call(stored, name)
        ? stored[name]
        : undefined
    if (typeof kept !== "string") {
      throw new Error(
        `${label} ${name} has no stored value to keep; enter the value again`,
      )
    }
    output[name] = kept
  }
  return output
}

/**
 * Replace placeholders the renderer sent back with the values stored for the
 * same key on `existing`. A placeholder for a key that has no stored value is
 * an error rather than a literal "••••••••" credential.
 */
function withStoredMcpSecrets(config, existing) {
  if (!isPlainObject(config)) return config
  return {
    ...config,
    ...(config.env !== undefined
      ? {
          env: resolvePlaceholderRecord(
            config.env,
            existing?.env,
            "MCP environment value",
          ),
        }
      : {}),
    ...(config.headers !== undefined
      ? {
          headers: resolvePlaceholderRecord(
            config.headers,
            existing?.headers,
            "MCP header",
          ),
        }
      : {}),
  }
}

function containsMcpSecretPlaceholder(config) {
  return [config?.env, config?.headers].some(
    (record) =>
      isPlainObject(record) &&
      Object.values(record).some((value) => value === MCP_SECRET_PLACEHOLDER),
  )
}

// ── Store ───────────────────────────────────────────────────────────────────

// What the backend stores is ciphertext once a key is set. The document store
// decrypts every list it reads and encrypts every list it writes, so the rest
// of this process works on plaintext through `mcpStore`. Created on first use.
let documentStore = null
function mcpDocumentStore() {
  documentStore ??= createDocumentStore("mcp", {
    maxItems: MAX_MCP_ENTRIES,
    maxBytes: MAX_MCP_STORE_BYTES,
    fromStored: (entries) =>
      entries.map((entry) => mapMcpSecrets(entry, (value) => decryptMcpSecret(value))),
    toStored: (entries) =>
      entries.map((entry) => mapMcpSecrets(entry, (value) => encryptMcpSecret(value))),
  })
  return documentStore
}

const mcpStore = {
  list: () => mcpDocumentStore().list(),
  async find(id) {
    return (await mcpStore.list()).find((entry) => entry.id === id) ?? null
  },
  async save(input) {
    // Merge existing fields with the new normalized config so partial
    // installs (re-installing an existing server) don't drop unrelated
    // fields the caller didn't touch.
    const normalized = normalizeMcpConfig(input)
    let saved = null
    await mcpDocumentStore().replaceWith((items) => {
      const index = items.findIndex((item) => item.id === normalized.id)
      const entry = index >= 0 ? { ...items[index], ...normalized } : { ...normalized }
      // The approval belongs to the command line being saved, never to the
      // one it replaces.
      if (!normalized.approval) delete entry.approval
      assertMcpServerRecord(entry)
      if (index >= 0) {
        items[index] = entry
      } else {
        if (items.length >= MAX_MCP_ENTRIES) {
          throw new Error(`Refusing to persist more than ${MAX_MCP_ENTRIES} entries`)
        }
        items.push(entry)
      }
      saved = entry
      return items
    })
    return saved
  },
  async update(id, patcher) {
    let updated = null
    await mcpDocumentStore().replaceWith((items) => {
      const index = items.findIndex((item) => item.id === id)
      updated = null
      if (index < 0) return null
      items[index] = assertMcpServerRecord({
        ...patcher(items[index]),
        id,
        updatedAt: new Date().toISOString(),
      })
      updated = items[index]
      return items
    })
    return updated
  },
  // Removal writes the other entries back exactly as stored.
  remove: (id) => mcpDocumentStore().remove(id),
  replaceAll: (entries) => mcpDocumentStore().replaceAll(entries),
  /** Compute the next plaintext list from the current one (`null` keeps it). */
  replaceWith: (compute) => mcpDocumentStore().replaceWith(compute),
}

/**
 * Installs the OS-protected settings key (the one main hands the backend
 * over its IPC channel). Lists are encrypted with it before they are sent to
 * the backend and decrypted after they are read; the backend encrypts any
 * plaintext an older version left in mcp-servers.json when it starts.
 * Without a key (safeStorage unavailable) values stay plaintext, matching
 * the backend's settings fallback.
 */
function setMcpEncryptionKey(base64Key) {
  mcpSecretKey = parseMcpSecretKey(base64Key)
}

function executableIdentity(filePath) {
  const canonical = canonicalRegularExecutable(filePath)
  if (!canonical) return null
  const stat = fs.statSync(canonical)
  return {
    path: canonical,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

function sameExecutableIdentity(left, right) {
  return (
    !!left &&
    !!right &&
    left.path === right.path &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  )
}

function mcpConfirmationDetail(server, resolvedCommand) {
  const args = server.args.map((arg, index) => `${index + 1}. ${JSON.stringify(arg)}`)
  const envNames = Object.keys(server.env).sort()
  // The arguments listed here are the ones the child actually receives:
  // `quoteWindowsCmdArg` now escapes the cmd layer correctly, so the displayed
  // value and the delivered argv agree. The one remaining divergence is `%`,
  // which cmd expands from the environment before caret processing — call it
  // out rather than showing text that will not be what runs.
  const percentArgs =
    process.platform === "win32"
      ? server.args.filter((arg) => typeof arg === "string" && arg.includes("%"))
      : []
  return [
    `Command: ${JSON.stringify(server.command)}`,
    ...(resolvedCommand !== server.command
      ? [`Resolved: ${JSON.stringify(resolvedCommand)}`]
      : []),
    `Arguments (${server.args.length}):`,
    ...(args.length > 0 ? args : ["(none)"]),
    `Environment keys (${envNames.length}; values hidden):`,
    ...(envNames.length > 0 ? envNames : ["(none)"]),
    ...(percentArgs.length > 0
      ? [
          "",
          `Warning: ${percentArgs.length} argument(s) contain "%". Windows may substitute an environment variable there, so the value that runs can differ from the value shown.`,
        ]
      : []),
    "",
    "This launches an arbitrary binary on your machine. Only proceed for MCP servers you trust.",
  ].join("\n")
}

// ── Approval of stored command lines ────────────────────────────────────────

const MCP_APPROVAL_KIND = "mcp"

/**
 * What the user approves for a command server: the executable and its exact
 * argument vector, canonicalized. Empty for a server that runs nothing
 * locally (a remote URL).
 */
function mcpLaunchCommandLine(server) {
  const command = typeof server?.command === "string" ? server.command.trim() : ""
  if (!command) return ""
  const args = Array.isArray(server.args)
    ? server.args.filter((arg) => typeof arg === "string")
    : []
  return JSON.stringify([command, ...args])
}

/** True when `entry` carries a valid approval for its current command line. */
function isMcpLaunchApproved(entry) {
  const commandLine = mcpLaunchCommandLine(entry)
  return (
    commandLine !== "" &&
    isApprovalMarkerValid(MCP_APPROVAL_KIND, commandLine, entry?.approval)
  )
}

/** One server's command line as the approval dialog lists it. */
function describeMcpLaunch(server) {
  const args = Array.isArray(server.args) ? server.args : []
  const envNames = isPlainObject(server.env) ? Object.keys(server.env).sort() : []
  const label =
    server.name && server.id && server.name !== server.id
      ? `${server.name} (${server.id})`
      : server.name || server.id || "MCP server"
  const percentArgs =
    process.platform === "win32" &&
    args.some((arg) => typeof arg === "string" && arg.includes("%"))
  return [
    label,
    `  ${JSON.stringify(server.command)}`,
    ...args.map((arg, index) => `  ${index + 1}. ${JSON.stringify(arg)}`),
    ...(envNames.length > 0
      ? [`  Environment: ${envNames.join(", ")} (values hidden)`]
      : []),
    ...(percentArgs
      ? ['  Note: Windows may replace "%…%" in these arguments with an environment variable.']
      : []),
  ].join("\n")
}

/** Group descriptions into as few dialogs as fit without clipping. */
function chunkLaunchDescriptions(items) {
  const chunks = []
  let current = []
  let size = 0
  for (const item of items) {
    const length = item.text.length + 2
    if (current.length > 0 && size + length > MAX_DIALOG_COMMAND_CHARS) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function parentWindowOf(event) {
  try {
    return event?.sender && BrowserWindow
      ? BrowserWindow.fromWebContents(event.sender)
      : null
  } catch {
    return null
  }
}

/**
 * Approve the command lines of MCP servers about to be stored. A server
 * without a command needs nothing; one whose command line equals the stored
 * entry `findExisting` returns keeps that entry's marker (or none, for
 * entries from before approvals or from CLI auto-sync of the user's own CLI
 * configuration). Every other server is listed, with its exact command and
 * arguments, in a native dialog; several fit in one dialog.
 *
 * Resolves to the approval marker for each server (aligned with `servers`,
 * null where none applies), or null when the user did not allow them.
 */
async function approveMcpLaunches(
  servers,
  { findExisting = () => null, parent = null, title, message, dialogImpl = dialog } = {},
) {
  const approvals = servers.map(() => null)
  const pending = []
  servers.forEach((server, index) => {
    const commandLine = mcpLaunchCommandLine(server)
    if (!commandLine) return
    const existing = findExisting(server)
    if (existing && mcpLaunchCommandLine(existing) === commandLine) {
      approvals[index] = normalizeApprovalMarker(existing.approval)
      return
    }
    pending.push({ index, text: describeMcpLaunch(server) })
  })
  const chunks = chunkLaunchDescriptions(pending)
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const part = chunks.length > 1 ? ` (${chunkIndex + 1} of ${chunks.length})` : ""
    const allowed = await confirmCommandApproval(dialogImpl, parent, {
      title: `${title || "Allow MCP server command?"}${part}`,
      message:
        message ||
        (chunk.length === 1
          ? "Save an MCP server that runs this command?"
          : `Save ${chunk.length} MCP servers that run these commands?`),
      commandLabel: chunk.length === 1 ? "MCP server:" : "MCP servers:",
      command: chunk.map((item) => item.text).join("\n\n"),
      notice:
        "BetterC0de starts these commands for agent turns without asking again. " +
        "Only allow MCP servers you trust.",
    })
    if (!allowed) return null
    for (const { index } of chunk) {
      approvals[index] = createApprovalMarker(
        MCP_APPROVAL_KIND,
        mcpLaunchCommandLine(servers[index]),
      )
    }
  }
  return approvals
}

async function probeMcp(config, { requireConfirm = true } = {}) {
  let server
  try {
    server = normalizeMcpConfig(config || {}, { requireIdentity: false })
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
  if (!server.command) return { ok: false, error: "Missing command" }

  // S2: resolve the binary to an absolute path NOW, before any user prompt.
  // The dialog shows the resolved path so the user can see exactly which
  // binary they're approving — `node` getting hijacked by a planted shim on
  // PATH is the threat we're closing here.
  const resolvedCommand = resolveCommandToAbsolute(server.command)
  if (!resolvedCommand) {
    return {
      ok: false,
      error: `Refusing to launch MCP server "${server.name || server.id}": command "${server.command}" could not be resolved to a file on disk.`,
    }
  }
  const approvedIdentity = executableIdentity(resolvedCommand)
  if (!approvedIdentity) {
    return { ok: false, error: "Resolved MCP command is no longer executable" }
  }

  if (requireConfirm) {
    const win = getFocusedWindow()
    const confirm = await dialog.showMessageBox(win, {
      type: "warning",
      title: "Launch MCP server?",
      message: `Start MCP server ${JSON.stringify(server.name || server.id)}?`,
      detail: mcpConfirmationDetail(server, resolvedCommand),
      buttons: ["Cancel", "Launch"],
      defaultId: 0,
      cancelId: 0,
    })
    if (confirm.response !== 1) {
      return { ok: false, error: "User cancelled" }
    }
  }

  const launchIdentity = executableIdentity(resolvedCommand)
  if (!sameExecutableIdentity(approvedIdentity, launchIdentity)) {
    return {
      ok: false,
      error:
        "The MCP command changed after it was approved. Review the command and try again.",
    }
  }

  try {
    const result = await runCli(resolvedCommand, server.args || [], {
      env: server.env || {},
      cwd: getBaseDir(),
      timeoutMs: appConfig.MCP_PROBE_TIMEOUT_MS,
      maxOutputBytes: appConfig.MCP_OUTPUT_MAX_CHARS * 4,
    })
    const response = {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      code: result.code,
      signal: result.signal,
      processTreeVerified: result.processTreeVerified,
    }
    if (result.timedOut) {
      return {
        ok: true,
        ...response,
        note: "Process launched successfully and its process tree was stopped after the probe timeout.",
      }
    }
    if (result.code === 0) {
      return {
        ok: true,
        ...response,
        ...(result.processTreeVerified === false
          ? {
              note:
                "The MCP launcher exited, but Windows cannot prove that it left no detached descendants without Job Object support.",
            }
          : {}),
      }
    }
    return {
      ok: false,
      ...response,
      error:
        response.stderr ||
        response.stdout ||
        `Process exited with code ${result.code}`,
    }
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: error?.message || String(error),
    }
  }

}

/**
 * A probe of a saved server arrives redacted. Its stored values are used only
 * when the probe launches exactly the saved command line (or URL), so a page
 * cannot point a stored credential at a different binary.
 */
async function resolveProbeSecrets(config) {
  let resolved = config
  if (containsMcpSecretPlaceholder(config)) {
    const draft = normalizeMcpConfig(config, { requireIdentity: false })
    const stored = await mcpStore.find(draft.id)
    const sameTransport =
      stored &&
      (stored.command || "") === draft.command &&
      JSON.stringify(stored.args || []) === JSON.stringify(draft.args) &&
      (stored.url || null) === (draft.url || null)
    if (!sameTransport) {
      throw new Error(
        "Saved MCP secrets are only used to test the saved command. Enter the values again to test a changed command.",
      )
    }
    resolved = withStoredMcpSecrets(config, stored)
  }
  if (hasOpaqueMcpSecret(resolved)) {
    throw new Error(
      "This MCP server's saved secrets cannot be decrypted on this computer. Enter them again.",
    )
  }
  return resolved
}

let registered = false

function registerMcpHandlers() {
  if (registered) return
  registered = true

  // Values never reach renderer JS (LLM-rendered HTML, plugin UI and XSS all
  // run there); see `redactMcpForRenderer`.
  rawHandle(
    IpcChannel.McpList,
    async () => (await mcpStore.list()).map(redactMcpForRenderer),
    {
      fallback: [],
      warnTag: "mcp-ipc",
    },
  )

  safeHandle(IpcChannel.McpInstall, async (event, config) => {
    const input = withoutApprovalMarker(config || {})
    const draft = normalizeMcpConfig(input)
    const existing = await mcpStore.find(draft.id)
    const normalized = normalizeMcpConfig(withStoredMcpSecrets(input, existing))
    const approvals = await approveMcpLaunches([normalized], {
      findExisting: () => existing,
      parent: parentWindowOf(event),
      title: "Allow MCP server command?",
      message: `Save MCP server ${JSON.stringify(normalized.name || normalized.id)}, which runs this command?`,
    })
    if (!approvals) {
      throw new Error("The MCP server was not saved because its command was not allowed.")
    }
    const entry = await mcpStore.save({ ...normalized, approval: approvals[0] })
    return { id: entry.id }
  })

  safeHandle(IpcChannel.McpRemove, async (_event, { id } = {}) => {
    const normalizedId = slugify(
      boundedString(id, "MCP id", 128, { required: true }),
    )
    if (!normalizedId) throw new Error("MCP id is required")
    await mcpStore.remove(normalizedId)
  })

  safeHandle(IpcChannel.McpUpdateEnv, async (_event, { id, env } = {}) => {
    const normalizedId = slugify(
      boundedString(id, "MCP id", 128, { required: true }),
    )
    const patch = normalizeMcpEnv(env)
    const updated = await mcpStore.update(normalizedId, (mcp) =>
      normalizeMcpConfig({
        ...mcp,
        env: normalizeMcpEnv({
          ...(mcp.env || {}),
          ...resolvePlaceholderRecord(patch, mcp.env, "MCP environment value"),
        }),
      }),
    )
    if (!updated) throw new Error(`MCP server not found: ${normalizedId}`)
  })

  safeHandle(IpcChannel.McpSetEnabled, async (_event, { id, enabled } = {}) => {
    if (typeof enabled !== "boolean") {
      throw new Error("MCP enabled state must be a boolean")
    }
    const normalizedId = slugify(
      boundedString(id, "MCP id", 128, { required: true }),
    )
    const updated = await mcpStore.update(normalizedId, (mcp) =>
      normalizeMcpConfig({ ...mcp, enabled }),
    )
    if (!updated) throw new Error(`MCP server not found: ${normalizedId}`)
  })

  safeHandle(IpcChannel.McpProbe, async (_event, config) => {
    // probeMcp returns its own envelope-like object — passthrough via safeHandle.
    let resolved
    try {
      resolved = await resolveProbeSecrets(config || {})
    } catch (error) {
      return { ok: false, error: error?.message || String(error) }
    }
    return probeMcp(resolved)
  })

  console.log("[mcp-ipc] Handlers registered")
}

module.exports = {
  registerMcpHandlers,
  setMcpEncryptionKey,
  // Main-process only: plaintext values. Never forward these to a renderer.
  // All three go through the backend and are async.
  readMcps: () => mcpStore.list(),
  writeMcps: async (mcps) => {
    if (!Array.isArray(mcps) || mcps.length > MAX_MCP_ENTRIES) {
      throw new Error(`MCP list exceeds ${MAX_MCP_ENTRIES} entries`)
    }
    await mcpStore.replaceAll(
      mcps.map((entry) => assertMcpServerRecord(normalizeMcpConfig(entry))),
    )
  },
  /**
   * Replace the list with what `compute` returns for the current one
   * (`null` keeps it). Written against the revision that was read, so a
   * concurrent change is never overwritten; `compute` may run again.
   */
  updateMcps: (compute) =>
    mcpStore.replaceWith((current) => {
      const next = compute(current)
      if (!next) return null
      if (!Array.isArray(next) || next.length > MAX_MCP_ENTRIES) {
        throw new Error(`MCP list exceeds ${MAX_MCP_ENTRIES} entries`)
      }
      return next.map((entry) => assertMcpServerRecord(normalizeMcpConfig(entry)))
    }),
  normalizeMcpConfig,
  normalizeMcpEnv,
  normalizeMcpHeaders,
  normalizeMcpSource,
  mcpConfirmationDetail,
  approveMcpLaunches,
  describeMcpLaunch,
  isMcpLaunchApproved,
  mcpLaunchCommandLine,
  parentWindowOf,
  withoutApprovalMarker,
  probeMcp,
  resolveCommandToAbsolute,
  MCP_SECRET_PLACEHOLDER,
  redactMcpForRenderer,
  withStoredMcpSecrets,
  containsMcpSecretPlaceholder,
  resolveProbeSecrets,
  encryptMcpSecret,
  decryptMcpSecret,
}
