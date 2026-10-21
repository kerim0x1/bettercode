import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { after, test } from "node:test"
import { installFakeDesktopConfigBackend } from "./fake-desktop-config-backend.mjs"

// mcp-servers.json belongs to the backend. The shell reaches it through
// shared/desktop-config-client.cjs, answered here by a fake backend that
// keeps the file in `home` (the runtime home) like the real one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-mcp-secrets-"))
process.env.BETTERC0DE_HOME = home
const backend = installFakeDesktopConfigBackend(home)
after(() => {
  backend.restore()
  fs.rmSync(home, { recursive: true, force: true })
})

const require = createRequire(import.meta.url)
const {
  setMcpEncryptionKey,
  readMcps,
  writeMcps,
  updateMcps,
  normalizeMcpConfig,
  redactMcpForRenderer,
  withStoredMcpSecrets,
  resolveProbeSecrets,
  MCP_SECRET_PLACEHOLDER,
} = require("../apps/shell/mcp-ipc.cjs")
const {
  redactScanSecrets,
  resolveImportedMcpSecrets,
} = require("../apps/shell/onboarding-ipc.cjs")

const storePath = path.join(home, "mcp-servers.json")
const key = crypto.randomBytes(32)

/** The backend's `settings/crypto.ts` `decryptSecret`, inlined. */
function backendDecrypt(value, secretKey = key) {
  assert.ok(value.startsWith("enc:v1:"), `expected ciphertext, got ${value}`)
  const payload = Buffer.from(value.slice("enc:v1:".length), "base64")
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    secretKey,
    payload.subarray(0, 12)
  )
  decipher.setAuthTag(payload.subarray(12, 28))
  return Buffer.concat([
    decipher.update(payload.subarray(28)),
    decipher.final(),
  ]).toString("utf8")
}

const onDisk = () => JSON.parse(fs.readFileSync(storePath, "utf8"))

// Encrypting plaintext an older version left in mcp-servers.json is the
// backend's job now (apps/backend/src/services/desktop-config/migration.test.ts).
test("the shell sends only ciphertext and reads plaintext back; installing the key writes nothing", async () => {
  fs.writeFileSync(
    storePath,
    JSON.stringify([
      {
        id: "github",
        name: "GitHub",
        type: "command",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "ghp_plaintext", EMPTY: "" },
        enabled: true,
      },
      {
        id: "remote",
        name: "Remote",
        type: "http",
        command: "",
        args: [],
        env: {},
        headers: { Authorization: "Bearer remote-secret" },
        headerEnv: { "X-Api-Key": "REMOTE_API_KEY" },
        url: "https://mcp.example.test",
        enabled: true,
      },
    ])
  )

  const requestsBefore = backend.requests.length
  setMcpEncryptionKey(key.toString("base64"))
  assert.equal(backend.requests.length, requestsBefore)
  assert.ok(fs.readFileSync(storePath, "utf8").includes("ghp_plaintext"))

  // Plaintext from an older version reads as itself until it is rewritten.
  const legacy = await readMcps()
  assert.equal(legacy[0].env.GITHUB_TOKEN, "ghp_plaintext")
  await writeMcps(legacy)

  // The request to the backend already carries ciphertext.
  const put = backend.requests.findLast((request) => request.method === "PUT")
  assert.equal(put.path, "/config/mcp")
  for (const secret of ["ghp_plaintext", "remote-secret"]) {
    assert.ok(!JSON.stringify(put.body).includes(secret), `sent ${secret}`)
  }
  const raw = fs.readFileSync(storePath, "utf8")
  assert.ok(!raw.includes("ghp_plaintext"))
  assert.ok(!raw.includes("remote-secret"))
  const [github, remote] = onDisk()
  assert.equal(backendDecrypt(github.env.GITHUB_TOKEN), "ghp_plaintext")
  // Empty values carry nothing and stay empty.
  assert.equal(github.env.EMPTY, "")
  assert.equal(backendDecrypt(remote.headers.Authorization), "Bearer remote-secret")
  // Environment variable *names* are not secrets.
  assert.deepEqual(remote.headerEnv, { "X-Api-Key": "REMOTE_API_KEY" })

  const plain = await readMcps()
  assert.equal(plain[0].env.GITHUB_TOKEN, "ghp_plaintext")
  assert.equal(plain[1].headers.Authorization, "Bearer remote-secret")
})

test("writes new entries encrypted", async () => {
  await writeMcps([
    ...(await readMcps()),
    { id: "db", name: "DB", command: "pg-mcp", env: { DATABASE_URL: "postgres://u:p@h/db" } },
  ])
  const stored = onDisk().find((entry) => entry.id === "db")
  assert.equal(backendDecrypt(stored.env.DATABASE_URL), "postgres://u:p@h/db")
  assert.equal(
    (await readMcps()).find((entry) => entry.id === "db").env.DATABASE_URL,
    "postgres://u:p@h/db"
  )
})

test("updateMcps writes against the revision it read and keeps a concurrent change", async () => {
  // Another writer stores a server between this update's read and its write.
  backend.beforeNextWrite("mcp", () => {
    const current = onDisk()
    fs.writeFileSync(
      storePath,
      JSON.stringify([...current, { id: "concurrent", name: "concurrent", command: "node", args: [], env: {} }])
    )
  })
  let runs = 0
  await updateMcps((current) => {
    runs += 1
    return [...current, { id: "added", name: "added", command: "node", args: ["a.js"], env: {} }]
  })
  assert.equal(runs, 2, "the change is computed again on the fresh list")
  const ids = onDisk().map((entry) => entry.id)
  assert.ok(ids.includes("concurrent"))
  assert.ok(ids.includes("added"))
  // `null` keeps the list as it is and writes nothing.
  const writes = backend.requests.filter((request) => request.method === "PUT").length
  await updateMcps(() => null)
  assert.equal(backend.requests.filter((request) => request.method === "PUT").length, writes)
})

