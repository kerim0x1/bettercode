import { describe, expect, it } from "vitest"
import {
  makeFailedRequestActivity,
  makeResolvedRequestActivity,
  projectProviderEventToThreadActivity,
} from "./index"

describe("provider activity projection", () => {
  it.each([NaN, Infinity, -Infinity, 1e100])(
    "ignores invalid numeric activity timestamps (%s)",
    (startedAt) => {
      const activity = projectProviderEventToThreadActivity(
        {
          event_type: "turn_completed",
          thread_id: "thread-1",
          payload: { started_at: startedAt, completed_at: 0 },
        },
        1
      )
      expect(activity).toMatchObject({
        kind: "turn.completed",
        created_at: "1970-01-01T00:00:00.000Z",
      })
      const fallback = projectProviderEventToThreadActivity(
        {
          event_type: "turn_completed",
          thread_id: "thread-1",
          payload: {
            completed_at: startedAt,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
        2
      )
      expect(fallback?.created_at).toBe("2026-01-01T00:00:00.000Z")
    }
  )

  it("projects tool lifecycle events into durable thread activities", () => {
    const activity = projectProviderEventToThreadActivity(
      {
        event_type: "tool_call",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          tool_id: "tool-1",
          tool_name: "exec_command",
          turn_id: "turn-1",
          input: { command: "npm test" },
        },
      },
      42
    )

    expect(activity).toMatchObject({
      activity_id: "thread-1::tool.started::tool-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      kind: "tool.started",
      tone: "tool",
      summary: "Ran command: npm test",
      sequence: 42,
    })
    expect(activity?.payload).toMatchObject({
      providerKind: "codex",
      toolId: "tool-1",
      toolName: "exec_command",
      presentation: {
        summary: "Ran command",
        detail: "npm test",
      },
    })
  })

  it("uses provider driver slugs as provider metadata fallbacks", () => {
    const activity = projectProviderEventToThreadActivity(
      {
        event_type: "tool_call",
        thread_id: "thread-1",
        payload: {
          provider: "claudeAgent",
          providerInstanceId: "claude-main",
          tool_id: "tool-1",
          tool_name: "Read",
          input: { file_path: "/repo/app.ts" },
        },
      },
      43
    )

    expect(activity).toMatchObject({
      provider_instance_id: "claude-main",
      payload: {
        provider: "claudeAgent",
        providerKind: "claude",
        providerInstanceId: "claude-main",
      },
    })
  })

  it("normalizes providerKind driver slugs on projected activities", () => {
    const claude = projectProviderEventToThreadActivity(
      {
        event_type: "tool_call",
        thread_id: "thread-1",
        payload: {
          providerKind: "claudeAgent",
          tool_id: "tool-claude",
          tool_name: "Read",
          input: { file_path: "/repo/app.ts" },
        },
      },
      44
    )

    expect(claude).not.toBeNull()
    if (!claude) throw new Error("expected claude activity")
    expect(claude.payload).toMatchObject({ providerKind: "claude" })

    const cursor = projectProviderEventToThreadActivity(
      {
        event_type: "tool_call",
        thread_id: "thread-1",
        payload: {
          providerKind: "cursor",
          tool_id: "tool-cursor",
          tool_name: "edit",
          input: { path: "app.ts" },
        },
      },
      45
    )

    expect(cursor).not.toBeNull()
    if (!cursor) throw new Error("expected cursor activity")
    expect(cursor.payload).toMatchObject({ providerKind: "cursor" })
  })

  it("normalizes provider-specific read and search tools into stable labels", () => {
    const read = projectProviderEventToThreadActivity(
      {
        event_type: "tool_call",
        thread_id: "thread-1",
        payload: {
          providerKind: "claude",
          tool_id: "tool-read",
          tool_name: "Read",
          input: { file_path: "/tmp/app.ts" },
        },
      },
      1
    )
    const search = projectProviderEventToThreadActivity(
      {
        event_type: "tool_call",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          tool_id: "tool-search",
          tool_name: "grep",
          input: { pattern: "ProviderSessionBindingStore" },
        },
      },
      2
    )

    expect(read).toMatchObject({
      summary: "Read file: /tmp/app.ts",
    })
    expect(search).toMatchObject({
      summary: "Searched files: ProviderSessionBindingStore",
    })
  })

  it("summarizes raw provider output when a tool has no better detail", () => {
    const activity = projectProviderEventToThreadActivity(
      {
        event_type: "tool_result",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          tool_id: "tool-search",
          tool_name: "find",
          output: { totalFiles: 12, truncated: true },
        },
      },
      3
    )

    expect(activity).toMatchObject({
      kind: "tool.completed",
      summary: "Searched files completed: 12 files+",
      payload: {
        presentation: {
          summary: "Searched files",
          detail: "12 files+",
        },
      },
    })
  })

  it("projects canonical item lifecycle events into tool activities", () => {
    const started = projectProviderEventToThreadActivity(
      {
        event_type: "item.started",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          itemId: "item-1",
          itemType: "command_execution",
          title: "Run tests",
          detail: "npm test",
          data: { command: "npm test" },
          turn_id: "turn-1",
        },
      },
      10
    )
    const completed = projectProviderEventToThreadActivity(
      {
        event_type: "item.completed",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          itemId: "item-1",
          itemType: "command_execution",
          title: "Run tests",
          data: { stdout: "ok" },
          turn_id: "turn-1",
        },
      },
      11
    )

    expect(started).toMatchObject({
      activity_id: "thread-1::tool.started::item-1",
      kind: "tool.started",
      tone: "tool",
      summary: "Ran command: npm test",
      payload: {
        toolId: "item-1",
        toolName: "Run tests",
        itemType: "command_execution",
        input: { command: "npm test" },
      },
    })
    expect(completed).toMatchObject({
      activity_id: "thread-1::tool.completed::item-1",
      kind: "tool.completed",
      tone: "tool",
      summary: "Ran command",
      payload: {
        toolId: "item-1",
        toolName: "Run tests",
        itemType: "command_execution",
        output: { stdout: "ok" },
      },
    })
  })

  it("projects completed read-file items without a completed suffix", () => {
    const activity = projectProviderEventToThreadActivity(
      {
        event_type: "item.completed",
        thread_id: "thread-1",
        payload: {
          providerKind: "cursor",
          itemId: "item-read-path",
          itemType: "dynamic_tool_call",
          title: "Read file",
          detail: "/tmp/app.ts",
          data: {
            toolCallId: "tool-read-path-1",
            kind: "read",
            locations: [{ path: "/tmp/app.ts" }],
          },
          turn_id: "turn-read-path",
        },
      },
      12
    )

    expect(activity).toMatchObject({
      activity_id: "thread-1::tool.completed::item-read-path",
      kind: "tool.completed",
      tone: "tool",
      summary: "Read file: /tmp/app.ts",
      payload: {
        itemType: "dynamic_tool_call",
        toolId: "item-read-path",
        toolName: "Read file",
        presentation: {
          summary: "Read file",
          detail: "/tmp/app.ts",
        },
      },
    })
  })

  it("projects nested canonical item payload envelopes into tool activities", () => {
    const activity = projectProviderEventToThreadActivity(
      {
        event_type: "item.started",
        thread_id: "thread-1",
        payload: {
          provider: "claudeAgent",
          providerInstanceId: "claude-main",
          itemId: "item-nested-1",
          turnId: "turn-1",
          payload: {
            itemType: "command_execution",
            title: "Run tests",
            data: {
              command: ["bash", "-lc", "npm test"],
            },
          },
        },
      },
      12
    )

    expect(activity).toMatchObject({
      activity_id: "thread-1::tool.started::item-nested-1",
      provider_instance_id: "claude-main",
      turn_id: "turn-1",
      kind: "tool.started",
      tone: "tool",
      summary: "Ran command: npm test",
      payload: {
        provider: "claudeAgent",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        itemType: "command_execution",
        toolId: "item-nested-1",
        toolName: "Run tests",
        input: {
          command: ["bash", "-lc", "npm test"],
        },
        presentation: {
          summary: "Ran command",
          detail: "npm test",
        },
      },
    })
  })

  it("projects canonical item updates into provider-shaped tool deltas", () => {
    const activity = projectProviderEventToThreadActivity(
      {
        event_type: "item.updated",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          itemId: "item-delta-1",
          itemType: "command_execution",
          title: "Run tests",
          detail: "running npm test",
          data: {
            input: { command: ["bash", "-lc", "npm test"] },
          },
          turn_id: "turn-1",
        },
      },
      13
    )

    expect(activity).toMatchObject({
      activity_id: "thread-1::tool.updated::item-delta-1",
      turn_id: "turn-1",
      kind: "tool.updated",
      tone: "tool",
      summary: "Ran command output: npm test",
      payload: {
        providerKind: "codex",
        itemType: "command_execution",
        toolId: "item-delta-1",
        toolName: "Run tests",
        input: {
          command: ["bash", "-lc", "npm test"],
        },
        output_delta: "running npm test",
        presentation: {
          summary: "Ran command",
          detail: "npm test",
        },
      },
    })
  })

  it("lifts an ACP tool kind so a search titled with its pattern stays a search", () => {
    const activity = projectProviderEventToThreadActivity(
      {
        event_type: "item.updated",
        thread_id: "thread-1",
        payload: {
          providerKind: "grok_cli",
          itemId: "call-1",
          itemType: "dynamic_tool_call",
          title: "readFile",
          detail: "readFile",
          data: {
            toolCallId: "call-1",
            kind: "search",
            rawInput: {
              variant: "Grep",
              pattern: "readFile",
              glob: "apps/**/*.ts",
            },
          },
        },
      },
      7
    )

    expect(activity).toMatchObject({
      kind: "tool.updated",
      summary: "Searched files output: readFile",
      payload: {
        kind: "search",
        toolName: "readFile",
        presentation: { summary: "Searched files", detail: "readFile" },
      },
    })
  })

  it("projects approval requests and resolved route acknowledgements", () => {
    const requested = projectProviderEventToThreadActivity(
      {
        event_type: "tool_approval_requested",
        thread_id: "thread-1",
        payload: {
          providerKind: "claude",
          requestId: "req-1",
          tool: "Edit",
          input: { path: "src/app.ts" },
        },
      },
      100
    )
    const resolved = makeResolvedRequestActivity({
      threadId: "thread-1",
      providerKind: "claude",
      requestId: "req-1",
      decision: "approve",
      sequence: 101,
    })
    const answered = makeResolvedRequestActivity({
      threadId: "thread-1",
      providerKind: "claude",
      requestId: "req-2",
      decision: "answer",
      answers: { framework: "React" },
      sequence: 102,
    })
    const rejected = makeResolvedRequestActivity({
      threadId: "thread-1",
      providerKind: "BetterC0de",
      requestId: "req-3",
      decision: "reject",
      sequence: 103,
    })

    expect(requested).toMatchObject({
      activity_id: "thread-1::approval.requested::req-1",
      kind: "approval.requested",
      tone: "approval",
      summary: "Approval required for Edit",
    })
    expect(requested?.payload).toMatchObject({
      requestKind: "file-change",
      requestId: "req-1",
    })
    expect(resolved).toMatchObject({
      activity_id: "thread-1::approval.resolved::req-1",
      kind: "approval.resolved",
      tone: "info",
      summary: "Approval approved",
    })
    expect(answered).toMatchObject({
      activity_id: "thread-1::user-input.resolved::req-2",
      kind: "user-input.resolved",
      tone: "info",
      summary: "User input answered",
      payload: {
        requestId: "req-2",
        decision: "answer",
        answers: { framework: "React" },
      },
    })
    expect(rejected).toMatchObject({
      activity_id: "thread-1::user-input.resolved::req-3",
      kind: "user-input.resolved",
      tone: "error",
      summary: "User input rejected",
      payload: {
        providerKind: "BetterC0de",
        requestId: "req-3",
        decision: "reject",
      },
    })
  })

  it("projects canonical request approval events", () => {
    const requested = projectProviderEventToThreadActivity(
      {
        event_type: "request.opened",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          requestId: "request-1",
          requestType: "command_execution_approval",
          detail: "Run npm test",
          turn_id: "turn-1",
          args: { command: "npm test" },
        },
      },
      110
    )
    const resolved = projectProviderEventToThreadActivity(
      {
        event_type: "request.resolved",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          requestId: "request-1",
          requestType: "command_execution_approval",
          decision: "approve",
          turn_id: "turn-1",
        },
      },
      111
    )

    expect(requested).toMatchObject({
      activity_id: "thread-1::approval.requested::request-1",
      turn_id: "turn-1",
      kind: "approval.requested",
      tone: "approval",
      summary: "Command approval requested",
      payload: {
        requestId: "request-1",
        requestKind: "command",
        requestType: "command_execution_approval",
        detail: "Run npm test",
      },
    })
    expect(resolved).toMatchObject({
      activity_id: "thread-1::approval.resolved::request-1",
      turn_id: "turn-1",
      kind: "approval.resolved",
      tone: "approval",
      summary: "Approval resolved",
      payload: {
        requestId: "request-1",
        requestKind: "command",
        requestType: "command_execution_approval",
        decision: "approve",
      },
    })
  })

  it("classifies dynamic tool approvals as command approvals", () => {
    const requested = projectProviderEventToThreadActivity(
      {
        event_type: "request.opened",
        thread_id: "thread-1",
        payload: {
          providerKind: "claude",
          requestId: "request-dynamic",
          requestType: "dynamic_tool_call",
          detail: "Run dynamic tool",
        },
      },
      112
    )

    expect(requested).toMatchObject({
      kind: "approval.requested",
      tone: "approval",
      summary: "Command approval requested",
      payload: {
        requestId: "request-dynamic",
        requestKind: "command",
        requestType: "dynamic_tool_call",
      },
    })
  })

  it("projects failed provider request responses for stale pending requests", () => {
    const failed = makeFailedRequestActivity({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      requestId: "req-stale-1",
      requestKind: "user-input",
      detail: "Stale pending user-input request: req-stale-1.",
      sequence: 102,
    })

    expect(failed).toMatchObject({
      activity_id: "thread-1::provider.user-input.respond.failed::req-stale-1",
      thread_id: "thread-1",
      provider_instance_id: "claude-main",
      kind: "provider.user-input.respond.failed",
      tone: "error",
      summary: "Provider user input response failed",
      sequence: 102,
    })
    expect(failed.payload).toMatchObject({
      providerKind: "claude",
      providerInstanceId: "claude-main",
      requestId: "req-stale-1",
      detail: "Stale pending user-input request: req-stale-1.",
    })
  })

  it("projects canonical user input events", () => {
    const requested = projectProviderEventToThreadActivity(
      {
        event_type: "user-input.requested",
        thread_id: "thread-1",
        payload: {
          providerKind: "claude",
          providerInstanceId: "claude-main",
          requestId: "req-1",
          questions: [{ id: "framework", question: "Framework?" }],
        },
      },
      103
    )
    const resolved = projectProviderEventToThreadActivity(
      {
        event_type: "user-input.resolved",
        thread_id: "thread-1",
        payload: {
          providerKind: "claude",
          providerInstanceId: "claude-main",
          requestId: "req-1",
          answers: { framework: "React" },
        },
      },
      104
    )

    expect(requested).toMatchObject({
      activity_id: "thread-1::user-input.requested::req-1",
      provider_instance_id: "claude-main",
      kind: "user-input.requested",
      tone: "info",
      summary: "User input requested",
    })
    expect(resolved).toMatchObject({
      activity_id: "thread-1::user-input.resolved::req-1",
      provider_instance_id: "claude-main",
      kind: "user-input.resolved",
      tone: "info",
      summary: "User input answered",
      payload: {
        answers: { framework: "React" },
      },
    })
  })

  it("projects provider task lifecycle events into reasoning activities", () => {
    const progress = projectProviderEventToThreadActivity(
      {
        event_type: "task.progress",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          providerInstanceId: "codex-work",
          turn_id: "turn-1",
          taskId: "task-1",
          description: "Scanning files",
          summary: "Found matching provider code",
          lastToolName: "grep",
        },
      },
      200
    )
    const completed = projectProviderEventToThreadActivity(
      {
        event_type: "task.completed",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          providerInstanceId: "codex-work",
          taskId: "task-1",
          status: "failed",
          summary: "Could not finish",
        },
      },
      201
    )

    expect(progress).toMatchObject({
      activity_id: "thread-1::task.progress::task-1",
      turn_id: "turn-1",
      provider_instance_id: "codex-work",
      kind: "task.progress",
      tone: "info",
      summary: "Reasoning update",
      payload: {
        detail: "Found matching provider code",
        lastToolName: "grep",
      },
    })
    expect(completed).toMatchObject({
      kind: "task.completed",
      tone: "error",
      summary: "Task failed",
      payload: {
        detail: "Could not finish",
      },
    })
  })

  it("projects auxiliary runtime events into visible activities", () => {
    const toolProgress = projectProviderEventToThreadActivity(
      {
        event_type: "tool.progress",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          providerInstanceId: "codex-work",
          turn_id: "turn-1",
          toolUseId: "tool-1",
          toolName: "grep",
          summary: "Searching files",
        },
      },
      300
    )
    const hookCompleted = projectProviderEventToThreadActivity(
      {
        event_type: "hook.completed",
        thread_id: "thread-1",
        payload: {
          providerKind: "claude",
          hookId: "hook-1",
          outcome: "error",
          stderr: "lint failed",
        },
      },
      301
    )
    const configWarning = projectProviderEventToThreadActivity(
      {
        event_type: "config.warning",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          summary: "Invalid config key",
          details: "Ignored deprecated option",
        },
      },
      302
    )
    const providerMetadata = projectProviderEventToThreadActivity(
      {
        event_type: "provider.metadata.changed",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          providerInstanceId: "codex-work",
          metadataKind: "skills",
          summary: "Skills changed",
        },
      },
      303
    )

    expect(toolProgress).toMatchObject({
      activity_id: "thread-1::tool.progress::tool-1",
      kind: "tool.updated",
      tone: "tool",
      summary: "Searching files",
      payload: {
        toolId: "tool-1",
        toolName: "grep",
        output_delta: "Searching files",
      },
    })
    expect(hookCompleted).toMatchObject({
      kind: "hook.completed",
      tone: "error",
      summary: "Hook failed",
      payload: { detail: "lint failed" },
    })
    expect(configWarning).toMatchObject({
      kind: "config.warning",
      tone: "info",
      summary: "Invalid config key",
      payload: { detail: "Ignored deprecated option" },
    })
    expect(providerMetadata).toMatchObject({
      kind: "provider.metadata.changed",
      tone: "info",
      summary: "Skills changed",
      payload: {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        detail: "skills",
      },
    })
  })

  it("projects session lifecycle events into visible activities", () => {
    const started = projectProviderEventToThreadActivity(
      {
        event_type: "session.started",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          providerInstanceId: "codex-work",
          message: "started",
        },
      },
      350
    )
    const configured = projectProviderEventToThreadActivity(
      {
        event_type: "session.configured",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          config: { cwd: "/repo" },
        },
      },
      351
    )
    const waiting = projectProviderEventToThreadActivity(
      {
        event_type: "session.state.changed",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          state: "waiting",
          reason: "status:compacting",
        },
      },
      352
    )
    const exited = projectProviderEventToThreadActivity(
      {
        event_type: "session.exited",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          exitKind: "graceful",
        },
      },
      353
    )

    expect(started).toMatchObject({
      kind: "session.started",
      tone: "info",
      summary: "Provider session started",
      payload: { detail: "started" },
    })
    expect(configured).toMatchObject({
      kind: "session.configured",
      summary: "Provider session configured",
    })
    expect(waiting).toMatchObject({
      kind: "session.state.changed",
      tone: "info",
      summary: "Provider session waiting",
      payload: { detail: "status:compacting" },
    })
    expect(exited).toMatchObject({
      kind: "session.exited",
      tone: "info",
      summary: "Provider session exited",
      payload: { exitKind: "graceful" },
    })
  })

  it("projects thread, plan, diff, and item update events", () => {
    const usage = projectProviderEventToThreadActivity(
      {
        event_type: "thread.token-usage.updated",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          usage: {
            usedTokens: 1075,
            maxTokens: 128000,
            inputTokens: 1000,
            outputTokens: 75,
          },
        },
      },
      400
    )
    const compacted = projectProviderEventToThreadActivity(
      {
        event_type: "thread.state.changed",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          state: "compacted",
          detail: { source: "provider" },
        },
      },
      401
    )
    const plan = projectProviderEventToThreadActivity(
      {
        event_type: "turn.plan.updated",
        thread_id: "thread-1",
        payload: {
          turn_id: "turn-1",
          plan: [{ step: "Inspect", status: "completed" }],
        },
      },
      402
    )
    const proposedPlan = projectProviderEventToThreadActivity(
      {
        event_type: "turn.proposed.completed",
        thread_id: "thread-1",
        payload: {
          planMarkdown: "# Ship it\n\n- step 1",
        },
      },
      403
    )
    const proposedPlanDuplicate = projectProviderEventToThreadActivity(
      {
        event_type: "turn.proposed.completed",
        thread_id: "thread-1",
        payload: {
          planMarkdown: "# Ship it\n\n- step 1",
        },
      },
      404
    )
    const emptyProposedPlan = projectProviderEventToThreadActivity(
      {
        event_type: "turn.proposed.completed",
        thread_id: "thread-1",
        payload: {
          planMarkdown: "   ",
        },
      },
      405
    )
    const item = projectProviderEventToThreadActivity(
      {
        event_type: "item.updated",
        thread_id: "thread-1",
        payload: {
          itemId: "item-1",
          itemType: "command_execution",
          title: "Run tests",
          detail: "npm test",
        },
      },
      406
    )
    const realtimeStarted = projectProviderEventToThreadActivity(
      {
        event_type: "thread.realtime.started",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          realtimeSessionId: "realtime-session-1",
        },
      },
      407
    )
    const realtimeError = projectProviderEventToThreadActivity(
      {
        event_type: "thread.realtime.error",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          message: "Realtime failed",
        },
      },
      408
    )

    expect(usage).toMatchObject({
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: {
        usedTokens: 1075,
        maxTokens: 128000,
      },
    })
    expect(compacted).toMatchObject({
      kind: "context-compaction",
      summary: "Context compacted",
    })
    expect(plan).toMatchObject({
      kind: "turn.plan.updated",
      turn_id: "turn-1",
      summary: "Plan updated",
    })
    expect(proposedPlan).toMatchObject({
      kind: "turn.proposed.completed",
      summary: "Plan proposed",
      payload: expect.objectContaining({
        planId: expect.stringMatching(/^plan:thread-1:content:hash-/),
        planMarkdown: "# Ship it\n\n- step 1",
      }),
    })
    expect(proposedPlanDuplicate?.activity_id).toBe(proposedPlan?.activity_id)
    expect(emptyProposedPlan).toBeNull()
    expect(item).toMatchObject({
      activity_id: "thread-1::tool.updated::item-1",
      kind: "tool.updated",
      tone: "tool",
      summary: "Ran command output",
      payload: {
        itemType: "command_execution",
        toolId: "item-1",
        toolName: "Run tests",
        detail: "npm test",
        output_delta: "npm test",
      },
    })
    expect(realtimeStarted).toMatchObject({
      kind: "thread.realtime.started",
      tone: "info",
      summary: "Realtime session started",
      payload: {
        detail: "realtime-session-1",
      },
    })
    expect(realtimeError).toMatchObject({
      kind: "thread.realtime.error",
      tone: "error",
      summary: "Realtime failed",
      payload: {
        detail: "Realtime failed",
      },
    })
  })

  it("projects proposed plans with stable turn ids", () => {
    const proposedPlan = projectProviderEventToThreadActivity(
      {
        event_type: "turn.proposed.completed",
        thread_id: "thread-1",
        payload: {
          turn_id: "turn-plan",
          planMarkdown: "# Plan\n\n- step 1",
        },
      },
      500
    )

    expect(proposedPlan).toMatchObject({
      activity_id:
        "thread-1::turn.proposed.completed::plan:thread-1:turn:turn-plan",
      turn_id: "turn-plan",
      kind: "turn.proposed.completed",
      payload: {
        planId: "plan:thread-1:turn:turn-plan",
        planMarkdown: "# Plan\n\n- step 1",
      },
    })
  })

  it("projects canonical runtime warning and error events directly", () => {
    const warning = projectProviderEventToThreadActivity(
      {
        event_type: "runtime.warning",
        thread_id: "thread-1",
        payload: {
          provider: "claudeAgent",
          providerInstanceId: "claude-main",
          event_id: "evt-warning",
          turn_id: "turn-1",
          message: "Provider got slow at C:\\private\\provider.json",
          detail: { token: "sk-sensitive" },
        },
      },
      410
    )
    const error = projectProviderEventToThreadActivity(
      {
        event_type: "runtime.error",
        thread_id: "thread-1",
        payload: {
          provider: "claudeAgent",
          providerInstanceId: "claude-main",
          event_id: "evt-error",
          turn_id: "turn-1",
          message: "Provider failed with token sk-sensitive",
          class: "transport_error",
        },
      },
      411
    )

    expect(warning).toMatchObject({
      activity_id: "thread-1::runtime.warning::evt-warning",
      thread_id: "thread-1",
      turn_id: "turn-1",
      provider_instance_id: "claude-main",
      kind: "runtime.warning",
      tone: "info",
      summary: "Provider runtime warning",
      payload: {
        providerKind: "claude",
        providerInstanceId: "claude-main",
      },
    })
    expect(error).toMatchObject({
      activity_id: "thread-1::runtime.error::evt-error",
      thread_id: "thread-1",
      turn_id: "turn-1",
      provider_instance_id: "claude-main",
      kind: "runtime.error",
      tone: "error",
      summary: "Provider runtime error",
      payload: {
        providerKind: "claude",
        providerInstanceId: "claude-main",
        class: "transport_error",
      },
    })
    expect(JSON.stringify(warning)).not.toContain("provider.json")
    expect(JSON.stringify(warning)).not.toContain("sk-sensitive")
    expect(JSON.stringify(error)).not.toContain("sk-sensitive")
  })

  it("keeps one row per streamed output chunk so the concatenation is the full output", () => {
    // Codex emits per-chunk `output_delta` (legacyBridge `tool.delta`). The
    // transcript rebuilds a tool's output by concatenating `output_delta`
    // across its `tool.updated` rows, so collapsing them onto one tool-keyed
    // row (replace-not-merge upsert) lost everything but the last chunk.
    const chunks = ["line 1\n", "line 2\n", "line 3\n"] as const
    const rows = chunks.map((delta, index) =>
      projectProviderEventToThreadActivity(
        {
          event_type: "tool_call_delta",
          thread_id: "thread-1",
          payload: {
            providerKind: "codex",
            tool_id: "cmd-42",
            tool_name: "Run command",
            output_delta: delta,
            streamKind: "command_output",
            turn_id: "turn-1",
          },
        },
        201 + index
      )
    )
    expect(rows.map((row) => row?.activity_id)).toEqual([
      "thread-1::tool.updated::201",
      "thread-1::tool.updated::202",
      "thread-1::tool.updated::203",
    ])
    const reconstructed = rows
      .map((row) => (row?.payload as { output_delta: string }).output_delta)
      .join("")
    expect(reconstructed).toBe("line 1\nline 2\nline 3\n")
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: "tool.updated",
        payload: { toolId: "cmd-42", toolName: "Run command" },
      })
    }
  })

  it("replaces one tool-keyed row when the update carries the cumulative detail", () => {
    // ACP providers (Cursor, Grok) send the whole output so far as `detail`;
    // the bridge mirrors it into `output_delta`. Replacing in place is right
    // there — a row per update would concatenate the cumulative snapshots.
    const ids = new Set<string>()
    let last: ReturnType<typeof projectProviderEventToThreadActivity> = null
    for (const [sequence, detail] of [
      [301, "Searching src"],
      [302, "Searching src\nSearching src/lib"],
      [303, "Searching src\nSearching src/lib\nFound 3 matches"],
    ] as const) {
      last = projectProviderEventToThreadActivity(
        {
          event_type: "tool_call_delta",
          thread_id: "thread-1",
          payload: {
            providerKind: "cursor",
            tool_id: "grep-42",
            tool_name: "Grep",
            detail,
            output_delta: detail,
            turn_id: "turn-1",
          },
        },
        sequence
      )
      expect(last?.kind).toBe("tool.updated")
      ids.add(last!.activity_id)
    }
    expect([...ids]).toEqual(["thread-1::tool.updated::grep-42"])
    expect(last?.payload).toMatchObject({
      output_delta: "Searching src\nSearching src/lib\nFound 3 matches",
    })

    // An input-only update (no output text) also updates the call's row.
    const inputOnly = projectProviderEventToThreadActivity(
      {
        event_type: "tool_call_delta",
        thread_id: "thread-1",
        payload: {
          providerKind: "claude",
          tool_id: "write-7",
          input: { path: "a.ts", content: "partial" },
        },
      },
      304
    )
    expect(inputOnly?.activity_id).toBe("thread-1::tool.updated::write-7")

    // Anonymous deltas cannot be attributed to a call and keep their own row.
    const anonymous = projectProviderEventToThreadActivity(
      {
        event_type: "tool_call_delta",
        thread_id: "thread-1",
        payload: { providerKind: "codex", output_delta: "..." },
      },
      305
    )
    expect(anonymous?.activity_id).toBe("thread-1::tool.updated::305")
  })

  it("keys a bridged cumulative snapshot by its tool even when detail differs from the output", () => {
    // Codex `patchUpdated` bridged: `detail` is the path list, `output_delta`
    // the whole patch, and the bridge's `cumulative` marker says replace.
    const ids = new Set<string>()
    for (const [sequence, patch] of [
      [501, "diff --git a/src/app.ts b/src/app.ts\n+one\n"],
      [502, "diff --git a/src/app.ts b/src/app.ts\n+one\n+two\n"],
    ] as const) {
      const row = projectProviderEventToThreadActivity(
        {
          event_type: "tool_call_delta",
          thread_id: "thread-1",
          payload: {
            providerKind: "codex",
            tool_id: "patch-1",
            tool_name: "File change",
            detail: "src/app.ts",
            output_delta: patch,
            cumulative: true,
            turn_id: "turn-1",
          },
        },
        sequence
      )
      expect(row?.kind).toBe("tool.updated")
      ids.add(row!.activity_id)
    }
    expect([...ids]).toEqual(["thread-1::tool.updated::patch-1"])
  })

  it("keys canonical item.updated rows the same way as bridged tool deltas", () => {
    const cumulative = projectProviderEventToThreadActivity(
      {
        event_type: "item.updated",
        thread_id: "thread-1",
        payload: {
          providerKind: "cursor",
          itemId: "item-9",
          itemType: "command_execution",
          detail: "npm test\nok",
        },
      },
      401
    )
    expect(cumulative?.activity_id).toBe("thread-1::tool.updated::item-9")

    const chunk = projectProviderEventToThreadActivity(
      {
        event_type: "item.updated",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          itemId: "item-9",
          itemType: "command_execution",
          output_delta: "ok\n",
        },
      },
      402
    )
    expect(chunk?.activity_id).toBe("thread-1::tool.updated::402")
  })
})

