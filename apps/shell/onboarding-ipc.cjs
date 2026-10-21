/**
 * Onboarding wizard IPC + CLI auto-sync + rules.
 *
 * This module used to be the 900-line catch-all that also owned MCP,
 * skills, hooks, and subagents. Those now live in their own `*-ipc.cjs`
 * files; this file is strictly the onboarding UX surface plus the bits
 * that cut across multiple feature areas: `cli:auto-sync` (scans the
 * Claude + Codex config dirs and imports anything the user doesn't
 * already have) and `rules:get/save` (a single markdown blob shared
 * across providers, kept here because it's tiny and wizard-adjacent).
 *
 * The rules, MCP servers, skills and subagents it imports are stored by the
 * backend (`/api/v1/config/*`, shared/desktop-config-client.cjs); this
 * process scans, asks the user, and hands over the result.
 *
 * The CLI scans run on fs/promises, so a large `~/.claude.json` or a deep
 * skills tree no longer blocks the main process (and with it every window)
 * while it is read. Importing MCP servers asks the user in a native dialog
 * that lists each new command line (mcp-ipc `approveMcpLaunches`).
 *
 * Removals stick: `cli-imports.json` in the runtime home (next to
 * imported-plugins.json) lists every CLI item this computer has imported or
 * found already present. Auto-sync does not bring back one of those that is
 * missing from BetterC0de's own list, because the user removed or hid it; a
 * manual "Sync from CLI" may (`includeDismissed`).
 */

const fsp = require("fs/promises")
const path = require("path")
const { scanClaude, scanCodex } = require("./cli-scanner.cjs")
const { IpcChannel } = require("./shared/ipc-contract.cjs")
const { ok, fail } = require("./shared/ipc-envelope.cjs")
const { registerHandler } = require("./shared/trusted-ipc.cjs")
const jsonFs = require("./shared/json-fs.cjs")
const {
  getBaseDir,
  getDoneFlag,
  getRuntimePaths,
  ensureDir,
  slugify,
} = require("./shared/runtime-paths.cjs")
const {
  readMcps,
  updateMcps,
  normalizeMcpConfig,
  redactMcpForRenderer,
  withStoredMcpSecrets,
  containsMcpSecretPlaceholder,
  approveMcpLaunches,
  parentWindowOf,
  withoutApprovalMarker,
} = require("./mcp-ipc.cjs")
const { listSkillDirs, importScannedSkills } = require("./skills-ipc.cjs")
const { listSubagentDirs, importScannedAgents } = require("./subagents-ipc.cjs")
const { fetchJson } = require("./shared/fetch-json.cjs")
const { getBackendConnection } = require("./shared/backend-endpoint.cjs")
const desktopConfig = require("./shared/desktop-config-client.cjs")

/** The user's rules (`rules.md`, owned by the backend). */
function readRules() {
  return desktopConfig.readRules()
}

function writeRules(content) {
  return desktopConfig.writeRules(content || "")
}

async function readBackendWorkspaceTrust(projectPath) {
  const cfg = getBackendConnection()
  if (!cfg) return null
  try {
    const payload = await fetchJson(
      `http://127.0.0.1:${cfg.port}/api/v1/permissions/workspace-trust/get`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspacePath: projectPath }),
      },
      { timeoutMs: 5_000 },
    )
    const trust = payload?.trust
    if (!trust || typeof trust !== "object" || Array.isArray(trust)) return null
    if (trust.state !== "trusted" && trust.state !== "untrusted") return null
    return trust
  } catch {
    return null
  }
}

