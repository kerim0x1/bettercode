import { describe, expect, it } from "vitest"
import { buildCursorAcpSpawnInput } from "./CursorAcpSupport"

describe("buildCursorAcpSpawnInput", () => {
  it("refuses a missing or relative Cursor binary", () => {
    expect(() => buildCursorAcpSpawnInput(undefined, "/tmp/project")).toThrow(
      /absolute/
    )
    expect(() =>
      buildCursorAcpSpawnInput({ binaryPath: "cursor-agent" }, "/tmp/project")
    ).toThrow(/absolute/)
  })

  it("includes the configured api endpoint and binary path", () => {
    expect(
      buildCursorAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/agent",
          apiEndpoint: "http://localhost:3000",
        },
        "/tmp/project"
      )
    ).toEqual({
      command: "/usr/local/bin/agent",
      args: ["-e", "http://localhost:3000", "acp"],
      cwd: "/tmp/project",
    })
  })
})
