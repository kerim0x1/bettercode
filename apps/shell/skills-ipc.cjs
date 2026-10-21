/**
 * Skills IPC handlers + HTTPS skill-import.
 *
 * Skills are markdown files that get appended to the model's system prompt,
 * so the URL import path is the most security-sensitive surface in the
 * main process short of plugin install. It DNS-resolves the host, rejects
 * private/loopback/link-local/ULA/multicast/reserved addresses to block
 * SSRF, refuses to follow redirects (a 302 to an internal host would defeat
 * the DNS check), and caps response size. User confirmation happens in-app
 * (ConfirmActionDialog in the renderer) before these handlers are invoked.
 *
 * BetterC0de's own skills (`skills/<id>/manifest.json` + `content.md` in the
 * runtime home) belong to the backend: this process reads and writes them
 * only through `/api/v1/config/skills` (shared/desktop-config-client.cjs).
 * The copies it keeps in the provider CLIs' own folders (`~/.codex/skills`,
 * `~/.claude/skills`) are still written here.
 */

const fs = require("fs")
const os = require("os")
const path = require("path")
const { IpcChannel } = require("./shared/ipc-contract.cjs")
const { safeHandle, rawHandle } = require("./shared/ipc-handlers-factory.cjs")
const appConfig = require("./shared/appConfig.cjs")
const { readText, writeText } = require("./shared/json-fs.cjs")
const {
  assertSafePublicHost,
  resolvePublicHostPinned,
} = require("./shared/security-checks.cjs")
const { ensureDir, slugify } = require("./shared/runtime-paths.cjs")
const {
  getDirectoryEntry,
  listDirectory,
  putDirectoryEntry,
  removeDirectoryEntry,
} = require("./shared/desktop-config-client.cjs")

function parseSkillContentFromPath(skillPath) {
  if (!skillPath) return ""
  const candidates = ["SKILL.md", "skill.md", "README.md", "content.md"]
  for (const fileName of candidates) {
    const full = path.join(skillPath, fileName)
    if (fs.existsSync(full)) return readText(full, "", { strict: true })
  }
  return ""
}

function resolveCodexHome() {
  const configured = process.env.CODEX_HOME
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(expandHome(configured.trim()))
  }
  return path.join(os.homedir(), ".codex")
}

function resolveClaudeConfigDir() {
  const configured = process.env.CLAUDE_CONFIG_DIR
  if (typeof configured === "string" && configured.trim()) {
    // CLAUDE_CONFIG_DIR names the config directory itself; unlike HOME it
    // must not gain an implicit `.claude` suffix.
    return path.resolve(expandHome(configured.trim()))
  }
  return path.join(os.homedir(), ".claude")
}

function expandHome(value) {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function sourceAlreadyInSkillsDir(manifest, skillsDir, sourceName) {
  if (manifest.source !== sourceName || !manifest.sourcePath) return false
  const sourcePath = path.resolve(manifest.sourcePath)
  const relative = path.relative(skillsDir, sourcePath)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function nativeSourceAlreadyLoadsSkill(manifest, provider) {
  if (manifest?.source !== provider || !manifest.sourcePath) return false
  const segments = path
    .normalize(path.resolve(manifest.sourcePath))
    .split(path.sep)
    .map((segment) => segment.toLowerCase())
  const marker = provider === "codex" ? ".agents" : ".claude"
  return segments.some(
    (segment, index) => segment === marker && segments[index + 1] === "skills"
  )
}

function normalizeProviderScope(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
}

function providerScopeTargets(scope, provider) {
  const key = normalizeProviderScope(scope)
  if (!key) return false
  const compactKey = key.replace(/-/g, "")
  if (provider === "codex") {
    return (
      key === "codex" ||
      key === "codex-cli" ||
      key === "openai-cli" ||
      compactKey === "codexcli" ||
      key.startsWith("codex-")
    )
  }
  if (provider === "claude") {
    return (
      key === "claude" ||
      key === "claude-cli" ||
      key === "claude-agent" ||
      key === "anthropic-cli" ||
      compactKey === "claudecli" ||
      compactKey === "claudeagent" ||
      key.startsWith("claude-")
    )
  }
  return key === provider
}

function manifestTargetsProvider(manifest, provider) {
  const providerInstanceIds = Array.isArray(manifest?.providerInstanceIds)
    ? manifest.providerInstanceIds
    : []
  if (providerInstanceIds.length > 0) {
    return providerInstanceIds.some((entry) =>
      providerScopeTargets(entry, provider)
    )
  }

  const providerKinds = Array.isArray(manifest?.providerKinds)
    ? manifest.providerKinds
    : []
  return providerKinds.some((entry) => providerScopeTargets(entry, provider))
}

function syncCodexSkill(manifest, content) {
  if (!manifestTargetsProvider(manifest, "codex")) return
  if (nativeSourceAlreadyLoadsSkill(manifest, "codex")) return
  const skillsDir = path.join(resolveCodexHome(), "skills")
  if (sourceAlreadyInSkillsDir(manifest, skillsDir, "codex")) return
  const dir = path.join(skillsDir, manifest.id)
  ensureDir(dir)
  writeText(path.join(dir, "SKILL.md"), content || "")
}

function syncClaudeSkill(manifest, content) {
  if (!manifestTargetsProvider(manifest, "claude")) return
  if (nativeSourceAlreadyLoadsSkill(manifest, "claude")) return
  const skillsDir = path.join(resolveClaudeConfigDir(), "skills")
  if (sourceAlreadyInSkillsDir(manifest, skillsDir, "claude")) return
  const dir = path.join(skillsDir, manifest.id)
  ensureDir(dir)
  writeText(path.join(dir, "SKILL.md"), content || "")
}

function deleteCodexSkillCopy(manifest, id) {
  if (!manifestTargetsProvider(manifest, "codex")) return
  if (nativeSourceAlreadyLoadsSkill(manifest, "codex")) return
  const skillsDir = path.join(resolveCodexHome(), "skills")
  if (sourceAlreadyInSkillsDir(manifest, skillsDir, "codex")) return
  const dir = path.join(skillsDir, id)
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only; BetterC0de's own skill removal should still succeed.
  }
}

function deleteClaudeSkillCopy(manifest, id) {
  if (!manifestTargetsProvider(manifest, "claude")) return
  if (nativeSourceAlreadyLoadsSkill(manifest, "claude")) return
  const skillsDir = path.join(resolveClaudeConfigDir(), "skills")
  if (sourceAlreadyInSkillsDir(manifest, skillsDir, "claude")) return
  const dir = path.join(skillsDir, id)
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only; BetterC0de's own skill removal should still succeed.
  }
}