async function resolveCliScanContext(request, dependencies = {}) {
  const rawProjectPath =
    request &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    typeof request.projectPath === "string"
      ? request.projectPath.trim()
      : ""
  if (!rawProjectPath) {
    // Never infer a workspace from the Electron process cwd. With no selected
    // project, scanning intentionally remains user-global.
    return {
      scanOptions: { workspaceTrusted: false },
      projectScope: {
        status: "not-selected",
        projectPath: null,
        workspaceTrusted: false,
      },
    }
  }
  if (
    rawProjectPath.length > 4_096 ||
    rawProjectPath.includes("\0") ||
    !path.isAbsolute(rawProjectPath)
  ) {
    return {
      scanOptions: { workspaceTrusted: false },
      projectScope: {
        status: "invalid",
        projectPath: null,
        workspaceTrusted: false,
      },
    }
  }

  const projectPath = path.resolve(rawProjectPath)
  try {
    if (!(await fsp.stat(projectPath)).isDirectory()) {
      throw new Error("Project root is not a directory")
    }
  } catch {
    return {
      scanOptions: { workspaceTrusted: false },
      projectScope: {
        status: "unavailable",
        projectPath,
        workspaceTrusted: false,
      },
    }
  }

  // The renderer used to forward its own copy of the trust bit. A compromised
  // page could mark an explicitly untrusted workspace as trusted and import
  // that folder's MCP commands. The backend record is the decision, and only
  // an explicit one: the backend's compatibility default reports `trusted`
  // for every folder it has no record for, which is not consent to read the
  // repository's own CLI configuration.
  const readTrust = dependencies.readWorkspaceTrust || readBackendWorkspaceTrust
  let trust = null
  try {
    trust = await readTrust(projectPath)
  } catch {
    trust = null
  }
  const workspaceTrusted = trust?.state === "trusted" && trust?.explicit === true
  return {
    scanOptions: {
      cwd: projectPath,
      projectRoot: projectPath,
      workspaceTrusted,
    },
    projectScope: {
      status: workspaceTrusted ? "trusted" : "untrusted",
      projectPath,
      workspaceTrusted,
    },
  }
}

// ── CLI import ledger (cli-imports.json) ────────────────────────────────────

const CLI_IMPORT_LEDGER_FILE = "cli-imports.json"

// Writes are queued so two auto-syncs (two windows, a quick project switch)
// cannot drop each other's additions.
let cliImportLedgerQueue = Promise.resolve()

/**
 * The ledger as a store: `read()` parses the file (missing or unreadable
 * reads as empty, so a damaged file heals on the next write), `update()`
 * writes what `compute` returns for the current ledger (`null` keeps it).
 * A ledger written by a newer release is read but never rewritten.
 */
const cliImportLedger = {
  file() {
    return path.join(getBaseDir(), CLI_IMPORT_LEDGER_FILE)
  },
  async read() {
    return parseCliImportLedger(
      await jsonFs.readJsonAsync(this.file(), null, { warn: "onboarding-ipc" }),
    )
  },
  update(compute) {
    const run = cliImportLedgerQueue.then(async () => {
      const next = compute(await this.read())
      if (!next || next.version > CLI_IMPORT_LEDGER_VERSION) return
      jsonFs.writeJson(this.file(), serializeCliImportLedger(next))
    })
    cliImportLedgerQueue = run.catch(() => {})
    return run
  },
}

async function scanCliAssets(request, dependencies = {}) {
  const { scanOptions, projectScope } = await resolveCliScanContext(request, dependencies)
  const scanClaudeImpl = dependencies.scanClaude || scanClaude
  const scanCodexImpl = dependencies.scanCodex || scanCodex
  // Both scans are asynchronous file reads; run them side by side.
  const [claude, codex] = await Promise.all([
    scanClaudeImpl(scanOptions),
    scanCodexImpl(scanOptions),
  ])
  return { claude, codex, projectScope }
}

/**
 * Scan CLI configs and import NEW user-level servers/skills/agents that are
 * not yet present in the BetterC0de runtime config. Never removes
 * user-configured items — only adds. Deduplicates MCP servers by both
 * id and transport identity (same command/args or URL under a renamed id);
 * skills and agents dedupe by id only.
 *
 * `scanRequest` is the renderer's scan context, optionally with `kinds`
 * (which of `mcpServers`, `skills`, `agents` to import; all by default) and
 * `includeDismissed` (a manual sync: also re-import items the user removed).
 * `dependencies.importLedger` is the ledger store (`cliImportLedger` for the
 * IPC handler); without one nothing counts as removed and nothing is
 * recorded.
 */
