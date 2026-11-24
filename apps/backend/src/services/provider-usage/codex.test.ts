import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { findRollout, rateLimitsOf, scanRolloutUsage } from "./codex"

const canZstd = typeof zlib.zstdCompressSync === "function"
const FUTURE = Math.floor(Date.parse("2099-01-01T00:00:00Z") / 1000)

function tokenCount(
  at: string,
  total: Record<string, number> | null,
  limits: Record<string, unknown> | null
): string {
  return JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: total ? { total_token_usage: total } : null,
      ...(limits ? { rate_limits: limits } : {}),
    },
  })
}

const rollout = [
  JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }),
  tokenCount(
    "2026-11-01T10:00:00.000Z",
    {
      input_tokens: 100,
      cached_input_tokens: 60,
      output_tokens: 10,
      reasoning_output_tokens: 4,
      total_tokens: 110,
    },
    { primary: { used_percent: 10, window_minutes: 300, resets_at: FUTURE } }
  ),
  JSON.stringify({
    type: "response_item",
    payload: { text: "x".repeat(5000) },
  }),
  tokenCount(
    "2026-11-01T10:04:00.000Z",
    {
      input_tokens: 1000,
      cached_input_tokens: 700,
      output_tokens: 50,
      reasoning_output_tokens: 20,
      total_tokens: 1050,
    },
    null
  ),
  // A rate-limit update without a usage total, as Codex writes them.
  tokenCount("2026-11-01T10:05:00.000Z", null, {
    primary: { used_percent: 30, window_minutes: 300, resets_at: FUTURE },
  }),
].join("\n")

describe("Codex rollouts", () => {
  let home = ""

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-codex-"))
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function place(relative: string, body: string | Buffer): string {
    const file = path.join(home, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
    return file
  }

  const expected = {
    input: 300,
    cacheRead: 700,
    output: 50,
    reasoning: 20,
    total: 1050,
    rateLimitsAt: Date.parse("2026-11-01T10:05:00.000Z"),
  }

  it("reads the token split and the last limits from a live rollout", async () => {
    const file = place("sessions/2026/11/01/rollout-a.jsonl", `${rollout}\n`)
    const usage = await scanRolloutUsage(file)
    expect(usage).toMatchObject({ ...expected, file })
    expect(usage?.rateLimits).toMatchObject({ primary: { used_percent: 30 } })
  })

  it.skipIf(!canZstd)(
    "reads the same from a rollout Codex compressed",
    async () => {
      const file = place(
        "sessions/2026/11/01/rollout-a.jsonl.zst",
        zlib.zstdCompressSync(Buffer.from(`${rollout}\n`))
      )
      const usage = await scanRolloutUsage(file)
      expect(usage).toMatchObject({ ...expected, file })
      expect(usage?.rateLimits).toMatchObject({
        primary: { used_percent: 30 },
      })
    }
  )

  it.skipIf(!canZstd)(
    "reads a damaged compressed rollout as one without a tally",
    async () => {
      const file = place(
        "sessions/2026/11/01/rollout-a.jsonl.zst",
        Buffer.from("not zstd at all")
      )
      expect(await scanRolloutUsage(file)).toMatchObject({
        total: 0,
        rateLimits: null,
      })
    }
  )

  it("finds a rollout where Codex compressed or archived it", async () => {
    const live = place("sessions/2026/11/01/rollout-live.jsonl", "{}\n")
    const compressed = place(
      "sessions/2026/11/01/rollout-done.jsonl.zst",
      "zst"
    )
    const archived = place("archived_sessions/rollout-old.jsonl.zst", "zst")
    const recorded = (name: string) =>
      path.join(home, "sessions", "2026", "11", "01", name)

    expect(await findRollout(home, live)).toBe(live)
    expect(await findRollout(home, `\\\\?\\${live}`)).toBe(live)
    expect(await findRollout(home, recorded("rollout-done.jsonl"))).toBe(
      compressed
    )
    expect(await findRollout(home, recorded("rollout-old.jsonl"))).toBe(
      archived
    )
    expect(await findRollout(home, recorded("rollout-gone.jsonl"))).toBeNull()
  })
})

describe("rateLimitsOf", () => {
  it("leaves out a window that reset since Codex reported it", () => {
    const now = Date.parse("2026-11-17T00:00:00.000Z")
    const { limits, plan } = rateLimitsOf(
      {
        plan_type: "pro",
        primary: {
          used_percent: 40,
          window_minutes: 10_080,
          resets_at: Math.floor(Date.parse("2026-11-05T19:12:21Z") / 1000),
        },
        secondary: {
          used_percent: 5,
          window_minutes: 300,
          resets_at: Math.floor(Date.parse("2026-11-17T03:00:00Z") / 1000),
        },
      },
      now
    )
    expect(plan).toBe("pro")
    expect(limits).toEqual([
      {
        id: "secondary",
        label: "5-hour limit",
        usedPercent: 5,
        resetsAt: "2026-11-17T03:00:00.000Z",
        resetLabel: null,
      },
    ])
  })
})
