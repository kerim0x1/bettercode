import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it, expect } from "vitest"
import {
  captureCheckpoint,
  applyHunk,
  checkout,
  commit,
  deleteCheckpointRefs,
  deleteThreadCheckpointRefs,
  diff,
  diffCheckpoints,
  diffStaged,
  hasCheckpointRef,
  invalidateStatusCache,
  parseCheckpointNumstatSummary,
  parsePorcelainV2Status,
  pruneRestoreSafetyRefs,
  RESTORE_SAFETY_REFS_PREFIX,
  restoreCheckpoint,
  undoCheckpointRestore,
  stageAll,
  status,
  summarizeCheckpointDiff,
  userProfile,
  validateRemoteUrl,
} from "./git"
import { checkpointRefForThreadTurn } from "@betterc0de/schema"

describe("validateRemoteUrl (S5)", () => {
  it("accepts https / ssh / git URLs without credentials", () => {
    expect(validateRemoteUrl("https://github.com/x/y.git")).toBe(
      "https://github.com/x/y.git"
    )
    expect(validateRemoteUrl("ssh://git@github.com/x/y.git")).toBe(
      "ssh://git@github.com/x/y.git"
    )
    expect(validateRemoteUrl("git://gitserver/x/y.git")).toBe(
      "git://gitserver/x/y.git"
    )
    expect(validateRemoteUrl("git+https://example.com/x/y.git")).toBe(
      "git+https://example.com/x/y.git"
    )
  })

  it("accepts the ssh shorthand `git@host:user/repo` form", () => {
    expect(validateRemoteUrl("git@github.com:x/y")).toBe("git@github.com:x/y")
    expect(validateRemoteUrl("git@github.com:x/y.git")).toBe(
      "git@github.com:x/y.git"
    )
  })

  it("rejects file:// (local-disk fetch lead-in)", () => {
    expect(() => validateRemoteUrl("file:///etc/passwd")).toThrow(/scheme/i)
    expect(() =>
      validateRemoteUrl("file://C:/Users/other/.ssh/id_rsa")
    ).toThrow(/scheme/i)
  })

  it("rejects esoteric schemes (ext::, javascript:, ftp:)", () => {
    expect(() => validateRemoteUrl("ext::sh -c 'id > /tmp/x'")).toThrow()
    expect(() => validateRemoteUrl("javascript:alert(1)")).toThrow(/scheme/i)
    expect(() => validateRemoteUrl("ftp://x/y")).toThrow(/scheme/i)
  })

  it("rejects embedded credentials in https URLs", () => {
    expect(() =>
      validateRemoteUrl("https://user:token@github.com/x/y.git")
    ).toThrow(/credentials/i)
    expect(() =>
      validateRemoteUrl("https://attacker@github.com/x/y.git")
    ).toThrow(/credentials/i)
  })

  it("rejects empty / whitespace / non-URL input", () => {
    expect(() => validateRemoteUrl("")).toThrow()
    expect(() => validateRemoteUrl("   ")).toThrow()
    expect(() => validateRemoteUrl("not a url")).toThrow(/Invalid remote URL/i)
  })

  it("rejects ssh-shorthand variants that smuggle path traversal or shell metas", () => {
    // The shorthand regex is intentionally strict.
    expect(() => validateRemoteUrl("git@host:..//etc/passwd")).toThrow()
    expect(() => validateRemoteUrl("git@host:user/repo;rm -rf")).toThrow()
    expect(() => validateRemoteUrl("git@host:user/repo$(rm)")).toThrow()
  })
})

describe("Git user profile", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function createRepo(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-profile-"))
    tempDirs.push(cwd)
    runGit(cwd, ["init", "--initial-branch=main"])
    return cwd
  }

  it("reads repository-local identity and infers a GitHub user from a noreply email", async () => {
    const cwd = createRepo()
    runGit(cwd, ["config", "user.name", "Test User"])
    runGit(cwd, [
      "config",
      "user.email",
      "123456+octocat@users.noreply.github.com",
    ])

    await expect(userProfile(cwd)).resolves.toEqual({
      name: "Test User",
      email: "123456+octocat@users.noreply.github.com",
      githubUser: "octocat",
    })
  })

  it("prefers an explicit valid github.user setting", async () => {
    const cwd = createRepo()
    runGit(cwd, ["config", "user.name", "Test User"])
    runGit(cwd, ["config", "user.email", "octocat@users.noreply.github.com"])
    runGit(cwd, ["config", "github.user", "configured-user"])

    await expect(userProfile(cwd)).resolves.toMatchObject({
      githubUser: "configured-user",
    })
  })
})

