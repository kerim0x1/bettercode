import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  decodeRuntimeFrame,
  pendingRequestFromEvent,
} from "@/lib/runtime-events"
import { createDemoTransport, DEMO_PROTOCOL } from "./index"

// The demo is what App Review, the component tests and the end-to-end flows
// see. It has to behave like a paired desktop and never reach the network.

let fetchSpy: ReturnType<typeof vi.fn>
let socketSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  fetchSpy = vi.fn(() => {
    throw new Error("the demo must not use the network")
  })
  socketSpy = vi.fn(() => {
    throw new Error("the demo must not open sockets")
  })
  vi.stubGlobal("fetch", fetchSpy)
  vi.stubGlobal("WebSocket", socketSpy)
})

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(socketSpy).not.toHaveBeenCalled()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function demo() {
  const transport = createDemoTransport({ chunkDelayMs: 10 })
  const frames: unknown[] = []
  const states: string[] = []
  const protocols: unknown[] = []
  const channel = transport.createChannel({
    onFrame: (frame) => frames.push(frame),
    onState: (state) => states.push(state),
    onProtocol: (protocol) => protocols.push(protocol),
  })
  channel.start()
  const events = () =>
    frames
      .map((frame) => decodeRuntimeFrame(frame))
      .filter((event) => event !== null)
  return { transport, channel, frames, states, protocols, events }
}

