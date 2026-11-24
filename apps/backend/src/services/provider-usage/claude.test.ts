import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { measureStatsScale, scanClaudeTranscript } from "./claude"
import { localDay } from "./shared"

const STAMP = "2026-11-16T10:00:00.000Z"
const MODEL = "claude-opus-5-5"

/** One transcript row of a reply, as Claude Code writes per content block. */
function reply(
  id: string | null,
  output: number,
  extra: { thinking?: number; requestId?: string } = {}
): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "session-1",
    requestId: extra.requestId ?? `req-${id}`,
    timestamp: STAMP,
    message: {
      ...(id ? { id } : {}),
      model: MODEL,
      content: [{ type: "text", text: "…" }],
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
        ...(extra.thinking !== undefined
          ? { output_tokens_details: { thinking_tokens: extra.thinking } }
          : {}),
      },
    },
  })
}

const toolResult = JSON.stringify({
  type: "user",
  sessionId: "session-1",
  timestamp: STAMP,
  message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
})

describe("scanClaudeTranscript", () => {
  let dir = ""
  let file = ""
  const day = localDay(Date.parse(STAMP))

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-claude-"))
    file = path.join(dir, "chat.jsonl")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("counts a reply written as several rows once, with its final output", async () => {
    fs.writeFileSync(
      file,
      [
        reply("msg-1", 5, { thinking: 2 }),
        reply("msg-1", 40, { thinking: 9 }),
        reply("msg-1", 40, { thinking: 9 }),
        toolResult,
        reply("msg-2", 7),
      ].join("\n") + "\n"
    )
    const scan = await scanClaudeTranscript(file, null)
    const aggregate = scan!.value
    expect(aggregate.messages).toBe(2)
    // [tokens, messages, input, output, reasoning, cacheRead, cacheWrite]
    expect(aggregate.days[day]).toEqual([
      10 + 40 + 100 + (10 + 7 + 100),
      2,
      20,
      47,
      9,
      200,
      0,
    ])
    expect(aggregate.dayModels[day]?.[MODEL]).toEqual([20, 47, 200, 0, 0])
    expect(aggregate.sessions["session-1"]?.[2]).toBe(2)
    // Every row, as Claude's own stats cache counts them.
    expect(aggregate.rowModels?.[MODEL]).toEqual([40, 92, 400, 0])
    expect(aggregate.rowDays?.[day]).toBe(115 + 150 + 150 + 117)
  })

  it("recognises a reply's further rows after resuming", async () => {
    fs.writeFileSync(file, `${reply("msg-1", 5)}\n`)
    const first = await scanClaudeTranscript(file, null)
    fs.appendFileSync(file, `${reply("msg-1", 30)}\n${reply("msg-2", 3)}\n`)
    const resumed = await scanClaudeTranscript(file, {
      value: structuredClone(first!.value),
      offset: first!.offset,
    })
    expect(resumed!.value.messages).toBe(2)
    expect(resumed!.value.days[day]?.[3]).toBe(33)
    expect(resumed!.value.dayModels[day]?.[MODEL]?.[1]).toBe(33)
  })

  it("keeps rows of different requests and rows without an id apart", async () => {
    fs.writeFileSync(
      file,
      [
        reply("msg-1", 5, { requestId: "req-a" }),
        reply("msg-1", 5, { requestId: "req-b" }),
        reply(null, 4),
        reply(null, 4),
      ].join("\n") + "\n"
    )
    const scan = await scanClaudeTranscript(file, null)
    expect(scan!.value.messages).toBe(4)
    expect(scan!.value.days[day]?.[3]).toBe(18)
  })
})

describe("measureStatsScale", () => {
  let dir = ""
  const day = localDay(Date.parse(STAMP))

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-scale-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // Rows: input 30, output 17, cache reads 300 (347 in all).
  // Replies: input 20, output 12, cache reads 200 (232 in all).
  async function aggregates() {
    const file = path.join(dir, "chat.jsonl")
    fs.writeFileSync(
      file,
      [reply("msg-1", 5), reply("msg-1", 5), reply("msg-2", 7)].join("\n") +
        "\n"
    )
    return [(await scanClaudeTranscript(file, null))!.value]
  }

  const statsWith = (dayTokens: number) => ({
    lastComputedDate: "9999-12-31",
    dailyModelTokens: [{ date: day, tokensByModel: { [MODEL]: dayTokens } }],
  })

  it("scales a stats cache that counts every row down to the replies", async () => {
    const scale = measureStatsScale(await aggregates(), statsWith(347))
    expect(scale).not.toBeNull()
    expect(scale!.forModel(MODEL)).toEqual({
      input: 20 / 30,
      output: 12 / 17,
      cacheRead: 200 / 300,
      // No cache writes measured: left as they are.
      cacheWrite: 1,
    })
    expect(scale!.forDayTotal(MODEL)).toBeCloseTo(232 / 347)
    expect(scale!.rowsPerReply).toBeCloseTo(347 / 232)
  })

  it("leaves a stats cache that counts replies as it is", async () => {
    expect(measureStatsScale(await aggregates(), statsWith(232))).toBeNull()
  })

  it("does not judge the stats cache's last, unfinished day", async () => {
    const stats = { ...statsWith(347), lastComputedDate: day }
    expect(measureStatsScale(await aggregates(), stats)).toBeNull()
  })
})