describe("git checkpoint refs", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function createRepo(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-checkpoint-"))
    tempDirs.push(cwd)
    runGit(cwd, ["init", "--initial-branch=main"])
    runGit(cwd, ["config", "user.email", "test@example.com"])
    runGit(cwd, ["config", "user.name", "Test User"])
    fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8")
    runGit(cwd, ["add", "."])
    runGit(cwd, ["commit", "-m", "Initial"])
    return cwd
  }

  it("captures hidden refs and diffs them without touching HEAD", async () => {
    const cwd = createRepo()
    const headBefore = runGit(cwd, ["rev-parse", "HEAD"]).trim()
    const fromRef = checkpointRefForThreadTurn("thread-checkpoint", 0)
    const toRef = checkpointRefForThreadTurn("thread-checkpoint", 1)

    await captureCheckpoint({ cwd, checkpointRef: fromRef })
    fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8")
    fs.writeFileSync(path.join(cwd, "notes.txt"), "new\n", "utf8")
    await captureCheckpoint({ cwd, checkpointRef: toRef })

    expect(await hasCheckpointRef({ cwd, checkpointRef: fromRef })).toBe(true)
    expect(await hasCheckpointRef({ cwd, checkpointRef: toRef })).toBe(true)
    expect(runGit(cwd, ["rev-parse", "HEAD"]).trim()).toBe(headBefore)

    const result = await diffCheckpoints({
      cwd,
      fromCheckpointRef: fromRef,
      toCheckpointRef: toRef,
      ignoreWhitespace: true,
    })
    expect(result.diff).toContain("diff --git a/README.md b/README.md")
    expect(result.diff).toContain("+v2")
    expect(result.diff).toContain("diff --git a/notes.txt b/notes.txt")
  }, 30_000)

  it("summarizes checkpoint files without loading patch contents", async () => {
    const cwd = createRepo()
    const fromRef = checkpointRefForThreadTurn("thread-summary", 0)
    const toRef = checkpointRefForThreadTurn("thread-summary", 1)
    await captureCheckpoint({ cwd, checkpointRef: fromRef })
    fs.writeFileSync(path.join(cwd, "README.md"), "v1\nv2\n", "utf8")
    fs.writeFileSync(path.join(cwd, "binary.dat"), Buffer.from([0, 1, 2]))
    await captureCheckpoint({ cwd, checkpointRef: toRef })

    const summary = await summarizeCheckpointDiff({
      cwd,
      fromCheckpointRef: fromRef,
      toCheckpointRef: toRef,
      ignoreWhitespace: false,
    })

    expect(summary).toEqual({
      files: [
        { path: "binary.dat", additions: 0, deletions: 0 },
        { path: "README.md", additions: 1, deletions: 0 },
      ].sort((left, right) => left.path.localeCompare(right.path)),
      totalFiles: 2,
      filesTruncated: false,
    })
  })

  it("byte-bounds checkpoint summaries while counting every changed file", () => {
    const records = Array.from({ length: 1_000 }, (_, index) => {
      const filePath = `generated/${index}-${"é".repeat(1_000)}.bin`
      return `${index % 7}\t${index % 5}\t${filePath}\0`
    }).join("")

    const summary = parseCheckpointNumstatSummary(records)

    expect(summary.totalFiles).toBe(1_000)
    expect(summary.filesTruncated).toBe(true)
    expect(summary.files.length).toBeLessThan(1_000)
    expect(
      Buffer.byteLength(JSON.stringify(summary.files), "utf8")
    ).toBeLessThanOrEqual(512 * 1024)
  })

  it("restores a checkpoint and deletes checkpoint refs best-effort", async () => {
    const cwd = createRepo()
    const ref = checkpointRefForThreadTurn("thread-restore", 0)
    await captureCheckpoint({ cwd, checkpointRef: ref })

    fs.writeFileSync(path.join(cwd, "README.md"), "changed\n", "utf8")
    fs.writeFileSync(path.join(cwd, "scratch.txt"), "remove me\n", "utf8")

    const restoreResult = await restoreCheckpoint({ cwd, checkpointRef: ref })
    expect(restoreResult.restored).toBe(true)
    expect(fs.readFileSync(path.join(cwd, "README.md"), "utf8")).toBe("v1\n")
    expect(fs.existsSync(path.join(cwd, "scratch.txt"))).toBe(false)

    // The restore must be undoable: `scratch.txt` was created after the
    // checkpoint, so the checkpoint itself cannot bring it back — only the
    // pre-restore safety snapshot can.
    expect(restoreResult.safetyRef).toBeTruthy()
    expect(restoreResult.preview?.removed).toContain("scratch.txt")
    expect(restoreResult.preview?.modified).toContain("README.md")

    await expect(
      undoCheckpointRestore({ cwd, safetyRef: restoreResult.safetyRef! })
    ).resolves.toBe(true)
    expect(fs.readFileSync(path.join(cwd, "README.md"), "utf8")).toBe(
      "changed\n"
    )
    expect(fs.readFileSync(path.join(cwd, "scratch.txt"), "utf8")).toBe(
      "remove me\n"
    )

    // Put the checkpoint state back for the ref-deletion assertions below.
    expect(
      (await restoreCheckpoint({ cwd, checkpointRef: ref })).restored
    ).toBe(true)

    await deleteCheckpointRefs({
      cwd,
      checkpointRefs: [ref, "refs/betterc0de/checkpoints/missing"],
    })
    expect(await hasCheckpointRef({ cwd, checkpointRef: ref })).toBe(false)
  })

  // The temporary index is seeded by copying the user's real index, which
  // carries the assume-unchanged (`h`) and skip-worktree (`S`) bits. `add -A`
  // on such a copy never re-stats those paths, so every snapshot (turn
  // checkpoint, restore preview, pre-restore safety ref) recorded HEAD's
  // content instead of the worktree's — and restore + undo then destroyed
  // the user's local edit.
  for (const flag of ["--assume-unchanged", "--skip-worktree"] as const) {
    it(`captures local edits to ${flag} files without touching the real index`, async () => {
      const cwd = createRepo()
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8")
      runGit(cwd, ["commit", "-am", "v2"])
      runGit(cwd, ["update-index", flag, "README.md"])
      fs.writeFileSync(path.join(cwd, "README.md"), "local edit\n", "utf8")
      const realIndexPath = path.join(cwd, ".git", "index")
      const indexBefore = fs.readFileSync(realIndexPath)

      const ref = checkpointRefForThreadTurn("thread-index-bits", 0)
      await captureCheckpoint({ cwd, checkpointRef: ref })

      expect(runGit(cwd, ["show", `${ref}:README.md`])).toBe("local edit\n")
      // Only the temporary copy may be rewritten; the user's index keeps
      // its bits and its bytes.
      expect(fs.readFileSync(realIndexPath).equals(indexBefore)).toBe(true)
      expect(runGit(cwd, ["ls-files", "-v", "--", "README.md"]).trim()).toBe(
        `${flag === "--assume-unchanged" ? "h" : "S"} README.md`
      )
      expect(
        fs
          .readdirSync(path.join(cwd, ".git"))
          .filter((name) => name.startsWith("betterc0de-"))
      ).toEqual([])
    })

    it(`keeps a ${flag} local edit recoverable through restore + undo`, async () => {
      const cwd = createRepo()
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8")
      // A second tracked file: `git restore -- .` skips skip-worktree
      // entries by design, and refuses a pathspec that matches nothing.
      fs.writeFileSync(path.join(cwd, "other.txt"), "other\n", "utf8")
      runGit(cwd, ["add", "."])
      runGit(cwd, ["commit", "-m", "v2"])
      runGit(cwd, ["update-index", flag, "README.md"])
      const ref = checkpointRefForThreadTurn("thread-index-bits-restore", 0)
      await captureCheckpoint({ cwd, checkpointRef: ref })
      fs.writeFileSync(path.join(cwd, "README.md"), "local edit\n", "utf8")

      const restoreResult = await restoreCheckpoint({ cwd, checkpointRef: ref })
      expect(restoreResult.restored).toBe(true)
      expect(restoreResult.preview?.modified).toContain("README.md")
      expect(restoreResult.safetyRef).toBeTruthy()
      expect(
        runGit(cwd, ["show", `${restoreResult.safetyRef}:README.md`])
      ).toBe("local edit\n")

      await expect(
        undoCheckpointRestore({ cwd, safetyRef: restoreResult.safetyRef! })
      ).resolves.toBe(true)
      expect(fs.readFileSync(path.join(cwd, "README.md"), "utf8")).toBe(
        "local edit\n"
      )
    })
  }

  it("does not mutate the worktree when the undo snapshot cannot be captured", async () => {
    const cwd = createRepo()
    const ref = checkpointRefForThreadTurn("thread-restore-fail-closed", 0)
    await captureCheckpoint({ cwd, checkpointRef: ref })
    fs.writeFileSync(path.join(cwd, "README.md"), "changed\n", "utf8")
    fs.writeFileSync(path.join(cwd, "scratch.txt"), "keep me\n", "utf8")

    const gitDir = path.join(cwd, ".git")
    const preRestorePath = path.join(
      gitDir,
      "refs",
      "betterc0de",
      "pre-restore"
    )
    fs.writeFileSync(preRestorePath, "not-a-directory\n", "utf8")

    const restoreResult = await restoreCheckpoint({ cwd, checkpointRef: ref })
    expect(restoreResult.restored).toBe(false)
    expect(restoreResult.safetyRef).toBeNull()
    expect(fs.readFileSync(path.join(cwd, "README.md"), "utf8")).toBe(
      "changed\n"
    )
    expect(fs.readFileSync(path.join(cwd, "scratch.txt"), "utf8")).toBe(
      "keep me\n"
    )
  })

  it("rejects refs outside the BetterC0de checkpoint namespace", async () => {
    const cwd = createRepo()
    const headBefore = runGit(cwd, ["rev-parse", "HEAD"]).trim()

    await expect(
      captureCheckpoint({ cwd, checkpointRef: "refs/heads/main" })
    ).rejects.toThrow(/checkpoint namespace/i)
    expect(runGit(cwd, ["rev-parse", "HEAD"]).trim()).toBe(headBefore)
  })

  it("deletes only the hidden checkpoint refs owned by one thread", async () => {
    const cwd = createRepo()
    const firstThreadRefs = [0, 1, 2].map((turn) =>
      checkpointRefForThreadTurn("thread-first", turn)
    )
    const otherThreadRef = checkpointRefForThreadTurn("thread-other", 0)
    for (const checkpointRef of [...firstThreadRefs, otherThreadRef]) {
      await captureCheckpoint({ cwd, checkpointRef })
    }

    await expect(deleteThreadCheckpointRefs(cwd, "thread-first")).resolves.toBe(
      3
    )
    for (const checkpointRef of firstThreadRefs) {
      await expect(hasCheckpointRef({ cwd, checkpointRef })).resolves.toBe(
        false
      )
    }
    await expect(
      hasCheckpointRef({ cwd, checkpointRef: otherThreadRef })
    ).resolves.toBe(true)
  })

  it("propagates non-zero git exits even when git prints output", async () => {
    const cwd = createRepo()
    await expect(commit(cwd, "nothing changed")).rejects.toThrow(
      /nothing to commit|working tree clean/i
    )
  })

  it("rejects option-like branch names before invoking checkout", async () => {
    const cwd = createRepo()
    await expect(checkout(cwd, "--orphan", false)).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})

describe("git hunk review", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await invalidateStatusCache()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function createRepo(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-hunks-"))
    tempDirs.push(cwd)
    runGit(cwd, ["init", "--initial-branch=main"])
    runGit(cwd, ["config", "user.email", "test@example.com"])
    runGit(cwd, ["config", "user.name", "Test User"])
    fs.writeFileSync(
      path.join(cwd, "example.txt"),
      Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n") +
        "\n",
      "utf8"
    )
    runGit(cwd, ["add", "."])
    runGit(cwd, ["commit", "-m", "Initial"])
    return cwd
  }

  it("accepts, rejects, and unstages exact hunks without touching siblings", async () => {
    const cwd = createRepo()
    const filePath = path.join(cwd, "example.txt")
    const changed = fs
      .readFileSync(filePath, "utf8")
      .replace("line 2\n", "line two\n")
      .replace("line 13\n", "line thirteen\n")
    fs.writeFileSync(filePath, changed, "utf8")

    const initialPatches = testHunkPatches((await diff(cwd)).diff)
    expect(initialPatches).toHaveLength(2)

    await applyHunk({
      cwd,
      path: "example.txt",
      source: "unstaged",
      action: "accept",
      patch: initialPatches[0]!,
    })

    expect((await diffStaged(cwd)).diff).toContain("+line two")
    expect((await diffStaged(cwd)).diff).not.toContain("+line thirteen")
    expect((await diff(cwd)).diff).not.toContain("+line two")
    expect((await diff(cwd)).diff).toContain("+line thirteen")

    const [remainingPatch] = testHunkPatches((await diff(cwd)).diff)
    await applyHunk({
      cwd,
      path: "example.txt",
      source: "unstaged",
      action: "reject",
      patch: remainingPatch!,
    })

    expect((await diff(cwd)).diff).toBe("")
    expect(fs.readFileSync(filePath, "utf8")).toContain("line 13\n")

    const [stagedPatch] = testHunkPatches((await diffStaged(cwd)).diff)
    const result = await applyHunk({
      cwd,
      path: "example.txt",
      source: "staged",
      action: "unstage",
      patch: stagedPatch!,
    })

    expect(result).toMatchObject({
      ok: true,
      action: "unstage",
    })
    expect(result.patchId).toMatch(/^[a-f0-9]{64}$/)
    expect((await diffStaged(cwd)).diff).toBe("")
    expect((await diff(cwd)).diff).toContain("+line two")
  }, 30_000)

  it("rejects a stale hunk before applying it", async () => {
    const cwd = createRepo()
    const filePath = path.join(cwd, "example.txt")
    fs.writeFileSync(
      filePath,
      fs.readFileSync(filePath, "utf8").replace("line 2\n", "changed once\n"),
      "utf8"
    )
    const [stalePatch] = testHunkPatches((await diff(cwd)).diff)
    fs.writeFileSync(
      filePath,
      fs
        .readFileSync(filePath, "utf8")
        .replace("changed once\n", "changed twice\n"),
      "utf8"
    )

    await expect(
      applyHunk({
        cwd,
        path: "example.txt",
        source: "unstaged",
        action: "reject",
        patch: stalePatch!,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "git_hunk_conflict",
    })
    expect(fs.readFileSync(filePath, "utf8")).toContain("changed twice\n")
  })

  it("dry-runs an exact hunk without changing the index or worktree", async () => {
    const cwd = createRepo()
    const filePath = path.join(cwd, "example.txt")
    fs.writeFileSync(
      filePath,
      fs.readFileSync(filePath, "utf8").replace("line 2\n", "preview only\n"),
      "utf8"
    )
    const [patch] = testHunkPatches((await diff(cwd)).diff)

    const result = await applyHunk({
      cwd,
      path: "example.txt",
      source: "unstaged",
      action: "accept",
      patch: patch!,
      dryRun: true,
    })

    expect(result).toMatchObject({
      ok: true,
      action: "accept",
      applied: false,
    })
    expect((await diffStaged(cwd)).diff).toBe("")
    expect((await diff(cwd)).diff).toContain("+preview only")
  })
})

describe("git status cache", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await invalidateStatusCache()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function createRepo(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-git-status-"))
    tempDirs.push(cwd)
    runGit(cwd, ["init", "--initial-branch=main"])
    runGit(cwd, ["config", "user.email", "test@example.com"])
    runGit(cwd, ["config", "user.name", "Test User"])
    fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8")
    runGit(cwd, ["add", "."])
    runGit(cwd, ["commit", "-m", "Initial"])
    return cwd
  }

  it("caches status briefly and invalidates after mutating git actions", async () => {
    const cwd = createRepo()

    expect(await status(cwd)).toMatchObject({
      is_clean: true,
      staged: [],
      modified: [],
    })

    fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8")
    expect(await status(cwd)).toMatchObject({
      is_clean: true,
      staged: [],
      modified: [],
    })

    await stageAll(cwd)

    expect(await status(cwd)).toMatchObject({
      is_clean: false,
      staged: ["README.md"],
      modified: [],
    })
  })
})

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
}