async function cliAutoSync(scanRequest, dependencies = {}) {
  const options = cliSyncOptions(scanRequest)
  const { claude, codex, projectScope } = await scanCliAssets(scanRequest)

  const scannedMcpServers = [
    ...(claude.mcpServers || []),
    ...(codex.mcpServers || []),
  ]
  const scannedSkills = [...(claude.skills || []), ...(codex.skills || [])]
  const scannedAgents = [...(claude.agents || []), ...(codex.agents || [])]
  const allScannedMcpServers = scannedMcpServers.filter(isUserScopedAsset)
  const allScannedSkills = scannedSkills.filter(isUserScopedAsset)
  const allScannedAgents = scannedAgents.filter(isUserScopedAsset)
  const skippedWorkspaceAssets =
    scannedMcpServers.length -
    allScannedMcpServers.length +
    (scannedSkills.length - allScannedSkills.length) +
    (scannedAgents.length - allScannedAgents.length)

  // What this computer imported (or found present) before. An entry listed
  // there but missing from BetterC0de's own list was removed by the user.
  const ledgerStore = dependencies.importLedger || null
  let ledger = null
  if (ledgerStore) {
    try {
      ledger = await ledgerStore.read()
    } catch (error) {
      warnCliImportLedger("read", error)
    }
  }
  const isDismissed = (kind, id) =>
    !options.includeDismissed && cliImportLedgerHas(ledger, kind, id)
  // Ids to record: everything imported now or found already present.
  const seen = { mcpServers: [], skills: [], agents: [] }
  const dismissed = { mcpServers: 0, skills: 0, agents: 0 }

  // ── MCP Servers: deduplicate by id AND command ──
  // Computed against the list as stored when it is written (the backend
  // retries on a concurrent change), so this may run more than once.
  let newMcpServers = []
  if (options.kinds.has("mcpServers")) {
    let presentMcpIds = []
    let dismissedMcp = 0
    await updateMcps((existingMcps) => {
      const existingIds = new Set(existingMcps.map((m) => m.id))
      const existingTransports = new Set(
        existingMcps.map(mcpTransportIdentity).filter(Boolean)
      )
      presentMcpIds = []
      dismissedMcp = 0
      newMcpServers = allScannedMcpServers.filter((server) => {
        const transport = mcpTransportIdentity(server)
        const id = slugify(server.id || server.name)
        if (existingIds.has(id) || (transport && existingTransports.has(transport))) {
          presentMcpIds.push(id)
          return false
        }
        if (isDismissed("mcpServers", id)) {
          dismissedMcp += 1
          return false
        }
        existingIds.add(id)
        if (transport) existingTransports.add(transport)
        return true
      })
      if (newMcpServers.length === 0) return null
      return [...existingMcps, ...newMcpServers.map(normalizeMcpConfig)]
    })
    seen.mcpServers.push(
      ...presentMcpIds,
      ...newMcpServers.map((server) => slugify(server.id || server.name)),
    )
    dismissed.mcpServers = dismissedMcp
  }

  // ── Skills: deduplicate by id ──
  const newSkills = []
  if (options.kinds.has("skills")) {
    const existingSkillIds = new Set(await listSkillDirs())
    for (const skill of allScannedSkills) {
      const id = slugify(skill.id || skill.name)
      if (existingSkillIds.has(id)) {
        seen.skills.push(id)
      } else if (isDismissed("skills", id)) {
        dismissed.skills += 1
      } else {
        newSkills.push(skill)
      }
    }
    if (newSkills.length > 0) {
      await importScannedSkills(newSkills)
    }
    seen.skills.push(...newSkills.map((skill) => slugify(skill.id || skill.name)))
  }

  // ── Agents / Subagents: deduplicate by id ──
  const newAgents = []
  if (options.kinds.has("agents")) {
    const existingAgentIds = new Set(await listSubagentDirs())
    for (const agent of allScannedAgents) {
      const id = slugify(agent.id || agent.name)
      if (existingAgentIds.has(id)) {
        seen.agents.push(id)
      } else if (isDismissed("agents", id)) {
        dismissed.agents += 1
      } else {
        newAgents.push(agent)
      }
    }
    if (newAgents.length > 0) {
      await importScannedAgents(newAgents)
    }
    seen.agents.push(...newAgents.map((agent) => slugify(agent.id || agent.name)))
  }

  if (ledgerStore) {
    try {
      await ledgerStore.update((current) => withCliImportIds(current, seen))
    } catch (error) {
      warnCliImportLedger("write", error)
    }
  }

  return {
    imported: {
      mcpServers: newMcpServers.length,
      skills: newSkills.length,
      agents: newAgents.length,
    },
    total: {
      mcpServers: allScannedMcpServers.length,
      skills: allScannedSkills.length,
      agents: allScannedAgents.length,
    },
    // Removed by the user earlier and therefore not imported again.
    dismissed,
    // User-level MCP servers the scanner could not import as they are
    // (unsupported options, malformed entries), so Settings can name them.
    skippedMcpServers: options.kinds.has("mcpServers")
      ? describeSkippedMcpServers([
          ...(claude.skippedMcpServers || []),
          ...(codex.skippedMcpServers || []),
        ])
      : [],
    found: { claude: claude?.found === true, codex: codex?.found === true },
    // Workspace-scoped entries found but deliberately left out of the
    // global stores (see `isUserScopedAsset`).
    skippedWorkspaceAssets,
    projectScope,
  }
}