describe("demo desktop", () => {
  it("connects like a paired desktop with a full session", async () => {
    const { transport, states, protocols } = demo()
    expect(states).toEqual(["live"])
    expect(protocols).toEqual([DEMO_PROTOCOL])
    const bootstrap = await transport.api.bootstrap()
    expect(bootstrap).toMatchObject({
      enabled: true,
      authenticated: true,
      authentication: "remote",
    })
    expect(bootstrap.session?.accessLevel).toBe("full")
    const page = await transport.api.listThreadsPage()
    expect(page.nextCursor).toBeNull()
    expect(page.threads.map((thread) => thread.title)).toContain(
      "Add dark mode to the settings screen"
    )
    expect(await transport.api.listProjects()).toHaveLength(2)
  })

  it("streams a reply, asks once to run the tests, and stores the answer", async () => {
    const { transport, events } = demo()
    const threadId = "demo-release-notes"
    const sent = await transport.api.sendMessage({
      threadId,
      userMessageId: "u1",
      message: "Draft the release notes",
      userMessageCreatedAt: "2026-09-24T10:00:00.000Z",
    })
    expect(sent.status).toBe("streaming")
    await vi.advanceTimersByTimeAsync(1_000)

    const approval = events()
      .map((event) => pendingRequestFromEvent(event))
      .find((request) => request !== null)
    expect(approval).toMatchObject({
      kind: "approval",
      title: "Run npm test",
      threadId,
    })
    expect(events().map((event) => event.type)).not.toContain("turn_completed")
    // The request is also visible to a reload, like on a real desktop.
    expect(
      (await transport.api.listActivities(threadId)).map(
        (activity) => activity.kind
      )
    ).toEqual(["approval.requested"])

    expect(
      await transport.api.respondApproval({
        threadId,
        requestId: approval!.id,
        decision: "approve",
      })
    ).toEqual({ status: "acknowledged", applied: "live" })
    await vi.runAllTimersAsync()
    const types = events().map((event) => event.type)
    expect(types[0]).toBe("turn_started")
    expect(types).toContain("content_delta")
    expect(types.at(-1)).toBe("turn_completed")
    expect(events().every((event) => event.turnId === sent.turnId)).toBe(true)

    const messages = await transport.api.listMessages(threadId)
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ])
    expect(messages[0]).toMatchObject({
      id: "u1",
      content: "Draft the release notes",
    })
    expect(messages[1]?.content).toContain("24 passed")
    expect(messages[1]?.toolCalls?.[0]).toMatchObject({
      name: "Bash",
      input: { command: "npm test" },
    })

    // The second message in the same chat needs no approval.
    const before = events().length
    await transport.api.sendMessage({
      threadId,
      userMessageId: "u2",
      message: "Thanks",
    })
    await vi.runAllTimersAsync()
    const second = events().slice(before)
    expect(
      second.some((event) => event.type === "tool_approval_requested")
    ).toBe(false)
    expect(second.at(-1)?.type).toBe("turn_completed")
  })

  it("stops a reply midway and keeps what was already written", async () => {
    const { transport, events } = demo()
    const threadId = "demo-flaky-login"
    const sent = await transport.api.sendMessage({
      threadId,
      userMessageId: "u1",
      message: "Explain the fix",
    })
    await vi.advanceTimersByTimeAsync(200)
    const approval = events()
      .map((event) => pendingRequestFromEvent(event))
      .find((request) => request !== null)
    await transport.api.respondApproval({
      threadId,
      requestId: approval!.id,
      decision: "deny",
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(
      await transport.api.interrupt({ providerKind: "demo", threadId })
    ).toEqual({ status: "interrupted" })
    await vi.runAllTimersAsync()
    expect(events().at(-1)).toMatchObject({
      type: "turn_interrupted",
      turnId: sent.turnId,
    })
    const messages = await transport.api.listMessages(threadId)
    expect(messages.at(-1)?.role).toBe("assistant")
    expect(messages.at(-1)?.toolCalls).toBeUndefined()
    // A new message is accepted again.
    await expect(
      transport.api.sendMessage({ threadId, message: "Again" })
    ).resolves.toMatchObject({
      status: "streaming",
    })
  })

  it("answers a message sent again under its id instead of running it twice", async () => {
    const { transport, events } = demo()
    const threadId = "demo-release-notes"
    const body = {
      threadId,
      userMessageId: "u1",
      message: "Draft the release notes",
    }
    const first = await transport.api.sendMessage(body)
    const again = await transport.api.sendMessage(body)
    expect(again).toEqual({
      status: "streaming",
      turnId: first.turnId,
      replayed: true,
    })
    await expect(
      transport.api.sendMessage({ ...body, message: "Something else" })
    ).rejects.toMatchObject({ status: 409, code: "dispatch_id_conflict" })
    await vi.runAllTimersAsync()
    const approval = events()
      .map((event) => pendingRequestFromEvent(event))
      .find((request) => request !== null)
    await transport.api.respondApproval({
      threadId,
      requestId: approval!.id,
      decision: "approve",
    })
    await vi.runAllTimersAsync()
    expect(
      events().filter((event) => event.type === "turn_started")
    ).toHaveLength(1)
    expect(await transport.api.sendMessage(body)).toMatchObject({
      status: "completed",
      replayed: true,
    })
    expect(
      (await transport.api.listMessages(threadId)).filter(
        (message) => message.id === "u1"
      )
    ).toHaveLength(1)
  })

  it("records what the agent does as activities and sends them live, as the desktop does", async () => {
    const { transport, frames, events } = demo()
    const threadId = "demo-release-notes"
    await transport.api.sendMessage({ threadId, message: "Draft the notes" })
    await vi.advanceTimersByTimeAsync(1_000)
    const approval = events()
      .map((event) => pendingRequestFromEvent(event))
      .find((request) => request !== null)
    await transport.api.respondApproval({
      threadId,
      requestId: approval!.id,
      decision: "approve",
    })
    await vi.runAllTimersAsync()

    const recorded = await transport.api.listActivities(threadId)
    expect(recorded.map((activity) => activity.kind)).toEqual([
      "approval.requested",
      "approval.resolved",
      "tool.started",
      "tool.completed",
    ])
    expect(recorded[2]).toMatchObject({
      tone: "tool",
      payload: { toolName: "Bash", input: { command: "npm test" } },
    })
    expect(recorded[0]?.payload).toMatchObject({ providerKind: "demo" })
    const live = frames.filter(
      (frame) => (frame as { channel?: string }).channel === "thread.activity"
    )
    expect(
      live.map((frame) => (frame as { data: { id: string } }).data.id)
    ).toEqual(recorded.map((activity) => activity.id))
  })

  it("renames a chat for every client, and deletes one", async () => {
    const { transport, frames } = demo()
    const renamed = await transport.api.renameThread(
      "demo-dark-mode",
      "  Dark mode  "
    )
    expect(renamed).toMatchObject({
      threadId: "demo-dark-mode",
      title: "Dark mode",
    })
    expect(frames).toContainEqual({ channel: "thread.metadata", data: renamed })
    expect((await transport.api.getThread("demo-dark-mode"))?.title).toBe(
      "Dark mode"
    )
    await expect(
      transport.api.renameThread("missing", "Name")
    ).rejects.toMatchObject({ status: 404, code: "thread_not_found" })

    await transport.api.deleteThread("demo-dark-mode")
    expect(await transport.api.getThread("demo-dark-mode")).toBeNull()
    expect(await transport.api.listMessages("demo-dark-mode")).toEqual([])
  })

  it("refuses a second message while a reply runs, as the desktop does", async () => {
    const { transport } = demo()
    const threadId = "demo-release-notes"
    await transport.api.sendMessage({ threadId, message: "First" })
    await expect(
      transport.api.sendMessage({ threadId, message: "Second" })
    ).rejects.toMatchObject({ status: 409, code: "turn_active" })
  })

  it("names a new chat after its first message", async () => {
    const { transport } = demo()
    const now = "2026-09-24T10:00:00.000Z"
    await transport.api.createThread({
      id: "new-chat",
      title: "New Chat",
      projectName: "weather-app",
      projectPath: "/Users/demo/code/weather-app",
      messages: [],
      createdAt: now,
      updatedAt: now,
    })
    await transport.api.sendMessage({
      threadId: "new-chat",
      message: "Show the humidity on the forecast screen",
    })
    expect((await transport.api.getThread("new-chat"))?.title).toBe(
      "Show the humidity on the forecast screen"
    )
    expect(await transport.api.getThread("missing")).toBeNull()
  })

  it("browses, searches and reads the demo projects' files", async () => {
    const { transport } = demo()
    const root = "/Users/demo/code/weather-app"
    const top = await transport.api.listDirectory(root)
    expect(top.parent).toBeNull()
    expect(top.entries.map((entry) => entry.name)).toEqual([
      "src",
      "package.json",
      "README.md",
    ])
    const src = await transport.api.listDirectory(`${root}/src`)
    expect(src.parent).toBe(root)
    expect(src.entries.map((entry) => entry.name)).toEqual([
      "screens",
      "App.tsx",
      "theme.ts",
    ])
    const found = await transport.api.searchFiles(root, "settings")
    expect(found.entries.map((entry) => entry.path)).toEqual([
      `${root}/src/screens/Settings.tsx`,
    ])
    const file = await transport.api.readFile(root, `${root}/src/theme.ts`)
    expect(file.content).toContain("export const dark")
    await expect(
      transport.api.readFile(root, `${root}/missing.ts`)
    ).rejects.toThrow("File not found")
  })
})