describe("tool output bounds in projected activities", () => {
  const bigOutput = `$ npm test\n${"line of output\n".repeat(150_000)}FAIL src/app.test.ts`

  it("stores a large tool result as a cut copy that records its full size", () => {
    const activity = projectProviderEventToThreadActivity(
      {
        event_type: "item.completed",
        thread_id: "thread-1",
        payload: {
          providerKind: "cursor",
          itemId: "item-1",
          itemType: "command_execution",
          title: "npm test",
          turn_id: "turn-1",
          output: bigOutput,
          detail: bigOutput,
        },
      },
      77
    )

    expect(activity).toMatchObject({
      activity_id: "thread-1::tool.completed::item-1",
      kind: "tool.completed",
      sequence: 77,
    })
    const payload = activity!.payload as Record<string, unknown>
    expect(
      Buffer.byteLength(JSON.stringify(payload), "utf8")
    ).toBeLessThanOrEqual(64 * 1024)
    expect(String(payload.output).startsWith("$ npm test")).toBe(true)
    expect(String(payload.output).endsWith("FAIL src/app.test.ts")).toBe(true)
    expect(String(payload.output)).toContain("[output truncated:")
    expect(payload.outputTruncated).toBe(true)
    expect(payload.outputBytes).toBe(Buffer.byteLength(bigOutput, "utf8"))
    expect(payload.truncatedFields).toEqual(
      expect.arrayContaining(["output", "detail"])
    )
    expect(payload.toolId).toBe("item-1")
    expect(activity!.summary.length).toBeLessThanOrEqual(2_000)
  })

  it("projects the whole output when asked not to bound it", () => {
    const activity = projectProviderEventToThreadActivity(
      {
        event_type: "tool_result",
        thread_id: "thread-1",
        payload: {
          tool_id: "tool-1",
          tool_name: "exec_command",
          output: bigOutput,
        },
      },
      78,
      { boundToolOutput: false }
    )

    const payload = activity!.payload as Record<string, unknown>
    expect(payload.output).toBe(bigOutput)
    expect(payload.outputTruncated).toBeUndefined()
  })

  it("leaves a small tool result untouched", () => {
    const activity = projectProviderEventToThreadActivity(
      {
        event_type: "tool_result",
        thread_id: "thread-1",
        payload: { tool_id: "tool-1", tool_name: "exec_command", output: "ok" },
      },
      79
    )

    const payload = activity!.payload as Record<string, unknown>
    expect(payload.output).toBe("ok")
    expect(payload).not.toHaveProperty("outputTruncated")
    expect(payload).not.toHaveProperty("truncatedFields")
  })
})