const CLI_IMPORT_KINDS = ["mcpServers", "skills", "agents"]
/** The ledger format this release writes; a newer one is never rewritten. */
const CLI_IMPORT_LEDGER_VERSION = 1
const MAX_CLI_IMPORT_LEDGER_IDS = 4_096
const MAX_CLI_IMPORT_ID_CHARS = 256
const MAX_REPORTED_SKIPPED_MCP_SERVERS = 50

function isPlainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** What a sync request asks for beyond the scan context. */
function cliSyncOptions(request) {
  const raw = isPlainRecord(request) ? request : {}
  const requested = Array.isArray(raw.kinds)
    ? CLI_IMPORT_KINDS.filter((kind) => raw.kinds.includes(kind))
    : []
  return {
    kinds: new Set(requested.length > 0 ? requested : CLI_IMPORT_KINDS),
    includeDismissed: raw.includeDismissed === true,
  }
}

/**
 * `cli-imports.json` as read: `{ version, imported: { mcpServers, skills,
 * agents } }`, each a list of BetterC0de ids. Unknown fields (and unknown
 * kinds) are kept in `raw` so a rewrite does not drop what a newer release
 * added; anything malformed reads as empty.
 */
function parseCliImportLedger(value) {
  const raw = isPlainRecord(value) ? value : {}
  const version =
    Number.isInteger(raw.version) && raw.version > 0
      ? raw.version
      : CLI_IMPORT_LEDGER_VERSION
  const imported = isPlainRecord(raw.imported) ? raw.imported : {}
  const ids = {}
  for (const kind of CLI_IMPORT_KINDS) {
    const list = Array.isArray(imported[kind]) ? imported[kind] : []
    ids[kind] = new Set(
      list
        .filter(
          (id) =>
            typeof id === "string" &&
            id.length > 0 &&
            id.length <= MAX_CLI_IMPORT_ID_CHARS,
        )
        .slice(-MAX_CLI_IMPORT_LEDGER_IDS),
    )
  }
  return { version, raw, ids }
}

function cliImportLedgerHas(ledger, kind, id) {
  return !!ledger && !!id && ledger.ids?.[kind]?.has(id) === true
}

/** The ledger with `additions` recorded, or null when nothing is new. */
function withCliImportIds(ledger, additions) {
  const current = ledger || parseCliImportLedger(null)
  let changed = false
  const ids = {}
  for (const kind of CLI_IMPORT_KINDS) {
    const next = new Set(current.ids[kind])
    for (const id of additions?.[kind] || []) {
      if (
        typeof id !== "string" ||
        id.length === 0 ||
        id.length > MAX_CLI_IMPORT_ID_CHARS ||
        next.has(id)
      ) {
        continue
      }
      next.add(id)
      changed = true
    }
    ids[kind] = next
  }
  return changed ? { ...current, ids } : null
}

function serializeCliImportLedger(ledger) {
  const imported = isPlainRecord(ledger.raw?.imported)
    ? { ...ledger.raw.imported }
    : {}
  for (const kind of CLI_IMPORT_KINDS) {
    // Oldest first, so the cap drops the oldest ids.
    imported[kind] = [...ledger.ids[kind]].slice(-MAX_CLI_IMPORT_LEDGER_IDS)
  }
  return {
    ...(isPlainRecord(ledger.raw) ? ledger.raw : {}),
    version: Math.max(ledger.version || 0, CLI_IMPORT_LEDGER_VERSION),
    imported,
  }
}

