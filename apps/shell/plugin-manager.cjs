/**
 * Plugin Manager — loads, manages, and executes provider plugins
 * Runs in Electron main process (Node.js)
 *
 * Plugins are trusted code the user installed explicitly, and they share the
 * main process. The manager bounds what a misbehaving one can do to the app:
 * every lifecycle step and method call has a deadline, a call that overruns
 * quarantines the plugin until it settles, and an exception thrown later from
 * a plugin's own timer or listener can be attributed to it
 * (`findPluginForError`) so the app unloads the plugin instead of quitting.
 *
 * With a plugin host (`new PluginManager({ host })`, see
 * shared/plugin-host-client.cjs; enabled by BETTERC0DE_PLUGIN_HOST=utility)
 * plugin modules are loaded in a separate utility process instead, which also
 * contains CPU stalls and crashes. Everything else here — install, config,
 * queuing, deadlines, quarantine — stays the same; the loaded "module" is
 * then a proxy whose functions call into the host.
 */

const fs = require("fs")
const path = require("path")
const { EventEmitter } = require("events")
const Module = require("module")
const crypto = require("crypto")
const { pathToFileURL } = require("url")
const { assertPathContained } = require("./shared/security-checks.cjs")
const { readJson, writeJson } = require("./shared/json-fs.cjs")
const { getBaseDir } = require("./shared/runtime-paths.cjs")

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const ALLOWED_ENTRY_EXT = new Set([".js", ".cjs", ".mjs"])
const SECRET_PREFIX = "enc:v1:"
const PLUGIN_CLEANUP_TIMEOUT_MS = 5_000
const PLUGIN_SHUTDOWN_TIMEOUT_MS = 10_000
// A plugin method call holds that plugin's operation queue; past this it is
// reported as failed and the plugin is quarantined until the call settles.
const PLUGIN_CALL_TIMEOUT_MS = 120_000
const MAX_PLUGIN_CONFIG_BYTES = 1024 * 1024
const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024
const MAX_PLUGIN_TREE_BYTES = 256 * 1024 * 1024

/**
 * The app's own node_modules directories that exist, in resolution order:
 * plugin code may require the app's runtime dependencies from these.
 */
function runtimeModulePaths() {
  const candidates = []
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "node_modules"),
      path.join(process.resourcesPath, "app.asar", "node_modules"),
      path.join(process.resourcesPath, "app.asar.unpacked", "node_modules")
    )
  }
  // After the apps/ migration the shell lives at apps/shell/, so to
  // reach the workspace-hoisted node_modules we go up two levels:
  // apps/shell/ → apps/ → repo root.
  candidates.push(path.join(__dirname, "..", "..", "node_modules"))
  return candidates.filter((candidate) => candidate && fs.existsSync(candidate))
}

function normalizeDisposer(candidate) {
  if (typeof candidate === "function") return candidate
  if (!candidate || typeof candidate !== "object") return null
  if (typeof candidate.dispose === "function") {
    return () => candidate.dispose.call(candidate)
  }
  if (typeof candidate.unsubscribe === "function") {
    return () => candidate.unsubscribe.call(candidate)
  }
  return null
}

