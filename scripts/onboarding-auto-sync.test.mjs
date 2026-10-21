import assert from "node:assert/strict"
import fs from "node:fs"
import { runInNewContext } from "node:vm"
import { test } from "node:test"

/** The module's helper functions (everything between cliAutoSync and the handlers). */
function loadOnboardingFunction(name, context) {
  const source = fs.readFileSync(new URL("../apps/shell/onboarding-ipc.cjs", import.meta.url), "utf8")
  const begin = source.indexOf("async function cliAutoSync(")
  const end = source.indexOf("let registered = false", begin)
  assert.ok(begin >= 0 && end > begin)
  return runInNewContext(`${source.slice(begin, end)}; ${name}`, context)
}

function loadCliAutoSync(context) {
  return loadOnboardingFunction("cliAutoSync", context)
}

test("the onboarding import replaces the imported plugin list only when it sends one", () => {
  const writes = []
  const save = loadOnboardingFunction("saveImportedPlugins", {})
  const writeJson = (file, value) => writes.push([file, value])

  // Settings → Skills reuses the import without a plugins field.
  assert.equal(save(undefined, "/home/.betterc0de/imported-plugins.json", writeJson), false)
  assert.equal(save(null, "/home/.betterc0de/imported-plugins.json", writeJson), false)
  assert.equal(save({ id: "not-a-list" }, "/home/.betterc0de/imported-plugins.json", writeJson), false)
  assert.deepEqual(writes, [])

  // An explicit list, empty included, is what the user selected.
  assert.equal(save([{ id: "a@claude" }], "/p.json", writeJson), true)
  assert.equal(save([], "/p.json", writeJson), true)
  assert.deepEqual(writes, [["/p.json", [{ id: "a@claude" }]], ["/p.json", []]])
})

/**
 * `updateMcps` as mcp-ipc.cjs provides it: `compute` gets the list stored at
 * write time (the backend retries on a conflict) and returns the next one,
 * or null to keep it.
 */
function fakeUpdateMcps(currentLists, onWrite) {
  const lists = [...currentLists]
  return async (compute) => {
    let next = null
    for (const current of lists.length > 0 ? lists : [[]]) next = compute(current)
    if (next) onWrite(next)
  }
}

test("the onboarding import asks before storing new MCP command lines", async () => {
  const stored = [
    { id: "same", name: "Same", command: "node", args: ["same.js"], approval: { v: 1, alg: "sha256", digest: "x" } },
  ]
  // Saved by someone else while the approval dialog was open.
  const meanwhile = { id: "meanwhile", name: "Meanwhile", command: "node", args: ["m.js"] }
  let written = null
  const approvals = []
  // resolveImportedMcpSecrets and isWorkspaceScopedAsset are the module's own.
  const importMcp = loadOnboardingFunction("importOnboardingMcpServers", {
    containsMcpSecretPlaceholder: () => false,
    withoutApprovalMarker: ({ approval: _ignored, ...rest }) => rest,
    normalizeMcpConfig: (entry) => entry,
    readMcps: () => stored,
    updateMcps: fakeUpdateMcps([[...stored, meanwhile]], (entries) => { written = entries }),
    approveMcpLaunches: async (servers, options) => {
      approvals.push({ ids: servers.map((server) => server.id), existing: servers.map(options.findExisting) })
      return servers.map((server) => ({ v: 1, alg: "sha256", digest: `approved-${server.id}` }))
    },
  })

  const result = await importMcp([
    // A renderer-supplied marker is never kept.
    { id: "new", command: "npx", args: ["server"], scope: "user", approval: { v: 1, alg: "sha256", digest: "forged" } },
    { id: "repo", command: "node", args: ["evil.js"], scope: "project" },
  ])
  assert.deepEqual(plain(result), { imported: 1, declined: 0 })
  assert.deepEqual(plain(approvals.map((call) => call.ids)), [["new"]])
  assert.deepEqual(plain(approvals[0].existing), [null])
  // Merged into the list as stored when it is written: the server saved
  // meanwhile is kept.
  assert.deepEqual(plain(written.map((entry) => [entry.id, entry.approval?.digest ?? null])), [
    ["same", "x"],
    ["meanwhile", null],
    ["new", "approved-new"],
  ])
})