function warnCliImportLedger(action, error) {
  console.warn(
    `[onboarding-ipc] Could not ${action} cli-imports.json: ${error?.message || error}`,
  )
}

/** The scanner's skipped user-level MCP servers, as Settings reports them. */
function describeSkippedMcpServers(skipped) {
  return skipped
    .filter((entry) => isPlainRecord(entry) && !isWorkspaceScopedAsset(entry))
    .slice(0, MAX_REPORTED_SKIPPED_MCP_SERVERS)
    .map((entry) => ({
      id: String(entry.id || ""),
      name: String(entry.name || entry.id || ""),
      source: typeof entry.source === "string" ? entry.source : "",
      reason: typeof entry.reason === "string" ? entry.reason : "",
    }))
}

/**
 * Record what an onboarding (or Settings → Skills) import stored, so that
 * removing it later sticks too. MCP servers count only once they are in the
 * stored list: a declined approval or an unresolvable secret stores nothing.
 * Best-effort: the import itself has already succeeded.
 */
async function recordOnboardingImports(
  { mcpServers, skills, agents },
  mcpResult,
  dependencies = {},
) {
  const store = dependencies.importLedger
  if (!store) return
  try {
    const idOf = (entry) => slugify(entry?.id || entry?.name)
    const userEntries = (list) =>
      (Array.isArray(list) ? list : []).filter(
        (entry) => isPlainRecord(entry) && !isWorkspaceScopedAsset(entry),
      )
    let mcpIds = []
    if (mcpResult?.imported > 0) {
      const read = dependencies.readMcps || readMcps
      const stored = new Set((await read()).map((entry) => entry.id))
      mcpIds = userEntries(mcpServers)
        .map(idOf)
        .filter((id) => stored.has(id))
    }
    await store.update((current) =>
      withCliImportIds(current, {
        mcpServers: mcpIds,
        skills: userEntries(skills).map(idOf).filter(Boolean),
        agents: userEntries(agents).map(idOf).filter(Boolean),
      }),
    )
  } catch (error) {
    warnCliImportLedger("update", error)
  }
}

/**
 * The scan result as the renderer may see it: MCP env and header values are
 * replaced by the placeholder (key names stay). The onboarding import
 * resolves placeholders from a fresh scan in this process.
 */
function redactScanSecrets(scan) {
  const redactSource = (source) =>
    source && typeof source === "object" && Array.isArray(source.mcpServers)
      ? {
          ...source,
          mcpServers: source.mcpServers.map(redactMcpForRenderer),
        }
      : source
  return { ...scan, claude: redactSource(scan.claude), codex: redactSource(scan.codex) }
}

