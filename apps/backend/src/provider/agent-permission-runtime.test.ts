import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openDatabase, type Db } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { AgentPermissionPolicy } from "./agent-permission-policy"
import {
  AgentPermissionRuntime,
  currentAgentPermissionRuntimeContext,
  defaultAgentPermissionRuntime,
  evaluateConfiguredAgentToolPermission,
  publishAgentPermissionEvent,
  releaseAgentPermissionRuntime,
  setDefaultAgentPermissionRuntime,
} from "./agent-permission-runtime"
import {
  clearSessionRules,
  recordSessionPermissionUpdates,
} from "./session-permission-rules"

const threadId = "runtime-policy-precedence"
const workspacePath = path.resolve("runtime-policy-workspace")
let db: Db
let policy: AgentPermissionPolicy
let runtime: AgentPermissionRuntime

beforeEach(() => {
  db = openDatabase(":memory:")
  runMigrations(db)
  policy = new AgentPermissionPolicy(db, { agentConfigRoots: () => [] })
  runtime = new AgentPermissionRuntime({ policy })
  runtime.bindContext({
    threadId,
    workspacePath,
    permissionLevel: "bypass",
  })
})

afterEach(() => {
  clearSessionRules(threadId)
  setDefaultAgentPermissionRuntime(null)
  db.close()
})

function sessionRule(
  behavior: "allow" | "ask" | "deny",
  ruleContent = "src/*"
) {
  recordSessionPermissionUpdates(threadId, [
    {
      type: "addRules",
      destination: "session",
      behavior,
      rules: [{ toolName: "Read", ruleContent }],
    },
  ])
}

function evaluate(filePath = "src/private.txt") {
  return runtime.evaluateToolPermission({
    threadId,
    toolName: "Read",
    toolInput: { file_path: filePath },
  })
}

describe("session and durable permission precedence", () => {
  it.each(["deny", "ask"] as const)(
    "preserves durable %s over session allow",
    (behavior) => {
      sessionRule("allow")
      policy.upsertGrant({
        destination: "workspace",
        workspacePath,
        toolName: "Read",
        pathScope: "src",
        behavior,
      })
      expect(evaluate()).toMatchObject({ decision: behavior, source: "grant" })
    }
  )

  it("preserves workspace trust after a session approval", () => {
    sessionRule("allow")
    policy.setWorkspaceTrust({ workspacePath, state: "untrusted" })
    expect(evaluate()).toMatchObject({
      decision: "deny",
      source: "workspace_trust",
    })
  })

  it("preserves path confinement after a session approval", () => {
    sessionRule("allow", "../*")
    expect(evaluate("../private.txt")).toMatchObject({
      decision: "deny",
      source: "path_confinement",
    })
  })

  it.each(["deny", "ask"] as const)(
    "preserves session %s over durable allow",
    (behavior) => {
      sessionRule(behavior)
      policy.upsertGrant({
        destination: "workspace",
        workspacePath,
        toolName: "Read",
        pathScope: "src",
        behavior: "allow",
      })
      expect(evaluate()).toMatchObject({
        decision: behavior,
        source: "session",
      })
    }
  )

  it("allows scoped session approvals when policy only supplies its default", () => {
    sessionRule("allow")
    expect(evaluate()).toMatchObject({ decision: "allow", source: "session" })
  })

  it("checks every input path before honoring a session approval", () => {
    sessionRule("allow")
    policy.upsertGrant({
      destination: "workspace",
      workspacePath,
      toolName: "Read",
      pathScope: "secrets",
      behavior: "deny",
    })
    expect(
      runtime.evaluateToolPermission({
        threadId,
        toolName: "Read",
        toolInput: {
          file_path: "src/public.txt",
          files: [{ path: "secrets/private.txt" }],
        },
      })
    ).toMatchObject({ decision: "deny", source: "grant" })
  })
})

describe("Claude setting sources", () => {
  it("omits project and local settings when the workspace is untrusted", () => {
    policy.setWorkspaceTrust({ workspacePath, state: "untrusted" })
    expect([...runtime.claudeSettingSourcesForCwd(workspacePath)]).toEqual([
      "user",
    ])
  })

  it("loads project and local settings (and their hooks) only after explicit trust", () => {
    // The compatibility default reports `trusted` without a stored record;
    // that is not consent to run the repository's Claude hooks.
    expect(policy.getWorkspaceTrust(workspacePath)).toMatchObject({
      state: "trusted",
      explicit: false,
    })
    expect([...runtime.claudeSettingSourcesForCwd(workspacePath)]).toEqual([
      "user",
    ])
    policy.setWorkspaceTrust({ workspacePath, state: "trusted" })
    expect([...runtime.claudeSettingSourcesForCwd(workspacePath)]).toEqual([
      "user",
      "project",
      "local",
    ])
  })

  it("loads only user settings when no workspace is selected", () => {
    expect([...runtime.claudeSettingSourcesForCwd(" ")]).toEqual(["user"])
  })

  it("loads only user settings when the trust lookup fails", () => {
    expect([
      ...runtime.claudeSettingSourcesForCwd("relative/workspace"),
    ]).toEqual(["user"])
  })

  it("loads only user settings when the runtime policy cannot report trust", () => {
    const withoutTrust = new AgentPermissionRuntime({
      policy: {
        evaluateTool: () => ({
          decision: "allow",
          source: "default",
          reason: "default",
          normalizedPath: null,
          grant: null,
        }),
        listGrants: () => [],
      },
    })
    expect([...withoutTrust.claudeSettingSourcesForCwd(workspacePath)]).toEqual(
      ["user"]
    )
  })
})

describe("installed runtime", () => {
  it("serves the free functions from the installed runtime only", () => {
    sessionRule("deny")
    expect(
      evaluateConfiguredAgentToolPermission({
        threadId,
        toolName: "Read",
        toolInput: { file_path: "src/private.txt" },
      })
    ).toBeNull()

    setDefaultAgentPermissionRuntime(runtime)
    expect(currentAgentPermissionRuntimeContext(threadId)).toMatchObject({
      workspacePath,
    })
    expect(
      evaluateConfiguredAgentToolPermission({
        threadId,
        toolName: "Read",
        toolInput: { file_path: "src/private.txt" },
      })
    ).toMatchObject({ decision: "deny", source: "session" })
  })

  it("publishes notices on its own bus only while a policy is attached", () => {
    const emitEvent = vi.fn()
    const reporting = new AgentPermissionRuntime({
      policy,
      events: { emitEvent },
    })
    const notice = {
      event_type: "tool.denied",
      thread_id: threadId,
      payload: { toolName: "Read", reason: "denied" },
    }
    setDefaultAgentPermissionRuntime(reporting)
    publishAgentPermissionEvent(notice)
    expect(emitEvent).toHaveBeenCalledWith(notice)

    reporting.setPolicy(null)
    publishAgentPermissionEvent(notice)
    expect(emitEvent).toHaveBeenCalledOnce()
  })

  it("releases its policy and contexts, uninstalling itself but never a newer runtime", () => {
    setDefaultAgentPermissionRuntime(runtime)
    releaseAgentPermissionRuntime(runtime)
    expect(runtime.currentContext(threadId)).toBeNull()
    expect(runtime.listGrants(threadId)).toEqual([])
    expect(defaultAgentPermissionRuntime()).not.toBe(runtime)

    const newer = new AgentPermissionRuntime({ policy })
    const older = new AgentPermissionRuntime({ policy })
    setDefaultAgentPermissionRuntime(newer)
    releaseAgentPermissionRuntime(older)
    expect(defaultAgentPermissionRuntime()).toBe(newer)
  })
})