test("an injected reader and writer still receive the merged list", async () => {
  let written = null
  const importMcp = loadOnboardingFunction("importOnboardingMcpServers", {
    containsMcpSecretPlaceholder: () => false,
    withoutApprovalMarker: (entry) => entry,
    normalizeMcpConfig: (entry) => entry,
    // Never reached: the injected pair is used instead.
    updateMcps: async () => assert.fail("updateMcps must not be used"),
  })
  const result = await importMcp([{ id: "new", command: "npx", scope: "user" }], {
    dependencies: {
      readMcps: async () => [{ id: "kept", command: "node" }],
      writeMcps: async (entries) => { written = entries },
      approveMcpLaunches: async (servers) => servers.map(() => ({ v: 1, alg: "sha256", digest: "ok" })),
    },
  })
  assert.deepEqual(plain(result), { imported: 1, declined: 0 })
  assert.deepEqual(plain(written.map((entry) => entry.id)), ["kept", "new"])
})

test("declining the MCP approval stores none of the imported servers", async () => {
  let written = null
  const importMcp = loadOnboardingFunction("importOnboardingMcpServers", {
    containsMcpSecretPlaceholder: () => false,
    withoutApprovalMarker: (entry) => entry,
    normalizeMcpConfig: (entry) => entry,
    readMcps: () => [],
    updateMcps: fakeUpdateMcps([], (entries) => { written = entries }),
    approveMcpLaunches: async () => null,
  })
  const result = await importMcp([
    { id: "one", command: "a", scope: "user" },
    { id: "two", command: "b", scope: "user" },
  ])
  assert.deepEqual(plain(result), { imported: 0, declined: 2 })
  assert.equal(written, null)
})

test("auto-sync deduplicates new MCP identities and transports within the same scan", async () => {
  let persisted
  const sync = loadCliAutoSync({
    scanCliAssets: () => ({
      claude: { mcpServers: [{ id: "same-id", command: "node", args: ["one"], scope: "user" }] },
      codex: { mcpServers: [
        { id: "same-id", command: "node", args: ["two"], scope: "user" },
        { id: "other-name", command: "node", args: ["one"], scope: "user" },
        { id: "unique", command: "node", args: ["three"], scope: "user" },
      ] },
      projectScope: {},
    }),
    updateMcps: fakeUpdateMcps([], (entries) => { persisted = entries }),
    normalizeMcpConfig: (entry) => entry,
    slugify: (value) => value,
    listSkillDirs: async () => [],
    listSubagentDirs: async () => [],
  })
  const result = await sync()
  assert.deepEqual(Array.from(persisted, entry => entry.id), ["same-id", "unique"])
  assert.equal(result.imported.mcpServers, 2)
})

test("auto-sync recomputes the new MCP servers against the list stored at write time", async () => {
  let persisted = null
  const sync = loadCliAutoSync({
    scanCliAssets: () => ({
      claude: { mcpServers: [
        { id: "a", command: "node", args: ["a"], scope: "user" },
        { id: "b", command: "node", args: ["b"], scope: "user" },
      ] },
      codex: { mcpServers: [] },
      projectScope: {},
    }),
    // The first attempt saw an empty list; by the retry another writer had
    // stored `b` (under another id, same command line).
    updateMcps: fakeUpdateMcps(
      [[], [{ id: "b-elsewhere", command: "node", args: ["b"] }]],
      (entries) => { persisted = entries },
    ),
    normalizeMcpConfig: (entry) => entry,
    slugify: (value) => value,
    listSkillDirs: async () => [],
    listSubagentDirs: async () => [],
  })
  const result = await sync()
  assert.deepEqual(Array.from(persisted, (entry) => entry.id), ["b-elsewhere", "a"])
  assert.equal(result.imported.mcpServers, 1)
})

