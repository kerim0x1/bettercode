import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// Renderer file and folder names are kebab-case: lowercase words joined by
// "-", with optional dot-separated suffixes (`chat-store.test.ts`,
// `material-icon-theme.generated.json`). The paths below predate the rule.
// Do not add to this list: name a new file in kebab-case instead. When one of
// these files is renamed, delete its entry; the test fails on stale entries
// so the list only shrinks.
const RENDERER_ROOT = "apps/ui/src"
const KEBAB_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/
const ALLOWLIST = new Set([
  "App.tsx",
  "services/backend/autonomyApi.ts",
  "services/backend/chatApi.ts",
  "services/backend/coreApi.ts",
  "services/backend/gitApi.test.ts",
  "services/backend/gitApi.ts",
  "services/backend/orchestratorApi.ts",
  "services/backend/providersApi.ts",
  "services/backend/remoteApi.test.ts",
  "services/backend/remoteApi.ts",
  "services/backend/themesApi.ts",
  "services/backend/workspaceApi.test.ts",
  "services/backend/workspaceApi.ts",
  "services/backend/wsClient.test.ts",
  "services/backend/wsClient.ts",
])

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function listRendererPaths(directory, prefix = "") {
  const paths = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Dotfiles (.DS_Store, .gitkeep) are tool artifacts, not source names.
    if (entry.name.startsWith(".")) continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    paths.push(relative)
    if (entry.isDirectory()) {
      paths.push(...listRendererPaths(path.join(directory, entry.name), relative))
    }
  }
  return paths
}

function isKebabCase(relativePath) {
  return relativePath.split("/").every((segment) => KEBAB_SEGMENT.test(segment))
}

const rendererPaths = listRendererPaths(path.join(repoRoot, RENDERER_ROOT))

test("the kebab-case pattern accepts the renderer's naming and rejects other cases", () => {
  for (const name of ["chat-store.ts", "use-chat-submit.test.ts", "global.d.ts", "a11y-labels.tsx", "material-icon-theme.generated.json"]) {
    assert.equal(isKebabCase(name), true, name)
  }
  for (const name of ["chatStore.ts", "ChatStore.tsx", "chat_store.ts", "chat--store.ts", "-chat.ts", "chat-.ts", "chat.Test.ts"]) {
    assert.equal(isKebabCase(name), false, name)
  }
  assert.equal(isKebabCase("lib/chatCommands/run.ts"), false)
})

test("new renderer files and folders use kebab-case names", () => {
  assert.ok(rendererPaths.length > 0, `no files found under ${RENDERER_ROOT}`)
  const offenders = rendererPaths.filter((relative) => !isKebabCase(relative) && !ALLOWLIST.has(relative))
  assert.deepEqual(
    offenders,
    [],
    `Rename these to kebab-case (e.g. chatStore.ts -> chat-store.ts) under ${RENDERER_ROOT}:\n${offenders.join("\n")}`
  )
})

test("the filename-case allowlist has no stale entries", () => {
  const present = new Set(rendererPaths)
  const stale = [...ALLOWLIST].filter((relative) => !present.has(relative) || isKebabCase(relative))
  assert.deepEqual(stale, [], `Remove these entries from ALLOWLIST in scripts/filename-case.test.mjs:\n${stale.join("\n")}`)
})
