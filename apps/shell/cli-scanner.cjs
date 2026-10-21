/**
 * Native CLI asset scanner used by onboarding and the non-blocking auto-sync.
 *
 * The provider runtimes remain authoritative for live capabilities. This
 * scanner only imports portable, file-backed assets (MCP definitions, skills,
 * and agents) into BetterC0de. Commands are inventoried for diagnostics but
 * stay native to the CLI that owns their invocation semantics.
 *
 * Sources are evaluated from least to most specific. Assets follow each CLI's
 * native collision behavior: configuration and agents use the closest scope,
 * Claude skills use project precedence, and Codex keeps same-named skills from
 * multiple `.agents/skills` roots visible.
 *
 * All file access is asynchronous (fs/promises): the scans run in the
 * Electron main process, where synchronous reads of a large
 * `~/.claude.json` or a deep skills tree froze every window.
 */

const fsp = require("fs/promises")
const path = require("path")
const os = require("os")
const {
  readJsonAsync,
  readBoundedRegularFileAsync,
} = require("./shared/json-fs.cjs")

const MAX_DISCOVERED_FILES = 512
const MAX_DISCOVERY_DEPTH = 8
const MAX_DISCOVERY_FILE_BYTES = 1024 * 1024
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/
const ENVIRONMENT_VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

async function listDirs(dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

async function listFilesRecursive(dir, extension, depth = 0, prefix = "") {
  if (depth > MAX_DISCOVERY_DEPTH) return []
  let entries
  try {
    entries = (await fsp.readdir(dir, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name)
    )
  } catch {
    return []
  }

  const files = []
  for (const entry of entries) {
    if (files.length >= MAX_DISCOVERED_FILES) break
    const relative = prefix ? path.join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      files.push(
        ...(
          await listFilesRecursive(
            path.join(dir, entry.name),
            extension,
            depth + 1,
            relative
          )
        ).slice(0, MAX_DISCOVERED_FILES - files.length)
      )
      continue
    }
    if (
      entry.isFile() &&
      (!extension || entry.name.toLowerCase().endsWith(extension))
    ) {
      files.push(relative)
    }
  }
  return files
}

function expandHome(value, homeDir) {
  if (value === "~") return homeDir
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDir, value.slice(2))
  }
  return value
}

function resolveClaudeConfigDir(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const configured =
    options.claudeDir ||
    options.configDir ||
    options.environment?.CLAUDE_CONFIG_DIR ||
    process.env.CLAUDE_CONFIG_DIR
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(expandHome(configured.trim(), homeDir))
  }
  return path.join(homeDir, ".claude")
}

function resolveCodexHome(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const configured =
    options.codexDir ||
    options.environment?.CODEX_HOME ||
    process.env.CODEX_HOME
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(expandHome(configured.trim(), homeDir))
  }
  return path.join(homeDir, ".codex")
}

function titleize(value) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

async function readFrontmatter(file) {
  let content
  try {
    content = (
      await readBoundedRegularFileAsync(file, MAX_DISCOVERY_FILE_BYTES)
    ).toString("utf8")
  } catch {
    return {}
  }
  if (!content.startsWith("---")) return {}
  const end = content.search(/\r?\n---(?:\r?\n|$)/)
  if (end < 0) return {}
  const metadata = {}
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^(name|description)\s*:\s*(.+?)\s*$/)
    if (!match) continue
    metadata[match[1]] = match[2].replace(/^["']|["']$/g, "").trim()
  }
  return metadata
}

async function findSkillFile(skillDir) {
  for (const name of ["SKILL.md", "skill.md"]) {
    const candidate = path.join(skillDir, name)
    try {
      if ((await fsp.stat(candidate)).isFile()) return candidate
    } catch {
      // Try the next canonical spelling.
    }
  }
  return null
}

/** Map `items` through an async function, keeping their order. */
function mapInOrder(items, mapper) {
  return Promise.all(items.map((item) => mapper(item)))
}

async function readSkills(root, source, scope, idNamespace = "") {
  const skills = await mapInOrder(await listDirs(root), async (directoryName) => {
    const skillDir = path.join(root, directoryName)
    const skillFile = await findSkillFile(skillDir)
    if (!skillFile) return []
    const metadata = await readFrontmatter(skillFile)
    const name = metadata.name || titleize(directoryName)
    return [
      {
        id: `${source}-skill-${
          idNamespace ? `${slug(idNamespace)}-` : ""
        }${slug(directoryName)}`,
        name,
        ...(metadata.description ? { description: metadata.description } : {}),
        source,
        scope,
        providerKinds: [source],
        path: skillDir,
        sourcePath: skillFile,
      },
    ]
  })
  return skills.flat()
}