test("auto-sync never copies workspace-scoped servers, skills or agents into the global stores", async () => {
  let persisted = null
  const importedSkills = []
  const importedAgents = []
  const sync = loadCliAutoSync({
    scanCliAssets: () => ({
      claude: {
        mcpServers: [
          { id: "user-server", command: "node", args: ["user.js"], scope: "user" },
          // A cloned repository's `.mcp.json` / `.claude/settings*.json`.
          { id: "repo-server", command: "node", args: ["evil.js"], scope: "project" },
          // `~/.claude.json` projects[<cwd>] entry.
          { id: "local-server", command: "node", args: ["local.js"], scope: "local" },
          // No scope: never assume user-level.
          { id: "unscoped", command: "node", args: ["x.js"] },
        ],
        skills: [
          { id: "user-skill", name: "User", scope: "user" },
          { id: "repo-skill", name: "Repo", scope: "project" },
        ],
        agents: [{ id: "repo-agent", name: "Repo agent", scope: "project" }],
      },
      codex: {
        mcpServers: [{ id: "codex-repo", command: "node", args: ["c.js"], scope: "project" }],
        skills: [],
        agents: [{ id: "user-agent", name: "User agent", scope: "user" }],
      },
      projectScope: { status: "trusted" },
    }),
    updateMcps: fakeUpdateMcps([], (entries) => { persisted = entries }),
    normalizeMcpConfig: (entry) => entry,
    slugify: (value) => value,
    listSkillDirs: async () => [],
    listSubagentDirs: async () => [],
    importScannedSkills: async (skills) => { importedSkills.push(...skills) },
    importScannedAgents: async (agents) => { importedAgents.push(...agents) },
  })
  const result = await sync()
  assert.deepEqual(Array.from(persisted, (entry) => entry.id), ["user-server"])
  assert.deepEqual(importedSkills.map((skill) => skill.id), ["user-skill"])
  assert.deepEqual(importedAgents.map((agent) => agent.id), ["user-agent"])
  assert.equal(result.imported.mcpServers, 1)
  assert.equal(result.skippedWorkspaceAssets, 6)
})

/**
 * A ledger store (`cli-imports.json`) kept in memory, using the module's own
 * parse and serialize helpers.
 */
function fakeLedgerStore(initial) {
  const parse = loadOnboardingFunction("parseCliImportLedger", {})
  const serialize = loadOnboardingFunction("serializeCliImportLedger", {})
  const store = {
    stored: initial,
    writes: 0,
    async read() {
      return parse(store.stored)
    },
    async update(compute) {
      const next = compute(parse(store.stored))
      if (!next) return
      store.stored = serialize(next)
      store.writes += 1
    },
  }
  return store
}

/** Plain copies, so values built in the module's context compare as usual. */
const plain = (value) => JSON.parse(JSON.stringify(value))

function ledgerScan() {
  return {
    claude: {
      found: true,
      mcpServers: [
        { id: "removed-server", command: "node", args: ["r.js"], scope: "user" },
        { id: "kept-server", command: "node", args: ["k.js"], scope: "user" },
        { id: "new-server", command: "node", args: ["n.js"], scope: "user" },
      ],
      skills: [
        { id: "claude-skill-removed", name: "Removed", scope: "user" },
        { id: "claude-skill-new", name: "New", scope: "user" },
      ],
      agents: [],
      skippedMcpServers: [
        { id: "odd", name: "Odd", source: "claude", scope: "user", reason: "Unsupported options." },
        { id: "repo", name: "Repo", source: "claude", scope: "project", reason: "Unsupported options." },
      ],
    },
    codex: {
      found: false,
      mcpServers: [],
      skills: [],
      agents: [{ id: "codex-agent-removed", name: "Removed agent", scope: "user" }],
    },
    projectScope: {},
  }
}

test("auto-sync does not bring back CLI items the user removed, and records what it saw", async () => {
  const store = fakeLedgerStore({
    version: 1,
    imported: {
      mcpServers: ["removed-server", "kept-server"],
      skills: ["claude-skill-removed"],
      agents: ["codex-agent-removed"],
    },
    // A field a newer release added survives the rewrite.
    futureField: "keep",
  })
  let persisted = null
  const importedSkills = []
  const importedAgents = []
  const sync = loadCliAutoSync({
    scanCliAssets: ledgerScan,
    updateMcps: fakeUpdateMcps(
      [[{ id: "kept-server", command: "node", args: ["k.js"] }]],
      (entries) => { persisted = entries },
    ),
    normalizeMcpConfig: (entry) => entry,
    slugify: (value) => value,
    listSkillDirs: async () => [],
    listSubagentDirs: async () => [],
    importScannedSkills: async (skills) => { importedSkills.push(...skills) },
    importScannedAgents: async (agents) => { importedAgents.push(...agents) },
  })

  const result = await sync(undefined, { importLedger: store })

  assert.deepEqual(Array.from(persisted, (entry) => entry.id), ["kept-server", "new-server"])
  assert.deepEqual(importedSkills.map((skill) => skill.id), ["claude-skill-new"])
  assert.equal(importedAgents.length, 0)
  assert.deepEqual(plain(result.imported), { mcpServers: 1, skills: 1, agents: 0 })
  assert.deepEqual(plain(result.dismissed), { mcpServers: 1, skills: 1, agents: 1 })
  // Only the user-level server the scanner could not import is reported.
  assert.deepEqual(plain(result.skippedMcpServers), [
    { id: "odd", name: "Odd", source: "claude", reason: "Unsupported options." },
  ])
  assert.deepEqual(plain(result.found), { claude: true, codex: false })
  assert.equal(store.writes, 1)
  assert.equal(store.stored.futureField, "keep")
  assert.deepEqual(plain(store.stored.imported), {
    mcpServers: ["removed-server", "kept-server", "new-server"],
    skills: ["claude-skill-removed", "claude-skill-new"],
    agents: ["codex-agent-removed"],
  })
})