function testHunkPatches(diffText: string): string[] {
  const lines = diffText
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/g, "")
    .split("\n")
  const starts = lines
    .map((line, index) => (line.startsWith("@@ ") ? index : -1))
    .filter((index) => index >= 0)
  if (starts.length === 0) return []
  const header = lines
    .slice(0, starts[0])
    .filter((line) => !line.startsWith("index "))
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    return `${[...header, ...lines.slice(start, end)].join("\n")}\n`
  })
}

describe("parsePorcelainV2Status", () => {
  it("reads branch, upstream, ahead/behind and every entry kind from one output", () => {
    const status = parsePorcelainV2Status(
      [
        "# branch.oid 0123abcd",
        "# branch.head feature/x",
        "# branch.upstream origin/feature/x",
        "# branch.ab +2 -1",
        "1 M. N... 100644 100644 100644 aaaa bbbb staged only.txt",
        "1 .M N... 100644 100644 100644 aaaa bbbb unstaged.txt",
        "1 MM N... 100644 100644 100644 aaaa bbbb both.txt",
        // `-z`: the original path of a rename is its own NUL record.
        "2 R. N... 100644 100644 100644 aaaa bbbb R100 renamed.txt",
        "old.txt",
        "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt",
        "? new file.txt",
        "! ignored.txt",
        "",
      ].join("\0")
    )
    expect(status).toEqual({
      branch: "feature/x",
      upstream: "origin/feature/x",
      ahead: 2,
      behind: 1,
      is_clean: false,
      staged: ["staged only.txt", "both.txt", "renamed.txt", "conflict.txt"],
      modified: ["unstaged.txt", "both.txt", "conflict.txt"],
      untracked: ["new file.txt"],
    })
  })

  // Regression: a rename's original path used to share the record with the
  // new path (tab-separated). In `-z` mode it is the next record, and a
  // parser that does not consume it would read `old.txt` as an entry of
  // unknown kind — or, worse, as an untracked file when it starts with `?`.
  it("consumes the rename's original path so it is never read as an entry", () => {
    const status = parsePorcelainV2Status(
      [
        "# branch.head main",
        "2 R. N... 100644 100644 100644 aaaa bbbb R100 renamed with space.txt",
        "? was-untracked-looking.txt",
        "1 .M N... 100644 100644 100644 aaaa bbbb ü ä.txt",
        "",
      ].join("\0")
    )
    expect(status.staged).toEqual(["renamed with space.txt"])
    expect(status.modified).toEqual(["ü ä.txt"])
    expect(status.untracked).toEqual([])
  })

  it("keeps the v1 wording for a detached HEAD and zero counts without upstream", () => {
    const status = parsePorcelainV2Status(
      ["# branch.oid 0123abcd", "# branch.head (detached)", ""].join("\0")
    )
    expect(status).toMatchObject({
      branch: "HEAD (no branch)",
      upstream: null,
      ahead: 0,
      behind: 0,
      is_clean: true,
    })
  })
})

