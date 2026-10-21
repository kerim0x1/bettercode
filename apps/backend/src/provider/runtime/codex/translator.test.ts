import { describe, expect, it } from "vitest"
import {
  normalizeCodexEffort,
  effortForModel,
  normalizeCodexServiceTier,
  serviceTierForModel,
} from "./CodexAdapter"
import type { CodexNativeEvent } from "./CodexSessionRuntime"
import { translateCodexEvent } from "./translator"

function translate(native: CodexNativeEvent) {
  return translateCodexEvent("thread-1", native)
}

describe("translateCodexEvent", () => {
  it("finds a tool ID after an empty nested item branch", () => {
    expect(
      translate({
        kind: "notification",
        method: "item/commandExecution/outputDelta",
        params: { item: {}, call: { id: "actual-call" }, delta: "output" },
      })[0]
    ).toMatchObject({ type: "tool.delta", toolId: "actual-call" })
  })

  it("bounds tool ID traversal for deeply nested JSON notifications", () => {
    const nested = JSON.parse(
      '{"item":'.repeat(12000) + "{}" + "}".repeat(12000)
    )
    const event = translate({
      kind: "notification",
      method: "item/commandExecution/outputDelta",
      params: { item: nested, delta: "output" },
    })[0]
    expect(event).toMatchObject({
      type: "tool.delta",
      toolId: expect.any(String),
    })
  })

  it("normalizes malformed item identity fields without dropping completion", () => {
    expect(
      translate({
        kind: "notification",
        method: "item/completed",
        params: { item: { id: 42, type: { invalid: true } } },
      })[0]
    ).toMatchObject({ type: "item.completed", itemId: "", kind: "unknown" })
  })

  it("reads tool status without coercing JSON objects", () => {
    expect(
      translate({
        kind: "notification",
        method: "item/completed",
        params: {
          item: {
            id: "tool-1",
            type: "commandExecution",
            status: { toString: null },
          },
        },
      })[0]
    ).toMatchObject({ type: "tool.completed", toolId: "tool-1" })
  })

  it("does not expose Codex stderr diagnostics in public events", () => {
    const privateDiagnostic =
      "failed to connect to websocket at C:\\private\\codex.json token sk-sensitive"
    const fatal = translate({
      kind: "stderr",
      stderr: {
        raw: privateDiagnostic,
        level: "error",
        message: privateDiagnostic,
        fatal: true,
        benign: false,
      },
    })
    const warning = translate({
      kind: "stderr",
      stderr: {
        raw: privateDiagnostic,
        level: "warn",
        message: privateDiagnostic,
        fatal: false,
        benign: false,
      },
    })
    const spawnFailure = translate({
      kind: "spawn-error",
      error: privateDiagnostic,
    })

    expect(fatal).toEqual([
      expect.objectContaining({
        type: "runtime.error",
        message: "Codex provider transport failed.",
        class: "transport_error",
      }),
    ])
    expect(warning).toEqual([
      expect.objectContaining({
        type: "runtime.warning",
        message: "Codex provider reported a process warning.",
      }),
    ])
    expect(spawnFailure).toEqual([
      expect.objectContaining({
        type: "runtime.error",
        message: "Codex provider process could not be started.",
      }),
    ])
    expect(
      JSON.stringify([...fatal, ...warning, ...spawnFailure])
    ).not.toContain(privateDiagnostic)
  })

  it("reads reasoning deltas nested under params.event.delta", () => {
    const events = translate({
      kind: "notification",
      method: "item/reasoning/textDelta",
      params: {
        event: {
          delta: { type: "thinking_delta", thinking: "step one" },
        },
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "reasoning.delta",
      streamKind: "reasoning_text",
      delta: "step one",
    })
  })

  it("handles unknown delta methods when the item is reasoning", () => {
    const events = translate({
      kind: "notification",
      method: "rawResponseItem/delta",
      params: {
        item: { type: "reasoning" },
        summaryIndex: 0,
        event: {
          delta: { text: "summary token" },
        },
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "reasoning.delta",
      streamKind: "reasoning_summary_text",
      delta: "summary token",
    })
  })

  it("emits canonical tool events for Codex command items", () => {
    const started = translate({
      kind: "notification",
      method: "item/started",
      params: {
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          cwd: "/repo",
        },
      },
    })
    const completed = translate({
      kind: "notification",
      method: "item/completed",
      params: {
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          output: "ok",
        },
      },
    })

    expect(started[0]).toMatchObject({
      type: "tool.started",
      providerKind: "codex",
      toolId: "cmd-1",
      toolName: "shell",
      input: { command: "npm test", cwd: "/repo" },
    })
    expect(completed[0]).toMatchObject({
      type: "tool.completed",
      providerKind: "codex",
      toolId: "cmd-1",
      output: "ok",
    })
  })

  it("recognizes camelCase Codex file change lifecycle items as tools", () => {
    const started = translate({
      kind: "notification",
      method: "item/started",
      params: {
        item: {
          id: "file-1",
          type: "fileChange",
          path: "src/app.ts",
        },
      },
    })
    const completed = translate({
      kind: "notification",
      method: "item/completed",
      params: {
        item: {
          id: "file-1",
          type: "fileChange",
          path: "src/app.ts",
          output: "updated",
        },
      },
    })

    expect(started[0]).toMatchObject({
      type: "tool.started",
      toolId: "file-1",
      toolName: "file_edit",
      input: { path: "src/app.ts" },
    })
    expect(completed[0]).toMatchObject({
      type: "tool.completed",
      toolId: "file-1",
      toolName: "file_edit",
      output: "updated",
    })
  })

  it("emits tool delta events without polluting assistant text", () => {
    const events = translate({
      kind: "notification",
      method: "item/commandExecution/outputDelta",
      params: {
        id: "cmd-1",
        delta: "line\n",
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool.delta",
      providerKind: "codex",
      toolId: "cmd-1",
      toolName: "shell",
      streamKind: "command_output",
      delta: "line\n",
    })
  })

  it("emits runtime auxiliary notifications", () => {
    expect(
      translate({
        kind: "notification",
        method: "thread/started",
        params: {
          thread: { id: "provider-thread-1" },
        },
      })[0]
    ).toMatchObject({
      type: "thread.started",
      payload: {
        providerThreadId: "provider-thread-1",
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "item/mcpToolCall/progress",
        params: {
          id: "tool-1",
          name: "grep",
          message: "Searching files",
          elapsedSeconds: 2,
        },
      })[0]
    ).toMatchObject({
      type: "tool.progress",
      payload: {
        toolUseId: "tool-1",
        toolName: "grep",
        summary: "Searching files",
        elapsedSeconds: 2,
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "model/rerouted",
        params: {
          fromModel: "gpt-5.4",
          toModel: "gpt-5.5",
          reason: "capacity",
        },
      })[0]
    ).toMatchObject({
      type: "model.rerouted",
      payload: {
        fromModel: "gpt-5.4",
        toModel: "gpt-5.5",
        reason: "capacity",
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "configWarning",
        params: {
          summary: "Invalid config key",
          details: "Ignored deprecated option",
          path: ".codex/config.toml",
        },
      })[0]
    ).toMatchObject({
      type: "config.warning",
      payload: {
        summary: "Invalid config key",
        details: "Ignored deprecated option",
        path: ".codex/config.toml",
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "account/updated",
        params: {
          account: { email: "dev@example.com" },
        },
      })[0]
    ).toMatchObject({
      type: "account.updated",
      payload: {
        account: { email: "dev@example.com" },
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "account/rateLimits/updated",
        params: {
          rateLimits: { primary: { used: 10 } },
        },
      })[0]
    ).toMatchObject({
      type: "account.rate-limits.updated",
      payload: {
        rateLimits: { primary: { used: 10 } },
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "mcpServer/oauthLogin/completed",
        params: {
          success: true,
          name: "github",
        },
      })[0]
    ).toMatchObject({
      type: "mcp.oauth.completed",
      payload: {
        success: true,
        name: "github",
      },
    })
  })

  it("maps Codex skills changes to provider metadata refresh events", () => {
    expect(
      translate({
        kind: "notification",
        method: "skills/changed",
        params: { roots: ["/repo/.codex/skills"] },
      })[0]
    ).toMatchObject({
      type: "provider.metadata.changed",
      payload: {
        metadataKind: "skills",
        summary: "Skills changed",
        details: "Codex reported updated skill metadata.",
        range: { roots: ["/repo/.codex/skills"] },
      },
    })
  })

  it("emits request resolution notifications for approvals and user input", () => {
    expect(
      translate({
        kind: "notification",
        method: "item/requestApproval/decision",
        requestId: "approval-1",
        params: {
          requestId: "approval-1",
          decision: "deny",
        },
      })[0]
    ).toMatchObject({
      type: "request.resolved",
      requestId: "approval-1",
      decision: "deny",
    })

    expect(
      translate({
        kind: "notification",
        method: "serverRequest/resolved",
        params: {
          requestId: 42,
        },
      })[0]
    ).toMatchObject({
      type: "request.resolved",
      requestId: "42",
      decision: "approve",
    })

    expect(
      translate({
        kind: "notification",
        method: "item/tool/requestUserInput/answered",
        requestId: "question-1",
        params: {
          answers: { scope: { answers: ["Backend"] } },
        },
      })[0]
    ).toMatchObject({
      type: "request.resolved",
      requestId: "question-1",
      decision: "answer",
    })
  })

  it("maps Codex realtime notifications", () => {
    expect(
      translate({
        kind: "notification",
        method: "thread/realtime/started",
        params: {
          realtimeSessionId: "realtime-session-1",
        },
      })[0]
    ).toMatchObject({
      type: "thread.realtime.started",
      payload: {
        realtimeSessionId: "realtime-session-1",
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "thread/realtime/itemAdded",
        params: {
          item: { id: "audio-item-1", type: "input_audio" },
        },
      })[0]
    ).toMatchObject({
      type: "thread.realtime.item-added",
      payload: {
        item: { id: "audio-item-1", type: "input_audio" },
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "thread/realtime/outputAudio/delta",
        params: {
          audio: "base64-audio-delta",
        },
      })[0]
    ).toMatchObject({
      type: "thread.realtime.audio.delta",
      payload: {
        audio: "base64-audio-delta",
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "thread/realtime/transcript/delta",
        params: {
          delta: "hello",
        },
      })[0]
    ).toMatchObject({
      type: "content.delta",
      streamKind: "assistant_text",
      delta: "hello",
    })

    expect(
      translate({
        kind: "notification",
        method: "thread/realtime/error",
        params: {
          message: "Realtime failed",
        },
      })[0]
    ).toMatchObject({
      type: "thread.realtime.error",
      payload: {
        message: "Realtime failed",
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "thread/realtime/closed",
        params: {
          reason: "client_closed",
        },
      })[0]
    ).toMatchObject({
      type: "thread.realtime.closed",
      payload: {
        reason: "client_closed",
      },
    })
  })

  it("uses Codex dynamic tool names and content items in tool lifecycle events", () => {
    expect(
      translate({
        kind: "notification",
        method: "item/started",
        params: {
          item: {
            id: "dyn-1",
            type: "dynamicToolCall",
            tool: "browser_open",
            arguments: { url: "http://localhost:5173" },
            status: "inProgress",
          },
        },
      })[0]
    ).toMatchObject({
      type: "tool.started",
      toolId: "dyn-1",
      toolName: "browser_open",
      input: { url: "http://localhost:5173" },
    })

    expect(
      translate({
        kind: "notification",
        method: "item/completed",
        params: {
          item: {
            id: "dyn-1",
            type: "dynamicToolCall",
            tool: "browser_open",
            contentItems: [{ type: "input_text", text: "Opened" }],
            success: true,
            status: "completed",
          },
        },
      })[0]
    ).toMatchObject({
      type: "tool.completed",
      toolId: "dyn-1",
      toolName: "browser_open",
      output: [{ type: "input_text", text: "Opened" }],
    })
  })

  it("maps Codex hook and patch update notifications", () => {
    expect(
      translate({
        kind: "notification",
        method: "hook/started",
        params: {
          turnId: "turn-1",
          run: {
            id: "hook-1",
            eventName: "preToolUse",
            sourcePath: "/repo/.codex/hooks/pre-tool.sh",
            status: "running",
          },
        },
      })[0]
    ).toMatchObject({
      type: "hook.started",
      turnId: "turn-1",
      payload: {
        hookId: "hook-1",
        hookName: "pre-tool.sh",
        hookEvent: "preToolUse",
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "hook/completed",
        params: {
          turnId: "turn-1",
          run: {
            id: "hook-1",
            status: "failed",
            entries: [{ kind: "error", text: "lint failed" }],
          },
        },
      })[0]
    ).toMatchObject({
      type: "hook.completed",
      turnId: "turn-1",
      payload: {
        hookId: "hook-1",
        outcome: "error",
        output: "[error] lint failed",
        stderr: "[error] lint failed",
      },
    })

    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n")
    const patchEvents = translate({
      kind: "notification",
      method: "item/fileChange/patchUpdated",
      params: {
        itemId: "patch-1",
        turnId: "turn-1",
        changes: [{ path: "src/app.ts", kind: "update", diff: patch }],
      },
    })
    expect(patchEvents).toEqual([
      expect.objectContaining({
        type: "turn.diff.updated",
        itemId: "patch-1",
        turnId: "turn-1",
        payload: expect.objectContaining({
          unifiedDiff: expect.stringContaining("+new"),
          files: [{ path: "src/app.ts", additions: 1, deletions: 1 }],
        }),
      }),
      expect.objectContaining({
        type: "item.updated",
        itemId: "patch-1",
        kind: "file_change",
        turnId: "turn-1",
        payload: expect.objectContaining({
          itemType: "file_change",
          detail: "src/app.ts",
          // The whole patch so far: a snapshot, carried as the item's
          // output so consumers replace instead of appending it. It is the
          // same text the diff panel receives.
          output: (patchEvents[0] as { payload: { unifiedDiff: string } })
            .payload.unifiedDiff,
        }),
      }),
    ])
    // A patch snapshot is not a chunk; it must never go out as a tool.delta.
    expect(patchEvents.map((event) => event.type)).not.toContain("tool.delta")
  })

  it("carries the runtime's user-safe child-error message into the runtime error", () => {
    expect(
      translate({
        kind: "child-error",
        error:
          "Codex did not receive the reply to its approval request because its input backlog is full; the turn was stopped.",
      })
    ).toEqual([
      expect.objectContaining({
        type: "runtime.error",
        class: "transport_error",
        message:
          "Codex did not receive the reply to its approval request because its input backlog is full; the turn was stopped.",
      }),
    ])
    expect(translate({ kind: "child-error", error: "" })).toEqual([
      expect.objectContaining({ message: "Codex provider connection lost." }),
    ])
  })

  it("keeps auto-approval and raw response notifications addressable", () => {
    expect(
      translate({
        kind: "notification",
        method: "item/autoApprovalReview/started",
        params: {
          reviewId: "review-1",
          turnId: "turn-1",
          review: {
            status: "pending",
            riskLevel: "low",
            rationale: "Safe read-only action",
          },
        },
      })[0]
    ).toMatchObject({
      type: "item.updated",
      itemId: "review-1",
      kind: "approval_review",
      turnId: "turn-1",
      payload: {
        itemType: "approval_review",
        status: "inProgress",
        title: "Auto approval review",
        detail: "pending · low · Safe read-only action",
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "rawResponseItem/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "raw-1",
            type: "function_call",
            name: "search",
            call_id: "call-1",
            arguments: "{}",
          },
        },
      })[0]
    ).toMatchObject({
      type: "item.completed",
      itemId: "raw-1",
      kind: "raw:function_call",
      turnId: "turn-1",
    })
  })

  it("maps process, MCP status, login, and warning notifications", () => {
    expect(
      translate({
        kind: "notification",
        method: "command/exec/outputDelta",
        params: {
          processId: "proc-1",
          stream: "stdout",
          deltaBase64: Buffer.from("line\n", "utf8").toString("base64"),
          capReached: false,
        },
      })[0]
    ).toMatchObject({
      type: "tool.delta",
      toolId: "proc-1",
      toolName: "shell",
      streamKind: "command_output",
      delta: "line\n",
    })

    expect(
      translate({
        kind: "notification",
        method: "process/exited",
        params: {
          processHandle: "proc-1",
          exitCode: 2,
          stderr: "failed",
          stdout: "",
        },
      })[0]
    ).toMatchObject({
      type: "tool.failed",
      toolId: "proc-1",
      toolName: "shell",
      error: "failed",
    })

    expect(
      translate({
        kind: "notification",
        method: "mcpServer/startupStatus/updated",
        params: {
          name: "github",
          status: "running",
        },
      })[0]
    ).toMatchObject({
      type: "mcp.status.updated",
      payload: {
        status: {
          name: "github",
          status: "running",
        },
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "account/login/completed",
        params: {
          success: false,
          error: "expired",
        },
      })[0]
    ).toMatchObject({
      type: "auth.status",
      payload: {
        isAuthenticating: false,
        error: "expired",
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "guardianWarning",
        params: {
          message: "Risky command",
        },
      })[0]
    ).toMatchObject({
      type: "runtime.warning",
      message: "Risky command",
    })
  })

  it("maps Codex lifecycle and platform notifications", () => {
    expect(
      translate({
        kind: "notification",
        method: "session/connecting",
        params: { message: "starting" },
      })[0]
    ).toMatchObject({
      type: "session.state.changed",
      status: "starting",
    })

    expect(
      translate({
        kind: "notification",
        method: "session/ready",
        params: { message: "ready" },
      })[0]
    ).toMatchObject({
      type: "session.state.changed",
      status: "ready",
    })

    expect(
      translate({
        kind: "notification",
        method: "process/stderr",
        params: {
          message: "failed to connect to websocket: HTTP error: 503",
        },
      })[0]
    ).toMatchObject({
      type: "runtime.error",
      class: "provider_error",
      message: "Codex provider transport failed.",
    })

    expect(
      translate({
        kind: "notification",
        method: "windows/worldWritableWarning",
        params: {
          message: "World-writable path detected",
        },
      })[0]
    ).toMatchObject({
      type: "runtime.warning",
      message: "World-writable path detected",
    })

    expect(
      translate({
        kind: "notification",
        method: "windowsSandbox/setupCompleted",
        params: {
          success: false,
          message: "Sandbox setup failed",
        },
      })
    ).toEqual([
      expect.objectContaining({
        type: "session.state.changed",
        status: "error",
      }),
      expect.objectContaining({
        type: "runtime.warning",
        message: "Sandbox setup failed",
      }),
    ])
  })

  it("accepts legacy Codex approval request method names", () => {
    expect(
      translate({
        kind: "server-request",
        method: "execCommandApproval",
        requestId: "exec-1",
        params: {
          command: ["npm", "test"],
          reason: "Run tests",
        },
      })[0]
    ).toMatchObject({
      type: "request.opened",
      requestId: "exec-1",
      kind: "tool_approval",
      tool: "shell",
      input: {
        command: ["npm", "test"],
        reason: "Run tests",
      },
    })

    expect(
      translate({
        kind: "server-request",
        method: "applyPatchApproval",
        requestId: "patch-1",
        params: {
          changes: [{ path: "src/app.ts" }],
        },
      })[0]
    ).toMatchObject({
      type: "request.opened",
      requestId: "patch-1",
      kind: "tool_approval",
      tool: "apply_patch",
    })
  })

  it("maps permission and MCP elicitation requests into actionable UI requests", () => {
    expect(
      translate({
        kind: "server-request",
        method: "item/permissions/requestApproval",
        requestId: "permission-1",
        params: {
          cwd: "/repo",
          reason: "Need write access",
          permissions: { fileSystem: { write: ["/repo"] } },
        },
      })[0]
    ).toMatchObject({
      type: "request.opened",
      requestId: "permission-1",
      kind: "tool_approval",
      tool: "permissions",
      input: {
        cwd: "/repo",
        reason: "Need write access",
        permissions: { fileSystem: { write: ["/repo"] } },
      },
    })

    expect(
      translate({
        kind: "server-request",
        method: "mcpServer/elicitation/request",
        requestId: "elicitation-1",
        params: {
          mode: "form",
          serverName: "github",
          message: "Select repository",
          requestedSchema: {
            type: "object",
            properties: {
              repo: {
                type: "string",
                title: "Repository",
                description: "Which repository should be used?",
                oneOf: [
                  { const: "BetterC0de", title: "BetterC0de" },
                  { const: "other", title: "Other" },
                ],
              },
            },
          },
        },
      })[0]
    ).toMatchObject({
      type: "request.opened",
      requestId: "elicitation-1",
      kind: "user_input",
      questions: [
        {
          id: "repo",
          header: "Repository",
          question: "Which repository should be used?",
          options: ["BetterC0de", "Other"],
        },
      ],
    })
  })

  it("reads the app-server's total/last token usage breakdown", () => {
    const breakdown = (totalTokens: number, inputTokens: number) => ({
      totalTokens,
      inputTokens,
      cachedInputTokens: 19_328,
      cacheWriteInputTokens: 0,
      outputTokens: totalTokens - inputTokens,
      reasoningOutputTokens: 40,
    })
    expect(
      translate({
        kind: "notification",
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: breakdown(187_000, 186_500),
            last: breakdown(35_000, 34_900),
            modelContextWindow: 950_000,
          },
        },
      })[0]
    ).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 35_000,
          totalProcessedTokens: 187_000,
          maxTokens: 950_000,
          inputTokens: 186_500,
          lastInputTokens: 34_900,
          lastUsedTokens: 35_000,
          compactsAutomatically: true,
        },
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            total: breakdown(0, 0),
            last: breakdown(0, 0),
            modelContextWindow: null,
          },
        },
      }).map((event) => event.type)
    ).not.toContain("thread.token-usage.updated")
  })

  it("emits thread, plan, diff, and item update notifications", () => {
    expect(
      translate({
        kind: "notification",
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            totalTokens: 126,
            maxTokens: 258400,
            inputTokens: 120,
            outputTokens: 6,
            compactsAutomatically: true,
          },
        },
      })[0]
    ).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 126,
          maxTokens: 258400,
          inputTokens: 120,
          outputTokens: 6,
          compactsAutomatically: true,
        },
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "turn/plan/updated",
        params: {
          explanation: "Working through it",
          plan: [{ step: "Inspect files", status: "inProgress" }],
        },
      })[0]
    ).toMatchObject({
      type: "turn.plan.updated",
      payload: {
        explanation: "Working through it",
        plan: [{ step: "Inspect files", status: "in_progress" }],
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "item/plan/delta",
        params: { delta: "- inspect\n" },
      })[0]
    ).toMatchObject({
      type: "turn.proposed.delta",
      payload: { delta: "- inspect\n" },
    })

    expect(
      translate({
        kind: "notification",
        method: "turn/diff/updated",
        params: {
          diff: [
            "diff --git a/a b/a",
            "--- a/a",
            "+++ b/a",
            "@@ -0,0 +1 @@",
            "+hello",
            "",
          ].join("\n"),
        },
      })[0]
    ).toMatchObject({
      type: "turn.diff.updated",
      payload: {
        unifiedDiff:
          "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+hello\n",
        files: [{ path: "a", additions: 1, deletions: 0 }],
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "item/commandExecution/terminalInteraction",
        params: { id: "cmd-1", message: "running tests" },
      })[0]
    ).toMatchObject({
      type: "item.updated",
      itemId: "cmd-1",
      payload: {
        itemType: "command_execution",
        detail: "running tests",
      },
    })
  })

  it("preserves Codex plan item ids on proposed-plan events", () => {
    expect(
      translate({
        kind: "notification",
        method: "item/plan/delta",
        params: {
          turnId: "turn-1",
          itemId: "plan-item-1",
          delta: "- inspect\n",
        },
      })[0]
    ).toMatchObject({
      type: "turn.proposed.delta",
      itemId: "plan-item-1",
      turnId: "turn-1",
      payload: {
        delta: "- inspect\n",
        itemId: "plan-item-1",
      },
    })

    expect(
      translate({
        kind: "notification",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "plan-item-1",
            type: "plan",
            text: "## Final plan\n\n- one",
          },
        },
      })[0]
    ).toMatchObject({
      type: "turn.proposed.completed",
      itemId: "plan-item-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "## Final plan\n\n- one",
        itemId: "plan-item-1",
      },
    })
  })
})

