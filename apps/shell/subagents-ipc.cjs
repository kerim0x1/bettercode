/**
 * Subagents IPC — named prompt templates the user can invoke as
 * lightweight specialist agents. Parses Codex-style `*.toml` agent
 * definitions for the import path.
 *
 * The subagents (`subagents/<id>/manifest.json` + `prompt.md` in the runtime
 * home) belong to the backend: this process reads and writes them only
 * through `/api/v1/config/subagents` (shared/desktop-config-client.cjs).
 */

const fs = require("fs")
const path = require("path")
const { IpcChannel } = require("./shared/ipc-contract.cjs")
const { safeHandle, rawHandle } = require("./shared/ipc-handlers-factory.cjs")
const { readText } = require("./shared/json-fs.cjs")
const { slugify } = require("./shared/runtime-paths.cjs")
const {
  getDirectoryEntry,
  listDirectory,
  putDirectoryEntry,
  removeDirectoryEntry,
} = require("./shared/desktop-config-client.cjs")

/**
 * Minimal TOML-ish parser tailored to Codex agent files. Pulls out the
 * three keys we care about — name, description, developer_instructions —
 * without dragging in a full TOML library. If Codex ever ships a richer
 * schema, swap to `@iarna/toml`.
 */
function parseCodexAgentToml(agentPath) {
  const content = readText(agentPath, "", { warn: "subagents-ipc" })
  if (!content) return null

  const matchValue = (pattern) => {
    const match = content.match(pattern)
    return match ? match[1].trim() : ""
  }

  const promptMatch = content.match(
    /developer_instructions\s*=\s*"""([\s\S]*?)"""/m
  )
  const fallbackId = path.basename(agentPath, path.extname(agentPath))

  return {
    id: slugify(matchValue(/^name\s*=\s*"([^"]+)"/m) || fallbackId),
    name: matchValue(/^name\s*=\s*"([^"]+)"/m) || fallbackId,
    description: matchValue(/^description\s*=\s*"([^"]+)"/m),
    prompt: promptMatch ? promptMatch[1].trim() : "",
    sourcePath: agentPath,
    source: "codex",
  }
}

function parseMarkdownAgent(agentPath, source = "claude") {
  const content = readText(agentPath, "", { warn: "subagents-ipc" })
  if (!content) return null

  let body = content
  const metadata = {}
  if (content.startsWith("---")) {
    const end = content.search(/\r?\n---(?:\r?\n|$)/)
    if (end >= 0) {
      for (const line of content.slice(3, end).split(/\r?\n/)) {
        const match = line.match(/^(name|description)\s*:\s*(.+?)\s*$/)
        if (!match) continue
        metadata[match[1]] = match[2].trim().replace(/^["']|["']$/g, "")
      }
      const closing = content.slice(end).match(/^\r?\n---(?:\r?\n|$)/)?.[0]
      body = content.slice(end + (closing?.length || 0)).trim()
    }
  }

  const fallbackId = path.basename(agentPath, path.extname(agentPath))
  const name = metadata.name || fallbackId
  return {
    id: slugify(name || fallbackId),
    name,
    description: metadata.description || "",
    prompt: body,
    sourcePath: agentPath,
    source,
  }
}

function parseScannedAgent(agent) {
  if (!agent?.path || !fs.existsSync(agent.path)) return null
  return path.extname(agent.path).toLowerCase() === ".toml"
    ? parseCodexAgentToml(agent.path)
    : parseMarkdownAgent(agent.path, agent.source || "import")
}

/** The ids (folder names) of the readable subagents. */
async function listSubagentDirs() {
  return (await listDirectory("subagents")).map((entry) => entry.id)
}

async function readSubagents() {
  return (await listDirectory("subagents")).map(({ manifest, text }) => ({
    ...manifest,
    enabled: manifest.enabled !== false,
    prompt: text,
  }))
}

/** Persist a subagent into its per-id directory. Returns `{id}`; the IPC
 *  layer wraps that in the `{ok: true, ...}` envelope. */
async function saveSubagent(data) {
  const id = slugify(data.id || data.name)
  if (!id) throw new Error("Subagent id is required")

  const existing = (await getDirectoryEntry("subagents", id))?.manifest ?? {}
  const now = new Date().toISOString()
  const manifest = {
    id,
    name: data.name || existing.name || id,
    description: data.description ?? existing.description ?? "",
    enabled: data.enabled ?? existing.enabled ?? true,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    source: data.source || existing.source || "local",
    sourcePath: data.sourcePath || existing.sourcePath,
  }

  // undefined fields are left out, as the file writer always did.
  await putDirectoryEntry(
    "subagents",
    id,
    JSON.parse(JSON.stringify(manifest)),
    data.prompt || existing.prompt || "",
  )
  return { id }
}

async function deleteSubagent(id) {
  const safeId = slugify(id)
  if (!safeId) throw new Error("Invalid subagent id")
  await removeDirectoryEntry("subagents", safeId)
}

async function importScannedAgents(agents) {
  for (const agent of agents || []) {
    const parsed = parseScannedAgent(agent)
    await saveSubagent({
      id: agent.id || parsed?.id || agent.name,
      name: parsed?.name || agent.name,
      description:
        parsed?.description || `Imported from ${agent.source || "scan"}`,
      prompt: parsed?.prompt || "",
      enabled: true,
      source: agent.source || parsed?.source || "import",
      sourcePath: agent.path || parsed?.sourcePath,
    })
  }
}

let registered = false

function registerSubagentsHandlers() {
  if (registered) return
  registered = true

  rawHandle(IpcChannel.SubagentList, async () => readSubagents(), {
    fallback: [],
    warnTag: "subagents-ipc",
  })

  safeHandle(IpcChannel.SubagentSave, async (_event, agent) =>
    saveSubagent(agent || {})
  )

  safeHandle(IpcChannel.SubagentDelete, async (_event, { id } = {}) => {
    await deleteSubagent(id)
  })

  console.log("[subagents-ipc] Handlers registered")
}

module.exports = {
  registerSubagentsHandlers,
  listSubagentDirs,
  importScannedAgents,
  parseCodexAgentToml,
  parseMarkdownAgent,
  parseScannedAgent,
}