describe("git status paths from a real repository", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await invalidateStatusCache()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: without `-z`, git C-quotes any path with a non-ASCII byte
  // (`"\303\274 \303\244.txt"`) and the renderer showed that literal string.
  // A rename carried both paths in one line; with `-z` the original path is
  // a record of its own and must not surface as a second entry.
  it("reports non-ASCII paths unquoted and a rename by its new path only", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-git-zpaths-"))
    tempDirs.push(cwd)
    runGit(cwd, ["init", "--initial-branch=main"])
    runGit(cwd, ["config", "user.email", "test@example.com"])
    runGit(cwd, ["config", "user.name", "Test User"])
    // Force the quoting on so the test proves `-z` is what disables it, not
    // a lucky local `core.quotePath=false`.
    runGit(cwd, ["config", "core.quotePath", "true"])
    fs.writeFileSync(path.join(cwd, "ü ä.txt"), "x\n", "utf8")
    fs.writeFileSync(path.join(cwd, "tab.txt"), "y\n", "utf8")
    runGit(cwd, ["add", "."])
    runGit(cwd, ["commit", "-m", "Initial"])

    runGit(cwd, ["mv", "tab.txt", "renamed with space.txt"])
    fs.appendFileSync(path.join(cwd, "ü ä.txt"), "z\n", "utf8")
    fs.writeFileSync(path.join(cwd, "nëw file.txt"), "n\n", "utf8")

    const result = await status(cwd)
    expect(result.staged).toEqual(["renamed with space.txt"])
    expect(result.modified).toEqual(["ü ä.txt"])
    expect(result.untracked).toEqual(["nëw file.txt"])
    for (const entry of [
      ...result.staged,
      ...result.modified,
      ...result.untracked,
    ]) {
      expect(entry).not.toContain('"')
      expect(entry).not.toContain("\\")
      expect(entry).not.toContain("\t")
    }
  }, 30_000)
})

