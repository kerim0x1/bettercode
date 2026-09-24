import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtime = vi.hoisted(() => ({
  httpInvoke: vi.fn(),
  invoke: vi.fn(),
  isRemoteRuntime: vi.fn(),
}))

vi.mock("./runtime", () => runtime)

import { HttpError } from "@/lib/errors"
import {
  getContextArtifact,
  getEffectiveRules,
  isRemoteTerminalSwitchOffError,
  remoteShellCapabilityError,
  searchContent,
  searchContentDetailed,
  searchEntries,
  searchEntriesDetailed,
  splitReadPathForKnownRoots,
  splitReadPathForWorkspace,
  terminalOpen,
  unwrapContentSearchResponse,
  unwrapSearchEntriesResponse,
  writeFile,
} from "./workspaceApi"

describe("workspace read paths", () => {
  it("keeps the registered workspace root for nested absolute files", () => {
    expect(
      splitReadPathForWorkspace(
        "C:/repo/app/src/components/button.tsx",
        "C:\\repo\\app"
      )
    ).toEqual({
      cwd: "C:\\repo\\app",
      relativePath: "src/components/button.tsx",
    })
  })

  it("resolves project-relative files against the registered workspace", () => {
    expect(splitReadPathForWorkspace("src/main.ts", "/repo/app")).toEqual({
      cwd: "/repo/app",
      relativePath: "src/main.ts",
    })
  })

  it("falls back to the containing folder without a workspace", () => {
    expect(splitReadPathForWorkspace("/tmp/main.ts")).toEqual({
      cwd: "/tmp",
      relativePath: "main.ts",
    })
  })

  // The backend 403s any cwd that is not a registered root, so a file from a
  // non-active pane's project must resolve against THAT project's root — not
  // the active workspace and not the file's parent directory.
  it("splits against whichever known root contains the file", () => {
    expect(
      splitReadPathForKnownRoots("C:/other/proj/assets/logo.png", [
        "C:\\repo\\app",
        null,
        "C:\\other\\proj",
      ])
    ).toEqual({
      cwd: "C:\\other\\proj",
      relativePath: "assets/logo.png",
    })
  })

  it("prefers the first containing root and ignores blanks", () => {
    expect(
      splitReadPathForKnownRoots("/repo/app/src/main.ts", [
        "  ",
        "/repo/app",
        "/repo",
      ])
    ).toEqual({ cwd: "/repo/app", relativePath: "src/main.ts" })
  })

  it("returns null when no known root contains the file", () => {
    expect(
      splitReadPathForKnownRoots("/tmp/elsewhere.png", ["/repo/app"])
    ).toBeNull()
  })
})

