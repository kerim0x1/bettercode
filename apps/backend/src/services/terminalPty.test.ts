import { setTimeout as delay } from "node:timers/promises"
import { describe, expect, it } from "vitest"
import {
  boundTerminalPtyData,
  resolveTerminalShellLaunch,
  TERMINAL_PTY_MAX_EVENT_DATA_BYTES,
  TerminalPtyService,
} from "./terminalPty"

/** The service under test; one per file, as the module state used to be. */
const ptys = new TerminalPtyService()

describe("terminalPty", () => {
  it("uses zsh as a login shell when selected", () => {
    if (process.platform === "win32") return

    expect(resolveTerminalShellLaunch("zsh")).toEqual({
      shell: "zsh",
      command: "zsh",
      args: ["-l"],
    })
  })

  it("accepts absolute unix shell paths for terminal sessions", () => {
    if (process.platform === "win32") return

    expect(resolveTerminalShellLaunch("/bin/sh")).toEqual({
      shell: "sh",
      command: "/bin/sh",
      args: [],
    })
  })

  it("redacts injected Claude system prompts from the visible launch event", async () => {
    const secretContext = "thread summary ".repeat(80)
    const opened = ptys.openSession({
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "process.exit(0)", "--append-system-prompt", secretContext],
      cols: 80,
      rows: 24,
    })

    const launch = opened.events.find((event) => event.type === "system")

    expect(opened.args).toContain("[BetterC0de thread context]")
    expect(opened.args).not.toContain(secretContext)
    expect(launch?.data).toContain("--append-system-prompt")
    expect(launch?.data).toContain("[BetterC0de thread context]")
    expect(launch?.data).not.toContain(secretContext.trim())

    // The child exits on its own. Wait for that exit before cleanup so the
    // Windows ConPTY implementation does not race a redundant process-tree
    // kill against an already disappearing console.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (ptys.readSession(opened.sessionId)?.status === "exited") break
      await delay(25)
    }
    ptys.closeSession(opened.sessionId)
  })

  it("opens a native PTY session and buffers process output", async () => {
    const opened = ptys.openSession({
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello from pty\\n')"],
      cols: 80,
      rows: 24,
    })

    let cursor = opened.nextCursor
    let output = opened.events
      .filter((event) => event.type === "data")
      .map((event) => event.data ?? "")
      .join("")
    let status = opened.status

    for (let attempt = 0; attempt < 20 && status === "running"; attempt += 1) {
      await delay(50)
      const snapshot = ptys.readSession(opened.sessionId, cursor)
      expect(snapshot).not.toBeNull()
      if (!snapshot) break
      output += snapshot.events
        .filter((event) => event.type === "data")
        .map((event) => event.data ?? "")
        .join("")
      cursor = snapshot.nextCursor
      status = snapshot.status
    }

    ptys.closeSession(opened.sessionId)
    expect(output).toContain("hello from pty")
  })

  it("bounds a single PTY data event by UTF-8 bytes", () => {
    const huge = "🙂".repeat(3 * 1024 * 1024)
    const bounded = boundTerminalPtyData(huge)

    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(
      TERMINAL_PTY_MAX_EVENT_DATA_BYTES
    )
    expect(bounded).toContain("terminal output truncated")
  })
})

describe("terminal ownership by renderer instance", () => {
  it("closes only the terminals the released renderer instance opened", async () => {
    const open = (clientInstanceId: string) =>
      ptys.openSession({
        cwd: process.cwd(),
        ownerId: "local-owner",
        clientInstanceId,
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30000)"],
        cols: 80,
        rows: 24,
      })
    const released = open("renderer-aaaa1111")
    const kept = open("renderer-bbbb2222")
    try {
      await expect(
        ptys.shutdownForClientInstance("local-owner", "renderer-aaaa1111")
      ).resolves.toBe(1)
      expect(ptys.readSession(released.sessionId)).toBeNull()
      expect(ptys.readSession(kept.sessionId)?.status).toBe("running")
    } finally {
      await ptys.shutdownForClientInstance("local-owner", "renderer-bbbb2222")
    }
  }, 30_000)
})
