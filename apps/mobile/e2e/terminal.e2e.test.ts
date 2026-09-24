import { TERMINAL_METHODS } from "@betterc0de/schema/remote-terminal"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { TerminalClient } from "@/terminal/terminal-client"
import { RemoteSocket } from "@/transport/live/socket"
import { CLIENT, startTestDesktop, type TestDesktop } from "./support/desktop"

// The phone's terminal against a real desktop: its WebSocket, its terminal
// channel and a real shell in the desktop's workspace.

let desktop: TestDesktop

beforeAll(async () => {
  desktop = await startTestDesktop()
  // A chat in the workspace makes it one the desktop knows.
  await desktop.saveThread("terminal-chat", new Date().toISOString())
  await desktop.setSettings({ remote_access_allow_terminal: true })
})

// The phones a test paired: their terminals end, and the test waits for
// their shells to exit, before the next test. Closing one from the phone
// does not wait, and on Windows a shell takes seconds to end (a graceful
// end it ignores, a forced one, then ConPTY's report); several left to the
// desktop's own shutdown can outlast its bound on a slow CI runner.
const pairedPhones: string[] = []
async function pairPhone() {
  const pairing = await desktop.pairPhone()
  pairedPhones.push(pairing.paired.session.id)
  return pairing
}
afterEach(async () => {
  for (const sessionId of pairedPhones.splice(0)) {
    await desktop.asDesktop(
      "DELETE",
      `/remote/sessions/${encodeURIComponent(sessionId)}/terminals`
    )
  }
})

afterAll(async () => {
  await desktop?.stop()
})

const ESCAPE = "\u001b"

/**
 * What a terminal printed, without its escape sequences (colours, cursor).
 * A move to another line counts as a line break: Windows' ConPTY moves the
 * cursor to the next line instead of printing one.
 */
function plain(output: string): string {
  let text = ""
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== ESCAPE) {
      text += output[index]
      continue
    }
    const kind = output[index + 1]
    index += 1
    if (kind === "[") {
      // Parameters and intermediates, up to the final letter.
      while (index + 1 < output.length && !/[@-~]/.test(output[index + 1]!))
        index += 1
      index += 1
      if ("HfEFBd".includes(output[index] ?? "")) text += "\n"
    } else if (kind === "]") {
      // A title: up to BEL or ESC \.
      while (
        index + 1 < output.length &&
        output[index + 1] !== "\u0007" &&
        output[index + 1] !== ESCAPE
      )
        index += 1
      index += output[index + 1] === ESCAPE ? 2 : 1
    }
  }
  return text
}

/** A phone: its connection to the desktop, and a terminal over it. */
async function phone(sessionToken: string) {
  let socket: RemoteSocket
  let shown = ""
  const ended: string[] = []
  const connect = async () => {
    let live!: () => void
    const connected = new Promise<void>((resolve) => {
      live = resolve
    })
    socket = new RemoteSocket(
      { baseUrl: desktop.baseUrl, sessionToken, client: CLIENT },
      {
        onFrame: (frame) => {
          terminal.receive(frame)
        },
        onState: (state) => {
          if (state === "live") live()
        },
      }
    )
    socket.start()
    await connected
  }
  const terminal = new TerminalClient(
    (method, params) => socket.call(method, params),
    {
      output: (text) => {
        shown += text
      },
      gap: () => ended.push("gap"),
      exit: (exitCode) => ended.push(`exit ${exitCode}`),
      closed: (reason) => ended.push(`closed ${reason}`),
      failed: (error) => ended.push(`failed ${String(error)}`),
    }
  )
  await connect()
  return {
    terminal,
    ended,
    call: (method: string, params: unknown) => socket.call(method, params),
    shown: () => plain(shown),
    /** The connection goes, and a new one comes. */
    async reconnect(typedWhileAway: string) {
      socket.stop()
      terminal.detached()
      terminal.write(typedWhileAway)
      await connect()
      await terminal.attach()
    },
    stop: () => socket.stop(),
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** `6*7` in the shell's own words. */
function arithmetic(shell: string): string {
  if (shell === "cmd") return "set /a 6*7\r"
  if (shell === "powershell" || shell === "pwsh") return "6*7\r"
  return "echo $((6*7))\r"
}

/** The output has `line` as a line of its own. */
const hasLine = (output: string, line: string) =>
  output.split(/\r?\n/).some((each) => each.trim() === line)

describe("a terminal on the desktop, from the phone", () => {
  it("runs a command in the workspace, and takes the terminal up again after a lost connection", async () => {
    const { paired } = await pairPhone()
    const first = await phone(paired.sessionToken)
    try {
      const opened = await first.terminal.open(desktop.workspace, 100, 30)
      expect(opened).toMatchObject({
        cwd: desktop.workspace,
        status: "running",
      })

      first.terminal.write(arithmetic(opened.shell))
      await until(() => hasLine(first.shown(), "42"), "6*7 to be 42")

      // Typed while the connection was gone: applied once it is back, once.
      await first.reconnect("echo back-again\r")
      await until(
        () => hasLine(first.shown(), "back-again"),
        "the input sent while away"
      )
      expect(
        first
          .shown()
          .split(/\r?\n/)
          .filter((line) => line.trim() === "back-again")
      ).toHaveLength(1)
      // What the phone had was not sent again.
      expect(
        first
          .shown()
          .split(/\r?\n/)
          .filter((line) => line.trim() === "42")
      ).toHaveLength(1)
    } finally {
      await first.terminal.close().catch(() => undefined)
      first.stop()
    }
  })

  it("keeps a phone's terminal to that phone", async () => {
    const owner = await phone((await pairPhone()).paired.sessionToken)
    const other = await phone((await pairPhone()).paired.sessionToken)
    try {
      const { terminalId } = await owner.terminal.open(
        desktop.workspace,
        80,
        24
      )
      await expect(
        other.call(TERMINAL_METHODS.attach, { terminalId, afterSeq: 0 })
      ).rejects.toMatchObject({ code: "terminal_not_found" })
      await expect(
        other.call(TERMINAL_METHODS.write, {
          terminalId,
          inputSeq: 1,
          data: "exit\r",
        })
      ).rejects.toMatchObject({ code: "terminal_not_found" })
      await expect(other.call(TERMINAL_METHODS.list, {})).resolves.toEqual({
        terminals: [],
      })
      await expect(
        other.call(TERMINAL_METHODS.open, { cwd: "/", cols: 80, rows: 24 })
      ).rejects.toMatchObject({ code: "workspace_not_registered" })
    } finally {
      await owner.terminal.close().catch(() => undefined)
      owner.stop()
      other.stop()
    }
  })

  it("ends when the desktop takes terminals away, and says why", async () => {
    const { paired } = await pairPhone()
    const device = await phone(paired.sessionToken)
    try {
      await device.terminal.open(desktop.workspace, 80, 24)
      await desktop.setSettings({ remote_access_allow_terminal: false })
      await until(() => device.ended.length > 0, "the terminal to end")
      expect(device.ended).toEqual(["closed grant_revoked"])
      await expect(
        device.call(TERMINAL_METHODS.open, {
          cwd: desktop.workspace,
          cols: 80,
          rows: 24,
        })
      ).rejects.toMatchObject({ code: "remote_terminal_disabled" })
    } finally {
      await desktop.setSettings({ remote_access_allow_terminal: true })
      device.stop()
    }
  })
})
