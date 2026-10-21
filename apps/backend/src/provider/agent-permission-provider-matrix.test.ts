import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openDatabase } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { AgentPermissionPolicy } from "./agent-permission-policy"
import {
  AgentPermissionRuntime,
  bindAgentPermissionRuntimeContext,
  clearAgentPermissionRuntimeContext,
  runWithAgentPermissionRuntimeContext,
  setDefaultAgentPermissionRuntime,
} from "./agent-permission-runtime"
import { gateToolCall } from "./agent-loop/tool-gate"
import { evaluateBetterC0deProjectToolPermission } from "./project-tool-policy"
import {
  approvalRequestId,
  threadId,
  type ProviderAdapterShape,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "./runtime/contracts"
import { ProviderHub } from "./runtime/ProviderHub"

const cleanupDirectories: string[] = []
const cleanupDatabases: Array<ReturnType<typeof openDatabase>> = []

afterEach(() => {
  setDefaultAgentPermissionRuntime(null)
  for (const db of cleanupDatabases.splice(0)) {
    try {
      db.close()
    } catch {
      // The assertion may have failed after the test already closed it.
    }
  }
  for (const directory of cleanupDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("durable agent permission provider matrix", () => {
  it("applies the same persisted path denial in direct and Hub approval seams", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-permission-matrix-")
    )
    cleanupDirectories.push(directory)
    const workspace = path.join(directory, "workspace")
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true })
    const db = openDatabase(path.join(directory, "betterc0de.sqlite"))
    cleanupDatabases.push(db)
    runMigrations(db)
    const policy = new AgentPermissionPolicy(db)
    policy.upsertGrant({
      destination: "workspace",
      workspacePath: workspace,
      toolName: "Edit",
      pathScope: "src",
      behavior: "deny",
    })
    // The direct gate, the Claude project policy and the Hub all consult the
    // installed runtime, as they do in a running backend.
    setDefaultAgentPermissionRuntime(new AgentPermissionRuntime({ policy }))

    const directContext = {
      threadId: "direct-thread",
      workspacePath: workspace,
      appMode: "agent",
      permissionLevel: "bypass",
    }
    const directToken = bindAgentPermissionRuntimeContext(directContext)
    const direct = await gateToolCall({
      emit: vi.fn(),
      providerKind: "openai",
      threadId: directContext.threadId,
      level: "bypass",
      mode: null,
      toolName: "Write",
      input: { file_path: "src/direct.ts" },
    })
    clearAgentPermissionRuntimeContext(directContext.threadId, directToken)
    expect(direct).toMatchObject({
      allow: false,
      reason: "Matched workspace deny grant.",
    })

    policy.upsertGrant({
      destination: "workspace",
      workspacePath: workspace,
      toolName: "Edit",
      pathScope: "src",
      behavior: "ask",
    })
    expect(
      runWithAgentPermissionRuntimeContext(directContext, () =>
        evaluateBetterC0deProjectToolPermission([], {
          toolName: "Write",
          toolInput: { file_path: "src/protected-claude.ts" },
        })
      )
    ).toMatchObject({ action: "ask", pattern: "src/protected-claude.ts" })
    policy.upsertGrant({
      destination: "workspace",
      workspacePath: workspace,
      toolName: "Edit",
      pathScope: "src",
      behavior: "deny",
    })

    let listener: ((event: ProviderRuntimeEvent) => void) | null = null
    let resolveApproval!: () => void
    const approvalSettled = new Promise<void>((resolve) => {
      resolveApproval = resolve
    })
    const observedDecisions: ProviderApprovalDecision[] = []
    const sessions = new Map<string, ProviderSession>()
    const adapter: ProviderAdapterShape = {
      provider: "codex",
      displayName: "Matrix Hub provider",
      capabilities: {
        supportsStreaming: true,
        supportsTools: true,
        supportsApprovals: true,
        supportsResume: true,
        managesOwnLifecycle: false,
      },
      isConfigured: () => true,
      availableModels: async () => [{ slug: "matrix", name: "Matrix" }],
      startSession: async (input) => {
        const now = Date.now()
        const session: ProviderSession = {
          threadId: input.threadId,
          providerThreadId: null,
          status: "ready",
          cwd: input.cwd ?? null,
          activeTurnId: null,
          runtimeMode: input.runtimeMode ?? null,
          createdAt: now,
          updatedAt: now,
        }
        sessions.set(input.threadId, session)
        return session
      },
      listSessions: async () => [...sessions.values()],
      sendTurn: async (input) => {
        listener?.({
          threadId: input.threadId,
          providerKind: "codex",
          eventId: "matrix-request",
          at: Date.now(),
          type: "request.opened",
          requestId: "matrix-approval",
          kind: "tool_approval",
          tool: "file_change_approval",
          input: { path: "src/hub.ts" },
        })
        await approvalSettled
      },
      interruptTurn: async () => {},
      respondToRequest: async (_thread, request, decision) => {
        expect(request).toBe(approvalRequestId("matrix-approval"))
        observedDecisions.push(decision)
        resolveApproval()
      },
      stopSession: async (id) => {
        sessions.delete(id)
      },
      hasSession: (id) => sessions.has(id),
      subscribe: (next) => {
        listener = next
        return () => {
          listener = null
        }
      },
      stopAll: async () => {
        sessions.clear()
      },
    }
    const hub = new ProviderHub({
      adapters: [adapter],
      projectProviderPolicyLoader: async () => null,
    })
    const hubEvents: ProviderRuntimeEvent[] = []
    const unsubscribe = hub.subscribe((event) => hubEvents.push(event))
    const turn = hub.startTurn("codex", {
      threadId: "hub-thread",
      message: "edit the file",
      modelId: "matrix",
      history: [],
      projectPath: workspace,
      appMode: "agent",
      permissionLevel: "bypass",
    })

    await expect(turn.completion).resolves.toBeUndefined()
    await expect(turn.settled).resolves.toBeUndefined()
    expect(observedDecisions).toEqual([
      {
        kind: "tool_approval",
        decision: "deny",
        message: "Matched workspace deny grant.",
      },
    ])
    expect(
      hubEvents.filter(
        (event) =>
          event.type === "tool.denied" || event.type === "runtime.error"
      )
    ).toEqual([
      expect.objectContaining({
        type: "tool.denied",
        threadId: threadId("hub-thread"),
        payload: {
          toolName: "file_change_approval",
          reason: "Matched workspace deny grant.",
        },
      }),
    ])

    policy.upsertGrant({
      destination: "workspace",
      workspacePath: workspace,
      toolName: "Edit",
      pathScope: "src",
      behavior: "allow",
    })
    const allowContext = {
      ...directContext,
      threadId: "direct-allow-thread",
      permissionLevel: "ask-on-edit",
    }
    const allowToken = bindAgentPermissionRuntimeContext(allowContext)
    const approvalEvents = vi.fn()
    await expect(
      gateToolCall({
        emit: approvalEvents,
        providerKind: "openai",
        threadId: allowContext.threadId,
        level: "ask-on-edit",
        mode: null,
        toolName: "Write",
        input: { file_path: "src/allowed.ts" },
      })
    ).resolves.toEqual({ allow: true })
    expect(approvalEvents).not.toHaveBeenCalled()
    clearAgentPermissionRuntimeContext(allowContext.threadId, allowToken)

    unsubscribe()
    await hub.stopAll()
  })
})