/** The ids (folder names) of BetterC0de's readable skills. */
async function listSkillDirs() {
  return (await listDirectory("skills")).map((entry) => entry.id)
}

async function readSkills() {
  return (await listDirectory("skills")).map(({ manifest, text }) => ({
    ...manifest,
    enabled: manifest.enabled !== false,
    content: text,
  }))
}

/** Persist a skill into its per-id directory. Returns `{id}` on success;
 *  the IPC layer wraps that into the standard envelope. */
async function saveSkill(data) {
  const id = slugify(data.id || data.name)
  if (!id) throw new Error("Skill id is required")

  const existing = (await getDirectoryEntry("skills", id))?.manifest ?? {}
  const now = new Date().toISOString()
  const manifest = {
    id,
    name: data.name || existing.name || id,
    version: data.version || existing.version || "1.0.0",
    public: data.isPublic ?? data.public ?? existing.public ?? false,
    enabled: data.enabled ?? existing.enabled ?? true,
    description: data.description ?? existing.description ?? "",
    createdAt: existing.createdAt || now,
    updatedAt: now,
    source: data.source || existing.source || "local",
    sourceUrl: data.sourceUrl || existing.sourceUrl,
    sourcePath: data.sourcePath || existing.sourcePath,
    providerKinds: Array.isArray(data.providerKinds)
      ? data.providerKinds.filter((entry) => typeof entry === "string")
      : existing.providerKinds,
    providerInstanceIds: Array.isArray(data.providerInstanceIds)
      ? data.providerInstanceIds.filter((entry) => typeof entry === "string")
      : existing.providerInstanceIds,
  }

  const content = data.content || ""
  // undefined fields are left out, as the file writer always did.
  await putDirectoryEntry(
    "skills",
    id,
    JSON.parse(JSON.stringify(manifest)),
    content,
  )
  syncCodexSkill(manifest, content)
  syncClaudeSkill(manifest, content)
  return { id }
}

async function deleteSkill(id) {
  const safeId = slugify(id)
  if (!safeId) throw new Error("Invalid skill id")
  const manifest = (await getDirectoryEntry("skills", safeId))?.manifest ?? null
  if (manifest) deleteCodexSkillCopy(manifest, safeId)
  if (manifest) deleteClaudeSkillCopy(manifest, safeId)
  await removeDirectoryEntry("skills", safeId)
}

async function importScannedSkills(skills) {
  for (const skill of skills || []) {
    const content = parseSkillContentFromPath(skill.path)
    await saveSkill({
      id: skill.id || skill.name,
      name: skill.name,
      description: skill.source
        ? `Imported from ${skill.source}`
        : "Imported skill",
      version: "1.0.0",
      isPublic: false,
      enabled: true,
      source: skill.source || "import",
      sourcePath: skill.path,
      providerKinds: skill.providerKinds,
      providerInstanceIds: skill.providerInstanceIds,
      content,
    })
  }
}

let registered = false