describe("git status against a real upstream", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await invalidateStatusCache()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports upstream and ahead count from a single status call", async () => {
    const remote = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-git-remote-")
    )
    tempDirs.push(remote)
    runGit(remote, ["init", "--bare", "--initial-branch=main"])
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-git-upstream-")
    )
    tempDirs.push(cwd)
    runGit(cwd, ["init", "--initial-branch=main"])
    runGit(cwd, ["config", "user.email", "test@example.com"])
    runGit(cwd, ["config", "user.name", "Test User"])
    fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8")
    runGit(cwd, ["add", "."])
    runGit(cwd, ["commit", "-m", "Initial"])
    runGit(cwd, ["remote", "add", "origin", remote])
    runGit(cwd, ["push", "-u", "origin", "main"])
    fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8")
    runGit(cwd, ["commit", "-am", "Second"])

    expect(await status(cwd)).toMatchObject({
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      is_clean: true,
    })
  }, 30_000)
})

describe("checkpoint snapshot performance paths", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function createRepo(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-ckpt-perf-"))
    tempDirs.push(cwd)
    runGit(cwd, ["init", "--initial-branch=main"])
    runGit(cwd, ["config", "user.email", "test@example.com"])
    runGit(cwd, ["config", "user.name", "Test User"])
    fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8")
    runGit(cwd, ["add", "."])
    runGit(cwd, ["commit", "-m", "Initial"])
    return cwd
  }

  // Regression: the temporary index is a copy of the real one. With
  // `core.splitIndex=true` that copy carried the split-index link extension,
  // so every checkpoint's `add -A` wrote a fresh `sharedindex.<oid>` into the
  // user's `.git` — one per turn, never collected.
  it("does not leave a new sharedindex file behind when the repo uses split-index", async () => {
    const cwd = createRepo()
    runGit(cwd, ["config", "core.splitIndex", "true"])
    runGit(cwd, ["update-index", "--split-index"])
    const gitDir = path.join(cwd, ".git")
    const sharedIndexFiles = () =>
      fs
        .readdirSync(gitDir)
        .filter((name) => name.startsWith("sharedindex."))
        .sort()
    const before = sharedIndexFiles()
    expect(before.length).toBeGreaterThan(0)

    fs.writeFileSync(path.join(cwd, "new.txt"), "new\n", "utf8")
    const ref = checkpointRefForThreadTurn("thread-split-index", 0)
    await captureCheckpoint({ cwd, checkpointRef: ref })

    expect(sharedIndexFiles()).toEqual(before)
    // The snapshot still recorded the worktree, so `add -A` did run on the
    // copy — the shared index was simply not re-split.
    expect(runGit(cwd, ["ls-tree", "--name-only", ref])).toContain("new.txt")
    // The user's own index is untouched and still split.
    expect(runGit(cwd, ["status", "--porcelain"])).toBe("?? new.txt\n")
    expect(
      fs
        .readdirSync(gitDir)
        .filter((name) => /^betterc0de-checkpoint-index-/.test(name))
    ).toEqual([])
  }, 30_000)

  it("captures the exact worktree even when the real index has staged and unstaged edits", async () => {
    const cwd = createRepo()
    fs.writeFileSync(path.join(cwd, "staged.txt"), "staged\n", "utf8")
    runGit(cwd, ["add", "staged.txt"])
    fs.writeFileSync(
      path.join(cwd, "staged.txt"),
      "staged then edited\n",
      "utf8"
    )
    fs.writeFileSync(path.join(cwd, "README.md"), "v1 edited\n", "utf8")
    fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked\n", "utf8")
    runGit(cwd, ["rm", "--cached", "-q", "README.md"])
    const indexBefore = fs.readFileSync(path.join(cwd, ".git", "index"))

    const ref = checkpointRefForThreadTurn("thread-seeded", 0)
    await captureCheckpoint({ cwd, checkpointRef: ref })

    const listing = runGit(cwd, ["ls-tree", "-r", "--name-only", ref])
    expect(listing.split("\n").filter(Boolean).sort()).toEqual([
      "README.md",
      "staged.txt",
      "untracked.txt",
    ])
    expect(runGit(cwd, ["show", `${ref}:staged.txt`])).toBe(
      "staged then edited\n"
    )
    expect(runGit(cwd, ["show", `${ref}:README.md`])).toBe("v1 edited\n")
    // The user's real index is untouched and no temporary index is left.
    expect(
      fs.readFileSync(path.join(cwd, ".git", "index")).equals(indexBefore)
    ).toBe(true)
    expect(
      fs
        .readdirSync(path.join(cwd, ".git"))
        .filter((name) => name.startsWith("betterc0de-"))
    ).toEqual([])
  }, 30_000)

  it("caps checkpoint diffs like the display diff", async () => {
    const cwd = createRepo()
    const fromRef = checkpointRefForThreadTurn("thread-bigdiff", 0)
    const toRef = checkpointRefForThreadTurn("thread-bigdiff", 1)
    await captureCheckpoint({ cwd, checkpointRef: fromRef })
    const line = "x".repeat(200) + "\n"
    fs.writeFileSync(path.join(cwd, "big.txt"), line.repeat(15_000), "utf8")
    await captureCheckpoint({ cwd, checkpointRef: toRef })

    const result = await diffCheckpoints({
      cwd,
      fromCheckpointRef: fromRef,
      toCheckpointRef: toRef,
    })
    expect(result.truncated).toBe(true)
    expect(result.totalBytes).toBeGreaterThan(2 * 1024 * 1024)
    expect(Buffer.byteLength(result.diff, "utf8")).toBeLessThanOrEqual(
      2 * 1024 * 1024
    )
    expect(result.diff.endsWith("\n")).toBe(true)
  }, 60_000)

  it("prunes pre-restore safety refs past the retention window and keeps recent ones", async () => {
    const cwd = createRepo()
    const ref = checkpointRefForThreadTurn("thread-prune", 0)
    await captureCheckpoint({ cwd, checkpointRef: ref })
    fs.writeFileSync(path.join(cwd, "README.md"), "changed\n", "utf8")
    const restored = await restoreCheckpoint({ cwd, checkpointRef: ref })
    expect(restored.safetyRef).toBeTruthy()
    const listSafetyRefs = () =>
      runGit(cwd, [
        "for-each-ref",
        "--format=%(refname)",
        `${RESTORE_SAFETY_REFS_PREFIX}/`,
      ])
        .split("\n")
        .filter(Boolean)
    expect(listSafetyRefs()).toEqual([restored.safetyRef])

    await expect(pruneRestoreSafetyRefs(cwd)).resolves.toBe(0)
    expect(listSafetyRefs()).toEqual([restored.safetyRef])

    const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1000
    await expect(
      pruneRestoreSafetyRefs(cwd, { now: eightDaysLater })
    ).resolves.toBe(1)
    expect(listSafetyRefs()).toEqual([])
  }, 30_000)
})