async function readMarkdownAssets(root, source, scope, kind) {
  return mapInOrder(await listFilesRecursive(root, ".md"), async (relativeFile) => {
    const absolutePath = path.join(root, relativeFile)
    const metadata = await readFrontmatter(absolutePath)
    const relativeName = relativeFile
      .replace(/\.md$/i, "")
      .split(path.sep)
      .join("/")
    const name = metadata.name || titleize(relativeName)
    return {
      id: `${source}-${kind}-${slug(relativeName)}`,
      name,
      ...(metadata.description ? { description: metadata.description } : {}),
      source,
      scope,
      path: absolutePath,
      sourcePath: absolutePath,
    }
  })
}

function mergeByLogicalName(groups) {
  const byName = new Map()
  for (const group of groups) {
    for (const item of group) {
      byName.set(String(item.name).trim().toLowerCase(), item)
    }
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  )
}

function sortByName(items) {
  return [...items].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  )
}

function dedupeByLogicalName(groups) {
  return mergeByLogicalName(groups)
}

function stripTomlComment(value) {
  let quote = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\" && quote === '"') {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char
      continue
    }
    if (char === "#" && !quote) return value.slice(0, index).trim()
  }
  return value.trim()
}

function splitTomlList(value) {
  const entries = []
  let current = ""
  let quote = null
  let escaped = false
  let nested = 0
  for (const char of value) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\" && quote === '"') {
      current += char
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char
      current += char
      continue
    }
    if (!quote && (char === "[" || char === "{")) nested += 1
    if (!quote && (char === "]" || char === "}")) nested -= 1
    if (char === "," && !quote && nested === 0) {
      entries.push(current.trim())
      current = ""
      continue
    }
    current += char
  }
  if (current.trim()) entries.push(current.trim())
  return entries
}

function parseTomlValue(rawValue) {
  const value = stripTomlComment(rawValue)
  if (!value) return ""
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  if (value === "true") return true
  if (value === "false") return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTomlList(value.slice(1, -1))
      .map(parseTomlValue)
      .filter((entry) => entry !== "")
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const record = {}
    for (const entry of splitTomlList(value.slice(1, -1))) {
      const match = entry.match(
        /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/
      )
      if (!match) continue
      const key = match[1].replace(/^["']|["']$/g, "")
      setOwnValue(record, key, parseTomlValue(match[2]))
    }
    return record
  }
  return value
}

function setOwnValue(record, key, value) {
  Object.defineProperty(record, key, {
    value, writable: true, enumerable: true, configurable: true,
  })
  return value
}

function parseMcpSection(section) {
  const match = section.match(
    /^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^.]+?))(?:\.(env|http_headers|env_http_headers))?$/
  )
  if (!match) return null
  return {
    name: match[1] || match[2] || match[3],
    child: match[4] || null,
  }
}

function parseTomlConfig(text) {
  const mcpServers = {}
  const config = { features: {} }
  let currentSection = ""

  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const section = trimmed.match(/^\[(.+)]$/)
    if (section) {
      currentSection = section[1].trim()
      continue
    }
    const keyValue = trimmed.match(
      /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/
    )
    if (!keyValue) continue
    const key = keyValue[1].replace(/^["']|["']$/g, "")
    const value = parseTomlValue(keyValue[2])
    const mcpSection = parseMcpSection(currentSection)
    if (mcpSection) {
      const server = Object.hasOwn(mcpServers, mcpSection.name)
        ? mcpServers[mcpSection.name]
        : setOwnValue(mcpServers, mcpSection.name, {})
      if (mcpSection.child) {
        const child = Object.hasOwn(server, mcpSection.child)
          ? server[mcpSection.child]
          : setOwnValue(server, mcpSection.child, {})
        if (child && typeof child === "object" && !Array.isArray(child)) {
          setOwnValue(child, key, value)
        }
      } else {
        setOwnValue(server, key, value)
      }
      continue
    }
    if (!currentSection && key === "model" && typeof value === "string") {
      config.model = value
    } else if (currentSection === "features" && typeof value === "boolean") {
      setOwnValue(config.features, key, value)
    }
  }

  return { mcpServers, config }
}

async function parseTomlMcpServers(file) {
  try {
    return parseTomlConfig(
      (await readBoundedRegularFileAsync(file, MAX_DISCOVERY_FILE_BYTES)).toString("utf8")
    ).mcpServers
  } catch {
    return {}
  }
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : []
}

function normalizeStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry) => typeof entry[1] === "string")
  )
}

