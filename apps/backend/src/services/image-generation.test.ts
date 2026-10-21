import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  __quarantineImageGenerationForTests,
  __resetImageGenerationForTests,
  activeImageGenerationCount,
  beginImageGenerationShutdown,
  buildCodexExecArgs,
  buildImageGenerationPrompt,
  generateImage,
  resumeImageGenerationAdmissions,
  resolveImageSavePath,
  shutdownAllImageGenerations,
  IMAGEGEN_MIN_CODEX_VERSION,
} from "./image-generation"

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  if (activeImageGenerationCount() === 0) {
    resumeImageGenerationAdmissions()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Fake `codex` executable for exercising the spawn path. On Windows the
 * service wraps non-.exe binaries through cmd.exe (same contract as
 * CodexRpcClient), so the fake is a `.cmd` shim delegating to node; on
 * POSIX it's a node script with a shebang.
 */
function makeFakeCodexBinary(body: string): string {
  const dir = makeTempDir("betterc0de-fake-codex-")
  const scriptPath = path.join(dir, "fake-codex.cjs")
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${body}\n`, "utf8")
  fs.chmodSync(scriptPath, 0o755)
  if (process.platform === "win32") {
    const cmdPath = path.join(dir, "fake-codex.cmd")
    fs.writeFileSync(
      cmdPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf8"
    )
    return cmdPath
  }
  return scriptPath
}

function fakeDetect(binaryPath: string, version = "0.142.5") {
  return () => ({
    installed: true,
    version,
    binaryPath,
    authenticated: true,
  })
}

describe("buildCodexExecArgs", () => {
  it("pins gpt-5.5 at xhigh with a non-interactive workspace-write sandbox", () => {
    const args = buildCodexExecArgs({
      workspaceDir: "C:/work/project",
      lastMessageFile: "C:/tmp/last.txt",
    })
    expect(args.slice(0, 2)).toEqual(["exec", "-"])
    expect(args).toContain("gpt-5.5")
    expect(args).toContain("model_reasoning_effort='xhigh'")
    expect(args).toContain("approval_policy='never'")
    expect(args).toContain("workspace-write")
    expect(args).toContain("--skip-git-repo-check")
    expect(args).toContain("--ephemeral")
    expect(args).toContain("--json")
    expect(args[args.indexOf("-C") + 1]).toBe("C:/work/project")
    expect(args[args.indexOf("-o") + 1]).toBe("C:/tmp/last.txt")
  })
})

describe("buildImageGenerationPrompt", () => {
  it("includes description, target path, and optional hints", () => {
    const prompt = buildImageGenerationPrompt({
      prompt: "a blue rocket",
      relativePath: "asset.png",
      size: "1536x1024",
      styleHint: "flat vector illustration",
    })
    expect(prompt).toContain("a blue rocket")
    expect(prompt).toContain("`asset.png`")
    expect(prompt).toContain("Size: 1536x1024.")
    expect(prompt).toContain("Style: flat vector illustration.")
    expect(prompt).toContain("image_generation")
  })
})

describe("resolveImageSavePath", () => {
  const workspace = "C:/work/project"

  it("accepts relative .png paths and normalizes separators", () => {
    expect(resolveImageSavePath(workspace, "assets/hero.png")).toMatchObject({
      relativePath: "assets/hero.png",
    })
    expect(resolveImageSavePath(workspace, "./hero.PNG")).toMatchObject({
      relativePath: "hero.PNG",
    })
  })

  it("rejects traversal, absolute paths, and non-png targets", () => {
    expect(resolveImageSavePath(workspace, "../outside.png")).toBeNull()
    expect(resolveImageSavePath(workspace, "a/../../outside.png")).toBeNull()
    expect(
      resolveImageSavePath(workspace, path.resolve(os.tmpdir(), "x.png"))
    ).toBeNull()
    expect(resolveImageSavePath(workspace, "/etc/x.png")).toBeNull()
    expect(resolveImageSavePath(workspace, "C:\\outside\\x.png")).toBeNull()
    expect(resolveImageSavePath(workspace, "logo.svg")).toBeNull()
    expect(resolveImageSavePath(workspace, "")).toBeNull()
  })
})

describe("generateImage", () => {
  it("does not start a generation for an already-aborted request", async () => {
    const controller = new AbortController()
    controller.abort()
    const workspaceDir = makeTempDir("betterc0de-imagegen-abort-")

    await expect(
      generateImage(
        {
          prompt: "x",
          savePath: "cancelled.png",
          workspaceDir,
          signal: controller.signal,
        },
        { detect: fakeDetect("must-not-start") }
      )
    ).resolves.toEqual({
      ok: false,
      code: "timeout",
      message: "Image generation was cancelled.",
    })
  })

  it("rejects invalid save paths before touching the CLI", async () => {
    const result = await generateImage(
      {
        prompt: "x",
        savePath: "../escape.png",
        workspaceDir: makeTempDir("betterc0de-imagegen-ws-"),
      },
      {
        detect: () => {
          throw new Error("detect must not be called for invalid paths")
        },
      }
    )
    expect(result).toMatchObject({ ok: false, code: "invalid_save_path" })
  })

  it("maps missing/old/unauthenticated CLI states to error codes", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-ws-")
    const base = { prompt: "x", savePath: "a.png", workspaceDir }

    await expect(
      generateImage(base, {
        detect: () => ({
          installed: false,
          version: null,
          binaryPath: "",
          authenticated: false,
        }),
      })
    ).resolves.toMatchObject({ ok: false, code: "codex_not_installed" })

    await expect(
      generateImage(base, {
        detect: () => ({
          installed: true,
          version: "0.130.0",
          binaryPath: "codex",
          authenticated: true,
        }),
      })
    ).resolves.toMatchObject({ ok: false, code: "codex_version_too_old" })
    expect(IMAGEGEN_MIN_CODEX_VERSION).toBe("0.140.0")

    await expect(
      generateImage(base, {
        detect: () => ({
          installed: true,
          version: "0.142.5",
          binaryPath: "codex",
          authenticated: false,
        }),
      })
    ).resolves.toMatchObject({ ok: false, code: "codex_not_authenticated" })
  })

  it("awaits asynchronous CLI detection before validating auth state", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-async-detect-")
    let completed = false

    const result = await generateImage(
      {
        prompt: "x",
        savePath: "a.png",
        workspaceDir,
      },
      {
        detect: async () => {
          await Promise.resolve()
          completed = true
          return {
            installed: true,
            version: "0.142.5",
            binaryPath: "codex",
            authenticated: false,
          }
        },
      }
    )

    expect(completed).toBe(true)
    expect(result).toMatchObject({
      ok: false,
      code: "codex_not_authenticated",
    })
  })

  it("moves the staged PNG into the workspace on success", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-ws-")
    const binary = makeFakeCodexBinary(
      [
        `const fs = require("node:fs")`,
        `if (!process.argv.includes("model_reasoning_effort='xhigh'") || !process.argv.includes("approval_policy='never'")) process.exit(2)`,
        `const oIdx = process.argv.indexOf("-o")`,
        `if (oIdx > -1) fs.writeFileSync(process.argv[oIdx + 1], "SAVED: asset.png")`,
        `fs.writeFileSync("asset.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))`,
        `process.exit(0)`,
      ].join("\n")
    )
    const result = await generateImage(
      {
        prompt: "a blue rocket",
        savePath: "public/assets/hero.png",
        workspaceDir,
      },
      { detect: fakeDetect(binary) }
    )
    expect(result).toMatchObject({
      ok: true,
      relativePath: "public/assets/hero.png",
      bytes: 8,
    })
    const written = fs.readFileSync(
      path.join(workspaceDir, "public", "assets", "hero.png")
    )
    expect(written.subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    )
  })

  it("preserves an existing file unless overwrite is explicit", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-ws-")
    const target = path.join(workspaceDir, "public", "hero.png")
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, "original", "utf8")
    const binary = makeFakeCodexBinary(
      [
        `const fs = require("node:fs")`,
        `fs.writeFileSync("asset.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))`,
        `process.exit(0)`,
      ].join("\n")
    )

    await expect(
      generateImage(
        {
          prompt: "replacement",
          savePath: "public/hero.png",
          workspaceDir,
        },
        { detect: fakeDetect(binary) }
      )
    ).resolves.toMatchObject({ ok: false, code: "target_exists" })
    expect(fs.readFileSync(target, "utf8")).toBe("original")

    await expect(
      generateImage(
        {
          prompt: "replacement",
          savePath: "public/hero.png",
          workspaceDir,
          overwrite: true,
        },
        { detect: fakeDetect(binary) }
      )
    ).resolves.toMatchObject({ ok: true, relativePath: "public/hero.png" })
    expect(fs.readFileSync(target).subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    )
    expect(
      fs
        .readdirSync(path.dirname(target))
        .some((name) => name.includes(".overwrite-backup"))
    ).toBe(false)
  })

  it("rejects a directory symlink or junction that escapes the workspace", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-ws-")
    const outsideDir = makeTempDir("betterc0de-imagegen-outside-")
    const linkedDir = path.join(workspaceDir, "linked")
    try {
      fs.symlinkSync(
        outsideDir,
        linkedDir,
        process.platform === "win32" ? "junction" : "dir"
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return
      throw error
    }
    const binary = makeFakeCodexBinary(
      [
        `const fs = require("node:fs")`,
        `fs.writeFileSync("asset.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))`,
        `process.exit(0)`,
      ].join("\n")
    )

    await expect(
      generateImage(
        {
          prompt: "escape attempt",
          savePath: "linked/escape.png",
          workspaceDir,
          overwrite: true,
        },
        { detect: fakeDetect(binary) }
      )
    ).resolves.toMatchObject({ ok: false, code: "invalid_save_path" })
    expect(fs.existsSync(path.join(outsideDir, "escape.png"))).toBe(false)
  })

  it("reports generation_failed on non-zero exit with diagnostics", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-ws-")
    const binary = makeFakeCodexBinary(
      [
        `process.stderr.write("boom: model unavailable\\n")`,
        `process.exit(1)`,
      ].join("\n")
    )
    const result = await generateImage(
      { prompt: "x", savePath: "a.png", workspaceDir },
      { detect: fakeDetect(binary) }
    )
    expect(result).toMatchObject({ ok: false, code: "generation_failed" })
    if (!result.ok) {
      expect(result.message).toContain("exited with code 1")
    }
  })

  it("reports file_not_created when codex exits 0 without producing the PNG", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-ws-")
    const binary = makeFakeCodexBinary(
      [
        `const fs = require("node:fs")`,
        `const oIdx = process.argv.indexOf("-o")`,
        `if (oIdx > -1) fs.writeFileSync(process.argv[oIdx + 1], "I could not generate the image.")`,
        `process.exit(0)`,
      ].join("\n")
    )
    const result = await generateImage(
      { prompt: "x", savePath: "a.png", workspaceDir },
      { detect: fakeDetect(binary) }
    )
    expect(result).toMatchObject({ ok: false, code: "file_not_created" })
    if (!result.ok) {
      expect(result.message).toContain("I could not generate the image.")
    }
  })

  it("kills the process tree and reports timeout when codex hangs", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-ws-")
    const binary = makeFakeCodexBinary(
      `setTimeout(() => process.exit(0), 30000)`
    )
    const result = await generateImage(
      { prompt: "x", savePath: "a.png", workspaceDir, timeoutMs: 750 },
      { detect: fakeDetect(binary) }
    )
    expect(result).toMatchObject({ ok: false, code: "timeout" })
    expect(activeImageGenerationCount()).toBe(0)
  }, 15000)

  it("closes admission and drains active process trees during shutdown", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-shutdown-")
    const startedMarker = path.join(workspaceDir, "child-started")
    const binary = makeFakeCodexBinary(
      [
        `require("node:fs").writeFileSync(${JSON.stringify(startedMarker)}, "started")`,
        `setTimeout(() => process.exit(0), 30000)`,
      ].join("\n")
    )
    const running = generateImage(
      {
        prompt: "x",
        savePath: "a.png",
        workspaceDir,
        timeoutMs: 30_000,
      },
      { detect: fakeDetect(binary) }
    )
    await vi.waitFor(() => {
      expect(activeImageGenerationCount()).toBe(1)
      expect(fs.existsSync(startedMarker)).toBe(true)
    })

    await expect(shutdownAllImageGenerations()).resolves.toBe(1)
    await expect(running).resolves.toMatchObject({
      ok: false,
      code: "timeout",
    })
    expect(activeImageGenerationCount()).toBe(0)
    await expect(
      generateImage(
        {
          prompt: "must not start",
          savePath: "blocked.png",
          workspaceDir,
        },
        { detect: fakeDetect("must-not-start") }
      )
    ).resolves.toMatchObject({
      ok: false,
      code: "generation_failed",
    })
  }, 15_000)
})