test("a manual sync brings removed items back, only for the kinds it asks for", async () => {
  const store = fakeLedgerStore({
    version: 1,
    imported: { mcpServers: ["removed-server"], skills: ["claude-skill-removed"] },
  })
  let persisted = null
  const sync = loadCliAutoSync({
    scanCliAssets: ledgerScan,
    updateMcps: fakeUpdateMcps([], (entries) => { persisted = entries }),
    normalizeMcpConfig: (entry) => entry,
    slugify: (value) => value,
    listSkillDirs: async () => assert.fail("skills are not part of this sync"),
    listSubagentDirs: async () => assert.fail("agents are not part of this sync"),
  })

  const result = await sync(
    { kinds: ["mcpServers"], includeDismissed: true },
    { importLedger: store },
  )

  assert.deepEqual(Array.from(persisted, (entry) => entry.id), [
    "removed-server",
    "kept-server",
    "new-server",
  ])
  assert.deepEqual(plain(result.imported), { mcpServers: 3, skills: 0, agents: 0 })
  assert.deepEqual(plain(result.dismissed), { mcpServers: 0, skills: 0, agents: 0 })
})

test("without a ledger store auto-sync imports as before and records nothing", async () => {
  let persisted = null
  const sync = loadCliAutoSync({
    scanCliAssets: ledgerScan,
    updateMcps: fakeUpdateMcps([], (entries) => { persisted = entries }),
    normalizeMcpConfig: (entry) => entry,
    slugify: (value) => value,
    listSkillDirs: async () => [],
    listSubagentDirs: async () => [],
    importScannedSkills: async () => {},
    importScannedAgents: async () => {},
  })
  const result = await sync()
  assert.equal(persisted.length, 3)
  assert.deepEqual(plain(result.dismissed), { mcpServers: 0, skills: 0, agents: 0 })
})

test("the ledger reads malformed content as empty and keeps only valid ids", () => {
  const parse = loadOnboardingFunction("parseCliImportLedger", {})
  const withIds = loadOnboardingFunction("withCliImportIds", {})
  const empty = parse("not a ledger")
  assert.equal(empty.version, 1)
  assert.equal(empty.ids.skills.size, 0)

  const newer = parse({ version: 2, imported: { skills: ["a", 7, "", "b"], mcpServers: "x" } })
  assert.equal(newer.version, 2)
  assert.deepEqual([...newer.ids.skills], ["a", "b"])
  assert.equal(newer.ids.mcpServers.size, 0)
  // Nothing new: no write.
  assert.equal(withIds(newer, { skills: ["a"] }), null)
  assert.deepEqual([...withIds(newer, { skills: ["c"] }).ids.skills], ["a", "b", "c"])
})

test("an onboarding import records only what it stored", async () => {
  const store = fakeLedgerStore(null)
  const record = loadOnboardingFunction("recordOnboardingImports", {
    slugify: (value) => value,
  })
  await record(
    {
      mcpServers: [
        { id: "stored", scope: "user" },
        // Declined or unresolvable: never reached the stored list.
        { id: "declined", scope: "user" },
        { id: "repo", scope: "project" },
      ],
      skills: [{ id: "claude-skill-a", scope: "user" }],
      agents: [{ id: "claude-agent-b", scope: "project" }],
    },
    { imported: 2, declined: 0 },
    {
      importLedger: store,
      readMcps: async () => [{ id: "stored" }, { id: "repo" }],
    },
  )
  assert.deepEqual(plain(store.stored.imported), {
    mcpServers: ["stored"],
    skills: ["claude-skill-a"],
    agents: [],
  })
})