function registerSkillsHandlers() {
  if (registered) return
  registered = true

  rawHandle(IpcChannel.SkillList, async () => readSkills(), {
    fallback: [],
    warnTag: "skills-ipc",
  })

  safeHandle(IpcChannel.SkillSave, async (_event, data) =>
    saveSkill(data || {})
  )

  safeHandle(IpcChannel.SkillDelete, async (_event, { id } = {}) => {
    await deleteSkill(id)
  })

  safeHandle(IpcChannel.SkillImportUrl, async (_event, { url, name } = {}) => {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("Invalid url")
    }
    const parsed = new URL(url)
    if (parsed.protocol !== "https:") {
      throw new Error("Only https:// URLs are allowed")
    }
    if (parsed.username || parsed.password) {
      throw new Error("Skill import URLs must not contain credentials")
    }
    // S1: resolve once and PIN the IP for the actual connection.  The previous
    // implementation called `assertSafePublicHost` then handed `parsed` to
    // `https.request`, which performed its own DNS lookup — leaving a
    // TOCTOU rebind window where a hostile authoritative nameserver returned
    // a public IP for the check and a private IP for the request (AWS
    // metadata at 169.254.169.254, internal services, etc).
    const pinned = await resolvePublicHostPinned(parsed.hostname)

    // Confirmation happens IN-APP (ConfirmActionDialog in the marketplace
    // My-Skills tab) before this call; the SSRF hardening above is the
    // security boundary that stays in the main process.

    const https = require("https")
    const MAX_BYTES = appConfig.SKILL_IMPORT_MAX_BYTES
    const requestOptions = {
      host: pinned.address, // pinned IP
      family: pinned.family === 6 ? 6 : 4,
      port: parsed.port ? Number(parsed.port) : 443,
      path: parsed.pathname + (parsed.search || ""),
      method: "GET",
      // SNI + Host header keep TLS validation and HTTP virtual-host routing
      // working against the original hostname while the socket actually
      // connects to the pinned IP.
      servername: parsed.hostname,
      headers: { Host: parsed.hostname },
      timeout: appConfig.SKILL_IMPORT_REQUEST_TIMEOUT_MS,
    }
    const content = await new Promise((resolve, reject) => {
      let response = null
      let settled = false
      let deadline = null
      const finish = (error, data) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        if (error) {
          // Do not drain an untrusted rejected body: it can stream forever.
          response?.destroy()
          req.destroy()
          reject(error)
        } else {
          resolve(data)
        }
      }
      const req = https.request(requestOptions, (res) => {
        response = res
        res.on("error", (error) => finish(error))
        res.on("aborted", () => finish(new Error("Response was interrupted")))
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          // Don't follow redirects — a redirect to a private host would
          // defeat the DNS check above. Fail closed.
          finish(new Error(`Refusing to follow redirect from ${parsed.host}`))
          return
        }
        if (res.statusCode !== 200) {
          finish(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const ct = String(res.headers["content-type"] || "").toLowerCase()
        if (ct && !ct.startsWith("text/") && !ct.includes("markdown")) {
          finish(new Error(`Unexpected content-type: ${ct}`))
          return
        }
        const chunks = []
        let bytes = 0
        res.on("data", (chunk) => {
          if (settled) return
          bytes += chunk.length
          if (bytes > MAX_BYTES) {
            finish(new Error(`Response exceeds ${MAX_BYTES}-byte limit`))
            return
          }
          chunks.push(chunk)
        })
        // Decode once so multi-byte characters split across chunks stay intact.
        res.on("end", () => finish(null, Buffer.concat(chunks).toString("utf-8")))
      })
      const timedOut = () => finish(new Error("Request timed out"))
      // Socket-idle timeouts alone never expire a continuously trickling peer.
      deadline = setTimeout(timedOut, appConfig.SKILL_IMPORT_REQUEST_TIMEOUT_MS)
      req.on("error", (error) => finish(error))
      req.on("timeout", timedOut)
      req.end()
    })
    const id = slugify(name || "imported-skill")
    return saveSkill({
      id,
      name: name || id,
      version: "1.0.0",
      isPublic: false,
      enabled: true,
      source: "url-import",
      sourceUrl: url,
      content,
    })
  })

  // skills.sh registry (vercel-labs `npx skills`). Preview/search are
  // read-only; add executes npx (remote code) — the renderer confirms
  // in-app before invoking it.
  const {
    skillsShPreview,
    skillsShAdd,
    skillsShSearch,
    skillsShPopular,
  } = require("./skills-sh.cjs")

  safeHandle(IpcChannel.SkillsShPreview, async (_event, { repo } = {}) =>
    skillsShPreview(repo)
  )

  safeHandle(IpcChannel.SkillsShSearch, async (_event, { query } = {}) => {
    const trimmed = typeof query === "string" ? query.trim() : ""
    return trimmed.length >= 2 ? skillsShSearch(trimmed) : skillsShPopular()
  })

  // Confirmation happens IN-APP (ConfirmActionDialog) before this call —
  // the native dialog gate was replaced on user request. Source/skill
  // validation inside skillsShAdd remains the last line of defense.
  safeHandle(IpcChannel.SkillsShAdd, async (_event, { repo, skill } = {}) =>
    skillsShAdd({ repo, skill })
  )

  console.log("[skills-ipc] Handlers registered")
}

module.exports = {
  registerSkillsHandlers,
  listSkillDirs,
  importScannedSkills,
  manifestTargetsProvider,
  nativeSourceAlreadyLoadsSkill,
  resolveClaudeConfigDir,
}