function normalizeMcpServer(name, raw, source, sourcePath, scope) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const supportedKeys = new Set([
    "args",
    "command",
    "disabled",
    "enabled",
    "env",
    "env_http_headers",
    "http_headers",
    "serverUrl",
    "type",
    "url",
  ])
  const unsupportedKeys = Object.keys(raw).filter(
    (key) => !supportedKeys.has(key)
  )
  if (unsupportedKeys.length > 0) {
    return {
      skipped: {
        id: name,
        name: titleize(name),
        source,
        scope,
        sourcePath,
        reason:
          "The source uses MCP options that BetterC0de cannot import without changing their semantics.",
        unsupportedKeys: unsupportedKeys.sort(),
      },
    }
  }
  if (
    raw.args !== undefined &&
    (!Array.isArray(raw.args) ||
      raw.args.some((entry) => typeof entry !== "string"))
  ) {
    return {
      skipped: {
        id: name,
        name: titleize(name),
        source,
        scope,
        sourcePath,
        reason: "The source has a malformed MCP args list.",
        unsupportedKeys: ["args"],
      },
    }
  }
  if (
    raw.env !== undefined &&
    (!raw.env ||
      typeof raw.env !== "object" ||
      Array.isArray(raw.env) ||
      Object.values(raw.env).some((entry) => typeof entry !== "string"))
  ) {
    return {
      skipped: {
        id: name,
        name: titleize(name),
        source,
        scope,
        sourcePath,
        reason: "The source has a malformed MCP environment map.",
        unsupportedKeys: ["env"],
      },
    }
  }
  for (const [key, label] of [
    ["http_headers", "HTTP header"],
    ["env_http_headers", "environment-backed HTTP header"],
  ]) {
    const value = raw[key]
    const entries =
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value)
        : []
    if (
      value !== undefined &&
      (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        entries.some(
          ([name, entry]) =>
            !HTTP_HEADER_NAME_RE.test(name) ||
            typeof entry !== "string" ||
            (key === "env_http_headers"
              ? !ENVIRONMENT_VARIABLE_NAME_RE.test(entry)
              : /[\0\r\n]/.test(entry))
        ))
    ) {
      return {
        skipped: {
          id: name,
          name: titleize(name),
          source,
          scope,
          sourcePath,
          reason: `The source has a malformed MCP ${label} map.`,
          unsupportedKeys: [key],
        },
      }
    }
  }
  const command =
    typeof raw.command === "string" && raw.command.trim()
      ? raw.command.trim()
      : null
  const urlCandidate =
    typeof raw.url === "string"
      ? raw.url
      : typeof raw.serverUrl === "string"
        ? raw.serverUrl
        : null
  const url = urlCandidate?.trim() || null
  if (!command && !url) return null
  if (
    command &&
    (Object.keys(normalizeStringRecord(raw.http_headers)).length > 0 ||
      Object.keys(normalizeStringRecord(raw.env_http_headers)).length > 0)
  ) {
    return {
      skipped: {
        id: name,
        name: titleize(name),
        source,
        scope,
        sourcePath,
        reason:
          "The source attaches HTTP headers to a command MCP transport, which BetterC0de cannot import without changing its semantics.",
        unsupportedKeys: ["env_http_headers", "http_headers"].filter(
          (key) => Object.keys(normalizeStringRecord(raw[key])).length > 0
        ),
      },
    }
  }
  return {
    server: {
      id: name,
      name: titleize(name),
      source,
      type: command ? "command" : "http",
      ...(command ? { command } : {}),
      args: normalizeStringArray(raw.args),
      env: normalizeStringRecord(raw.env),
      ...(!command && raw.http_headers !== undefined
        ? { headers: normalizeStringRecord(raw.http_headers) }
        : {}),
      ...(!command && raw.env_http_headers !== undefined
        ? { headerEnv: normalizeStringRecord(raw.env_http_headers) }
        : {}),
      ...(url ? { url } : {}),
      enabled: raw.enabled !== false && raw.disabled !== true,
      authenticated: false,
      scope,
      sourcePath,
    },
  }
}

