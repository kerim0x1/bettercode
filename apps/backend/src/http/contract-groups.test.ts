import { httpContracts } from "@betterc0de/schema/http-contracts"
import { describe, expect, it } from "vitest"

// The route groups that declare their contracts in modules of their own
// (provider-, shell-, chat-, thread- and runtime-contracts.ts). The backend
// sends what these schemas return, so they must keep every field it writes
// and accept every value it may legitimately send.

const snapshot = {
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  enabled: true,
  configured: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-10-07T00:00:00.000Z",
  availability: "available",
  models: [{ slug: "gpt-5", name: "GPT-5", capabilities: null }],
  retirementFailure: "still running",
}

describe("provider contracts", () => {
  it("keep a provider instance's own fields and check the ones clients branch on", () => {
    const [parsed] = httpContracts.providerInstances.response.parse([snapshot])
    expect(parsed).toEqual(snapshot)
    expect(
      httpContracts.providerInstances.response.safeParse([
        { ...snapshot, status: "sleeping" },
      ]).success
    ).toBe(false)
  })

  it("lists catalog entries whatever sign-in methods they offer", () => {
    const entry = {
      id: "openai",
      name: "OpenAI",
      defaultModels: [],
      authMethods: [
        { type: "api-key", label: "API key", envVars: ["OPENAI_API_KEY"] },
        { type: "oauth", label: "ChatGPT", handler: "chatgpt" },
        {
          type: "cli",
          label: "Codex CLI",
          command: "codex",
          versionArgs: ["--version"],
        },
      ],
      enabledByDefault: true,
    }
    expect(httpContracts.providerCatalog.response.parse([entry])).toEqual([
      entry,
    ])
  })

  it("answers a refused key check in the same shape", () => {
    expect(
      httpContracts.providerValidateKey.response.parse({
        ok: false,
        valid: false,
        error: "Unknown provider kind: x",
      })
    ).toMatchObject({ ok: false })
  })
})

describe("shell contracts", () => {
  it("read a terminal whose process tree could not be ended", () => {
    const terminal = {
      sessionId: "pty-1",
      pid: 42,
      cwd: "/repo",
      shell: "bash",
      command: "bash",
      args: [],
      status: "cleanup_failed",
      events: [
        { seq: 1, type: "exit", exitCode: null, signal: "SIGKILL", at: 1 },
      ],
      nextCursor: 2,
      lastSeq: 1,
    }
    expect(httpContracts.terminalRead.response.parse(terminal)).toEqual(
      terminal
    )
    const { nextCursor: _cursor, ...withoutCursor } = terminal
    expect(
      httpContracts.terminalRead.response.safeParse(withoutCursor).success
    ).toBe(false)
  })

  it("never needs the archive path a run spools to", () => {
    const run = {
      success: true,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      combined: "ok",
      sessionId: "run-1",
      aborted: false,
      timedOut: false,
      outputArchiveId: "a".repeat(32),
      outputDownloadUrl: `/api/v1/shell/output/${"a".repeat(32)}`,
    }
    expect(httpContracts.shellRun.response.parse(run)).toEqual(run)
  })
})

describe("chat and permission contracts", () => {
  it("accept both answers of a rule deletion and refuse an unknown status", () => {
    const response = httpContracts.permissionClaudeRuleDelete.response
    expect(response.parse({ status: "acknowledged" })).toEqual({
      status: "acknowledged",
    })
    expect(
      response.parse({ status: "failed", error: "Rule not found" })
    ).toEqual({ status: "failed", error: "Rule not found" })
    expect(response.safeParse({ status: "deleted" }).success).toBe(false)
  })

  it("lists session rules with every behavior the provider records", () => {
    expect(
      httpContracts.permissionSessionRulesList.response.parse({
        rules: [{ threadId: "t", behavior: "ask", toolName: "Bash" }],
      }).rules[0]?.behavior
    ).toBe("ask")
  })
})

describe("thread contracts", () => {
  it("describe both answers of GET /threads/:id/diffs", () => {
    expect(httpContracts.threadDiffs.path).toBe(
      httpContracts.threadCheckpointSummary.path
    )
    expect(
      httpContracts.threadCheckpointSummary.response.parse({
        threadId: "thread-1",
        currentTurnCount: 3,
      })
    ).toEqual({ threadId: "thread-1", currentTurnCount: 3 })
    expect(
      httpContracts.threadDiffs.response.parse({
        turnDiffs: [],
        checkpointDiffs: [],
        nextBeforeTurnIndex: null,
        nextBeforeCheckpointId: null,
      })
    ).toMatchObject({ turnDiffs: [], checkpointDiffs: [] })
  })

  it("keep any JSON value a tool returned as its full output", () => {
    const output = {
      activityId: "a",
      output: { rows: [1, 2] },
      truncated: false,
      bytes: 14,
    }
    expect(httpContracts.threadActivityOutput.response.parse(output)).toEqual(
      output
    )
  })
})

describe("runtime contracts", () => {
  it("answer an unhealthy database in the same shape", () => {
    expect(
      httpContracts.runtimeHealth.response.parse({
        status: "error",
        db: "error",
      })
    ).toEqual({ status: "error", db: "error" })
    expect(httpContracts.wsPort.response.parse(3773)).toBe(3773)
  })
})
