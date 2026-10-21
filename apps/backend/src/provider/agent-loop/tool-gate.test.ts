import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  configureAgentPermissionRuntime,
  bindAgentPermissionRuntimeContext,
} from "../agent-permission-runtime"
import {
  cancelPendingApprovals,
  resolveApproval,
  type PermissionLevel,
} from "../permissions"
import { gateToolCall } from "./tool-gate"

const threadId = "direct-mode-ceiling"
afterEach(() => {
  cancelPendingApprovals(threadId)
  configureAgentPermissionRuntime(null)
})

describe("direct tool gate mode ceilings", () => {
  it.each([
    { mode: "security", level: "bypass", toolName: "Write" },
    { mode: "plan", level: "bypass", toolName: "WebFetch" },
    { mode: "ask", level: "bypass", toolName: "WebFetch" },
    { mode: null, level: "read-only", toolName: "WebFetch" },
  ] as const)(
    "requires approval despite an allow grant in $mode/$level",
    async ({ mode, level, toolName }) => {
      bindAgentPermissionRuntimeContext({
        threadId,
        workspacePath: path.resolve("workspace"),
        chatMode: mode,
        permissionLevel: level,
      })
      configureAgentPermissionRuntime({
        listGrants: () => [],
        evaluateTool: () => ({
          decision: "allow",
          source: "grant",
          reason: "Allowed path",
          normalizedPath: "src",
          grant: null,
        }),
      })
      const emit = vi.fn()
      const pending = gateToolCall({
        emit,
        providerKind: "openai",
        threadId,
        level: level as PermissionLevel,
        mode,
        toolName,
        input: { path: "src/file.ts" },
      })
      expect(emit).toHaveBeenCalledOnce()
      expect(
        resolveApproval(
          threadId,
          emit.mock.calls[0]![0].payload.requestId,
          "deny"
        )
      ).toBe(true)
      await expect(pending).resolves.toMatchObject({ allow: false })
    }
  )

  it("denies a project bash rule even when the session level is bypass", async () => {
    const emit = vi.fn()
    await expect(
      gateToolCall({
        emit,
        providerKind: "openai",
        threadId,
        level: "bypass",
        mode: null,
        toolName: "Bash",
        input: { command: "curl https://example.test" },
        projectPermissionRules: [
          { permission: "bash", pattern: "curl*", action: "deny" },
        ],
      })
    ).resolves.toMatchObject({
      allow: false,
      reason: expect.stringContaining("project permission denied bash:"),
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it("asks when a project rule says ask even at bypass", async () => {
    const emit = vi.fn()
    const pending = gateToolCall({
      emit,
      providerKind: "openai",
      threadId,
      level: "bypass",
      mode: null,
      toolName: "Bash",
      input: { command: "npm test" },
      projectPermissionRules: [
        { permission: "bash", pattern: "npm*", action: "ask" },
      ],
    })
    expect(emit).toHaveBeenCalledOnce()
    expect(
      resolveApproval(
        threadId,
        emit.mock.calls[0]![0].payload.requestId,
        "deny"
      )
    ).toBe(true)
    await expect(pending).resolves.toMatchObject({ allow: false })
  })
})