describe("remote terminal capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal("window", { electronAPI: undefined })
  })

  it("uses a paired remote session when Electron IPC is unavailable", async () => {
    runtime.isRemoteRuntime.mockReturnValue(true)
    runtime.httpInvoke
      .mockResolvedValueOnce({ capability: "remote-operation-capability" })
      .mockResolvedValueOnce({ sessionId: "terminal-1" })

    await terminalOpen({ cwd: "/repo", command: "pwsh" })

    expect(runtime.httpInvoke).toHaveBeenNthCalledWith(1, "/shell/capability", {
      method: "POST",
      body: {
        operation: "pty-open",
        cwd: "/repo",
        sessionId: undefined,
        command: "pwsh",
      },
    })
    expect(runtime.httpInvoke).toHaveBeenNthCalledWith(2, "/shell/pty/open", {
      method: "POST",
      body: {
        cwd: "/repo",
        command: "pwsh",
        humanOrigin: true,
        permissionLevel: "bypass",
        humanCapability: "remote-operation-capability",
      },
    })
  })

  it("names the desktop switch when the host refuses this device a terminal", async () => {
    runtime.isRemoteRuntime.mockReturnValue(true)
    runtime.httpInvoke.mockRejectedValueOnce(
      new HttpError(
        "Terminal access from paired devices is disabled on the desktop host.",
        403,
        "/shell/capability",
        { code: "remote_terminal_disabled" }
      )
    )

    await expect(terminalOpen({ cwd: "/repo" })).rejects.toThrow(
      'Terminal access from paired devices is disabled on the desktop host. Enable "Allow terminal from remote devices" in Remote Access settings'
    )
    // The refusal comes from the backend, never from a local pre-check.
    expect(runtime.httpInvoke).toHaveBeenCalledTimes(1)
    expect(runtime.httpInvoke).toHaveBeenCalledWith(
      "/shell/capability",
      expect.objectContaining({ method: "POST" })
    )
  })

  it("keys the settings hint on the backend code, falling back to its message", () => {
    const switchOff = new HttpError(
      "Terminal access from paired devices is disabled on the desktop host.",
      403,
      "/shell/capability",
      { code: "remote_terminal_disabled" }
    )
    expect(isRemoteTerminalSwitchOffError(switchOff)).toBe(true)
    // An older backend without `code`: the message alone still qualifies.
    expect(
      isRemoteTerminalSwitchOffError(
        new HttpError(
          "Terminal access from paired devices is disabled on the desktop host.",
          403,
          "/shell/capability"
        )
      )
    ).toBe(true)
    // Same code, but the session is read-only: no switch fixes that.
    const readOnly = new HttpError(
      "This remote session is read-only; terminal access requires a full session.",
      403,
      "/shell/capability",
      { code: "remote_terminal_disabled" }
    )
    expect(isRemoteTerminalSwitchOffError(readOnly)).toBe(false)
    expect(remoteShellCapabilityError(readOnly).message).toBe(readOnly.message)
    // Other 403s carry their own code and their own message.
    for (const other of [
      new HttpError(
        "workspace root is not registered",
        403,
        "/shell/capability",
        {
          code: "workspace_not_registered",
        }
      ),
      new HttpError(
        "Shell capabilities require trusted desktop IPC.",
        403,
        "/shell/capability",
        {
          code: "desktop_only",
        }
      ),
      new HttpError("Forbidden", 403, "/shell/capability"),
      new HttpError("service draining", 503, "/shell/capability", {
        code: "remote_terminal_disabled",
      }),
      new Error(
        "Terminal access from paired devices is disabled on the desktop host."
      ),
    ]) {
      expect(isRemoteTerminalSwitchOffError(other), other.message).toBe(false)
      expect(remoteShellCapabilityError(other).message).toBe(other.message)
    }
  })

  it("passes other capability failures through unchanged", async () => {
    runtime.isRemoteRuntime.mockReturnValue(true)
    runtime.httpInvoke.mockRejectedValueOnce(
      new HttpError(
        "workspace root is not registered",
        403,
        "/shell/capability",
        {
          code: "workspace_not_registered",
        }
      )
    )
    await expect(terminalOpen({ cwd: "/elsewhere" })).rejects.toThrow(
      /^workspace root is not registered$/
    )
    runtime.httpInvoke.mockRejectedValueOnce(
      new HttpError(
        "This remote session is read-only; terminal access requires a full session.",
        403,
        "/shell/capability",
        { code: "remote_terminal_disabled" }
      )
    )
    await expect(terminalOpen({ cwd: "/repo" })).rejects.toThrow(
      /^This remote session is read-only; terminal access requires a full session\.$/
    )

    runtime.httpInvoke.mockRejectedValueOnce(
      new HttpError("service draining", 503, "/shell/capability")
    )
    await expect(terminalOpen({ cwd: "/repo" })).rejects.toThrow(
      /^service draining$/
    )
  })

  it("does not treat an ordinary bridge-less renderer as a paired client", async () => {
    runtime.isRemoteRuntime.mockReturnValue(false)

    await expect(terminalOpen({ cwd: "/repo" })).rejects.toThrow(
      "trusted desktop bridge or a paired remote session"
    )
    expect(runtime.httpInvoke).not.toHaveBeenCalled()
  })
})

