import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HttpError } from "../../errors"
import { ABSENT_REVISION, revisionOf, withFileLock } from "./files"
import { DesktopConfigStore } from "./store"

const temporary: string[] = []

function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-config-"))
  temporary.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function expectHttpError(run: () => unknown, status: number, code: string) {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(HttpError)
  expect(caught).toMatchObject({ statusCode: status, code })
}

describe("desktop configuration documents", () => {
  it("reads a missing file as an empty document and writes it atomically", () => {
    const store = new DesktopConfigStore(home())
    expect(store.readHooks()).toEqual({
      entries: [],
      revision: ABSENT_REVISION,
    })

    const written = store.writeHooks([
      { id: "a", event: "on_commit", command: "npm test", enabled: true },
    ])
    const onDisk = fs.readFileSync(store.paths.hooksFile)
    expect(written.revision).toBe(revisionOf(onDisk))
    expect(JSON.parse(onDisk.toString("utf8"))).toEqual(written.entries)
    expect(store.readHooks()).toEqual(written)
    // No staged files or locks are left behind.
    expect(fs.readdirSync(store.paths.home)).toEqual(["hooks.json"])
  })

  it("keeps every field of an entry exactly as given", () => {
    const store = new DesktopConfigStore(home())
    const entry = {
      id: "github",
      type: "command",
      command: "npx",
      args: ["-y", "server"],
      env: { GITHUB_TOKEN: "enc:v1:opaque" },
      scope: "project",
      projectRoot: "/work/repo",
      approval: { v: 1, alg: "hmac-sha256", digest: "x".repeat(44) },
      futureField: { nested: true },
    }
    store.writeMcp([entry])
    expect(store.readMcp().entries).toEqual([entry])
  })

  it("writes against a revision and refuses a stale one", () => {
    const store = new DesktopConfigStore(home())
    const first = store.writeMcp([{ id: "one" }])
    const second = store.writeMcp(
      [{ id: "one" }, { id: "two" }],
      first.revision
    )
    expectHttpError(
      () => store.writeMcp([{ id: "three" }], first.revision),
      409,
      "desktop_config_conflict"
    )
    expect(store.readMcp()).toEqual(second)
    // Without an expected revision a write overwrites.
    expect(store.writeMcp([{ id: "three" }]).entries).toEqual([{ id: "three" }])
  })

  it("reports a file that is not a list and keeps non-JSON content aside before replacing it", () => {
    const store = new DesktopConfigStore(home())
    const broken = '[{"id":"existing","command":"unfinished'
    fs.writeFileSync(store.paths.hooksFile, broken)
    const document = store.readHooks()
    expect(document.entries).toEqual([])
    expect(document.problem).toMatch(/hooks\.json: it is not valid JSON/)

    store.writeHooks([{ id: "new" }], document.revision)
    const backups = fs
      .readdirSync(store.paths.home)
      .filter((name) => name.startsWith("hooks.json.corrupt-"))
    expect(backups).toHaveLength(1)
    expect(
      fs.readFileSync(path.join(store.paths.home, backups[0]!), "utf8")
    ).toBe(broken)
    expect(store.readHooks().entries).toEqual([{ id: "new" }])
  })

  it("never replaces JSON whose entries cannot be told apart", () => {
    const store = new DesktopConfigStore(home())
    for (const value of [
      {},
      [null],
      [42],
      [{ id: 42 }],
      [{ id: "" }],
      [{ id: "a" }, { id: "a" }],
    ]) {
      const original = JSON.stringify(value)
      fs.writeFileSync(store.paths.mcpFile, original)
      expect(store.readMcp().problem).toBeTruthy()
      expectHttpError(
        () => store.writeMcp([{ id: "new" }]),
        409,
        "desktop_config_unsafe"
      )
      expect(fs.readFileSync(store.paths.mcpFile, "utf8")).toBe(original)
    }
  })

  it("rejects invalid entries before touching the file", () => {
    const store = new DesktopConfigStore(home())
    store.writeMcp([{ id: "existing" }])
    const original = fs.readFileSync(store.paths.mcpFile, "utf8")
    for (const invalid of [[{ id: "a" }, { id: "a" }], [{ id: " " }]]) {
      expectHttpError(
        () => store.writeMcp(invalid),
        400,
        "desktop_config_invalid"
      )
    }
    expect(fs.readFileSync(store.paths.mcpFile, "utf8")).toBe(original)
  })

  it("does not follow or replace a symlinked document", () => {
    const root = home()
    const target = path.join(root, "elsewhere.json")
    fs.writeFileSync(target, "[]")
    const store = new DesktopConfigStore(path.join(root, "home"))
    fs.mkdirSync(store.paths.home)
    try {
      fs.symlinkSync(target, store.paths.mcpFile)
    } catch {
      return // Creating symlinks needs a privilege on some Windows setups.
    }
    expect(store.readMcp().problem).toMatch(/symbolic link/)
    expectHttpError(
      () => store.writeMcp([{ id: "x" }]),
      409,
      "desktop_config_unsafe"
    )
    expect(fs.readFileSync(target, "utf8")).toBe("[]")
  })

  it("holds a per-file lock while writing and refuses a concurrent writer", () => {
    const store = new DesktopConfigStore(home())
    withFileLock(`${store.paths.rulesFile}.lock`, () => {
      expectHttpError(
        () => store.writeRules("blocked"),
        409,
        "desktop_config_busy"
      )
    })
    expect(store.writeRules("after").content).toBe("after")
    expect(fs.existsSync(`${store.paths.rulesFile}.lock`)).toBe(false)
  })

  it("breaks a lock that a dead writer left behind", () => {
    const store = new DesktopConfigStore(home())
    const lock = `${store.paths.rulesFile}.lock`
    fs.mkdirSync(store.paths.home, { recursive: true })
    fs.writeFileSync(lock, "")
    const old = Date.now() / 1000 - 120
    fs.utimesSync(lock, old, old)
    expect(store.writeRules("recovered").content).toBe("recovered")
  })
})

