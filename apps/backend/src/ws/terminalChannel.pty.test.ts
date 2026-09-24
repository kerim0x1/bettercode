import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { TERMINAL_METHODS } from "@betterc0de/schema/remote-terminal"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AppState } from "../appState"
import { readTerminalPtySession } from "../services/terminalPty"
import type { WsConnection, WsRemotePrincipal } from "./server"
import { RemoteTerminalChannel } from "./terminalChannel"

// The channel with the real PTY service (terminalChannel.test.ts has the
// rules with a stand-in): a small program in the terminal answers "ping"
// with "pong" and ends with 7 on "quit".
const PROGRAM = [
  'process.stdin.setEncoding("utf8")',
  'process.stdout.write("ready\\n")',
  'let typed = ""',
  'process.stdin.on("data", (chunk) => {',
  "  typed += chunk",
  '  if (typed.includes("quit")) process.exit(7)',
  '  if (typed.includes("ping")) { typed = ""; process.stdout.write("pong\\n") }',
  "})",
].join("\n")

const device: WsRemotePrincipal = {
  kind: "remote",
  sessionId: "phone-pty",
  accessLevel: "full",
  expiresAt: Date.now() + 3_600_000,
}

interface Frame {
  channel: string
  data: Record<string, unknown>
}

let workspace = ""

beforeEach(() => {
  // The OS's own realpath, as the desktop resolves a workspace: on Windows
  // the JavaScript one keeps a short 8.3 name (a CI runner's temp folder is
  // C:\Users\RUNNER~1\…) or a subst drive where the desktop has the long path.
  workspace = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "remote-terminal-pty-"))
  )
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
})

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

describe("the terminal for paired devices, with a real terminal", () => {
  it("runs the program, takes the device's input and sends its output and exit", async () => {
    const frames: Frame[] = []
    const on: WsConnection = {
      send: (frame) => {
        frames.push(frame as Frame)
      },
      bufferedAmount: () => 0,
      isOpen: () => true,
      onClose: () => () => undefined,
    }
    const terminals = new RemoteTerminalChannel({
      state: {
        projectProjections: { listAll: () => [{ path: workspace }] },
        threads: { listProjects: () => [] },
        worktreeRegistry: { listAll: () => [] },
      } as unknown as AppState,
      terminalGranted: () => true,
      launch: () => ({ command: process.execPath, args: ["-e", PROGRAM] }),
    })
    const shown = () =>
      frames
        .filter((frame) => frame.channel === "terminal.output")
        .map((frame) => String(frame.data.output))
        .join("")
    const opened = (await terminals.handle(
      TERMINAL_METHODS.open,
      { cwd: workspace, cols: 80, rows: 24 },
      device,
      on
    )) as { terminalId: string; cwd: string; status: string }
    try {
      expect(opened).toMatchObject({ cwd: workspace, status: "running" })
      await until(() => shown().includes("ready"), "the program to start")

      await terminals.handle(
        TERMINAL_METHODS.write,
        { terminalId: opened.terminalId, inputSeq: 1, data: "ping\r" },
        device,
        on
      )
      await until(() => shown().includes("pong"), "the answer")

      await terminals.handle(
        TERMINAL_METHODS.write,
        { terminalId: opened.terminalId, inputSeq: 2, data: "quit\r" },
        device,
        on
      )
      await until(
        () => frames.some((frame) => frame.channel === "terminal.exit"),
        "the exit"
      )
      expect(
        frames.find((frame) => frame.channel === "terminal.exit")?.data
      ).toMatchObject({ terminalId: opened.terminalId, exitCode: 7 })
      const seqs = frames
        .filter((frame) => "seq" in frame.data)
        .map((frame) => Number(frame.data.seq))
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    } finally {
      await terminals
        .handle(
          TERMINAL_METHODS.close,
          { terminalId: opened.terminalId },
          device,
          on
        )
        .catch(() => undefined)
      await until(
        () =>
          readTerminalPtySession(opened.terminalId) === null ||
          readTerminalPtySession(opened.terminalId)?.status === "exited",
        "the terminal to end"
      )
      terminals.dispose()
    }
  }, 60_000)
})
