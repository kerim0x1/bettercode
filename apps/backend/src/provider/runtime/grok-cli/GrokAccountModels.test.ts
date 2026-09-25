import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
import { grokAccountModels, saveGrokAccountModels } from "./GrokAccountModels"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

it("keeps Grok ACP models with their CLI account across restarts", () => {
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-grok-account-")
  )
  directories.push(home)
  const authHome = path.join(home, ".grok")
  fs.mkdirSync(authHome)
  const credential = path.join(authHome, "credentials.json")
  const options = {
    modelHomeDir: home,
    modelCacheDir: path.join(home, "snapshots"),
    providerInstanceId: "grok-cli",
  }
  fs.writeFileSync(credential, '{"token":"account-a"}')
  saveGrokAccountModels(options, [{ slug: "grok-4.7", name: "Grok 4.7" }])
  expect(grokAccountModels(options).map((model) => model.slug)).toEqual([
    "grok-4.7",
  ])

  fs.writeFileSync(credential, '{"token":"account-b"}')
  expect(grokAccountModels(options)).toEqual([])
})

it("ignores a CLI model cache written before the current login", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-grok-cache-"))
  directories.push(home)
  const authHome = path.join(home, ".grok")
  fs.mkdirSync(authHome)
  const cache = path.join(authHome, "models_cache.json")
  fs.writeFileSync(
    cache,
    JSON.stringify({ models: { "grok-old": { info: { id: "grok-old" } } } })
  )
  const credential = path.join(authHome, "credentials.json")
  fs.writeFileSync(credential, '{"token":"new-account"}')
  const old = new Date("2026-01-01T00:00:00Z")
  const recent = new Date("2026-01-02T00:00:00Z")
  fs.utimesSync(cache, old, old)
  fs.utimesSync(credential, recent, recent)
  expect(grokAccountModels({ modelHomeDir: home })).toEqual([])
})
