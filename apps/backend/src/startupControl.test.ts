import { describe, expect, it } from "vitest"
import {
  BACKEND_STARTUP_MESSAGE_TYPE,
  STARTUP_CONTROL_ENV,
  sendStartupControl,
  startupControlChannelFromEnvironment,
  startupControlLine,
} from "./startupControl"

function channel(connected = true) {
  const sent: unknown[] = []
  return {
    sent,
    connected,
    send(message: unknown, callback?: (error: Error | null) => void) {
      sent.push(message)
      callback?.(null)
      return true
    },
  }
}

function stderr() {
  const lines: string[] = []
  return { lines, write: (chunk: string) => lines.push(chunk) }
}

describe("backend startup control frames", () => {
  it("go over the IPC channel when the shell started the backend, never to stderr", async () => {
    const ipc = channel()
    const log = stderr()
    await expect(
      sendStartupControl(
        { status: "ready", port: 4100, token: "t".repeat(48) },
        { channel: ipc, stderr: log }
      )
    ).resolves.toBe("ipc")
    expect(ipc.sent).toEqual([
      {
        type: BACKEND_STARTUP_MESSAGE_TYPE,
        protocol: 1,
        status: "ready",
        port: 4100,
        token: "t".repeat(48),
      },
    ])
    // The bearer never reaches the logged stream.
    expect(log.lines).toEqual([])
  })

  it("fall back to the established stderr lines without a channel", async () => {
    const log = stderr()
    for (const frame of [
      { status: "starting" as const },
      { status: "ready" as const, port: 4100, token: "secret-token" },
      { status: "error" as const, message: "locked" },
    ]) {
      await expect(
        sendStartupControl(frame, { channel: {}, stderr: log })
      ).resolves.toBe("stderr")
    }
    expect(log.lines.map((line) => JSON.parse(line))).toEqual([
      {
        control: BACKEND_STARTUP_MESSAGE_TYPE,
        status: "starting",
        protocol: 1,
      },
      { port: 4100, token: "secret-token", status: "ready" },
      { status: "error", message: "locked" },
    ])
  })

  it("treat a disconnected channel as no channel", async () => {
    const ipc = channel(false)
    const log = stderr()
    await sendStartupControl(
      { status: "starting" },
      { channel: ipc, stderr: log }
    )
    expect(ipc.sent).toEqual([])
    expect(log.lines).toEqual([
      `${startupControlLine({ status: "starting" })}\n`,
    ])
  })

  it("use the IPC channel only when the shell asked for it", () => {
    const host = channel()
    const asked: NodeJS.ProcessEnv = { [STARTUP_CONTROL_ENV]: "ipc" }
    expect(startupControlChannelFromEnvironment(asked, host)).toBe(host)
    // The request is consumed, so no child process inherits it.
    expect(asked[STARTUP_CONTROL_ENV]).toBeUndefined()

    // An older shell (or a plain `node dist/index.js`) gets stderr frames.
    expect(startupControlChannelFromEnvironment({}, host)).toEqual({})
    expect(
      startupControlChannelFromEnvironment(
        { [STARTUP_CONTROL_ENV]: "ipc" },
        { connected: true }
      )
    ).toEqual({})
  })

  it("do not hold up an exiting process when delivery never confirms", async () => {
    const silent = {
      connected: true,
      send: () => true,
    }
    await expect(
      sendStartupControl(
        { status: "error", message: "boom" },
        { channel: silent, stderr: stderr(), timeoutMs: 5 }
      )
    ).resolves.toBe("ipc")
  })
})
