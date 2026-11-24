import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AgentPermissionRuntime,
  setDefaultAgentPermissionRuntime,
} from "../agent-permission-runtime"
import {
  cancelPendingApprovals,
  pendingApprovalCount,
  resolveApproval,
  type PermissionLevel,
} from "../permissions"
import { gateToolCall } from "./tool-gate"

const threadId = "direct-mode-ceiling"
afterEach(() => {
  cancelPendingApprovals(threadId)
  setDefaultAgentPermissionRuntime(null)
})

describe("direct tool approval delivery", () => {
  const call = {
    threadId,
    level: "ask-on-edit",
    mode: "agent",
    toolName: "Write",
    input: { file_path: "src/file.ts" },
  } as const

  it.each(["anthropic", "openai", "grok", "openrouter", "lmstudio"])(
    "accepts an immediate approval for %s",
    async (providerKind) => {
      await expect(
        gateToolCall({
          ...call,
          providerKind,
          emit: ({ payload }) => {
            expect(
              resolveApproval(threadId, String(payload.requestId), "approve")
            ).toBe(true)
          },
        })
      ).resolves.toEqual({ allow: true })
    }
  )

  it("cancels an approval while it is being published", async () => {
    const controller = new AbortController()
    await expect(
      gateToolCall({
        ...call,
        providerKind: "openai",
        signal: controller.signal,
        emit: () => {
          controller.abort()
          expect(cancelPendingApprovals(threadId)).toBe(1)
        },
      })
    ).resolves.toEqual({ allow: false, reason: "Turn cancelled." })
  })

  it("does not request approval once the turn has stopped", async () => {
    const emit = vi.fn()
    await expect(
      gateToolCall({
        ...call,
        providerKind: "anthropic",
        signal: AbortSignal.abort(),
        emit,
      })
    ).resolves.toEqual({ allow: false, reason: "Turn cancelled." })
    expect(emit).not.toHaveBeenCalled()
  })

  it("clears the approval if publishing it fails", async () => {
    const failure = new Error("could not publish approval")
    await expect(
      gateToolCall({
        ...call,
        providerKind: "openrouter",
        emit: () => {
          throw failure
        },
      })
    ).rejects.toBe(failure)
    expect(pendingApprovalCount(threadId)).toBe(0)
  })
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
      const runtime = new AgentPermissionRuntime({
        policy: {
          listGrants: () => [],
          evaluateTool: () => ({
            decision: "allow",
            source: "grant",
            reason: "Allowed path",
            normalizedPath: "src",
            grant: null,
          }),
        },
      })
      runtime.bindContext({
        threadId,
        workspacePath: path.resolve("workspace"),
        chatMode: mode,
        permissionLevel: level,
      })
      setDefaultAgentPermissionRuntime(runtime)
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
