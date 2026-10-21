import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openDatabase, type Db } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { AgentPermissionPolicy } from "./agent-permission-policy"
import {
  bindAgentPermissionRuntimeContext,
  claudeSettingSourcesForCwd,
  configureAgentPermissionRuntime,
  evaluateConfiguredAgentToolPermission,
} from "./agent-permission-runtime"
import {
  clearSessionRules,
  recordSessionPermissionUpdates,
} from "./session-permission-rules"

const threadId = "runtime-policy-precedence"
const workspacePath = path.resolve("runtime-policy-workspace")
let db: Db
let policy: AgentPermissionPolicy

beforeEach(() => {
  db = openDatabase(":memory:")
  runMigrations(db)
  policy = new AgentPermissionPolicy(db, { agentConfigRoots: () => [] })
  configureAgentPermissionRuntime(policy)
  bindAgentPermissionRuntimeContext({
    threadId,
    workspacePath,
    permissionLevel: "bypass",
  })
})

afterEach(() => {
  clearSessionRules(threadId)
  configureAgentPermissionRuntime(null)
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
  return evaluateConfiguredAgentToolPermission({
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
      evaluateConfiguredAgentToolPermission({
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
    expect([...claudeSettingSourcesForCwd(workspacePath)]).toEqual(["user"])
  })

  it("keeps project and local settings when the workspace is trusted or has no record", () => {
    expect([...claudeSettingSourcesForCwd(workspacePath)]).toEqual([
      "user",
      "project",
      "local",
    ])
    policy.setWorkspaceTrust({ workspacePath, state: "trusted" })
    expect([...claudeSettingSourcesForCwd(workspacePath)]).toEqual([
      "user",
      "project",
      "local",
    ])
  })

  it("loads only user settings when no workspace is selected", () => {
    expect([...claudeSettingSourcesForCwd(" ")]).toEqual(["user"])
  })

  it("keeps project and local settings when the runtime policy cannot report trust", () => {
    configureAgentPermissionRuntime({
      evaluateTool: () => ({
        decision: "allow",
        source: "default",
        reason: "default",
        normalizedPath: null,
        grant: null,
      }),
      listGrants: () => [],
    })
    expect([...claudeSettingSourcesForCwd(workspacePath)]).toEqual([
      "user",
      "project",
      "local",
    ])
  })
})
