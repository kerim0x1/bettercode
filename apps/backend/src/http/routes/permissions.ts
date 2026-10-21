import type { Hono } from "hono"
import type { AppState } from "../../appState"
import { handleHttpContract } from "../contracts"
import {
  listClaudePermissionRules,
  deleteClaudePermissionRule,
} from "../../services/claude-permission-settings"
import {
  deleteSessionRule,
  listAllSessionRules,
  listSessionRules,
} from "../../provider/session-permission-rules"
import { withCheckpointRecoveryMutation } from "../checkpointRecoveryFence"
import { resolveRequestIdentity } from "../../remote/http"
import { resolveApprovedWorkspaceRoot } from "../../services/workspace/authorization"

const REMOTE_PERMISSION_READS = [
  "/permissions/claude-rules/list",
  "/permissions/session-rules/list",
  "/permissions/grants/list",
  "/permissions/grants/evaluate",
  "/permissions/workspace-trust/get",
] as const

/**
 * Permission-rules management for the settings UI: lists and deletes the
 * "Always allow" rules persisted by approval decisions — file-based rules in
 * the Claude settings files plus the in-memory per-thread session mirror.
 * Every route parses and answers through its shared contract
 * (`@betterc0de/schema/http-contracts`, `chat-contracts.ts`).
 */
export function registerPermissionsRoutes(
  api: Hono,
  state: Pick<
    AppState,
    | "config"
    | "remoteAccess"
    | "checkpointReverts"
    | "workspaceRecoveryGate"
    | "agentPermissions"
    | "db"
    | "projectProjections"
    | "threads"
    | "worktreeRegistry"
  >
): void {
  // Policy mutations, including newly added actions, require the desktop owner.
  // Remote approval responses are separate, request-scoped chat endpoints.
  api.use("/permissions/*", async (c, next) => {
    const readOnly =
      c.req.method === "POST" &&
      REMOTE_PERMISSION_READS.some((route) => c.req.path.endsWith(route))
    if (
      !readOnly &&
      resolveRequestIdentity(c, state.config, state.remoteAccess)?.kind !==
        "local"
    ) {
      return c.json(
        {
          error: "Only the desktop host can change permission policy.",
          code: "remote_host_owner_required",
        },
        403
      )
    }
    return next()
  })
  api.post("/permissions/claude-rules/list", (c) =>
    handleHttpContract(
      c,
      "permissionClaudeRulesList",
      async (body) => {
        const cwd = body.cwd?.trim()
        const approvedCwd =
          cwd &&
          resolveRequestIdentity(c, state.config, state.remoteAccess)?.kind ===
            "remote"
            ? await resolveApprovedWorkspaceRoot(state, cwd)
            : cwd
        return { rules: listClaudePermissionRules({ cwd: approvedCwd }) }
      },
      { operation: "permissions claude-rules list" }
    )
  )

  api.post("/permissions/claude-rules/delete", (c) =>
    handleHttpContract(
      c,
      "permissionClaudeRuleDelete",
      async (body) => {
        if (body.source === "session") {
          return {
            status: "failed" as const,
            error: "Use /permissions/session-rules/delete",
          }
        }
        const source = body.source
        const removeRule = () =>
          deleteClaudePermissionRule({
            source,
            behavior: body.behavior,
            rule: body.rule,
            cwd: body.cwd,
          })
        const workspace =
          source === "userSettings" ? null : body.cwd?.trim() || null
        const deleted = workspace
          ? await withCheckpointRecoveryMutation(
              state,
              { workspaces: [workspace] },
              removeRule
            )
          : removeRule()
        return deleted
          ? { status: "acknowledged" as const }
          : { status: "failed" as const, error: "Rule not found" }
      },
      { operation: "permissions claude-rules delete" }
    )
  )

  api.post("/permissions/session-rules/list", (c) =>
    handleHttpContract(
      c,
      "permissionSessionRulesList",
      async (body) => {
        const threadId = body.threadId
        return {
          rules: threadId
            ? listSessionRules(threadId).map((rule) => ({ ...rule, threadId }))
            : listAllSessionRules(),
        }
      },
      { operation: "permissions session-rules list" }
    )
  )

  api.post("/permissions/session-rules/delete", (c) =>
    handleHttpContract(
      c,
      "permissionSessionRuleDelete",
      async (body) => {
        if (!body.threadId) {
          return { status: "failed" as const, error: "threadId is required" }
        }
        const deleted = deleteSessionRule(body.threadId, {
          behavior: body.behavior,
          rule: body.rule,
        })
        return deleted
          ? { status: "acknowledged" as const }
          : { status: "failed" as const, error: "Rule not found" }
      },
      { operation: "permissions session-rules delete" }
    )
  )

  const agentPermissions = state.agentPermissions

  api.post("/permissions/grants/list", (c) =>
    handleHttpContract(
      c,
      "permissionGrantsList",
      async (body) => ({
        grants: agentPermissions.listGrants({
          workspacePath: body.workspacePath,
          destination: body.destination,
          includeUser: body.includeUser,
        }),
      }),
      { operation: "permissions grants list" }
    )
  )

  api.post("/permissions/grants/upsert", (c) =>
    handleHttpContract(
      c,
      "permissionGrantUpsert",
      async (body) => ({
        grant: agentPermissions.upsertGrant(body),
      }),
      { operation: "permissions grants upsert" }
    )
  )

  api.post("/permissions/grants/delete", (c) =>
    handleHttpContract(
      c,
      "permissionGrantDelete",
      async (body) =>
        agentPermissions.deleteGrant(body.id)
          ? { status: "acknowledged" as const }
          : { status: "failed" as const, error: "Grant not found" },
      { operation: "permissions grants delete" }
    )
  )

  api.post("/permissions/grants/evaluate", (c) =>
    handleHttpContract(
      c,
      "permissionGrantEvaluate",
      async (body) => ({
        evaluation: agentPermissions.evaluateTool(body),
      }),
      { operation: "permissions grants evaluate" }
    )
  )

  api.post("/permissions/workspace-trust/get", (c) =>
    handleHttpContract(
      c,
      "workspaceTrustGet",
      async (body) => ({
        trust: agentPermissions.getWorkspaceTrust(body.workspacePath),
      }),
      { operation: "permissions workspace-trust get" }
    )
  )

  api.post("/permissions/workspace-trust/set", (c) =>
    handleHttpContract(
      c,
      "workspaceTrustSet",
      async (body) => ({
        trust: agentPermissions.setWorkspaceTrust(body),
      }),
      { operation: "permissions workspace-trust set" }
    )
  )

  // Called when the user deliberately opens a folder. Unlike `set` it never
  // overrides a decision the user already made, in either direction.
  api.post("/permissions/workspace-trust/ensure", (c) =>
    handleHttpContract(
      c,
      "workspaceTrustEnsure",
      async (body) => ({
        trust: agentPermissions.ensureWorkspaceTrusted(body.workspacePath),
      }),
      { operation: "permissions workspace-trust ensure" }
    )
  )
}