test("the renderer projection carries key names and placeholders, never values", async () => {
  const projected = (await readMcps()).map(redactMcpForRenderer)
  const serialized = JSON.stringify(projected)
  for (const secret of ["ghp_plaintext", "remote-secret", "u:p@h", "enc:v1:"]) {
    assert.ok(!serialized.includes(secret), `leaked ${secret}`)
  }
  const github = projected.find((entry) => entry.id === "github")
  assert.deepEqual(github.env, { GITHUB_TOKEN: MCP_SECRET_PLACEHOLDER, EMPTY: "" })
  assert.deepEqual(github.envKeys, ["GITHUB_TOKEN", "EMPTY"])
  assert.equal(github.secretsRedacted, true)
  const remote = projected.find((entry) => entry.id === "remote")
  assert.deepEqual(remote.headers, { Authorization: MCP_SECRET_PLACEHOLDER })
  assert.deepEqual(remote.headerKeys, ["Authorization"])
})

test("a placeholder sent back keeps the stored value; an unknown placeholder is refused", async () => {
  const stored = (await readMcps()).find((entry) => entry.id === "github")
  const edited = withStoredMcpSecrets(
    {
      id: "github",
      name: "GitHub",
      command: "npx",
      env: { GITHUB_TOKEN: MCP_SECRET_PLACEHOLDER, NEW_KEY: "typed" },
    },
    stored
  )
  assert.deepEqual(edited.env, { GITHUB_TOKEN: "ghp_plaintext", NEW_KEY: "typed" })
  assert.throws(
    () =>
      withStoredMcpSecrets(
        { id: "github", env: { MISSING: MCP_SECRET_PLACEHOLDER } },
        stored
      ),
    /no stored value/
  )
})

test("a probe uses stored secrets only for the saved command line", async () => {
  const listed = (await readMcps())
    .map(redactMcpForRenderer)
    .find((entry) => entry.id === "github")
  assert.equal((await resolveProbeSecrets(listed)).env.GITHUB_TOKEN, "ghp_plaintext")
  await assert.rejects(
    resolveProbeSecrets({ ...listed, command: "/tmp/other-binary" }),
    /saved command/
  )
  await assert.rejects(
    resolveProbeSecrets({ ...listed, args: ["--exfiltrate"] }),
    /saved command/
  )
})

test("without the key, ciphertext stays opaque and is never handed to a probe", async () => {
  setMcpEncryptionKey("")
  try {
    const github = (await readMcps()).find((entry) => entry.id === "github")
    assert.ok(github.env.GITHUB_TOKEN.startsWith("enc:v1:"))
    // Rewrites keep the opaque value intact.
    await writeMcps(await readMcps())
    assert.equal(
      backendDecrypt(onDisk().find((entry) => entry.id === "github").env.GITHUB_TOKEN),
      "ghp_plaintext"
    )
    await assert.rejects(
      resolveProbeSecrets(redactMcpForRenderer(github)),
      /cannot be decrypted/
    )
  } finally {
    setMcpEncryptionKey(key.toString("base64"))
  }
})

test("normalization keeps a workspace origin and adds none for user servers", () => {
  const root = path.resolve(os.tmpdir(), "repo")
  assert.deepEqual(
    (({ scope, projectRoot }) => ({ scope, projectRoot }))(
      normalizeMcpConfig({
        id: "repo",
        command: "node",
        scope: "project",
        projectRoot: root,
      })
    ),
    { scope: "project", projectRoot: root }
  )
  const user = normalizeMcpConfig({ id: "u", command: "node", scope: "user" })
  assert.equal("scope" in user, false)
  assert.equal("projectRoot" in user, false)
  assert.equal(
    normalizeMcpConfig({ id: "rel", command: "node", scope: "local", projectRoot: "relative" })
      .projectRoot,
    null
  )
  assert.throws(
    () => normalizeMcpConfig({ id: "x", command: "node", scope: "global" }),
    /Unsupported MCP scope/
  )
})

test("the onboarding scan is redacted and the import resolves its placeholders in-process", async () => {
  const claudeServer = {
    id: "linear",
    name: "Linear",
    source: "claude",
    type: "command",
    command: "linear-mcp",
    args: [],
    env: { LINEAR_API_KEY: "lin_secret" },
    scope: "user",
    sourcePath: path.join(home, ".claude.json"),
  }
  const dependencies = {
    scanClaude: () => ({ found: true, mcpServers: [claudeServer] }),
    scanCodex: () => ({ found: false, mcpServers: [] }),
  }
  const redacted = redactScanSecrets({
    claude: dependencies.scanClaude(),
    codex: dependencies.scanCodex(),
    projectScope: { status: "not-selected" },
  })
  assert.ok(!JSON.stringify(redacted).includes("lin_secret"))
  const [shown] = redacted.claude.mcpServers
  assert.deepEqual(shown.env, { LINEAR_API_KEY: MCP_SECRET_PLACEHOLDER })

  const [resolved] = await resolveImportedMcpSecrets([shown], dependencies)
  assert.equal(resolved.env.LINEAR_API_KEY, "lin_secret")

  // A server the source no longer lists is skipped, not saved with a
  // literal placeholder credential.
  assert.deepEqual(
    await resolveImportedMcpSecrets([{ ...shown, id: "gone" }], dependencies),
    []
  )
})
