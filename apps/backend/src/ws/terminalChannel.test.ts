import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  TERMINAL_LIMITS,
  TERMINAL_METHODS,
} from "@betterc0de/schema/remote-terminal"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../appState"
import type { WsConnection, WsPrincipal, WsRemotePrincipal } from "./server"
import { RemoteTerminalChannel } from "./terminalChannel"

// The PTY service stands in here, so each test decides what the terminal
// prints, what its buffer keeps and when it ends. terminalChannel.pty.test.ts
// runs the channel with a real one.
const pty = vi.hoisted(() => {
  interface FakeEvent {
    seq: number
    type: "data" | "exit" | "system"
    data?: string
    exitCode?: number | null
    signal?: number | string | null
    at: number
  }
  interface FakeSession {
    id: string
    ownerId?: string
    cwd: string
    status: "running" | "exited"
    events: FakeEvent[]
    nextSeq: number
    listeners: Set<(event: FakeEvent) => void>
    written: string[]
    size: { cols: number; rows: number }
    closed: boolean
  }
  const sessions = new Map<string, FakeSession>()
  let opened = 0
  const owned = (id: string, ownerId?: string) => {
    const session = sessions.get(id)
    return session && (ownerId === undefined || session.ownerId === ownerId)
      ? session
      : null
  }
  const snapshot = (session: FakeSession, cursor: number) => {
    const events = session.events.filter((event) => event.seq > cursor)
    return {
      sessionId: session.id,
      pid: 1,
      cwd: session.cwd,
      shell: "fake",
      command: "fake",
      args: [],
      status: session.status,
      events,
      nextCursor: events.at(-1)?.seq ?? cursor,
      lastSeq: session.nextSeq,
    }
  }
  const push = (session: FakeSession, event: Omit<FakeEvent, "seq" | "at">) => {
    session.nextSeq += 1
    const stored = { ...event, seq: session.nextSeq, at: Date.now() }
    session.events.push(stored)
    for (const listener of session.listeners) listener(stored)
    return stored.seq
  }
  return {
    sessions,
    reset() {
      sessions.clear()
      opened = 0
    },
    open(input: {
      ownerId?: string
      cwd: string
      cols?: number
      rows?: number
    }) {
      opened += 1
      const session: FakeSession = {
        id: `terminal-${opened}`,
        ownerId: input.ownerId,
        cwd: input.cwd,
        status: "running",
        events: [],
        nextSeq: 0,
        listeners: new Set(),
        written: [],
        size: { cols: input.cols ?? 80, rows: input.rows ?? 24 },
        closed: false,
      }
      sessions.set(session.id, session)
      push(session, { type: "system", data: "fake shell" })
      return snapshot(session, 0)
    },
    read: (id: string, cursor = 0, ownerId?: string) => {
      const session = owned(id, ownerId)
      return session ? snapshot(session, cursor) : null
    },
    subscribe: (
      id: string,
      listener: (event: FakeEvent) => void,
      ownerId?: string
    ) => {
      const session = owned(id, ownerId)
      if (!session) return null
      session.listeners.add(listener)
      return () => session.listeners.delete(listener)
    },
    write: (id: string, data: string, ownerId?: string) => {
      const session = owned(id, ownerId)
      if (!session || session.status !== "running" || session.closed)
        return false
      session.written.push(data)
      return true
    },
    resize: (id: string, cols: number, rows: number, ownerId?: string) => {
      const session = owned(id, ownerId)
      if (!session || session.status !== "running") return false
      session.size = { cols, rows }
      return true
    },
    close: (id: string, ownerId?: string) => {
      const session = owned(id, ownerId)
      if (!session) return false
      session.closed = true
      sessions.delete(id)
      return true
    },
    /** The terminal prints. */
    print(id: string, data: string) {
      return push(sessions.get(id)!, { type: "data", data })
    },
    exit(id: string, exitCode: number) {
      const session = sessions.get(id)!
      session.status = "exited"
      return push(session, { type: "exit", exitCode, signal: null })
    },
    /** The buffer lets go of its oldest events. */
    drop(id: string, count: number) {
      sessions.get(id)!.events.splice(0, count)
    },
  }
})