function sameScannedMcpServer(left, right) {
  const normalizedPath = (value) => {
    const resolved = typeof value === "string" && value ? path.resolve(value) : ""
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return (
    left?.source === right?.source &&
    String(left?.id || "").toLowerCase() === String(right?.id || "").toLowerCase() &&
    normalizedPath(left?.sourcePath) === normalizedPath(right?.sourcePath)
  )
}

/**
 * Onboarding import of scanned MCP servers: the renderer only ever saw
 * redacted values, so placeholders are resolved against a fresh user-level
 * scan in this process. A server whose secrets cannot be resolved (its
 * source changed since the scan) is skipped rather than saved with a
 * literal placeholder credential.
 */
async function resolveImportedMcpSecrets(mcpServers, dependencies = {}) {
  const pending = mcpServers.filter(containsMcpSecretPlaceholder)
  if (pending.length === 0) return mcpServers
  const scan = await scanCliAssets(undefined, dependencies)
  const scanned = [
    ...(scan.claude?.mcpServers || []),
    ...(scan.codex?.mcpServers || []),
  ]
  const resolved = []
  for (const server of mcpServers) {
    if (!containsMcpSecretPlaceholder(server)) {
      resolved.push(server)
      continue
    }
    const match = scanned.find((candidate) => sameScannedMcpServer(candidate, server))
    try {
      if (!match) throw new Error("source no longer lists this server")
      resolved.push(withStoredMcpSecrets(server, match))
    } catch (error) {
      console.warn(
        `[onboarding-ipc] Skipping MCP server ${JSON.stringify(server?.id || server?.name || "")}: ${error?.message || error}`,
      )
    }
  }
  return resolved
}

function mcpTransportIdentity(server) {
  const command =
    typeof server?.command === "string" ? server.command.trim() : ""
  if (command) {
    const args = Array.isArray(server.args)
      ? server.args.filter((arg) => typeof arg === "string")
      : []
    return `command:${command}\0${args.join("\0")}`
  }
  const url = typeof server?.url === "string" ? server.url.trim() : ""
  return url ? `url:${url}` : ""
}

/**
 * Only user-level CLI configuration (`~/.claude`, `~/.codex`, …) may enter
 * BetterC0de's global stores. Everything in them applies to EVERY workspace:
 * a global MCP server is spawned for any agent turn and a global skill or
 * agent is injected into any prompt. A repository's `.mcp.json`,
 * `.claude/settings*.json`, `.codex/config.toml`, skills and agents
 * (`project`), and Claude's per-project entries in `~/.claude.json`
 * (`local`), belong to that one workspace and are applied there by the
 * provider CLIs and the backend's own trust-gated project configuration.
 */
function isUserScopedAsset(entry) {
  return entry?.scope === "user"
}

/** Explicitly project- or workspace-scoped entries; unknown scope is kept. */
function isWorkspaceScopedAsset(entry) {
  return entry?.scope === "project" || entry?.scope === "local"
}

async function projectScopeForFailure(scanRequest) {
  try {
    return (await resolveCliScanContext(scanRequest)).projectScope
  } catch {
    return {
      status: "unavailable",
      projectPath: null,
      workspaceTrusted: false,
    }
  }
}

/**
 * Store the MCP servers an onboarding import selected. Every server whose
 * command line is new or differs from the stored entry with the same id is
 * listed in a native confirmation first (`approveMcpLaunches`); declining
 * imports none of them. Entries are merged by id: Settings → Skills reuses
 * this import with `mcpServers: []`, which once erased every configured
 * server.
 *
 * Resolves to the number of servers stored and the number the user declined.
 */
async function importOnboardingMcpServers(mcpServers, options = {}) {
  const {
    parent = null,
    dependencies = {},
  } = options
  const read = dependencies.readMcps || readMcps
  // Without an injected writer the merge is written against the stored list
  // at that moment (another change made while the dialog was open is kept).
  const update =
    dependencies.updateMcps ||
    (dependencies.writeMcps
      ? async (compute) => {
          const next = compute(await read())
          if (next) await dependencies.writeMcps(next)
        }
      : updateMcps)
  const approve = dependencies.approveMcpLaunches || approveMcpLaunches
  // Workspace-scoped entries never become global (see isUserScopedAsset),
  // and an approval marker is never taken from the renderer.
  const userMcpServers = await resolveImportedMcpSecrets(
    (Array.isArray(mcpServers) ? mcpServers : [])
      .filter((server) => !isWorkspaceScopedAsset(server))
      .map(withoutApprovalMarker),
    dependencies,
  )
  const incoming = userMcpServers.map((server) => normalizeMcpConfig(server))
  if (incoming.length === 0) return { imported: 0, declined: 0 }
  const stored = await read()
  const approvals = await approve(incoming, {
    findExisting: (server) => stored.find((entry) => entry.id === server.id) ?? null,
    parent,
    title: "Import MCP servers?",
    message:
      incoming.length === 1
        ? "Import an MCP server that runs this command?"
        : "Import MCP servers that run these commands?",
  })
  if (!approvals) return { imported: 0, declined: incoming.length }
  const incomingIds = new Set(incoming.map((server) => server.id))
  await update((current) => [
    ...current.filter((server) => !incomingIds.has(server.id)),
    ...incoming.map((server, index) =>
      approvals[index] ? { ...server, approval: approvals[index] } : server,
    ),
  ])
  return { imported: incoming.length, declined: 0 }
}

/**
 * Store the CLI plugins an onboarding import selected. Only an explicit list
 * replaces the stored one: a caller that sends no `plugins` field (Settings →
 * Skills reuses this import) must not erase it. Returns whether it wrote.
 */
function saveImportedPlugins(plugins, pluginsFile, writeJson = jsonFs.writeJson) {
  if (!Array.isArray(plugins)) return false
  writeJson(pluginsFile, plugins)
  return true
}

async function isOnboardingDone() {
  try {
    await fsp.access(getDoneFlag())
    return true
  } catch {
    return false
  }
}

let registered = false

function registerOnboardingHandlers() {
  if (registered) return
  registered = true

  registerHandler(IpcChannel.OnboardingIsDone, () => isOnboardingDone())

  registerHandler(IpcChannel.OnboardingScan, async (_event, scanRequest) => {
    try {
      return ok(redactScanSecrets(await scanCliAssets(scanRequest)))
    } catch (e) {
      const projectScope = await projectScopeForFailure(scanRequest)
      return fail(e, {
        claude: {
          found: false,
          plugins: [],
          mcpServers: [],
          skills: [],
          agents: [],
          commands: [],
          skippedMcpServers: [],
          configSources: [],
        },
        codex: {
          found: false,
          plugins: [],
          mcpServers: [],
          skills: [],
          agents: [],
          commands: [],
          skippedMcpServers: [],
          configSources: [],
        },
        projectScope,
      })
    }
  })

  registerHandler(IpcChannel.OnboardingImport, async (event, payload) => {
    const { mcpServers, skills, plugins, agents } =
      payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}
    try {
      const { baseDir, pluginsFile } = getRuntimePaths()
      ensureDir(baseDir)
      const mcp = await importOnboardingMcpServers(mcpServers, {
        parent: parentWindowOf(event),
      })
      await importScannedSkills(
        (Array.isArray(skills) ? skills : []).filter(
          (skill) => !isWorkspaceScopedAsset(skill),
        ),
      )
      await importScannedAgents(
        (Array.isArray(agents) ? agents : []).filter(
          (agent) => !isWorkspaceScopedAsset(agent),
        ),
      )
      saveImportedPlugins(plugins, pluginsFile)
      await recordOnboardingImports({ mcpServers, skills, agents }, mcp, {
        importLedger: cliImportLedger,
      })
      // Declined MCP servers are left out; the rest of the import stands.
      return ok(mcp.declined > 0 ? { mcpServersDeclined: mcp.declined } : undefined)
    } catch (e) {
      return fail(e)
    }
  })

  registerHandler(IpcChannel.OnboardingComplete, async () => {
    try {
      await fsp.mkdir(getBaseDir(), { recursive: true })
      await fsp.writeFile(getDoneFlag(), new Date().toISOString())
      return ok()
    } catch (e) {
      return fail(e)
    }
  })

  registerHandler(IpcChannel.OnboardingReset, async () => {
    try {
      await fsp.rm(getDoneFlag(), { force: true })
      return ok()
    } catch (e) {
      return fail(e)
    }
  })

  registerHandler(IpcChannel.CliAutoSync, async (_event, scanRequest) => {
    try {
      return ok(
        await cliAutoSync(scanRequest, { importLedger: cliImportLedger }),
      )
    } catch (e) {
      const projectScope = await projectScopeForFailure(scanRequest)
      return fail(e, {
        imported: { mcpServers: 0, skills: 0, agents: 0 },
        total: { mcpServers: 0, skills: 0, agents: 0 },
        projectScope,
      })
    }
  })

  registerHandler(IpcChannel.RulesGet, async () => ({ content: await readRules() }))

  registerHandler(IpcChannel.RulesSave, async (_, content) => {
    try {
      await writeRules(typeof content === "string" ? content : content?.content || "")
      return ok()
    } catch (e) {
      return fail(e)
    }
  })

  console.log("[onboarding-ipc] Handlers registered")
}

module.exports = {
  registerOnboardingHandlers,
  importOnboardingMcpServers,
  saveImportedPlugins,
  resolveCliScanContext,
  scanCliAssets,
  redactScanSecrets,
  resolveImportedMcpSecrets,
}