function mergeMcpObject(
  target,
  rawServers,
  source,
  sourcePath,
  scope,
  skipped = []
) {
  if (
    !rawServers ||
    typeof rawServers !== "object" ||
    Array.isArray(rawServers)
  ) {
    return
  }
  for (const [name, raw] of Object.entries(rawServers)) {
    const normalized = normalizeMcpServer(name, raw, source, sourcePath, scope)
    if (normalized?.server) target.set(name.toLowerCase(), normalized.server)
    if (normalized?.skipped) skipped.push(normalized.skipped)
  }
}

// `~/.claude.json` grows with Claude Code's project history (up to the 8 MB
// JSON read limit), every scan reads it twice, and auto-sync scans on each
// project switch. Parse a config file once per change of its identity (size,
// mtime, ctime, inode). Cached values are shared between scans: callers must
// treat them as read-only.
const MAX_PARSED_JSON_CACHE = 16
const parsedJsonCache = new Map()

async function readJsonCached(file) {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    parsedJsonCache.delete(file)
    return readJsonAsync(file)
  }
  const identity = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
  const cached = parsedJsonCache.get(file)
  if (cached && cached.identity === identity) return cached.value
  const value = await readJsonAsync(file)
  parsedJsonCache.delete(file)
  if (parsedJsonCache.size >= MAX_PARSED_JSON_CACHE) {
    parsedJsonCache.delete(parsedJsonCache.keys().next().value)
  }
  parsedJsonCache.set(file, { identity, value })
  return value
}

async function mergeJsonMcpFile(target, file, source, scope, configSources, skipped) {
  const parsed = await readJsonCached(file)
  if (!parsed || typeof parsed !== "object") return
  configSources.push(file)
  mergeMcpObject(
    target,
    parsed.mcpServers || parsed.mcp_servers || parsed,
    source,
    file,
    scope,
    skipped
  )
}

async function mergeClaudeCredentials(target, file, configSources) {
  const parsed = await readJsonAsync(file)
  if (!parsed || typeof parsed !== "object") return
  configSources.push(file)
  const servers = parsed.mcpServers
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const key = name.toLowerCase()
    const existing = target.get(key)
    const url =
      typeof raw.serverUrl === "string" && raw.serverUrl.trim()
        ? raw.serverUrl.trim()
        : null
    if (!existing && !url) continue
    target.set(key, {
      ...(existing || {
        id: name,
        name: titleize(name),
        source: "claude",
        type: "oauth",
        args: [],
        env: {},
        enabled: true,
        scope: "user",
        sourcePath: file,
      }),
      ...(url ? { url } : {}),
      authenticated:
        typeof raw.accessToken === "string" && raw.accessToken.length > 0,
    })
  }
}

async function mergeClaudeLocalProjectMcp(
  target,
  file,
  cwd,
  configSources,
  skipped
) {
  const parsed = await readJsonCached(file)
  const projects =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed.projects
      : null
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    return
  }
  const normalizedCwd = normalizedPathIdentity(cwd)
  const entry = Object.entries(projects).find(
    ([projectPath]) => normalizedPathIdentity(projectPath) === normalizedCwd
  )?.[1]
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return
  configSources.push(file)
  mergeMcpObject(
    target,
    entry.mcpServers,
    "claude",
    file,
    "local",
    skipped
  )
}

