import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CodexShadowHomeError,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout"

const tempRoots: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function writeTextFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents, "utf8")
}

function readLink(filePath: string): string {
  return fs.readlinkSync(filePath)
}

function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink()
  } catch {
    return false
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    })
  }
})

describe("CodexHomeLayout", () => {
  describe("resolveCodexHomeLayout", () => {
    it("uses direct CODEX_HOME when no shadow home is configured", () => {
      const homePath = makeTempDir("betterc0de-codex-home-")

      expect(resolveCodexHomeLayout({ homePath })).toMatchObject({
        mode: "direct",
        sharedHome: homePath,
        runtimeHome: homePath,
        authHome: homePath,
        continuationKey: `codex:home:${homePath}`,
      })
    })

    it("uses the shared home for continuation and the shadow home for runtime auth", () => {
      const sharedHome = makeTempDir("betterc0de-codex-shared-")
      const shadowRoot = makeTempDir("betterc0de-codex-shadow-root-")
      const shadowHome = path.join(shadowRoot, "shadow")

      expect(
        resolveCodexHomeLayout({
          homePath: sharedHome,
          shadowHomePath: shadowHome,
        })
      ).toMatchObject({
        mode: "authOverlay",
        sharedHome,
        runtimeHome: shadowHome,
        authHome: shadowHome,
        continuationKey: `codex:home:${sharedHome}`,
      })
    })
  })

  describe("materializeCodexShadowHome", () => {
    it.skipIf(process.platform !== "win32")(
      "respects case-insensitive private files and shared directories on Windows",
      () => {
        const root = makeTempDir("betterc0de-codex-casing-")
        const source = path.join(root, "source")
        const overlay = path.join(root, "overlay")
        writeTextFile(path.join(source, "AUTH.JSON"), "private shared auth")
        fs.mkdirSync(path.join(source, "SESSIONS"))
        materializeCodexShadowHome(source, overlay)
        expect(fs.existsSync(path.join(overlay, "AUTH.JSON"))).toBe(false)
        expect(readLink(path.join(overlay, "sessions"))).toBe(
          path.join(source, "SESSIONS")
        )
        expect(
          fs
            .readdirSync(overlay)
            .filter((name) => name.toLowerCase() === "sessions")
        ).toHaveLength(1)
      }
    )

    it("does not create directories or detach a cache when any destination conflicts", () => {
      const root = makeTempDir("betterc0de-codex-preflight-")
      const source = path.join(root, "source")
      const overlay = path.join(root, "overlay")
      writeTextFile(path.join(source, "models_cache.json"), "shared cache")
      writeTextFile(path.join(overlay, "worktrees"), "keep this file")
      fs.symlinkSync(
        path.join(source, "models_cache.json"),
        path.join(overlay, "models_cache.json")
      )
      expect(() => materializeCodexShadowHome(source, overlay)).toThrow(
        CodexShadowHomeError
      )
      expect(fs.readdirSync(source)).toEqual(["models_cache.json"])
      expect(isSymlink(path.join(overlay, "models_cache.json"))).toBe(true)
      expect(fs.readFileSync(path.join(overlay, "worktrees"), "utf8")).toBe(
        "keep this file"
      )
    })

    it("rejects directory aliases and nesting before changing the filesystem", () => {
      const root = makeTempDir("betterc0de-codex-alias-")
      const source = path.join(root, "source")
      const alias = path.join(root, "alias")
      fs.mkdirSync(source)
      fs.symlinkSync(
        source,
        alias,
        process.platform === "win32" ? "junction" : "dir"
      )
      for (const target of [alias, path.join(source, "overlay")]) {
        expect(() => materializeCodexShadowHome(source, target)).toThrow(
          /non-overlapping/
        )
      }
      expect(fs.readdirSync(source)).toEqual([])
    })

    it("reuses correct links and repairs stale links without modifying their old targets", () => {
      const root = makeTempDir("betterc0de-codex-reconcile-")
      const source = path.join(root, "source")
      const overlay = path.join(root, "overlay")
      const old = path.join(root, "old")
      writeTextFile(path.join(old, "keep.txt"), "old session")
      fs.mkdirSync(overlay)
      fs.symlinkSync(
        old,
        path.join(overlay, "sessions"),
        process.platform === "win32" ? "junction" : "dir"
      )
      materializeCodexShadowHome(source, overlay)
      materializeCodexShadowHome(source, overlay)
      expect(readLink(path.join(overlay, "sessions"))).toBe(
        path.join(source, "sessions")
      )
      expect(fs.readFileSync(path.join(old, "keep.txt"), "utf8")).toBe(
        "old session"
      )
    })

    it("validates private auth before creating shared runtime state", () => {
      const root = makeTempDir("betterc0de-codex-auth-check-")
      const source = path.join(root, "source")
      const overlay = path.join(root, "overlay")
      fs.mkdirSync(path.join(overlay, "auth.json"), { recursive: true })
      expect(() => materializeCodexShadowHome(source, overlay)).toThrow(
        /must be a real file/
      )
      expect(fs.existsSync(source)).toBe(false)
    })

    it("materializes a shadow home with shared state links and private auth", () => {
      const sharedHome = makeTempDir("betterc0de-codex-shared-")
      const shadowRoot = makeTempDir("betterc0de-codex-shadow-root-")
      const shadowHome = path.join(shadowRoot, "shadow")

      fs.mkdirSync(path.join(sharedHome, "sessions"))
      writeTextFile(
        path.join(sharedHome, "config.toml"),
        'model = "gpt-5-codex"\n'
      )
      writeTextFile(
        path.join(sharedHome, "models_cache.json"),
        '{"models":["shared"]}\n'
      )
      writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n')
      fs.mkdirSync(shadowHome, { recursive: true })
      writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n')
      fs.symlinkSync(
        path.join(sharedHome, "models_cache.json"),
        path.join(shadowHome, "models_cache.json")
      )

      materializeCodexShadowHome(sharedHome, shadowHome)

      expect(readLink(path.join(shadowHome, "sessions"))).toBe(
        path.join(sharedHome, "sessions")
      )
      expect(readLink(path.join(shadowHome, "config.toml"))).toBe(
        path.join(sharedHome, "config.toml")
      )
      expect(fs.existsSync(path.join(shadowHome, "models_cache.json"))).toBe(
        false
      )
      expect(isSymlink(path.join(shadowHome, "auth.json"))).toBe(false)
      expect(
        fs.readFileSync(path.join(shadowHome, "auth.json"), "utf8")
      ).toContain("shadow")
    })

    it("shares non-private Codex sidecars instead of copying stale shadow files", () => {
      const sharedHome = makeTempDir("betterc0de-codex-shared-")
      const shadowRoot = makeTempDir("betterc0de-codex-shadow-root-")
      const shadowHome = path.join(shadowRoot, "shadow")

      writeTextFile(path.join(sharedHome, "config.json"), '{"shared":true}\n')
      writeTextFile(
        path.join(sharedHome, "credentials.json"),
        '{"shared":true}\n'
      )
      writeTextFile(path.join(sharedHome, "AGENTS.md"), "shared rules\n")
      writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n')

      materializeCodexShadowHome(sharedHome, shadowHome)

      expect(readLink(path.join(shadowHome, "config.json"))).toBe(
        path.join(sharedHome, "config.json")
      )
      expect(readLink(path.join(shadowHome, "credentials.json"))).toBe(
        path.join(sharedHome, "credentials.json")
      )
      expect(readLink(path.join(shadowHome, "AGENTS.md"))).toBe(
        path.join(sharedHome, "AGENTS.md")
      )
    })

    it("accepts Codex-created shadow-local runtime directories", () => {
      const sharedHome = makeTempDir("betterc0de-codex-shared-")
      const shadowRoot = makeTempDir("betterc0de-codex-shadow-root-")
      const shadowHome = path.join(shadowRoot, "shadow")

      fs.mkdirSync(path.join(sharedHome, "log"))
      fs.mkdirSync(path.join(sharedHome, "memories"))
      fs.mkdirSync(path.join(sharedHome, "tmp"))
      writeTextFile(
        path.join(sharedHome, "config.toml"),
        'model = "gpt-5-codex"\n'
      )
      writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n')
      fs.mkdirSync(path.join(shadowHome, "log"), { recursive: true })
      fs.mkdirSync(path.join(shadowHome, "memories"), { recursive: true })
      fs.mkdirSync(path.join(shadowHome, "tmp"), { recursive: true })

      materializeCodexShadowHome(sharedHome, shadowHome)

      expect(readLink(path.join(shadowHome, "config.toml"))).toBe(
        path.join(sharedHome, "config.toml")
      )
      expect(isSymlink(path.join(shadowHome, "log"))).toBe(false)
      expect(isSymlink(path.join(shadowHome, "memories"))).toBe(false)
      expect(isSymlink(path.join(shadowHome, "tmp"))).toBe(false)
    })

    it("rejects shadow homes that point at the shared home", () => {
      const sharedHome = makeTempDir("betterc0de-codex-shared-")

      expect(() =>
        resolveCodexHomeLayout({
          homePath: sharedHome,
          shadowHomePath: sharedHome,
        })
      ).toThrow(CodexShadowHomeError)
    })

    it("rejects shared entries that already exist in the shadow home as real files", () => {
      const sharedHome = makeTempDir("betterc0de-codex-shared-")
      const shadowRoot = makeTempDir("betterc0de-codex-shadow-root-")
      const shadowHome = path.join(shadowRoot, "shadow")
      writeTextFile(
        path.join(sharedHome, "config.toml"),
        'model = "gpt-5-codex"\n'
      )
      writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n')

      expect(() => materializeCodexShadowHome(sharedHome, shadowHome)).toThrow(
        /already exists and is not a symlink/
      )
    })

    it("rejects shadow auth that points back to shared auth", () => {
      const sharedHome = makeTempDir("betterc0de-codex-shared-")
      const shadowRoot = makeTempDir("betterc0de-codex-shadow-root-")
      const shadowHome = path.join(shadowRoot, "shadow")
      writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n')
      fs.mkdirSync(shadowHome, { recursive: true })
      fs.symlinkSync(
        path.join(sharedHome, "auth.json"),
        path.join(shadowHome, "auth.json")
      )

      expect(() => materializeCodexShadowHome(sharedHome, shadowHome)).toThrow(
        /must be a real file/
      )
    })
  })
})
