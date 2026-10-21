import { describe, expect, it, vi } from "vitest"
import type { AcpExtensionContext } from "../acp/AcpAdapterBase"
import type { AcpRuntime } from "../acp/AcpRuntimeBase"
import type { ProviderRuntimeEvent, TurnId } from "../contracts"
import { registerCursorExtensions } from "./CursorAcpExtensions"

function fixture() {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>()
  const events: ProviderRuntimeEvent[] = []
  let active = true
  let turnId = "initial-turn" as TurnId
  const ctx: AcpExtensionContext = {
    threadKey: "thread",
    pendingUserInputs: new Map(),
    pendingRequestTimeoutMs: 60_000,
    isActive: () => active,
    activeTurnId: () => turnId,
    eventBase: () => ({
      threadId: "thread",
      provider: "cursor",
      providerKind: "cursor",
      providerInstanceId: "cursor",
      eventId: "event",
      at: Date.now(),
    }),
    emitEvent: (event) => events.push(event),
    logNative: vi.fn(),
    emitPlanUpdate: vi.fn(),
  }
  registerCursorExtensions(
    {
      onExtRequest: (
        method: string,
        handler: (params: unknown) => Promise<unknown>
      ) => handlers.set(method, handler),
      onExtNotification: vi.fn(),
    } as unknown as AcpRuntime,
    ctx
  )
  return {
    ctx,
    events,
    ask: () =>
      handlers.get("cursor/ask_question")!({
        questions: [{ id: "scope", prompt: "Scope?" }],
      }),
    stop: () => {
      active = false
    },
    nextTurn: () => {
      turnId = "later-turn" as TurnId
    },
  }
}

describe("Cursor question lifecycle", () => {
  it("registers the waiter before an immediate response and retains the initiating turn", async () => {
    const f = fixture()
    f.ctx.emitEvent = (event) => {
      f.events.push(event)
      if (event.type === "user-input.requested") {
        const pending = f.ctx.pendingUserInputs.get(event.requestId!)
        expect(pending).toBeDefined()
        f.nextTurn()
        pending!.resolve({ scope: "workspace" })
      }
    }
    await expect(f.ask()).resolves.toEqual({ answers: { scope: "workspace" } })
    expect(f.events.at(-1)).toMatchObject({
      type: "user-input.resolved",
      turnId: "initial-turn",
    })
    expect(f.ctx.pendingUserInputs.size).toBe(0)
  })

  it("does not publish a resolution after the session stops", async () => {
    const f = fixture()
    const answer = f.ask()
    f.stop()
    for (const pending of f.ctx.pendingUserInputs.values()) pending.resolve({})
    await expect(answer).resolves.toEqual({ answers: {} })
    expect(f.events.map((event) => event.type)).toEqual([
      "user-input.requested",
    ])
  })

  it("clears a waiter if publishing the request fails", async () => {
    const f = fixture()
    f.ctx.emitEvent = () => {
      throw new Error("subscriber failed")
    }
    await expect(f.ask()).rejects.toThrow("subscriber failed")
    expect(f.ctx.pendingUserInputs.size).toBe(0)
  })
})