describe("image generation quarantine recovery", () => {
  afterEach(() => {
    __resetImageGenerationForTests()
  })

  it("keeps an unconfirmed process tree quarantined beyond the former deadline", async () => {
    vi.useFakeTimers()
    try {
      __quarantineImageGenerationForTests()
      expect(activeImageGenerationCount()).toBe(1)

      await expect(
        generateImage(
          { prompt: "x", savePath: "a.png", workspaceDir: os.tmpdir() },
          { detect: fakeDetect("must-not-start") }
        )
      ).resolves.toMatchObject({
        ok: false,
        code: "generation_failed",
        message: expect.stringMatching(/recovering/i),
      })

      // Elapsed time does not establish ownership-safe process-tree cleanup.
      await vi.advanceTimersByTimeAsync(125_000)
      expect(activeImageGenerationCount()).toBe(1)

      const detect = vi.fn(() => ({
        installed: false,
        version: null,
        binaryPath: "",
        authenticated: false,
      }))
      await expect(
        generateImage(
          { prompt: "x", savePath: "a.png", workspaceDir: os.tmpdir() },
          { detect }
        )
      ).resolves.toMatchObject({ ok: false, code: "generation_failed" })
      expect(detect).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not reopen while shutdown is in progress", async () => {
    vi.useFakeTimers()
    try {
      __quarantineImageGenerationForTests()
      const shutdown = shutdownAllImageGenerations(50).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(125_000)
      await shutdown
      await expect(
        generateImage(
          { prompt: "x", savePath: "a.png", workspaceDir: os.tmpdir() },
          { detect: fakeDetect("must-not-start") }
        )
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringMatching(/shutting down/i),
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("image generation filesystem and cancellation races", () => {
  it("preserves a temporary destination that wins the exclusive-create race", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-collision-")
    const binary = makeFakeCodexBinary(
      'require("node:fs").writeFileSync("asset.png", Buffer.from([137,80,78,71,13,10,26,10,1]))'
    )
    const originalOpen = fs.promises.open.bind(fs.promises)
    let collisionPath: string | null = null
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const candidate = String(args[0])
      if (args[1] === "wx" && candidate.endsWith(".tmp")) {
        collisionPath = candidate
        await fs.promises.writeFile(candidate, "belongs to another writer")
      }
      return await originalOpen(...args)
    })
    await expect(
      generateImage(
        { prompt: "x", savePath: "a.png", workspaceDir },
        { detect: fakeDetect(binary) }
      )
    ).resolves.toMatchObject({ ok: false, code: "target_exists" })
    expect(collisionPath).not.toBeNull()
    expect(await fs.promises.readFile(collisionPath!, "utf8")).toBe(
      "belongs to another writer"
    )
  })

  it("does not spawn when shutdown begins while staging-directory creation is pending", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-shutdown-race-")
    const marker = path.join(workspaceDir, "started")
    const binary = makeFakeCodexBinary(
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`
    )
    const originalMkdtemp = fs.promises.mkdtemp.bind(fs.promises)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = false
    vi.spyOn(fs.promises, "mkdtemp").mockImplementation(async (...args) => {
      const directory = await originalMkdtemp(...args)
      entered = true
      await held
      return directory
    })
    const running = generateImage(
      { prompt: "x", savePath: "a.png", workspaceDir },
      { detect: fakeDetect(binary) }
    )
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      beginImageGenerationShutdown()
    } finally {
      release()
    }
    await expect(running).resolves.toMatchObject({ ok: false, code: "timeout" })
    expect(fs.existsSync(marker)).toBe(false)
    expect(activeImageGenerationCount()).toBe(0)
  })

  it("observes stdin errors when a CLI rejects a large prompt before reading it", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-stdin-")
    const binary = makeFakeCodexBinary("process.exit(1)")
    await expect(
      generateImage(
        {
          prompt: "x".repeat(2 * 1024 * 1024),
          savePath: "a.png",
          workspaceDir,
        },
        { detect: fakeDetect(binary) }
      )
    ).resolves.toMatchObject({ ok: false, code: "generation_failed" })
  })
})

describe("image generation Codex home", () => {
  it("passes the resolved CODEX_HOME to the codex child like native text generation", async () => {
    const workspaceDir = makeTempDir("betterc0de-imagegen-home-")
    const codexHome = makeTempDir("betterc0de-imagegen-codex-home-")
    // The fake writes the CODEX_HOME it sees into the last-message file and
    // fails, so the value surfaces in the error message.
    const binary = makeFakeCodexBinary(
      [
        `const out = process.argv[process.argv.indexOf("-o") + 1]`,
        `require("node:fs").writeFileSync(out, "HOME=" + (process.env.CODEX_HOME ?? "<unset>"))`,
        `process.exit(1)`,
      ].join("\n")
    )
    const result = await generateImage(
      { prompt: "x", savePath: "a.png", workspaceDir, timeoutMs: 20_000 },
      { detect: fakeDetect(binary), codexHome: { homePath: codexHome } }
    )
    expect(result).toMatchObject({ ok: false, code: "generation_failed" })
    expect((result as { message: string }).message).toContain(
      `HOME=${codexHome}`
    )
  }, 30_000)
})