function normalizedPathIdentity(value) {
  const normalized = path.normalize(path.resolve(String(value || "")))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

async function existingFiles(files) {
  const present = await mapInOrder(files, async (file) => {
    try {
      return (await fsp.stat(file)).isFile()
    } catch {
      return false
    }
  })
  return files.filter((_file, index) => present[index])
}

async function pathExists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

async function scanClaude(options = {}) {
  const homeDir = options.homeDir || os.homedir()
  const claudeDir = resolveClaudeConfigDir(options)
  const cwd = options.cwd ? path.resolve(options.cwd) : null
  const projectDir =
    cwd && options.workspaceTrusted === true ? path.join(cwd, ".claude") : null
  const configSources = []
  const skippedMcpServers = []
  const settingsPath = path.join(claudeDir, "settings.json")
  const settings = await readJsonAsync(settingsPath)
  if (settings && typeof settings === "object") configSources.push(settingsPath)

  const enabledPlugins = settings?.enabledPlugins
  const pluginIds = Array.isArray(enabledPlugins)
    ? enabledPlugins.filter((id) => typeof id === "string")
    : enabledPlugins && typeof enabledPlugins === "object"
      ? Object.entries(enabledPlugins)
          .filter(([, value]) => value !== false)
          .map(([id]) => id)
      : []

  const mcpByName = new Map()
  mergeMcpObject(
    mcpByName,
    settings?.mcpServers,
    "claude",
    settingsPath,
    "user",
    skippedMcpServers
  )
  // Sequential on purpose: later sources override earlier ones by name.
  for (const file of [
    path.join(homeDir, ".claude.json"),
    path.join(claudeDir, ".mcp.json"),
  ]) {
    await mergeJsonMcpFile(
      mcpByName,
      file,
      "claude",
      "user",
      configSources,
      skippedMcpServers
    )
  }
  await mergeClaudeCredentials(
    mcpByName,
    path.join(claudeDir, "credentials.json"),
    configSources
  )
  if (cwd && projectDir) {
    for (const file of [
      path.join(cwd, ".mcp.json"),
      path.join(projectDir, "settings.json"),
      path.join(projectDir, "settings.local.json"),
    ]) {
      await mergeJsonMcpFile(
        mcpByName,
        file,
        "claude",
        "project",
        configSources,
        skippedMcpServers
      )
    }
    await mergeClaudeLocalProjectMcp(
      mcpByName,
      path.join(homeDir, ".claude.json"),
      cwd,
      configSources,
      skippedMcpServers
    )
  }

  const [
    userSkills,
    projectSkills,
    userAgents,
    projectAgents,
    userCommands,
    projectCommands,
    found,
  ] = await Promise.all([
    readSkills(path.join(claudeDir, "skills"), "claude", "user"),
    projectDir
      ? readSkills(path.join(projectDir, "skills"), "claude", "project")
      : [],
    readMarkdownAssets(path.join(claudeDir, "agents"), "claude", "user", "agent"),
    projectDir
      ? readMarkdownAssets(
          path.join(projectDir, "agents"),
          "claude",
          "project",
          "agent"
        )
      : [],
    readMarkdownAssets(
      path.join(claudeDir, "commands"),
      "claude",
      "user",
      "command"
    ),
    projectDir
      ? readMarkdownAssets(
          path.join(projectDir, "commands"),
          "claude",
          "project",
          "command"
        )
      : [],
    (async () =>
      (await pathExists(claudeDir)) ||
      Boolean(projectDir && (await pathExists(projectDir))) ||
      Boolean(
        projectDir && cwd && (await pathExists(path.join(cwd, ".mcp.json")))
      ))(),
  ])

  return {
    found,
    plugins: pluginIds
      .map((id) => ({
        id,
        name: titleize(String(id).split("@")[0]),
        source: "claude",
        marketplace: "claude",
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    mcpServers: [...mcpByName.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    ),
    skills: mergeByLogicalName([userSkills, projectSkills]),
    agents: mergeByLogicalName([userAgents, projectAgents]),
    commands: mergeByLogicalName([userCommands, projectCommands]),
    skippedMcpServers,
    configSources: [...new Set(configSources)],
  }
}

async function readTomlAgentMetadata(file) {
  let content
  try {
    content = (
      await readBoundedRegularFileAsync(file, MAX_DISCOVERY_FILE_BYTES)
    ).toString("utf8")
  } catch {
    return {}
  }
  const metadata = {}
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^(name|description)\s*=\s*(["'])(.*?)\2\s*(?:#.*)?$/
    )
    if (match) metadata[match[1]] = match[3].trim()
  }
  return metadata
}

async function readCodexAgents(root, scope) {
  return mapInOrder(await listFilesRecursive(root, ".toml"), async (relativeFile) => {
    const relativeName = relativeFile
      .replace(/\.toml$/i, "")
      .split(path.sep)
      .join("/")
    const absolutePath = path.join(root, relativeFile)
    const metadata = await readTomlAgentMetadata(absolutePath)
    const name = metadata.name || titleize(relativeName)
    return {
      id: `codex-agent-${slug(relativeName)}`,
      name,
      ...(metadata.description ? { description: metadata.description } : {}),
      source: "codex",
      scope,
      path: absolutePath,
      sourcePath: absolutePath,
    }
  })
}

async function findDefaultProjectRoot(cwd) {
  let current = path.resolve(cwd)
  while (true) {
    if (await pathExists(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

function projectLayerDirectories(cwd, projectRoot) {
  const resolvedCwd = path.resolve(cwd)
  const resolvedRoot = path.resolve(projectRoot)
  const relative = path.relative(resolvedRoot, resolvedCwd)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return [resolvedCwd]
  }
  const segments = relative ? relative.split(path.sep).filter(Boolean) : []
  const directories = [resolvedRoot]
  let current = resolvedRoot
  for (const segment of segments) {
    current = path.join(current, segment)
    directories.push(current)
  }
  return directories
}

async function scanCodex(options = {}) {
  const codexDir = resolveCodexHome(options)
  const homeDir = options.homeDir || os.homedir()
  const cwd = options.cwd ? path.resolve(options.cwd) : null
  const projectRoot = cwd
    ? path.resolve(options.projectRoot || (await findDefaultProjectRoot(cwd)))
    : null
  const projectDirectories =
    cwd && projectRoot && options.workspaceTrusted === true
      ? projectLayerDirectories(cwd, projectRoot)
      : []
  const configSources = []
  const skippedMcpServers = []
  const mcpByName = new Map()
  let model = null
  const features = {}

  for (const { file, scope } of [
    { file: path.join(codexDir, "config.toml"), scope: "user" },
    ...projectDirectories.map((directory) => ({
      file: path.join(directory, ".codex", "config.toml"),
      scope: "project",
    })),
  ]) {
    let parsed
    try {
      parsed = parseTomlConfig(
        (await readBoundedRegularFileAsync(file, MAX_DISCOVERY_FILE_BYTES)).toString("utf8")
      )
    } catch {
      continue
    }
    configSources.push(file)
    mergeMcpObject(
      mcpByName,
      parsed.mcpServers,
      "codex",
      file,
      scope,
      skippedMcpServers
    )
    if (parsed.config.model) model = parsed.config.model
    for (const [key, value] of Object.entries(parsed.config.features)) {
      setOwnValue(features, key, value)
    }
  }

  const [
    codexUserSkills,
    agentsUserSkills,
    projectSkillGroups,
    userAgents,
    projectAgentGroups,
    found,
  ] = await Promise.all([
    readSkills(path.join(codexDir, "skills"), "codex", "user"),
    readSkills(path.join(homeDir, ".agents", "skills"), "codex", "user"),
    mapInOrder(projectDirectories, (directory) => {
      const namespace =
        projectRoot && directory === projectRoot
          ? "root"
          : path.relative(projectRoot || directory, directory) || "cwd"
      return readSkills(
        path.join(directory, ".agents", "skills"),
        "codex",
        "project",
        namespace
      )
    }),
    readCodexAgents(path.join(codexDir, "agents"), "user"),
    mapInOrder(projectDirectories, (directory) =>
      readCodexAgents(path.join(directory, ".codex", "agents"), "project")
    ),
    (async () => {
      if (await pathExists(codexDir)) return true
      if (await pathExists(path.join(homeDir, ".agents"))) return true
      for (const directory of projectDirectories) {
        if (
          (await pathExists(path.join(directory, ".codex"))) ||
          (await pathExists(path.join(directory, ".agents")))
        ) {
          return true
        }
      }
      return false
    })(),
  ])
  const userSkills = dedupeByLogicalName([codexUserSkills, agentsUserSkills])
  const projectSkills = projectSkillGroups.flat()
  const projectAgents = projectAgentGroups.flat()

  return {
    found,
    plugins: [],
    mcpServers: [...mcpByName.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    ),
    // Codex intentionally surfaces duplicate skill names from nested
    // `.agents/skills` roots; unlike agents/config, they do not override.
    skills: sortByName([...userSkills, ...projectSkills]),
    agents: mergeByLogicalName([userAgents, projectAgents]),
    commands: [],
    skippedMcpServers,
    configSources: await existingFiles(configSources),
    ...(model ? { model } : {}),
    ...(Object.keys(features).length > 0 ? { features } : {}),
  }
}

module.exports = {
  scanClaude,
  scanCodex,
  parseTomlMcpServers,
  parseTomlConfig,
  resolveClaudeConfigDir,
  resolveCodexHome,
}