describe("writing a file", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtime.invoke.mockResolvedValue(undefined)
    // A write announces the changed file to the window.
    vi.stubGlobal("window", { dispatchEvent: vi.fn() })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("sends the expected hash only when there is one, null included", async () => {
    await writeFile("/repo", "a.txt", "text")
    await writeFile("/repo", "b.txt", "", { expectedSha256: null })
    await writeFile("/repo", "c.txt", "new", { expectedSha256: "a".repeat(64) })
    expect(
      runtime.invoke.mock.calls.map(([, options]) => options.body)
    ).toEqual([
      { cwd: "/repo", relativePath: "a.txt", contents: "text" },
      {
        cwd: "/repo",
        relativePath: "b.txt",
        contents: "",
        expectedSha256: null,
      },
      {
        cwd: "/repo",
        relativePath: "c.txt",
        contents: "new",
        expectedSha256: "a".repeat(64),
      },
    ])
  })
})

describe("effective rules client", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("uses the typed workspace endpoint with the same target in IPC and HTTP transports", async () => {
    const result = {
      workspaceRoot: "/repo",
      targetPath: "src/app.ts",
      content: "effective context",
      sources: [],
      explanation: {
        mergeOrder: "low-to-high" as const,
        summary: "No sources.",
        precedence: [],
      },
    }
    runtime.invoke.mockResolvedValue(result)

    await expect(getEffectiveRules("/repo", "src/app.ts")).resolves.toBe(result)
    expect(runtime.invoke).toHaveBeenCalledWith("/workspace/effective-rules", {
      args: { cwd: "/repo", targetPath: "src/app.ts" },
      method: "POST",
      body: { cwd: "/repo", targetPath: "src/app.ts" },
    })
  })

  it("uses the workspace root as the default inspection target", async () => {
    runtime.invoke.mockResolvedValue({
      workspaceRoot: "/repo",
      targetPath: ".",
      content: "",
      sources: [],
      explanation: {
        mergeOrder: "low-to-high",
        summary: "No sources.",
        precedence: [],
      },
    })

    await getEffectiveRules("/repo")

    expect(runtime.invoke).toHaveBeenCalledWith("/workspace/effective-rules", {
      args: { cwd: "/repo", targetPath: "." },
      method: "POST",
      body: { cwd: "/repo", targetPath: "." },
    })
  })
})

describe("context artifact client", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("uses the typed workspace endpoint with the active thread correlation", async () => {
    const result = {
      workspaceRoot: "/repo",
      targetPath: ".",
      threadId: "thread-1",
      usedTokens: 120,
      estimatedTokens: 100,
      maxTokens: 1_000,
      remainingTokens: 880,
      compactsAutomatically: true,
      compaction: {
        generation: 1,
        boundaryMessageId: "message-1",
        excludedMessageCount: 2,
      },
      sources: [],
    }
    runtime.invoke.mockResolvedValue(result)

    await expect(
      getContextArtifact("/repo", ".", " thread-1 ", {
        messageCharacters: 42,
        attachments: [
          {
            id: "draft-file",
            name: "notes.txt",
            mediaType: "text/plain",
            sizeBytes: null,
          },
        ],
      })
    ).resolves.toBe(result)
    expect(runtime.invoke).toHaveBeenCalledWith("/workspace/context-artifact", {
      args: {
        cwd: "/repo",
        targetPath: ".",
        threadId: "thread-1",
        pendingMessageCharacters: 42,
        pendingAttachments: [
          {
            id: "draft-file",
            name: "notes.txt",
            mediaType: "text/plain",
            sizeBytes: null,
          },
        ],
      },
      method: "POST",
      body: {
        cwd: "/repo",
        targetPath: ".",
        threadId: "thread-1",
        pendingMessageCharacters: 42,
        pendingAttachments: [
          {
            id: "draft-file",
            name: "notes.txt",
            mediaType: "text/plain",
            sizeBytes: null,
          },
        ],
      },
    })
  })

  it("omits an empty thread ID and defaults to the workspace root", async () => {
    runtime.invoke.mockResolvedValue({
      workspaceRoot: "/repo",
      targetPath: ".",
      threadId: null,
      usedTokens: 0,
      estimatedTokens: 0,
      maxTokens: null,
      remainingTokens: null,
      compactsAutomatically: null,
      compaction: {
        generation: 0,
        boundaryMessageId: null,
        excludedMessageCount: 0,
      },
      sources: [],
    })

    await getContextArtifact("/repo", undefined, " ")

    expect(runtime.invoke).toHaveBeenCalledWith("/workspace/context-artifact", {
      args: { cwd: "/repo", targetPath: "." },
      method: "POST",
      body: { cwd: "/repo", targetPath: "." },
    })
  })
})

