import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  buildLaunchInvocation,
  detectOpenTargets,
  quoteWindowsCmdArg,
  SHELL_TARGET_IDS,
  TARGET_IDS,
  wrapWindowsScriptInvocation,
  type DetectDeps,
  type LaunchInvocation,
} from "./openTargets"

const SPACE_PATH = "C:\\Users\\developer\\My Projects\\app"

// `DetectDeps.platform` steers target selection, but path handling stays on
// the host: `IS_WIN` is fixed at module load and POSIX `path.isAbsolute`
// rejects `C:\...`. Assertions that resolve Windows install paths therefore
// only hold on a Windows host.
const itOnWindows = it.runIf(process.platform === "win32")

function winDeps(overrides: Partial<DetectDeps> = {}): DetectDeps {
  return {
    pathExists: async () => false,
    lookupPathNames: async () => new Map(),
    platform: "win32",
    ...overrides,
  }
}

describe("detectOpenTargets", () => {
  it("lists all win32 targets with unique ids", async () => {
    const targets = await detectOpenTargets({}, winDeps())
    const ids = targets.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of [
      "vscode",
      "cursor",
      "zed",
      "antigravity",
      "android-studio",
      "github-desktop",
      "git-bash",
      "wsl",
      "explorer",
      "terminal",
    ]) {
      expect(ids).toContain(id)
    }
  })

  it("marks explorer and terminal always available, others by detection", async () => {
    const targets = await detectOpenTargets({}, winDeps())
    const byId = new Map(targets.map((t) => [t.id, t]))
    expect(byId.get("explorer")?.available).toBe(true)
    expect(byId.get("terminal")?.available).toBe(true)
    expect(byId.get("vscode")?.available).toBe(false)
    expect(byId.get("git-bash")?.available).toBe(false)
  })

  itOnWindows(
    "resolves via known install paths without a PATH lookup",
    async () => {
      const codePath = path.join(
        "C:\\Users\\developer\\AppData\\Local",
        "Programs",
        "Microsoft VS Code",
        "Code.exe"
      )
      const lookup = vi.fn(
        async (_names: string[]) => new Map<string, string>()
      )
      const targets = await detectOpenTargets(
        {},
        winDeps({
          pathExists: async (p) => p.endsWith("Code.exe"),
          lookupPathNames: lookup,
        })
      )
      expect(targets.find((t) => t.id === "vscode")?.available).toBe(true)
      // vscode resolved via the async known-path check; only the OTHER
      // pathName-carrying targets go through the batched lookup.
      expect(lookup).toHaveBeenCalledTimes(1)
      const requested = lookup.mock.calls[0]![0]
      expect(requested).not.toContain("code")
      expect(codePath.endsWith("Code.exe")).toBe(true)
    }
  )

  it("falls back to the batched PATH lookup", async () => {
    const targets = await detectOpenTargets(
      {},
      winDeps({
        lookupPathNames: async (names) =>
          new Map(
            names.includes("zed") ? [["zed", "C:\\Tools\\zed\\zed.exe"]] : []
          ),
      })
    )
    expect(targets.find((t) => t.id === "zed")?.available).toBe(true)
  })

  it("exports the id sets the HTTP route validates against", async () => {
    const detected = new Set<string>()
    for (const platform of ["win32", "darwin", "linux"] as const) {
      for (const target of await detectOpenTargets({}, winDeps({ platform }))) {
        detected.add(target.id)
      }
    }
    expect([...TARGET_IDS].sort()).toEqual([...detected].sort())
    // The shell-opening targets are the ones a remote terminal grant gates.
    expect([...SHELL_TARGET_IDS].sort()).toEqual([
      "git-bash",
      "terminal",
      "wsl",
    ])
    for (const id of SHELL_TARGET_IDS) expect(TARGET_IDS.has(id)).toBe(true)
  })

  it("omits targets not supported on the platform", async () => {
    const targets = await detectOpenTargets({}, winDeps({ platform: "linux" }))
    const ids = targets.map((t) => t.id)
    expect(ids).not.toContain("git-bash")
    expect(ids).not.toContain("wsl")
    expect(ids).not.toContain("github-desktop")
    expect(ids).toContain("explorer")
  })

  it("single-flights concurrent refresh requests", async () => {
    let releaseLookup: ((value: Map<string, string>) => void) | undefined
    const lookupResult = new Promise<Map<string, string>>((resolve) => {
      releaseLookup = resolve
    })
    const lookup = vi.fn(async () => await lookupResult)
    const deps = winDeps({ lookupPathNames: lookup })

    const first = detectOpenTargets({ refresh: true }, deps)
    const second = detectOpenTargets({ refresh: true }, deps)
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))
    releaseLookup?.(new Map([["zed", "C:\\Tools\\zed.exe"]]))

    const [firstTargets, secondTargets] = await Promise.all([first, second])
    expect(firstTargets).toEqual(secondTargets)
    expect(firstTargets.find((target) => target.id === "zed")?.available).toBe(
      true
    )
  })

  it("rate-limits explicit refreshes while returning the cached result", async () => {
    let now = 1_000
    let zedAvailable = true
    const lookup = vi.fn(async () =>
      zedAvailable
        ? new Map([["zed", "C:\\Tools\\zed.exe"]])
        : new Map<string, string>()
    )
    const deps = winDeps({ lookupPathNames: lookup, now: () => now })

    const initial = await detectOpenTargets({ refresh: true }, deps)
    zedAvailable = false
    now += 1_000
    const rateLimited = await detectOpenTargets({ refresh: true }, deps)

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(initial.find((target) => target.id === "zed")?.available).toBe(true)
    expect(rateLimited.find((target) => target.id === "zed")?.available).toBe(
      true
    )

    now += 31_000
    const refreshed = await detectOpenTargets({ refresh: true }, deps)
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(refreshed.find((target) => target.id === "zed")?.available).toBe(
      false
    )
  })

  it("returns a safe partial result when async filesystem checks exceed the deadline", async () => {
    const lookup = vi.fn(async () => new Map<string, string>())
    const deps = winDeps({
      deadlineMs: 10,
      pathExists: async () =>
        await new Promise<boolean>(() => {
          // Deliberately unresolved; the detection deadline must win.
        }),
      lookupPathNames: lookup,
    })

    const targets = await detectOpenTargets({ refresh: true }, deps)

    expect(targets.find((target) => target.id === "explorer")?.available).toBe(
      true
    )
    expect(targets.find((target) => target.id === "vscode")?.available).toBe(
      false
    )
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe("wrapWindowsScriptInvocation", () => {
  const base = (command: string): LaunchInvocation => ({
    command,
    args: [SPACE_PATH],
    options: { detached: true, stdio: "ignore", windowsHide: true },
  })

  it("wraps .bat through ComSpec with quoting and verbatim args", () => {
    const wrapped = wrapWindowsScriptInvocation(
      base(
        "C:\\Users\\developer\\AppData\\Local\\GitHubDesktop\\bin\\github.bat"
      )
    )
    expect(wrapped.command.toLowerCase()).toContain("cmd")
    expect(wrapped.args.slice(0, 3)).toEqual(["/d", "/s", "/c"])
    expect(wrapped.args[3]).toContain("github.bat")
    // Real quotes, not caret-escaped ones: a .bat re-parses `%*`, so only a
    // quoted region keeps a path with spaces or operators as one argument.
    // See windowsCommandLine.test.ts for the real-shim spawn proof.
    expect(wrapped.args[3]).toContain(
      '"C:\\Users\\developer\\My Projects\\app"'
    )
    expect(wrapped.options.windowsVerbatimArguments).toBe(true)
  })

  it("leaves .exe invocations untouched", () => {
    const inv = base("C:\\Tools\\Code.exe")
    expect(wrapWindowsScriptInvocation(inv)).toBe(inv)
  })
})

describe("quoteWindowsCmdArg", () => {
  // The escaping contract itself is pinned by
  // `src/security/windowsCommandLine.test.ts`, which decodes both the cmd and
  // MSVCRT layers and asserts no unescaped operator survives. This case only
  // guards the re-export from this module.
  //
  // These expectations changed with the fix: the old implementation wrapped in
  // quotes and caret-escaped INSIDE them (`"x^&y"`), which is wrong — a caret
  // is literal inside a cmd quoted region, so an embedded quote could close the
  // region and expose the operators after it. The quotes are now caret-escaped
  // too, leaving no quoted region for cmd to parse.
  it("quotes whitespace and cmd operators so .cmd shims see one token", () => {
    expect(quoteWindowsCmdArg("plain")).toBe("plain")
    expect(quoteWindowsCmdArg("a b")).toBe('"a b"')
    expect(quoteWindowsCmdArg("x&y")).toBe('"x&y"')
  })
})

describe("buildLaunchInvocation", () => {
  it("throws statusCode 400 for unknown targets", async () => {
    try {
      await buildLaunchInvocation("nonsense", SPACE_PATH, winDeps())
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400)
    }
  })

  it("throws 400 when the target is not installed", async () => {
    try {
      await buildLaunchInvocation("vscode", SPACE_PATH, winDeps())
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as Error).message).toContain("not installed")
      expect((err as { statusCode?: number }).statusCode).toBe(400)
    }
  })

  itOnWindows(
    "keeps a space-containing path as one argv element for editors",
    async () => {
      const inv = await buildLaunchInvocation(
        "vscode",
        SPACE_PATH,
        winDeps({ pathExists: async (p) => p.endsWith("Code.exe") })
      )
      expect(inv.command.endsWith("Code.exe")).toBe(true)
      expect(inv.args).toEqual([SPACE_PATH])
    }
  )

  it("builds git-bash --cd as a single argv element", async () => {
    const inv = await buildLaunchInvocation(
      "git-bash",
      SPACE_PATH,
      winDeps({ pathExists: async (p) => p.endsWith("git-bash.exe") })
    )
    expect(inv.args).toEqual([`--cd=${SPACE_PATH}`])
  })

  it("terminal on macOS opens Terminal.app at the project path", async () => {
    // The launch builders follow the injected platform, not the host's.
    const inv = await buildLaunchInvocation("terminal", SPACE_PATH, {
      ...winDeps(),
      platform: "darwin",
    })
    expect(inv.command).toBe("/usr/bin/open")
    expect(inv.args).toEqual(["-a", "Terminal", SPACE_PATH])
  })

  it("terminal without wt falls back to cmd with the path only in cwd", async () => {
    const inv = await buildLaunchInvocation("terminal", SPACE_PATH, winDeps())
    expect(inv.command.toLowerCase()).toContain("cmd")
    expect(inv.args.join(" ")).not.toContain(SPACE_PATH)
    expect(inv.options.cwd).toBe(SPACE_PATH)
  })

  itOnWindows("terminal prefers wt with -d <path>", async () => {
    const inv = await buildLaunchInvocation(
      "terminal",
      SPACE_PATH,
      winDeps({ pathExists: async (p) => p.endsWith("wt.exe") })
    )
    expect(inv.command.endsWith("wt.exe")).toBe(true)
    expect(inv.args).toEqual(["-d", SPACE_PATH])
  })

  itOnWindows("wsl prefers Windows Terminal when it is resolved", async () => {
    const inv = await buildLaunchInvocation(
      "wsl",
      SPACE_PATH,
      winDeps({
        pathExists: async (p) => p.endsWith("wsl.exe") || p.endsWith("wt.exe"),
      })
    )
    expect(inv.command.endsWith("wt.exe")).toBe(true)
    expect(inv.args).toEqual(["-d", SPACE_PATH, "wsl"])
  })

  it("routes github-desktop's .bat through the ComSpec wrapper", async () => {
    const inv = await buildLaunchInvocation(
      "github-desktop",
      SPACE_PATH,
      winDeps({ pathExists: async (p) => p.endsWith("github.bat") })
    )
    expect(inv.command.toLowerCase()).toContain("cmd")
    expect(inv.args[3]).toContain("github.bat")
    expect(inv.options.windowsVerbatimArguments).toBe(true)
  })

  itOnWindows("resolves legacy ids through the alias map", async () => {
    const inv = await buildLaunchInvocation("explorer", SPACE_PATH, winDeps())
    expect(inv.command.toLowerCase()).toContain("explorer.exe")
    expect(inv.args).toEqual([SPACE_PATH])
  })
})
