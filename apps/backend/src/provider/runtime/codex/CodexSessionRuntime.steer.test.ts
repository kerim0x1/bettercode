import { describe, expect, it, vi } from "vitest"
import { CodexSessionRuntime } from "./CodexSessionRuntime"

/** A runtime whose app-server answers through `answer`, without a process. */
function runtimeWith(
  answer: (method: string, params: unknown) => Promise<unknown>
) {
  const runtime = new CodexSessionRuntime({ binaryPath: "codex" })
  const calls: Array<{ method: string; params: unknown }> = []
  Object.assign(runtime as unknown as Record<string, unknown>, {
    rpc: {
      call: vi.fn((method: string, params: unknown) => {
        calls.push({ method, params })
        return answer(method, params)
      }),
    },
    initialized: true,
    providerThreadId: "provider-thread-1",
  })
  return { runtime, calls }
}

describe("CodexSessionRuntime.steerTurn", () => {
  it("adds the input to the running turn it names", async () => {
    const { runtime, calls } = runtimeWith(async (method) =>
      method === "turn/start"
        ? { turn: { id: "turn-1" } }
        : { turnId: "turn-1" }
    )
    await runtime.sendTurn({ message: "Refactor the parser" })

    await expect(
      runtime.steerTurn({
        message: "Keep the public API",
        images: [{ url: "data:image/png;base64,aGVsbG8=" }],
      })
    ).resolves.toEqual({ status: "steered", turnId: "turn-1" })
    expect(calls[1]).toEqual({
      method: "turn/steer",
      params: {
        threadId: "provider-thread-1",
        input: [
          { type: "text", text: "Keep the public API" },
          { type: "image", url: "data:image/png;base64,aGVsbG8=" },
        ],
        expectedTurnId: "turn-1",
      },
    })
  })

  it("waits for a turn that is still starting", async () => {
    let answerTurnStart: (value: unknown) => void = () => undefined
    const { runtime, calls } = runtimeWith((method) =>
      method === "turn/start"
        ? new Promise((resolve) => {
            answerTurnStart = resolve
          })
        : Promise.resolve({ turnId: "turn-2" })
    )
    const sending = runtime.sendTurn({ message: "Start the task" })
    const steering = runtime.steerTurn({ message: "Change course" })

    answerTurnStart({ turn: { id: "turn-2" } })
    await sending

    await expect(steering).resolves.toEqual({
      status: "steered",
      turnId: "turn-2",
    })
    expect(calls.map((call) => call.method)).toEqual([
      "turn/start",
      "turn/steer",
    ])
  })

  it("reports no running turn without asking the app-server", async () => {
    const { runtime, calls } = runtimeWith(async () => ({}))

    await expect(
      runtime.steerTurn({ message: "Anyone there?" })
    ).resolves.toMatchObject({ status: "not_running" })
    expect(calls).toEqual([])
  })

  it("reads an app-server without turn/steer as unsupported and throws other errors", async () => {
    let failure = new Error("codex rpc error -32601: Method not found")
    const { runtime } = runtimeWith(async (method) => {
      if (method === "turn/start") return { turn: { id: "turn-3" } }
      throw failure
    })
    await runtime.sendTurn({ message: "Start" })

    await expect(
      runtime.steerTurn({ message: "Steer" })
    ).resolves.toMatchObject({ status: "unsupported" })

    failure = new Error("codex rpc timeout after 15000 ms: turn/steer")
    await expect(runtime.steerTurn({ message: "Steer" })).rejects.toThrow(
      "timeout"
    )
  })
})