async function runWithTimeout(operation, timeoutMs, label) {
  const pendingOperation = Promise.resolve().then(operation)
  let timer
  try {
    return await Promise.race([
      pendingOperation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            const error = new Error(`${label} timed out after ${timeoutMs}ms`)
            error.code = "PLUGIN_OPERATION_TIMEOUT"
            error.pendingOperation = pendingOperation
            reject(error)
          },
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function settingsKey(value) {
  if (typeof value !== "string" || !value) return null
  try {
    const key = Buffer.from(value, "base64")
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

function encryptConfigSecret(value, key) {
  if (!key || typeof value !== "string" || !value || value.startsWith(SECRET_PREFIX)) {
    return value
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return SECRET_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")
}

function decryptConfigSecret(value, key) {
  if (typeof value !== "string" || !value.startsWith(SECRET_PREFIX)) return value
  if (!key) {
    throw new Error("Plugin secret is encrypted but no settings key is available")
  }
  try {
    const payload = Buffer.from(value.slice(SECRET_PREFIX.length), "base64")
    if (payload.length < 28) throw new Error("Encrypted plugin secret is truncated")
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12))
    decipher.setAuthTag(payload.subarray(12, 28))
    return Buffer.concat([
      decipher.update(payload.subarray(28)),
      decipher.final(),
    ]).toString("utf8")
  } catch (error) {
    throw new Error("Plugin secret could not be decrypted", { cause: error })
  }
}

function secretConfigKeys(manifest) {
  return new Set(
    Array.isArray(manifest?.config)
      ? manifest.config
          .filter((field) => field?.type === "secret" && typeof field.key === "string")
          .map((field) => field.key)
      : [],
  )
}

function transformPluginConfig(config, manifest, key, mode) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config)
  ) {
    throw new Error("Plugin config must be an object")
  }
  const clone = structuredClone(config)
  if (
    !clone.values ||
    typeof clone.values !== "object" ||
    Array.isArray(clone.values)
  ) {
    throw new Error("Plugin config values must be an object")
  }
  for (const field of secretConfigKeys(manifest)) {
    if (typeof clone.values[field] !== "string" || !clone.values[field]) continue
    clone.values[field] =
      mode === "encrypt"
        ? encryptConfigSecret(clone.values[field], key)
        : decryptConfigSecret(clone.values[field], key)
  }
  return clone
}

function validatePluginId(pluginId) {
  if (typeof pluginId !== "string" || !PLUGIN_ID_RE.test(pluginId)) {
    throw new Error(`Invalid plugin id: ${String(pluginId).slice(0, 80)}`)
  }
  return pluginId
}

function safePluginPath(baseDir, pluginId) {
  validatePluginId(pluginId)
  return assertPathContained(baseDir, pluginId, "Plugin path")
}

function safeEntryPath(pluginDir, entry) {
  if (typeof entry !== "string" || entry.length === 0 || entry.length > 256) {
    throw new Error("Invalid manifest entry")
  }
  if (path.isAbsolute(entry)) throw new Error("manifest.entry must be relative")
  const ext = path.extname(entry).toLowerCase()
  if (!ALLOWED_ENTRY_EXT.has(ext)) {
    throw new Error(`manifest.entry must end in .js/.cjs/.mjs (got ${ext})`)
  }
  return assertPathContained(pluginDir, entry, "manifest.entry")
}

/**
 * S3: walk a plugin source tree and throw if any entry is a symlink or
 * junction. Bounded by a node count so a maliciously huge tree can't DOS
 * the install path. Exported for tests.
 */
function assertPluginTreeHasNoSymlinks(
  root,
  { maxNodes = 10_000, maxBytes = MAX_PLUGIN_TREE_BYTES } = {},
) {
  let visited = 0
  let totalBytes = 0
  /** @type {string[]} */
  const stack = [root]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (++visited > maxNodes) {
      throw new Error(
        `Plugin source contains more than ${maxNodes} entries — refusing install`,
      )
    }
    let st
    try {
      st = fs.lstatSync(cur)
    } catch (err) {
      throw new Error(`Cannot stat ${cur}: ${err && err.message ? err.message : err}`)
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Plugin source contains a symlink/junction at ${cur} — refusing install`)
    }
    if (st.isDirectory()) {
      let entries
      try {
        entries = fs.readdirSync(cur)
      } catch (err) {
        throw new Error(`Cannot read directory ${cur}: ${err && err.message ? err.message : err}`)
      }
      for (const entry of entries) stack.push(path.join(cur, entry))
    } else if (st.isFile()) {
      totalBytes += st.size
      if (totalBytes > maxBytes) {
        throw new Error(`Plugin source exceeds ${maxBytes} bytes`)
      }
    } else {
      throw new Error(`Plugin source contains a non-file entry at ${cur}`)
    }
  }
  return { nodes: visited, bytes: totalBytes }
}

class PluginManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {ReturnType<typeof import("./shared/plugin-host-client.cjs").createPluginHostClient> | null} [options.host]
   *   Load plugin modules in this out-of-process host instead of `require()`.
   */
  constructor({ host = null } = {}) {
    super()
    this._host = host
    this.plugins = new Map() // id -> { manifest, module, config, enabled }
    this._pluginsDir = null // Lazy-initialized
    this._settingsKey = null
    // Per-plugin mtime-keyed cache for `manifest.json` + `config.json`. The
    // Plugins settings tab calls `listPlugins()` on every open — before the
    // cache each call re-read ~3 files per plugin (existsSync + manifest
    // readFileSync + config readFileSync), so ~30 blocking syscalls per
    // modal open with the default plugin set. Keyed on mtime so external
    // edits (user hand-editing manifest.json) still invalidate correctly.
    //
    // Map<pluginDirName, { manifestMtimeMs, configMtimeMs, manifest, config }>
    this._manifestCache = new Map()
    // All lifecycle operations and method invocations for one plugin share a
    // tail. An unload queued after a long-running method therefore cannot
    // dispose the module until that invocation has settled.
    this._operationTails = new Map()
    this._quarantinedPlugins = new Map()
    this._acceptingOperations = true
    this._disposeAllPromise = null
    // Module resolution is changed only by an explicit `init()` (or the
    // first plugin load), never as a side effect of constructing a manager.
    this._runtimeModulePathsRegistered = false
    // Why a plugin was stopped after an uncaught error, shown in the list
    // until it is enabled and loaded again.
    this._faults = new Map()
    this._callTimeoutMs = PLUGIN_CALL_TIMEOUT_MS
  }

  /**
   * Make the app's own node_modules resolvable for plugin code. Idempotent;
   * called before the first plugin module is required.
   */
  init() {
    if (this._runtimeModulePathsRegistered) return
    this._runtimeModulePathsRegistered = true
    // Plugin code runs in the host, which registers the same paths itself.
    if (this._host) return
    this._registerRuntimeModulePaths()
  }

  _assertAcceptingOperations() {
    if (!this._acceptingOperations) {
      throw new Error("Plugin manager is shutting down")
    }
  }

  _assertPluginUsable(pluginId) {
    const quarantine = this._quarantinedPlugins.get(pluginId)
    if (quarantine) {
      throw new Error(
        `Plugin ${pluginId} is quarantined after incomplete cleanup: ${quarantine.message}`,
      )
    }
  }

  _quarantinePlugin(pluginId, error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error))
    this._quarantinedPlugins.set(pluginId, normalized)
    const pending = normalized.pendingOperation
    if (pending && typeof pending.then === "function") {
      pending.catch((lateError) => {
        console.warn(
          `[plugin] Quarantined cleanup later rejected for ${pluginId}:`,
          lateError,
        )
      })
    }
  }

  _enqueuePluginOperation(
    pluginId,
    operation,
    { allowDuringShutdown = false, allowQuarantined = false } = {},
  ) {
    validatePluginId(pluginId)
    if (!allowDuringShutdown) this._assertAcceptingOperations()
    if (!allowQuarantined) this._assertPluginUsable(pluginId)

    const previous = this._operationTails.get(pluginId) || Promise.resolve()
    const result = previous.then(() => {
      // The shutdown gate may have closed while this operation was queued
      // behind an invocation. Do not let stale queued loads or sends start
      // after disposeAll has begun.
      if (!allowDuringShutdown) this._assertAcceptingOperations()
      if (!allowQuarantined) this._assertPluginUsable(pluginId)
      return operation()
    })
    // Store an always-fulfilled tail so one failed plugin call does not poison
    // every later operation for that plugin.
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this._operationTails.set(pluginId, tail)

    return result.finally(() => {
      if (this._operationTails.get(pluginId) === tail) {
        this._operationTails.delete(pluginId)
      }
    })
  }

  /** Configure the same OS-protected key used by backend settings. */
  setEncryptionKey(base64Key) {
    this._settingsKey = settingsKey(base64Key)
    if (!this._settingsKey) return
    this._ensureDir()
    for (const entry of fs.readdirSync(this.pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const config = this._readConfig(entry.name)
        this._writeConfig(entry.name, config)
      } catch (error) {
        // A malformed plugin should not prevent migration of the remaining set.
        console.warn(
          `[plugin] Refusing to rewrite unreadable config for ${entry.name}:`,
          error,
        )
      }
    }
  }

  _readManifest(pluginId, { strict = false } = {}) {
    try {
      const manifest = readJson(
        path.join(safePluginPath(this.pluginsDir, pluginId), "manifest.json"),
        null,
        {
          strict: true,
          maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
        },
      )
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error(`Plugin ${pluginId} manifest must be an object`)
      }
      return manifest
    } catch (error) {
      if (strict) throw error
      return null
    }
  }

  /** Drop cache entries for a single plugin (or all plugins when id omitted). */
  _invalidateCache(pluginId) {
    if (pluginId === undefined) {
      this._manifestCache.clear()
      return
    }
    this._manifestCache.delete(pluginId)
  }

  // Use different paths for dev vs packaged to avoid conflicts
  // Computed lazily to ensure app.isPackaged is ready
  get pluginsDir() {
    if (!this._pluginsDir) {
      this._pluginsDir = path.join(getBaseDir(), "plugins")
    }
    return this._pluginsDir
  }

  _registerRuntimeModulePaths() {
    for (const candidate of runtimeModulePaths()) {
      if (!Module.globalPaths.includes(candidate)) {
        Module.globalPaths.push(candidate)
      }
    }
  }

  /** Ensure plugins directory exists */
  _ensureDir() {
    fs.mkdirSync(this.pluginsDir, { recursive: true })
  }

  /** Get config file path for a plugin */
  _configPath(pluginId) {
    return path.join(safePluginPath(this.pluginsDir, pluginId), "config.json")
  }

  /** Read plugin config from disk */
  _readConfig(pluginId) {
    const p = this._configPath(pluginId)
    const stored = readJson(p, null, {
      strict: true,
      maxBytes: MAX_PLUGIN_CONFIG_BYTES,
    })
    if (stored === null) return { enabled: true, values: {} }
    return transformPluginConfig(
      stored,
      this._readManifest(pluginId, { strict: true }),
      this._settingsKey,
      "decrypt",
    )
  }

  /** Write plugin config to disk */
  _writeConfig(pluginId, config) {
    try {
      this._writeConfigFile(
        this._configPath(pluginId),
        config,
        this._readManifest(pluginId, { strict: true }),
      )
      // Next `listPlugins` rereads for this plugin; cache hit on other
      // plugins stays valid because the mtime guard is per-file.
      this._invalidateCache(pluginId)
    } catch (e) {
      console.error(`[plugin] Failed to write config for ${pluginId}:`, e)
      throw e
    }
  }

  _writeConfigFile(filePath, config, manifest) {
    const forDisk = transformPluginConfig(
      config,
      manifest,
      this._settingsKey,
      "encrypt",
    )
    writeJson(filePath, forDisk, { maxBytes: MAX_PLUGIN_CONFIG_BYTES })
  }

  /**
   * Read (manifest, config) for a single plugin dir with mtime-keyed
   * caching. `dirName` is the on-disk directory name, which matches
   * `manifest.id` for well-formed plugins; we key on dirName because
   * callers have that before they've read the manifest.
   *
   * Cache invariant: entry is valid iff BOTH files' on-disk mtimeMs
   * values match the cached mtimeMs. A missing config file counts as
   * mtime `0` — creating the file later (mtime > 0) invalidates. A
   * missing manifest returns null (skip this plugin).
   */
  _readPluginCached(dirName) {
    const manifestPath = path.join(this.pluginsDir, dirName, "manifest.json")
    const configPath = path.join(this.pluginsDir, dirName, "config.json")

    let manifestStat
    try {
      manifestStat = fs.lstatSync(manifestPath)
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return null
    } catch {
      return null
    }
    let configStat = null
    let configStatError = null
    try {
      configStat = fs.lstatSync(configPath)
      if (!configStat.isFile() || configStat.isSymbolicLink()) {
        configStatError = "Plugin config is not a regular file"
        configStat = null
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        configStatError =
          error instanceof Error ? error.message : String(error)
      }
    }

    const manifestMtimeMs = manifestStat.mtimeMs
    const configMtimeMs = configStat ? configStat.mtimeMs : configStatError ? -1 : 0
    const manifestIdentity = `${manifestStat.dev}:${manifestStat.ino}:${manifestStat.size}`
    const configIdentity = configStat
      ? `${configStat.dev}:${configStat.ino}:${configStat.size}`
      : configStatError
        ? "unsafe"
        : "missing"

    const cached = this._manifestCache.get(dirName)
    if (
      cached &&
      cached.manifestMtimeMs === manifestMtimeMs &&
      cached.configMtimeMs === configMtimeMs &&
      cached.manifestIdentity === manifestIdentity &&
      cached.configIdentity === configIdentity
    ) {
      return {
        manifest: cached.manifest,
        config: cached.config,
        configError: cached.configError || null,
      }
    }

    let manifest
    try {
      manifest = readJson(manifestPath, null, {
        strict: true,
        maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
      })
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("Manifest must be an object")
      }
    } catch (e) {
      console.error(`[plugin] Bad manifest in ${dirName}:`, e.message)
      return null
    }
    let config = configStatError
      ? { enabled: false, values: {} }
      : { enabled: true, values: {} }
    let configError = configStatError
    if (configStat) {
      try {
        config = transformPluginConfig(
          readJson(configPath, null, {
            strict: true,
            maxBytes: MAX_PLUGIN_CONFIG_BYTES,
          }),
          manifest,
          this._settingsKey,
          "decrypt",
        )
      } catch (error) {
        configError =
          error instanceof Error ? error.message : String(error)
        config = { enabled: false, values: {} }
      }
    }

    this._manifestCache.set(dirName, {
      manifestMtimeMs,
      configMtimeMs,
      manifestIdentity,
      configIdentity,
      manifest,
      config,
      configError,
    })
    return { manifest, config, configError }
  }

  /** Scan plugins directory and return manifests (mtime-cached). */
  listPlugins() {
    this._ensureDir()
    const result = []
    let dirs
    try {
      dirs = fs
        .readdirSync(this.pluginsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
    } catch {
      return result
    }

    for (const dir of dirs) {
      const read = this._readPluginCached(dir.name)
      if (!read) continue
      const { manifest, config, configError } = read
      const loaded = this.plugins.get(manifest.id)
      result.push({
        manifest,
        enabled: config.enabled !== false,
        config: this._publicConfig(manifest, config.values || {}),
        status: configError || loaded?.error || this._faults.has(manifest.id)
          ? "error"
          : config.enabled !== false
            ? "active"
            : "disabled",
        error: configError || loaded?.error || this._faults.get(manifest.id) || null,
      })
    }
    return result
  }

  /** Install a plugin from a source directory */
  async installPlugin(sourcePath) {
    this._assertAcceptingOperations()
    this._ensureDir()
    if (typeof sourcePath !== "string" || sourcePath.length === 0) {
      throw new Error("Plugin source path is empty")
    }
    const absoluteSource = path.resolve(sourcePath)
    // S3: refuse to install a plugin tree that contains symlinks/junctions.
    // `fs.cpSync` follows them by default, so a malicious plugin folder with
    // a `node_modules/x → /etc/passwd` (or a Windows junction to another
    // user's profile) would smuggle arbitrary host files into the plugin
    // directory where the entry script can read them. Pre-walk the tree and
    // refuse on any link, then pass `dereference: false` for belt+suspenders.
    assertPluginTreeHasNoSymlinks(absoluteSource)

    const manifestPath = path.join(absoluteSource, "manifest.json")
    const manifest = readJson(manifestPath, null, {
      strict: true,
      maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
    })
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("No valid manifest.json found in plugin directory")
    }
    if (!manifest.id || !manifest.name || !manifest.entry) {
      throw new Error("Invalid manifest: missing id, name, or entry")
    }
    validatePluginId(manifest.id)
    // Reject manifest.entry that would escape the plugin directory once copied.
    const sourceEntry = safeEntryPath(absoluteSource, manifest.entry)
    const sourceEntryStat = fs.lstatSync(sourceEntry)
    if (!sourceEntryStat.isFile() || sourceEntryStat.isSymbolicLink()) {
      throw new Error("Plugin manifest entry must be a regular file")
    }

    const destDir = safePluginPath(this.pluginsDir, manifest.id)
    return this._enqueuePluginOperation(manifest.id, async () => {
      const existingConfig = fs.existsSync(destDir)
        ? this._readConfig(manifest.id)
        : { enabled: true, values: {} }
      await this._unloadPluginUnlocked(manifest.id)
      const stageDir = assertPathContained(
        this.pluginsDir,
        `.plugin-stage-${manifest.id}-${crypto.randomUUID()}`,
        "Plugin staging path",
      )
      const backupDir = assertPathContained(
        this.pluginsDir,
        `.plugin-backup-${manifest.id}-${crypto.randomUUID()}`,
        "Plugin backup path",
      )
      let displaced = false
      try {
        fs.cpSync(absoluteSource, stageDir, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        })
        assertPluginTreeHasNoSymlinks(stageDir)

        const stagedManifest = readJson(
          path.join(stageDir, "manifest.json"),
          null,
          {
            strict: true,
            maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
          },
        )
        if (
          !stagedManifest ||
          stagedManifest.id !== manifest.id ||
          stagedManifest.entry !== manifest.entry ||
          !stagedManifest.name
        ) {
          throw new Error(
            "Plugin manifest changed while the source tree was copied",
          )
        }
        const stagedEntry = safeEntryPath(stageDir, stagedManifest.entry)
        const stagedEntryStat = fs.lstatSync(stagedEntry)
        if (
          !stagedEntryStat.isFile() ||
          stagedEntryStat.isSymbolicLink()
        ) {
          throw new Error("Staged plugin entry is not a regular file")
        }
        this._writeConfigFile(
          path.join(stageDir, "config.json"),
          existingConfig,
          stagedManifest,
        )

        if (fs.existsSync(destDir)) {
          fs.renameSync(destDir, backupDir)
          displaced = true
        }
        try {
          fs.renameSync(stageDir, destDir)
        } catch (error) {
          if (displaced && !fs.existsSync(destDir)) {
            fs.renameSync(backupDir, destDir)
            displaced = false
          }
          throw error
        }

        if (displaced) {
          try {
            fs.rmSync(backupDir, { recursive: true, force: true })
            displaced = false
          } catch (error) {
            console.warn(
              `[plugin] Installed ${manifest.id}, but could not remove its recovery backup:`,
              error,
            )
          }
        }
        this._invalidateCache(manifest.id)
        console.log(`[plugin] Installed: ${manifest.id}`)
        return stagedManifest
      } finally {
        fs.rmSync(stageDir, { recursive: true, force: true })
        if (displaced && !fs.existsSync(destDir) && fs.existsSync(backupDir)) {
          fs.renameSync(backupDir, destDir)
        }
      }
    })
  }

  /** Remove a plugin */
  async removePlugin(pluginId) {
    const dir = safePluginPath(this.pluginsDir, pluginId)
    return this._enqueuePluginOperation(pluginId, async () => {
      await this._unloadPluginUnlocked(pluginId)
      if (fs.existsSync(dir)) {
        this._invalidateCache(pluginId)
        fs.rmSync(dir, { recursive: true, force: true })
        console.log(`[plugin] Removed: ${pluginId}`)
      }
    })
  }

  /** Toggle plugin enabled state */
  async togglePlugin(pluginId, enabled) {
    validatePluginId(pluginId)
    if (typeof enabled !== "boolean") {
      throw new Error("Plugin enabled state must be a boolean")
    }
    return this._enqueuePluginOperation(pluginId, async () => {
      const config = this._readConfig(pluginId)
      config.enabled = enabled
      this._writeConfig(pluginId, config)
      if (!enabled) {
        await this._unloadPluginUnlocked(pluginId)
      }
    })
  }

  /** Update a config value */
  async setConfig(pluginId, key, value) {
    validatePluginId(pluginId)
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      throw new Error("Plugin config key must be a non-empty bounded string")
    }
    return this._enqueuePluginOperation(pluginId, () => {
      const config = this._readConfig(pluginId)
      const isSecret = secretConfigKeys(
        this._readManifest(pluginId, { strict: true }),
      ).has(key)
      if (isSecret) {
        if (
          value &&
          typeof value === "object" &&
          typeof value.set === "string" &&
          value.set
        ) {
          config.values[key] = value.set
        } else if (value && typeof value === "object" && value.clear === true) {
          config.values[key] = ""
        } else if (typeof value === "string") {
          config.values[key] = value
        } else if (
          !(
            value &&
            typeof value === "object" &&
            typeof value.configured === "boolean"
          )
        ) {
          throw new Error(
            "Secret config must be { set: string } or { clear: true }",
          )
        }
      } else {
        config.values[key] = value
      }
      this._writeConfig(pluginId, config)
      const loaded = this.plugins.get(pluginId)
      if (loaded) loaded.config = structuredClone(config.values)
    })
  }

  /** Get config values */
  getConfig(pluginId) {
    validatePluginId(pluginId)
    const config = this._readConfig(pluginId)
    return config.values || {}
  }

  getPublicConfig(pluginId) {
    validatePluginId(pluginId)
    const manifest = this._readManifest(pluginId)
    const config = this._readConfig(pluginId)
    return this._publicConfig(manifest, config.values || {})
  }

  _publicConfig(manifest, values) {
    const result = { ...values }
    for (const key of secretConfigKeys(manifest)) {
      result[key] = {
        configured: typeof values[key] === "string" && values[key].length > 0,
        storage: this._settingsKey ? "encrypted" : "plaintext",
      }
    }
    return result
  }

  /** Load a plugin's entry module */
  async loadPlugin(pluginId) {
    return this._enqueuePluginOperation(pluginId, () =>
      this._loadPluginUnlocked(pluginId),
    )
  }

  async _loadPluginUnlocked(pluginId) {
    const dir = safePluginPath(this.pluginsDir, pluginId)
    assertPluginTreeHasNoSymlinks(dir)
    const manifestPath = path.join(dir, "manifest.json")
    const manifest = readJson(manifestPath, null, {
      strict: true,
      maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
    })
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`Plugin ${pluginId} not found or has an invalid manifest`)
    }
    if (manifest.id !== pluginId) {
      throw new Error(`Plugin directory ${pluginId} contains id ${manifest.id}`)
    }
    const entryPath = safeEntryPath(dir, manifest.entry)
    const entryStat = fs.lstatSync(entryPath)
    if (!entryStat.isFile() || entryStat.isSymbolicLink())
      throw new Error(`Entry ${manifest.entry} not found for ${pluginId}`)
    const persistedConfig = this._readConfig(pluginId)
    if (persistedConfig.enabled === false) {
      await this._unloadPluginUnlocked(pluginId)
      throw new Error(`Plugin ${pluginId} is disabled`)
    }

    // Cleanup failures retain the previous module and its disposers in a
    // quarantine so a later unload/shutdown can retry them. Keep that work
    // outside the module-load catch below: treating an unload failure like a
    // require() failure would overwrite the only remaining cleanup handles.
    await this._unloadPluginUnlocked(pluginId)
    this.init()
    try {
      const mod = await this._requirePluginModule(pluginId, dir, entryPath)

      this._faults.delete(pluginId)
      this.plugins.set(pluginId, {
        manifest,
        module: mod,
        config: persistedConfig.values || {},
        error: null,
        eventDisposer: null,
        eventSetupPending: null,
        eventCleanupPending: null,
        moduleCleanupPending: null,
        moduleCleanupComplete: false,
        entryPath,
      })
      console.log(`[plugin] Loaded: ${pluginId}`)
      return mod
    } catch (e) {
      const errorMessage =
        typeof e?.message === "string" ? e.message : String(e)
      const missingDependency = e && e.code === "MODULE_NOT_FOUND"
      const message = missingDependency
        ? `${errorMessage}. Plugins must be self-contained and include their own runtime dependencies.`
        : errorMessage
      this._evictPluginRequireCache(pluginId, entryPath)
      this.plugins.set(pluginId, {
        manifest,
        module: null,
        config: {},
        error: message,
        eventDisposer: null,
        eventSetupPending: null,
        eventCleanupPending: null,
        moduleCleanupPending: null,
        moduleCleanupComplete: true,
        entryPath,
      })
      console.error(`[plugin] Failed to load ${pluginId}:`, message)
      throw new Error(message)
    }
  }

  /**
   * The plugin's entry module: `require()`d here, or, with a plugin host, a
   * proxy for the module the host loaded.
   */
  async _requirePluginModule(pluginId, pluginDir, entryPath) {
    if (this._host) {
      return this._host.loadPlugin({ pluginId, pluginDir, entryPath })
    }
    // Clear require cache to allow reloading
    delete require.cache[require.resolve(entryPath)]
    return require(entryPath)
  }

  /** Load all enabled plugins */
  async loadAllEnabled() {
    const list = this.listPlugins()
    for (const p of list) {
      if (p.enabled) {
        try {
          await this.loadPlugin(p.manifest.id)
        } catch {}
      }
    }
  }

  /** Send a method call to a plugin */
  async sendToPlugin(pluginId, method, args) {
    return this._enqueuePluginOperation(pluginId, async () => {
      const persistedConfig = this._readConfig(pluginId)
      if (persistedConfig.enabled === false) {
        await this._unloadPluginUnlocked(pluginId)
        throw new Error(`Plugin ${pluginId} is disabled`)
      }

      let loaded = this.plugins.get(pluginId)
      if (!loaded || !loaded.module) {
        await this._loadPluginUnlocked(pluginId)
        loaded = this.plugins.get(pluginId)
      }
      if (!loaded?.module) throw new Error(`Plugin ${pluginId} not loaded`)

      const fn = typeof method === "string" && Object.hasOwn(loaded.module, method)
        ? loaded.module[method] : undefined
      if (typeof fn !== "function")
        throw new Error(`Plugin ${pluginId} has no method: ${method}`)

      // Await the result while holding this plugin's operation slot. Disable,
      // remove and reload calls queued behind it therefore drain invocations.
      // A call that never settles must not hold the slot forever: past the
      // deadline the caller gets an error and the plugin stays quarantined
      // (no other operation may start) until the call finally settles.
      const input =
        args && typeof args === "object" && !Array.isArray(args) ? args : {}
      try {
        return await runWithTimeout(
          () => fn.call(loaded.module, { ...input, config: loaded.config }),
          this._callTimeoutMs,
          `Plugin ${pluginId} call ${method}`,
        )
      } catch (error) {
        if (error?.code === "PLUGIN_OPERATION_TIMEOUT") {
          this._quarantineUntilSettled(pluginId, error)
        }
        throw error
      }
    })
  }

  /** Quarantine `pluginId` until the timed-out operation behind `error` settles. */
  _quarantineUntilSettled(pluginId, error) {
    this._quarantinePlugin(pluginId, error)
    const quarantine = this._quarantinedPlugins.get(pluginId)
    const pending = error?.pendingOperation
    if (!pending || typeof pending.then !== "function") return
    const lift = () => {
      if (this._quarantinedPlugins.get(pluginId) === quarantine) {
        this._quarantinedPlugins.delete(pluginId)
      }
    }
    pending.then(lift, lift)
  }

  /**
   * The loaded plugin whose code appears in `error`'s stack, or null. Used to
   * attribute an exception thrown from a plugin's timer or listener, which
   * would otherwise reach the process-wide handler.
   */
  findPluginForError(error) {
    const stack = typeof error?.stack === "string" ? error.stack : ""
    if (!stack || this.plugins.size === 0) return null
    const haystack = process.platform === "win32" ? stack.toLowerCase() : stack
    for (const pluginId of this.plugins.keys()) {
      let pluginDir
      try {
        pluginDir = safePluginPath(this.pluginsDir, pluginId)
      } catch {
        continue
      }
      const needles = [pluginDir + path.sep, pathToFileURL(pluginDir).href + "/"]
      for (const needle of needles) {
        const candidate = process.platform === "win32" ? needle.toLowerCase() : needle
        if (haystack.includes(candidate)) return pluginId
      }
    }
    return null
  }

  /**
   * Contain an uncaught exception that came from plugin code: record it on
   * the plugin, quarantine it and unload it in the background. Returns the
   * plugin id, or null when the error is not a plugin's.
   */
  containPluginFault(error) {
    const pluginId = this.findPluginForError(error)
    if (!pluginId) return null
    return this.disablePluginAfterFault(pluginId, error)
  }

  /**
   * Record an uncaught error on `pluginId`, quarantine it, unload it in the
   * background and keep it disabled. Used for errors attributed here
   * (`containPluginFault`) and for those the plugin host attributed.
   */
  disablePluginAfterFault(pluginId, error) {
    validatePluginId(pluginId)
    const message = typeof error?.message === "string" ? error.message : String(error)
    const fault = `Disabled after an uncaught error: ${message}`.slice(0, 2_000)
    this._faults.set(pluginId, fault)
    const loaded = this.plugins.get(pluginId)
    if (loaded) loaded.error = fault
    this._quarantinePlugin(
      pluginId,
      new Error(`Plugin ${pluginId} threw an uncaught error: ${message}`, { cause: error }),
    )
    // Unload (allowed while quarantined, and lifts the quarantine), then keep
    // it disabled so the same fault does not recur on the next start.
    void this.unloadPlugin(pluginId)
      .then(() => this.togglePlugin(pluginId, false))
      .catch((unloadError) => {
        console.warn(`[plugin] Could not stop ${pluginId} after its error:`, unloadError)
      })
    return pluginId
  }

  /**
   * Plugin host mode: the host process ended, and every module it held (and
   * every event subscription) went with it. Forget them, so the next use
   * loads them again, and show why in the plugin list until then. Returns
   * the plugin ids that were loaded.
   */
  handleHostExit(reason) {
    const affected = [...this.plugins.keys()]
    const fault = `Stopped because the plugin host exited (${String(reason).slice(0, 200)})`
    for (const pluginId of affected) {
      this.plugins.delete(pluginId)
      this._quarantinedPlugins.delete(pluginId)
      this._faults.set(pluginId, fault)
    }
    return affected
  }

  /** Register event listener on a plugin */
  async setupPluginEvents(pluginId, callback) {
    return this._enqueuePluginOperation(pluginId, () =>
      this._setupPluginEventsUnlocked(pluginId, callback),
    )
  }

  async _setupPluginEventsUnlocked(pluginId, callback) {
    const loaded = this.plugins.get(pluginId)
    if (!loaded?.module?.onEvent) return false
    if (typeof callback !== "function") {
      throw new Error("Plugin event callback must be a function")
    }

    if (typeof loaded.eventDisposer === "function") {
      const previousDisposer = loaded.eventDisposer
      try {
        await this._runRetainedCleanupOperation({
          loaded,
          pendingKey: "eventCleanupPending",
          operation: previousDisposer,
          onSuccess: () => {
            if (loaded.eventDisposer === previousDisposer) {
              loaded.eventDisposer = null
            }
          },
          label: `Event cleanup for plugin ${pluginId}`,
        })
      } catch (err) {
        this._quarantinePlugin(pluginId, err)
        console.warn(`[plugin] Event cleanup failed for ${pluginId}:`, err)
        try {
          await this._unloadPluginUnlocked(pluginId)
        } catch (cleanupError) {
          throw new AggregateError(
            [err, cleanupError],
            `Plugin ${pluginId} event replacement cleanup failed`,
          )
        }
        throw err
      }
    }

    const listener = (event) => {
      callback({ pluginId, ...event })
    }

    const fallbackDisposer =
      typeof loaded.module.offEvent === "function"
        ? () => loaded.module.offEvent(listener)
        : typeof loaded.module.removeListener === "function"
          ? () => loaded.module.removeListener("event", listener)
          : null
    // Retain the fallback before invoking plugin code. A plugin may register
    // the listener and then throw/reject before returning its preferred
    // disposer; unload must still have a way to remove that partial setup.
    if (fallbackDisposer) loaded.eventDisposer = fallbackDisposer
    const setup = Promise.resolve()
      .then(() => loaded.module.onEvent(listener))
      .then((returnedDisposer) => {
        const disposer =
          normalizeDisposer(returnedDisposer) || fallbackDisposer
        if (!disposer) {
          throw new Error(
            `Plugin ${pluginId} onEvent must return a disposer or expose offEvent/removeListener`,
          )
        }
        loaded.eventDisposer = disposer
      })
    loaded.eventSetupPending = setup
    void setup.finally(() => {
      if (loaded.eventSetupPending === setup) {
        loaded.eventSetupPending = null
      }
    }).catch(() => {
      // The awaited setup path below owns the public rejection. This observer
      // only prevents a detached finally-chain rejection after a timeout.
    })
    try {
      await runWithTimeout(
        () => setup,
        PLUGIN_CLEANUP_TIMEOUT_MS,
        `Event setup for plugin ${pluginId}`,
      )
      return true
    } catch (setupError) {
      if (setupError?.code === "PLUGIN_OPERATION_TIMEOUT") {
        this._quarantinePlugin(pluginId, setupError)
      }
      try {
        await this._unloadPluginUnlocked(pluginId)
      } catch (cleanupError) {
        throw new AggregateError(
          [setupError, cleanupError],
          `Plugin ${pluginId} event setup and rollback failed`,
        )
      }
      throw setupError
    }
  }

  /** Idempotently release listener and module-owned resources. */
  async unloadPlugin(pluginId) {
    return this._enqueuePluginOperation(
      pluginId,
      () => this._unloadPluginUnlocked(pluginId),
      { allowQuarantined: true },
    )
  }

  async _runRetainedCleanupOperation({
    loaded,
    pendingKey,
    operation,
    onSuccess,
    label,
  }) {
    const existingPending = loaded[pendingKey]
    if (existingPending && typeof existingPending.then === "function") {
      await runWithTimeout(
        () => existingPending,
        PLUGIN_CLEANUP_TIMEOUT_MS,
        label,
      )
      if (loaded[pendingKey] === existingPending) {
        loaded[pendingKey] = null
      }
      onSuccess()
      return
    }

    try {
      await runWithTimeout(operation, PLUGIN_CLEANUP_TIMEOUT_MS, label)
      onSuccess()
    } catch (error) {
      const pending = error?.pendingOperation
      if (pending && typeof pending.then === "function") {
        loaded[pendingKey] = pending
        void pending.then(
          () => {
            if (loaded[pendingKey] === pending) {
              loaded[pendingKey] = null
              onSuccess()
            }
          },
          () => {
            if (loaded[pendingKey] === pending) {
              loaded[pendingKey] = null
            }
          },
        )
      }
      throw error
    }
  }

  async _unloadPluginUnlocked(pluginId) {
    validatePluginId(pluginId)
    const loaded = this.plugins.get(pluginId)
    if (!loaded) {
      this._quarantinedPlugins.delete(pluginId)
      return false
    }
    const cleanupErrors = []
    if (loaded.eventSetupPending) {
      try {
        await runWithTimeout(
          () => loaded.eventSetupPending,
          PLUGIN_CLEANUP_TIMEOUT_MS,
          `Event setup settlement for plugin ${pluginId}`,
        )
      } catch (err) {
        cleanupErrors.push(err)
        console.warn(
          `[plugin] Event setup did not quiesce for ${pluginId}:`,
          err,
        )
        // Never run module disposal concurrently with a still-executing
        // onEvent hook. Retain the full loaded context for a later retry.
        if (err?.pendingOperation) {
          const aggregate = new AggregateError(
            cleanupErrors,
            `Plugin ${pluginId} cleanup failed`,
          )
          aggregate.pendingOperation = err.pendingOperation
          this._quarantinePlugin(pluginId, aggregate)
          throw aggregate
        }
      }
    }

    if (typeof loaded.eventDisposer === "function") {
      const eventDisposer = loaded.eventDisposer
      try {
        await this._runRetainedCleanupOperation({
          loaded,
          pendingKey: "eventCleanupPending",
          operation: eventDisposer,
          onSuccess: () => {
            if (loaded.eventDisposer === eventDisposer) {
              loaded.eventDisposer = null
            }
          },
          label: `Event cleanup for plugin ${pluginId}`,
        })
      } catch (err) {
        cleanupErrors.push(err)
        console.warn(`[plugin] Event cleanup failed for ${pluginId}:`, err)
      }
    }

    const dispose =
      typeof loaded.module?.deactivate === "function"
        ? loaded.module.deactivate
        : typeof loaded.module?.dispose === "function"
          ? loaded.module.dispose
          : null
    if (dispose && loaded.moduleCleanupComplete !== true) {
      try {
        await this._runRetainedCleanupOperation({
          loaded,
          pendingKey: "moduleCleanupPending",
          operation: () => dispose.call(loaded.module),
          onSuccess: () => {
            loaded.moduleCleanupComplete = true
          },
          label: `Module cleanup for plugin ${pluginId}`,
        })
      } catch (err) {
        cleanupErrors.push(err)
        console.warn(`[plugin] Cleanup failed for ${pluginId}:`, err)
      }
    }

    if (cleanupErrors.length > 0) {
      const aggregate = new AggregateError(
        cleanupErrors,
        `Plugin ${pluginId} cleanup failed`,
      )
      aggregate.pendingOperation =
        cleanupErrors.find((error) => error?.pendingOperation)
          ?.pendingOperation || null
      this._quarantinePlugin(pluginId, aggregate)
      throw aggregate
    }
    this.plugins.delete(pluginId)
    this._quarantinedPlugins.delete(pluginId)
    this._evictPluginRequireCache(pluginId, loaded.entryPath)
    return true
  }

  _evictPluginRequireCache(pluginId, entryPath) {
    if (this._host) {
      // The modules live in the host; it drops them (requests are ordered,
      // so a reload queued after this sees the eviction).
      void this._host.evictPlugin(pluginId)
      return
    }
    const pluginDir = safePluginPath(this.pluginsDir, pluginId)
    for (const cachePath of Object.keys(require.cache)) {
      const relative = path.relative(pluginDir, cachePath)
      const isInsidePlugin =
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      if (cachePath === entryPath || isInsidePlugin) {
        delete require.cache[cachePath]
      }
    }
  }

  disposeAll() {
    if (this._disposeAllPromise) return this._disposeAllPromise
    this._acceptingOperations = false
    const pluginIds = new Set([
      ...this._operationTails.keys(),
      ...this.plugins.keys(),
      ...this._quarantinedPlugins.keys(),
    ])
    this._disposeAllPromise = runWithTimeout(
      async () => {
        const results = await Promise.allSettled(
          [...pluginIds].reverse().map((pluginId) =>
            this._enqueuePluginOperation(
              pluginId,
              () => this._unloadPluginUnlocked(pluginId),
              { allowDuringShutdown: true, allowQuarantined: true },
            ),
          ),
        )
        const failures = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason)
        for (const [pluginId, error] of this._quarantinedPlugins) {
          failures.push(
            new Error(
              `Plugin ${pluginId} remained quarantined at shutdown: ${error.message}`,
            ),
          )
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "One or more plugins failed to clean up")
        }
      },
      PLUGIN_SHUTDOWN_TIMEOUT_MS,
      "Plugin shutdown",
    )
    return this._disposeAllPromise
  }

  /** Plugins promoted to native backend builtins — removed from user data
   *  on startup so they don't double-show in the dropdown. The `claude`
   *  builtin (src/lib/builtin-providers.ts) replaced anthropic-claude. */
  static RETIRED_PLUGIN_IDS = ["anthropic-claude"]

  /** Remove plugins that have been retired in newer versions. Called from
   *  installDefaults so it happens on every startup. */
  async pruneRetiredPlugins() {
    this._assertAcceptingOperations()
    this._ensureDir()
    for (const pluginId of PluginManager.RETIRED_PLUGIN_IDS) {
      const dest = path.join(this.pluginsDir, pluginId)
      if (!fs.existsSync(dest)) continue
      try {
        await this._enqueuePluginOperation(pluginId, async () => {
          await this._unloadPluginUnlocked(pluginId)
          fs.rmSync(dest, { recursive: true, force: true })
          this._invalidateCache(pluginId)
        })
      } catch {
        // best-effort cleanup; if it fails the user's stale plugin will
        // still load but at least the source is gone after this commit.
      }
    }
  }

  /** Copy default plugins from resources if not already installed */
  async installDefaults(resourcesDir) {
    this._assertAcceptingOperations()
    this._ensureDir()
    await this.pruneRetiredPlugins()
    if (!fs.existsSync(resourcesDir)) {
      return { available: false, installed: 0, updated: 0 }
    }
    let installed = 0
    let updated = 0
    try {
      const dirs = fs
        .readdirSync(resourcesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
      for (const dir of dirs) {
        const dest = path.join(this.pluginsDir, dir.name)
        const srcDir = path.join(resourcesDir, dir.name)
        const srcManifestPath = path.join(srcDir, "manifest.json")
        const destManifestPath = path.join(dest, "manifest.json")

        let shouldCopy = !fs.existsSync(dest)
        let action = "installed"

        if (
          !shouldCopy &&
          fs.existsSync(srcManifestPath) &&
          fs.existsSync(destManifestPath)
        ) {
          try {
            const sourceManifest = JSON.parse(
              fs.readFileSync(srcManifestPath, "utf-8")
            )
            const existingManifest = JSON.parse(
              fs.readFileSync(destManifestPath, "utf-8")
            )
            const sourceVersion = String(sourceManifest.version || "0.0.0")
            const existingVersion = String(existingManifest.version || "0.0.0")
            const isManagedDefault =
              sourceManifest.id === existingManifest.id &&
              (existingManifest.author === sourceManifest.author ||
                existingManifest.author === "BetterC0de")

            if (
              isManagedDefault &&
              this._isVersionGreater(sourceVersion, existingVersion)
            ) {
              shouldCopy = true
              action = "updated"
            }
          } catch {
            // ignore manifest parse errors and keep existing plugin as-is
          }
        }

        if (shouldCopy) {
          validatePluginId(dir.name)
          const installedManifest = await this.installPlugin(srcDir)
          if (installedManifest.id !== dir.name) {
            throw new Error(
              `Bundled plugin directory ${dir.name} contains id ${installedManifest.id}`,
            )
          }
          // Fresh manifest on disk — drop the cached entry before the next
          // `listPlugins` so the new version actually shows up in the UI.
          if (action === "updated") updated++
          else installed++
          console.log(`[plugin] Default ${action}: ${dir.name}`)
        }
      }
    } catch (e) {
      console.error("[plugin] Failed to install defaults:", e.message)
    }
    return { available: true, installed, updated }
  }

  _isVersionGreater(a, b) {
    const left = String(a || "0.0.0")
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0)
    const right = String(b || "0.0.0")
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0)
    const len = Math.max(left.length, right.length)
    for (let i = 0; i < len; i++) {
      const l = left[i] || 0
      const r = right[i] || 0
      if (l > r) return true
      if (l < r) return false
    }
    return false
  }
}

module.exports = {
  PluginManager,
  validatePluginId,
  safePluginPath,
  assertPluginTreeHasNoSymlinks,
  runtimeModulePaths,
}