describe("workspace search results", () => {
  const entry = { path: "src/a.ts", name: "a.ts", is_dir: false }
  const hit = {
    path: "src/a.ts",
    name: "a.ts",
    matches: [{ line: 1, column: 1, preview: "needle" }],
  }

  beforeEach(() => {
    runtime.invoke.mockReset()
  })

  it("keeps the truncation flag and reason from the detailed wire shape", () => {
    expect(
      unwrapSearchEntriesResponse({
        entries: [entry],
        truncated: true,
        truncatedReason: "deadline",
      })
    ).toEqual({
      entries: [entry],
      truncated: true,
      truncatedReason: "deadline",
    })
    expect(
      unwrapContentSearchResponse({
        results: [hit],
        truncated: true,
        truncatedReason: "limit",
      })
    ).toEqual({ results: [hit], truncated: true, truncatedReason: "limit" })
  })

  // A reason without the flag is a contradiction; the flag wins so a UI
  // keyed on `truncatedReason` alone can never show a cut that did not happen.
  it("drops a stray reason when the search was complete", () => {
    expect(
      unwrapSearchEntriesResponse({
        entries: [entry],
        truncated: false,
        truncatedReason: "deadline",
      })
    ).toEqual({ entries: [entry], truncated: false })
    expect(
      unwrapContentSearchResponse({ results: [hit], truncated: false })
    ).not.toHaveProperty("truncatedReason")
  })

  // The dev backend is not hot-reloaded, so a renderer can meet a `dist`
  // that still answers with the old bare array. All such a backend can say
  // is "here is what I found", which is reported as complete, not as broken.
  it("accepts the legacy bare-array wire shape as a complete result", () => {
    expect(unwrapSearchEntriesResponse([entry])).toEqual({
      entries: [entry],
      truncated: false,
    })
    expect(unwrapContentSearchResponse([hit])).toEqual({
      results: [hit],
      truncated: false,
    })
  })

  it("treats garbage as an empty, complete result rather than throwing", () => {
    for (const raw of [null, undefined, 42, "x", {}, { entries: "no" }]) {
      expect(unwrapSearchEntriesResponse(raw)).toEqual({
        entries: [],
        truncated: false,
      })
      expect(unwrapContentSearchResponse(raw)).toEqual({
        results: [],
        truncated: false,
      })
    }
  })

  it("posts the same request for the detailed and the array form", async () => {
    runtime.invoke.mockResolvedValue({
      entries: [entry],
      truncated: true,
      truncatedReason: "visited",
    })
    await expect(searchEntriesDetailed("/repo", "a")).resolves.toEqual({
      entries: [entry],
      truncated: true,
      truncatedReason: "visited",
    })
    // The array wrapper is the old signature: rows only, flag dropped.
    await expect(searchEntries("/repo", "a")).resolves.toEqual([entry])
    expect(runtime.invoke).toHaveBeenCalledTimes(2)
    for (const call of runtime.invoke.mock.calls) {
      expect(call).toEqual([
        "/workspace/search",
        {
          args: { cwd: "/repo", query: "a" },
          method: "POST",
          body: { cwd: "/repo", query: "a" },
        },
      ])
    }
  })

  it("keeps the numeric limit shorthand for content search in both forms", async () => {
    runtime.invoke.mockResolvedValue({
      results: [hit],
      truncated: true,
      truncatedReason: "limit",
    })
    await expect(searchContentDetailed("/repo", "needle", 1)).resolves.toEqual({
      results: [hit],
      truncated: true,
      truncatedReason: "limit",
    })
    await expect(searchContent("/repo", "needle", 1)).resolves.toEqual([hit])
    expect(runtime.invoke).toHaveBeenCalledTimes(2)
    for (const call of runtime.invoke.mock.calls) {
      expect(call).toEqual([
        "/workspace/search-content",
        {
          args: { cwd: "/repo", query: "needle", limit: 1 },
          method: "POST",
          body: { cwd: "/repo", query: "needle", limit: 1 },
        },
      ])
    }
  })
})
