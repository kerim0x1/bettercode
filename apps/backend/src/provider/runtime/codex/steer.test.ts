import { describe, expect, it } from "vitest"
import { classifyCodexSteerError } from "./steer"

describe("classifyCodexSteerError", () => {
  it("reads a turn that ended before the message arrived", () => {
    expect(
      classifyCodexSteerError("codex rpc error -32600: no active turn to steer")
    ).toMatchObject({ status: "not_running" })
    expect(
      classifyCodexSteerError(
        "codex rpc error -32600: expected active turn id `turn-1` but found `turn-2`"
      )
    ).toMatchObject({ status: "not_running" })
  })

  it("keeps review and compaction turns free of input", () => {
    expect(
      classifyCodexSteerError(
        "codex rpc error -32600: cannot steer a review turn"
      )
    ).toMatchObject({ status: "not_steerable" })
    expect(
      classifyCodexSteerError(
        "codex rpc error -32600: cannot steer a compact turn"
      )
    ).toMatchObject({ status: "not_steerable" })
  })

  it("recognises an app-server without turn/steer", () => {
    expect(
      classifyCodexSteerError("codex rpc error -32601: Method not found")
    ).toMatchObject({ status: "unsupported" })
    expect(
      classifyCodexSteerError(
        "codex rpc error -32600: Invalid request: unknown variant `turn/steer`, expected one of `turn/start`, `turn/interrupt`"
      )
    ).toMatchObject({ status: "unsupported" })
  })

  it("leaves other failures to the caller", () => {
    expect(
      classifyCodexSteerError("codex rpc timeout after 15000 ms: turn/steer")
    ).toBeNull()
    expect(
      classifyCodexSteerError("codex rpc error -32600: input must not be empty")
    ).toBeNull()
    expect(
      classifyCodexSteerError("codex rpc not alive for call turn/steer")
    ).toBeNull()
  })
})