describe("rules.md", () => {
  it("reads empty without a file and round-trips content", () => {
    const store = new DesktopConfigStore(home())
    expect(store.readRules()).toEqual({
      content: "",
      revision: ABSENT_REVISION,
    })
    const written = store.writeRules("Answer in German.\n")
    expect(fs.readFileSync(store.paths.rulesFile, "utf8")).toBe(
      "Answer in German.\n"
    )
    expect(store.readRules()).toEqual(written)
    expectHttpError(
      () => store.writeRules("stale", ABSENT_REVISION),
      409,
      "desktop_config_conflict"
    )
  })
})

describe("skills and subagents", () => {
  it("writes the manifest and the markdown file of an entry", () => {
    const store = new DesktopConfigStore(home())
    store.putDirectoryEntry(
      "skills",
      "style",
      { id: "style", name: "Style", enabled: true },
      "Use tabs."
    )
    store.putDirectoryEntry(
      "subagents",
      "reviewer",
      { id: "reviewer", name: "Reviewer" },
      "Review carefully."
    )
    expect(
      fs.readFileSync(
        path.join(store.paths.skillsDir, "style", "content.md"),
        "utf8"
      )
    ).toBe("Use tabs.")
    expect(store.getDirectoryEntry("skills", "style")).toEqual({
      id: "style",
      manifest: { id: "style", name: "Style", enabled: true },
      text: "Use tabs.",
    })
    expect(store.listDirectory("subagents")).toEqual([
      {
        id: "reviewer",
        manifest: { id: "reviewer", name: "Reviewer" },
        text: "Review carefully.",
      },
    ])
    expect(store.getDirectoryEntry("skills", "missing")).toBeNull()
  })

  it("lists only folders with a manifest object, the way the desktop did", () => {
    const store = new DesktopConfigStore(home())
    const write = (name: string, file: string, content: string) => {
      fs.mkdirSync(path.join(store.paths.skillsDir, name), { recursive: true })
      fs.writeFileSync(path.join(store.paths.skillsDir, name, file), content)
    }
    write("ok", "manifest.json", JSON.stringify({ name: "OK" }))
    write("no-text", "manifest.json", JSON.stringify({ name: "No text" }))
    write("ok", "content.md", "text")
    write("broken", "manifest.json", "{not json")
    write("array", "manifest.json", "[]")
    write("no-manifest", "content.md", "orphan")
    fs.writeFileSync(path.join(store.paths.skillsDir, "stray.md"), "file")
    expect(
      store.listDirectory("skills").map((entry) => [entry.id, entry.text])
    ).toEqual([
      ["no-text", ""],
      ["ok", "text"],
    ])
  })

  it("removes an entry and reports whether there was one", () => {
    const store = new DesktopConfigStore(home())
    expect(store.removeDirectoryEntry("skills", "style")).toBe(false)
    store.putDirectoryEntry("skills", "style", { id: "style" }, "")
    expect(store.removeDirectoryEntry("skills", "style")).toBe(true)
    expect(fs.existsSync(path.join(store.paths.skillsDir, "style"))).toBe(false)
    expect(fs.readdirSync(store.paths.skillsDir)).toEqual([])
  })

  it("accepts only slug ids, so no path leaves its folder", () => {
    const store = new DesktopConfigStore(home())
    for (const id of ["../escape", "a/b", "UPPER", "", "dot.dot", "-lead"]) {
      expectHttpError(
        () => store.putDirectoryEntry("skills", id, {}, ""),
        400,
        "desktop_config_invalid_id"
      )
      expectHttpError(
        () => store.removeDirectoryEntry("subagents", id),
        400,
        "desktop_config_invalid_id"
      )
    }
  })
})
