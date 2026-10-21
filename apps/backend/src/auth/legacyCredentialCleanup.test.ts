import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { removeLegacyCredentialStore } from "./legacyCredentialCleanup"

describe("removeLegacyCredentialStore", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  function dataDir(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-auth-cleanup-"))
    roots.push(root)
    return root
  }

  it("deletes the retired auth.json and interrupted temp writes", () => {
    const root = dataDir()
    const authPath = path.join(root, "auth.json")
    fs.writeFileSync(authPath, JSON.stringify({ openai: "enc:v1:blob" }))
    fs.writeFileSync(`${authPath}.tmp.123.456`, "{}")
    fs.writeFileSync(path.join(root, "settings.json"), "{}")

    expect(removeLegacyCredentialStore(authPath)).toBe(2)
    expect(fs.readdirSync(root)).toEqual(["settings.json"])
  })

  it("does nothing when no credential store was ever written", () => {
    const root = dataDir()
    expect(removeLegacyCredentialStore(path.join(root, "auth.json"))).toBe(0)
    expect(
      removeLegacyCredentialStore(path.join(root, "missing", "auth.json"))
    ).toBe(0)
  })
})
