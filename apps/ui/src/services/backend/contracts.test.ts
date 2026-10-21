import { afterEach, describe, expect, it, vi } from "vitest"
import "@betterc0de/schema/http-contracts"
import { invokeContract } from "./contracts"
import { loadMessage, messagePageQuery, searchThreadMessages } from "./coreApi"
import { invoke } from "./runtime"

vi.mock("./runtime", () => ({ invoke: vi.fn() }))
afterEach(() => vi.clearAllMocks())

describe("renderer HTTP contracts", () => {
  it("validates actual transport responses before exposing them", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: "approved" })
    await expect(
      invokeContract("chatApproval", {
        body: {
          threadId: "t",
          providerKind: "codex",
          requestId: "r",
          decision: "approve",
        },
      })
    ).rejects.toThrow("Invalid backend response")
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it("does not send legacy GET args as a request body", async () => {
    vi.mocked(invoke).mockResolvedValue([])
    await expect(
      invokeContract("listActivities", { id: "a/b", args: { threadId: "a/b" } })
    ).resolves.toEqual([])
    expect(invoke).toHaveBeenCalledWith(
      "/threads/a%2Fb/activities",
      expect.objectContaining({ method: "GET", body: undefined })
    )
  })
  it("fills path parameters besides the thread id", async () => {
    const message = {
      id: "m/1",
      role: "assistant",
      content: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    vi.mocked(invoke).mockResolvedValue(message)
    await expect(loadMessage("t 1", "m/1")).resolves.toEqual(message)
    expect(invoke).toHaveBeenCalledWith(
      "/threads/t%201/messages/m%2F1",
      expect.objectContaining({ method: "GET" })
    )
    await expect(invokeContract("getMessage", { id: "t" })).rejects.toThrow(
      "Missing path parameter messageId"
    )
  })
  it("searches the older messages of a chat through its contract", async () => {
    const answer = {
      hits: [
        {
          messageId: "m-1",
          role: "user",
          sequence: 3,
          createdAt: "2026-01-01T00:00:00.000Z",
          matchCount: 2,
          snippet: "a&b c and a&b c",
        },
      ],
      totalMatches: 2,
      truncated: false,
    }
    vi.mocked(invoke).mockResolvedValue(answer)
    await expect(
      searchThreadMessages("t 1", {
        query: "a&b c",
        caseSensitive: true,
        beforeSequence: 40,
      })
    ).resolves.toEqual(answer)
    expect(invoke).toHaveBeenCalledWith(
      "/threads/t%201/messages/search?q=a%26b+c&caseSensitive=1&beforeSequence=40",
      expect.objectContaining({ method: "GET", body: undefined })
    )
  })
  it("asks for light transcript pages only when told to", () => {
    expect(messagePageQuery({ limit: 100, light: true })).toBe(
      "?limit=100&light=1"
    )
    expect(messagePageQuery({ limit: 100, beforeSequence: 7 })).toBe(
      "?limit=100&beforeSequence=7"
    )
    expect(messagePageQuery({ light: false })).toBe("")
    expect(messagePageQuery(undefined)).toBe("")
  })
})