vi.mock("../services/terminalPty", () => ({
  openTerminalPtySession: (input: Parameters<typeof pty.open>[0]) =>
    pty.open(input),
  readTerminalPtySession: pty.read,
  subscribeTerminalPtySession: pty.subscribe,
  writeTerminalPtySession: pty.write,
  resizeTerminalPtySession: pty.resize,
  closeTerminalPtySession: pty.close,
}))

interface FakeConnection extends WsConnection {
  readonly frames: Array<{ channel: string; data: Record<string, unknown> }>
  queued: number
  close(): void
}

function connection(): FakeConnection {
  const listeners = new Set<() => void>()
  let open = true
  const fake: FakeConnection = {
    frames: [],
    queued: 0,
    send: (frame) => {
      fake.frames.push(frame as FakeConnection["frames"][number])
    },
    bufferedAmount: () => fake.queued,
    isOpen: () => open,
    onClose: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      open = false
      for (const listener of [...listeners]) listener()
    },
  }
  return fake
}

const device = (
  sessionId = "phone-1",
  accessLevel: WsRemotePrincipal["accessLevel"] = "full"
): WsRemotePrincipal => ({
  kind: "remote",
  sessionId,
  accessLevel,
  expiresAt: Date.now() + 3_600_000,
})

let workspace = ""
let granted = true

function channel(detachedMs?: number) {
  const state = {
    projectProjections: { listAll: () => [{ path: workspace }] },
    threads: { listProjects: () => [] },
    worktreeRegistry: { listAll: () => [] },
  } as unknown as AppState
  return new RemoteTerminalChannel({
    state,
    terminalGranted: () => granted,
    detachedMs,
  })
}

const call = (
  terminals: RemoteTerminalChannel,
  method: string,
  params: unknown,
  principal: WsPrincipal = device(),
  on: WsConnection = connection()
) => terminals.handle(method, params, principal, on)

async function openOne(
  terminals: RemoteTerminalChannel,
  on: FakeConnection,
  principal: WsPrincipal = device()
) {
  const opened = (await call(
    terminals,
    TERMINAL_METHODS.open,
    { cwd: workspace, cols: 80, rows: 24 },
    principal,
    on
  )) as { terminalId: string }
  return opened.terminalId
}

const output = (on: FakeConnection) =>
  on.frames
    .filter((frame) => frame.channel === "terminal.output")
    .map((frame) => String(frame.data.output))
    .join("")

beforeEach(() => {
  vi.useFakeTimers()
  workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "remote-terminal-"))
  )
  granted = true
  pty.reset()
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(workspace, { recursive: true, force: true })
})