describe("normalizeCodexEffort", () => {
  it.each([
    // Codex's canonical levels — `none|minimal|low|medium|high|xhigh|max|ultra`.
    // Note: "fast" is intentionally NOT here. Fast Mode is a separate
    // `serviceTier: "fast"` field, not a reasoning effort. See BetterC0de's
    // CodexAdapter.ts for the canonical mapping.
    ["none", "none"],
    ["No Reasoning", "none"],
    ["off", "none"],
    ["minimal", "minimal"],
    ["Low", "low"],
    ["Review", "low"], // Codex's built-in `Review` collaboration preset = effort: low.
    ["Medium", "medium"],
    ["Plan", "medium"], // Codex's built-in `Plan` collaboration preset = effort: medium.
    ["High", "high"],
    // Bug regression: `xhigh` USED to collapse to `high`, swallowing the
    // user's Ultra Think toggle. It must pass through to the wire now.
    ["xHigh", "xhigh"],
    // Live model/list descriptors may expose max/ultra. Preserve those wire
    // values and let `effortForModel` validate them against the descriptor.
    ["max", "max"],
    ["Max", "max"],
    ["ultra", "ultra"],
    ["Ultra Think", "ultra"],
    ["ultra-think", "ultra"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(normalizeCodexEffort(input)).toBe(expected)
  })

  it("does NOT accept 'fast' as an effort — that is serviceTier territory", () => {
    expect(normalizeCodexEffort("fast")).toBeUndefined()
  })

  it("drops unsupported effort values", () => {
    expect(normalizeCodexEffort("turbo")).toBeUndefined()
    expect(normalizeCodexEffort(null)).toBeUndefined()
  })
})

describe("normalizeCodexServiceTier (Fast Mode)", () => {
  it("maps boolean true to 'fast'", () => {
    expect(normalizeCodexServiceTier(true)).toBe("fast")
  })

  it("ignores boolean false / null / undefined", () => {
    expect(normalizeCodexServiceTier(false)).toBeUndefined()
    expect(normalizeCodexServiceTier(null)).toBeUndefined()
    expect(normalizeCodexServiceTier(undefined)).toBeUndefined()
  })

  it("accepts the literal Codex schema strings 'fast' and 'flex'", () => {
    expect(normalizeCodexServiceTier("fast")).toBe("fast")
    expect(normalizeCodexServiceTier("flex")).toBe("flex")
    expect(normalizeCodexServiceTier("FAST")).toBe("fast")
  })

  it("rejects unknown strings", () => {
    expect(normalizeCodexServiceTier("priority")).toBeUndefined()
    expect(normalizeCodexServiceTier("default")).toBeUndefined()
  })

  it("requires a live fastMode capability before sending serviceTier", () => {
    expect(serviceTierForModel(true)).toBeUndefined()
    expect(
      serviceTierForModel(true, {
        optionDescriptors: [
          { id: "fastMode", label: "Fast Mode", type: "boolean" },
        ],
      })
    ).toBe("fast")
    expect(serviceTierForModel(true, { optionDescriptors: [] })).toBeUndefined()
  })
})

describe("effortForModel", () => {
  const capabilities = (options: string[], currentValue?: string) => ({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select" as const,
        options: options.map((id) => ({ id, label: id })),
        ...(currentValue ? { currentValue } : {}),
      },
    ],
  })

  it("passes through every effort explicitly advertised by model/list", () => {
    const live = capabilities(["low", "xhigh", "max", "ultra"])
    expect(effortForModel("low", "any-live-slug", live)).toBe("low")
    expect(effortForModel("max", "any-live-slug", live)).toBe("max")
    expect(effortForModel("ultra", "any-live-slug", live)).toBe("ultra")
  })

  it("uses live default metadata rather than a slug-based fallback", () => {
    const live = capabilities(["low", "medium", "high"], "medium")
    expect(effortForModel("ultra", "model-with-any-name", live)).toBe("medium")
  })

  it("omits effort when metadata is unavailable", () => {
    expect(effortForModel("high", "unknown-model")).toBeUndefined()
    expect(effortForModel(undefined, "unknown-model")).toBeUndefined()
  })
})