describe("the terminal for paired devices", () => {
  it("is for a paired device with a full session, while the desktop allows it", async () => {
    const terminals = channel()
    const open = { cwd: workspace, cols: 80, rows: 24 }
    await expect(
      call(terminals, TERMINAL_METHODS.open, open, { kind: "local" })
    ).rejects.toMatchObject({ statusCode: 403, code: "remote_terminal_only" })
    await expect(
      call(
        terminals,
        TERMINAL_METHODS.open,
        open,
        device("phone-1", "read_only")
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "remote_terminal_disabled",
    })
    granted = false
    await expect(
      call(terminals, TERMINAL_METHODS.open, open)
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "remote_terminal_disabled",
    })
    expect(pty.sessions.size).toBe(0)
  })

  it("opens only in a workspace the desktop knows", async () => {
    const elsewhere = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "not-a-workspace-"))
    )
    try {
      await expect(
        call(channel(), TERMINAL_METHODS.open, {
          cwd: elsewhere,
          cols: 80,
          rows: 24,
        })
      ).rejects.toMatchObject({ code: "workspace_not_registered" })
      expect(pty.sessions.size).toBe(0)
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it("sends output in order, as far ahead as the device has acknowledged", async () => {
    const terminals = channel()
    const on = connection()
    const id = await openOne(terminals, on)
    const chunk = "x".repeat(40 * 1024)
    const printed: number[] = []
    for (let index = 0; index < 10; index += 1) {
      printed.push(pty.print(id, `${index}${chunk}`))
    }
    await vi.advanceTimersByTimeAsync(20)

    const sent = on.frames.filter(
      (frame) => frame.channel === "terminal.output"
    )
    const bytes = sent.reduce(
      (total, frame) => total + String(frame.data.output).length,
      0
    )
    // Up to the limit, and at most the one frame that crossed it.
    expect(bytes).toBeGreaterThanOrEqual(TERMINAL_LIMITS.unackedBytes)
    expect(bytes).toBeLessThan(TERMINAL_LIMITS.unackedBytes + 41 * 1024)
    expect(bytes).toBeLessThan(10 * 40 * 1024)

    const seqs = sent.map((frame) => Number(frame.data.seq))
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    await call(
      terminals,
      TERMINAL_METHODS.ack,
      {
        terminalId: id,
        seq: seqs.at(-1),
      },
      device(),
      on
    )
    await vi.advanceTimersByTimeAsync(20)

    expect(output(on)).toBe(
      Array.from({ length: 10 }, (_, index) => `${index}${chunk}`).join("")
    )
    expect(on.frames.at(-1)?.data.seq).toBe(printed.at(-1))
  })

  it("says so when the buffer dropped output before it was sent", async () => {
    const terminals = channel()
    const on = connection()
    const id = await openOne(terminals, on)
    for (const text of ["a", "b", "c", "d", "e"]) pty.print(id, text)
    // The system note (1) and "a", "b" (2, 3) are gone before the flush.
    pty.drop(id, 3)
    await vi.advanceTimersByTimeAsync(20)

    expect(on.frames[0]).toEqual({
      channel: "terminal.gap",
      data: { terminalId: id, fromSeq: 1, toSeq: 3 },
    })
    expect(output(on)).toBe("cde")
  })

  it("sends the exit after the output, and the device's close ends the process", async () => {
    const terminals = channel()
    const on = connection()
    const id = await openOne(terminals, on)
    pty.print(id, "bye\r\n")
    const exitSeq = pty.exit(id, 3)
    await vi.advanceTimersByTimeAsync(20)

    expect(on.frames.map((frame) => frame.channel)).toEqual([
      "terminal.output",
      "terminal.exit",
    ])
    expect(on.frames[1]!.data).toEqual({
      terminalId: id,
      seq: exitSeq,
      exitCode: 3,
      signal: null,
    })

    await call(
      terminals,
      TERMINAL_METHODS.close,
      { terminalId: id },
      device(),
      on
    )
    expect(pty.sessions.has(id)).toBe(false)
    expect(on.frames.at(-1)).toEqual({
      channel: "terminal.closed",
      data: { terminalId: id, reason: "closed" },
    })
    await expect(
      call(terminals, TERMINAL_METHODS.list, {}, device(), on)
    ).resolves.toEqual({ terminals: [] })
  })

  it("applies input once and in order, even when the device does not wait", async () => {
    const terminals = channel()
    const on = connection()
    const id = await openOne(terminals, on)
    const write = (inputSeq: number, data: string) =>
      call(
        terminals,
        TERMINAL_METHODS.write,
        { terminalId: id, inputSeq, data },
        device(),
        on
      )

    await expect(
      Promise.all([write(1, "e"), write(2, "c"), write(3, "h"), write(4, "o")])
    ).resolves.toEqual([
      { applied: true },
      { applied: true },
      { applied: true },
      { applied: true },
    ])
    // Sent again after a lost connection: already applied.
    await expect(write(3, "h")).resolves.toEqual({ applied: false })
    await expect(write(6, "!")).rejects.toMatchObject({
      statusCode: 409,
      code: "terminal_input_gap",
    })
    expect(pty.sessions.get(id)!.written).toEqual(["e", "c", "h", "o"])

    await expect(
      write(5, "x".repeat(TERMINAL_LIMITS.maxWriteBytes) + "é")
    ).rejects.toMatchObject({ code: "invalid_params" })
    await expect(
      write(5, "é".repeat(TERMINAL_LIMITS.maxWriteBytes / 2 + 1))
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "terminal_input_too_large",
    })

    pty.exit(id, 0)
    await expect(write(5, "late")).rejects.toMatchObject({
      statusCode: 409,
      code: "terminal_exited",
    })
  })

  it("keeps a device's terminals to that device", async () => {
    const terminals = channel()
    const id = await openOne(terminals, connection())
    const other = device("phone-2")
    for (const [method, params] of [
      [TERMINAL_METHODS.attach, { terminalId: id, afterSeq: 0 }],
      [TERMINAL_METHODS.write, { terminalId: id, inputSeq: 1, data: "ls\r" }],
      [TERMINAL_METHODS.resize, { terminalId: id, cols: 100, rows: 30 }],
      [TERMINAL_METHODS.ack, { terminalId: id, seq: 1 }],
      [TERMINAL_METHODS.close, { terminalId: id }],
    ] as const) {
      await expect(
        call(terminals, method, params, other)
      ).rejects.toMatchObject({ statusCode: 404, code: "terminal_not_found" })
    }
    await expect(
      call(terminals, TERMINAL_METHODS.list, {}, other)
    ).resolves.toEqual({ terminals: [] })
    expect(pty.sessions.get(id)!.written).toEqual([])
    const listed = (await call(terminals, TERMINAL_METHODS.list, {})) as {
      terminals: Array<{ terminalId: string }>
    }
    expect(listed.terminals.map((terminal) => terminal.terminalId)).toEqual([
      id,
    ])
  })

  it("takes a device back after the output it already has", async () => {
    const terminals = channel()
    const first = connection()
    const id = await openOne(terminals, first)
    pty.print(id, "before ")
    await vi.advanceTimersByTimeAsync(20)
    const had = Number(first.frames.at(-1)!.data.seq)
    first.close()

    pty.print(id, "while away ")
    const second = connection()
    await expect(
      call(
        terminals,
        TERMINAL_METHODS.attach,
        { terminalId: id, afterSeq: had },
        device(),
        second
      )
    ).resolves.toMatchObject({
      terminalId: id,
      status: "running",
      nextInputSeq: 1,
    })
    pty.print(id, "after")
    await vi.advanceTimersByTimeAsync(20)

    expect(output(first)).toBe("before ")
    expect(output(second)).toBe("while away after")
  })

  it("ends a terminal no device came back to", async () => {
    const terminals = channel(60_000)
    const first = connection()
    const id = await openOne(terminals, first)
    first.close()
    await vi.advanceTimersByTimeAsync(59_000)
    const second = connection()
    await call(
      terminals,
      TERMINAL_METHODS.attach,
      { terminalId: id, afterSeq: 0 },
      device(),
      second
    )
    // Back in time: the clock starts again when this connection goes.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pty.sessions.has(id)).toBe(true)

    second.close()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(pty.sessions.has(id)).toBe(true)
    await vi.advanceTimersByTimeAsync(2)
    expect(pty.sessions.has(id)).toBe(false)
    await expect(call(terminals, TERMINAL_METHODS.list, {})).resolves.toEqual({
      terminals: [],
    })
  })

  it("tells each device why when the desktop takes the grant away", async () => {
    const terminals = channel()
    const phone = connection()
    const tablet = connection()
    const first = await openOne(terminals, phone)
    const second = await openOne(terminals, tablet, device("tablet-1"))

    granted = false
    terminals.grantRevoked()
    expect(phone.frames.at(-1)).toEqual({
      channel: "terminal.closed",
      data: { terminalId: first, reason: "grant_revoked" },
    })
    expect(tablet.frames.at(-1)).toEqual({
      channel: "terminal.closed",
      data: { terminalId: second, reason: "grant_revoked" },
    })
    expect(terminals.count("phone-1")).toBe(0)
    expect(terminals.count("tablet-1")).toBe(0)
    await expect(
      call(terminals, TERMINAL_METHODS.write, {
        terminalId: first,
        inputSeq: 1,
        data: "ls\r",
      })
    ).rejects.toMatchObject({ code: "remote_terminal_disabled" })
    // The grant's own teardown ends the processes (bootstrap/providers.ts):
    // the channel does not kill them a second time.
    expect(pty.sessions.get(first)?.closed).toBe(false)
    expect(pty.sessions.get(second)?.closed).toBe(false)
  })

  it("tells only that device when the desktop ends its terminals", async () => {
    const terminals = channel()
    const phone = connection()
    const tablet = connection()
    const first = await openOne(terminals, phone)
    const second = await openOne(terminals, phone)
    const other = await openOne(terminals, tablet, device("tablet-1"))

    terminals.endedOnDesktop("phone-1")
    expect(phone.frames.slice(-2)).toEqual([
      {
        channel: "terminal.closed",
        data: { terminalId: first, reason: "ended_on_desktop" },
      },
      {
        channel: "terminal.closed",
        data: { terminalId: second, reason: "ended_on_desktop" },
      },
    ])
    expect(terminals.count("phone-1")).toBe(0)
    expect(
      tablet.frames.some((frame) => frame.channel === "terminal.closed")
    ).toBe(false)
    await expect(
      call(terminals, TERMINAL_METHODS.list, {}, device("tablet-1"))
    ).resolves.toMatchObject({ terminals: [{ terminalId: other }] })
    // The desktop's route ends the processes, with the device's other
    // shells: the channel does not kill them a second time.
    expect(pty.sessions.get(first)?.closed).toBe(false)
    expect(pty.sessions.get(second)?.closed).toBe(false)
  })

  it("forgets the terminals of a revoked session", async () => {
    const terminals = channel()
    const phone = connection()
    await openOne(terminals, phone)
    const tabletTerminal = await openOne(
      terminals,
      connection(),
      device("tablet-1")
    )
    expect(terminals.count("phone-1")).toBe(1)

    terminals.forgetSessions(["phone-1"])
    expect(terminals.count("phone-1")).toBe(0)
    expect(terminals.count("tablet-1")).toBe(1)
    await expect(
      call(terminals, TERMINAL_METHODS.list, {}, device("tablet-1"))
    ).resolves.toMatchObject({ terminals: [{ terminalId: tabletTerminal }] })
  })

  it("waits while the socket is full", async () => {
    const terminals = channel()
    const on = connection()
    const id = await openOne(terminals, on)
    on.queued = 600 * 1024
    pty.print(id, "held")
    await vi.advanceTimersByTimeAsync(200)
    expect(output(on)).toBe("")

    on.queued = 0
    await vi.advanceTimersByTimeAsync(60)
    expect(output(on)).toBe("held")
  })

  it("passes a resize on, and refuses anything it does not know", async () => {
    const terminals = channel()
    const id = await openOne(terminals, connection())
    await call(terminals, TERMINAL_METHODS.resize, {
      terminalId: id,
      cols: 120,
      rows: 40,
    })
    expect(pty.sessions.get(id)!.size).toEqual({ cols: 120, rows: 40 })
    await expect(
      call(terminals, TERMINAL_METHODS.resize, {
        terminalId: id,
        cols: 5,
        rows: 40,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "invalid_params" })
    await expect(
      call(terminals, "terminal.teleport", { terminalId: id })
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
