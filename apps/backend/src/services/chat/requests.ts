import {
  chatApprovalSchema,
  chatPermissionModeSchema,
  chatPlanApprovalSchema,
  chatUserInputRejectSchema,
  chatUserInputSchema,
} from "@betterc0de/schema"
import type { ApprovalResponse } from "@betterc0de/schema/http-contracts"
import type { z } from "zod"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import {
  makeFailedRequestActivity,
  makeResolvedRequestActivity,
} from "../../provider/activity-projection"
import { recordApprovedPermissionUpdates } from "../../provider/agent-permission-updates"
import {
  isBypassPermissionLevel,
  normalizeGatePermissionLevel,
  providerPermissionModeForLevel,
  setSessionPermission,
} from "../../provider/permissions"
import {
  approvalRequestId as toApprovalRequestId,
  threadId as toThreadId,
} from "../../provider/runtime"
import type { ThreadActivityProjection } from "../../persistence/projections"
import { broadcastThreadActivity } from "../../ws/threadActivityBroadcast"
import { withCheckpointRecoveryMutation } from "../checkpoint-recovery-fence"
import {
  asHubProviderKind,
  chatRecoveryWorkspaces,
  resolveHubInstanceId,
} from "./dispatch"

/**
 * What the caller of a chat route may do with the permission system.
 *
 * Bypass (`bypassPermissions`, Codex `danger-full-access`,
 * `claude --dangerously-skip-permissions`) hands the agent an unattended
 * shell. A paired device holds a bearer, which proves possession of a
 * session, not a human at this machine — so it gets bypass only when the
 * desktop owner granted paired devices a terminal and the session is a full
 * one (the same rule `/shell/run` applies). Durable permission grants are
 * policy changes and stay desktop-only, as on `/permissions/*`.
 */
export interface RemotePermissionAccess {
  /** A paired device rather than the desktop's own renderer. */
  readonly remote: boolean
  /** May request or keep bypass-level permission. */
  readonly mayBypass: boolean
}

export const DESKTOP_PERMISSION_ACCESS: RemotePermissionAccess = {
  remote: false,
  mayBypass: true,
}

export function remoteBypassRefusal(): HttpError {
  return new HttpError(
    403,
    "Full access (bypass) from a paired device requires terminal access to be allowed on the desktop host.",
    "remote_bypass_disabled"
  )
}

type PermissionScopedChatBody = {
  readonly permission_level: string | null
  readonly sandbox?: string | null
  readonly approvalPolicy?: string | null
}

/**
 * Caps a chat turn requested by a paired device without the bypass grant.
 * A bypass (or missing) level becomes `ask-on-edit`, so the turn still runs
 * and its approvals surface; the never-ask / unsandboxed provider hints are
 * dropped. A missing level is pinned too: adapters would otherwise fall back
 * to the session's stored runtime mode, which may be full access.
 */
export function capRemoteChatPermissions<T extends PermissionScopedChatBody>(
  body: T,
  access: RemotePermissionAccess
): T {
  if (access.mayBypass) return body
  const level = body.permission_level?.trim() ?? ""
  return {
    ...body,
    permission_level:
      !level || isBypassPermissionLevel(level) ? "ask-on-edit" : level,
    ...(body.sandbox === "dangerFullAccess" ? { sandbox: null } : {}),
    ...(body.approvalPolicy === "never" ? { approvalPolicy: null } : {}),
  } as T
}

const DURABLE_PERMISSION_DESTINATIONS = new Set([
  "userSettings",
  "projectSettings",
  "localSettings",
])

/**
 * The approval's "always allow" updates a caller may apply. A paired device
 * never writes durable grants (policy changes are desktop-only), and without
 * the bypass grant it cannot switch the session to bypass either.
 */
export function permittedApprovalUpdates<T>(
  updates: ReadonlyArray<T> | null | undefined,
  access: RemotePermissionAccess
): T[] {
  if (!updates) return []
  if (!access.remote) return [...updates]
  return updates.filter((update) => {
    if (!update || typeof update !== "object") return false
    const record = update as {
      destination?: unknown
      type?: unknown
      mode?: unknown
    }
    if (
      typeof record.destination === "string" &&
      DURABLE_PERMISSION_DESTINATIONS.has(record.destination)
    ) {
      return false
    }
    if (
      !access.mayBypass &&
      record.type === "setMode" &&
      record.mode === "bypassPermissions"
    ) {
      return false
    }
    return true
  })
}

/**
 * Every request settlement this module records goes through here: persist,
 * then broadcast. These activities bypass the provider event lane (the
 * provider never saw the settlement), so without the broadcast a failed
 * approval response was durable but invisible — every live client kept its
 * request card until a reload.
 */
function recordRouteActivity(
  state: AppState,
  activity: ThreadActivityProjection
): void {
  state.threadActivities.upsert(activity)
  broadcastThreadActivity(activity)
}

/**
 * Activity sequence for route-emitted entries.
 *
 * This used to be seeded once at module load and only incremented, so after
 * the backend had been up for a while its numbers lagged far behind the
 * provider event projection's — which stamps wall-clock time. A resolution
 * could therefore carry a LOWER sequence than the request it settled, and any
 * consumer ordering by sequence saw the request re-open: answering a question
 * made it reappear immediately. Re-reading the clock on every emit keeps both
 * emitters on the same scale; the counter only breaks ties within a
 * millisecond and when the clock steps backwards.
 */
let lastRouteActivitySequence = 0

function nextRouteActivitySequence(): number {
  const wallClock = Date.now() * 1000
  lastRouteActivitySequence =
    wallClock > lastRouteActivitySequence
      ? wallClock
      : lastRouteActivitySequence + 1
  return lastRouteActivitySequence
}

/**
 * Turn a failed provider round-trip into an HTTP failure the client can act
 * on. The cause is logged in full (local log, the only place it belongs); the
 * response carries a fixed public detail so provider paths and tokens never
 * reach the wire. A nominal HttpError from our own resolution step (no
 * session binding → 409) passes through unchanged; a provider-side failure
 * is a 502 because the upstream, not the request, failed. Previously these
 * came back as 200 `{status:"failed"}`, which clients treated as success.
 */
function providerRequestFailure(
  state: AppState,
  input: {
    readonly operation: string
    readonly threadId: string
    readonly providerKind: string
    readonly providerInstanceId: string | null
    readonly requestId: string
    readonly requestKind: "approval" | "plan-approval" | "user-input"
    readonly detail: string
    readonly cause: unknown
  }
): HttpError {
  logger.error(
    {
      err: input.cause,
      threadId: input.threadId,
      providerKind: input.providerKind,
      providerInstanceId: input.providerInstanceId,
      requestId: input.requestId,
      requestKind: input.requestKind,
    },
    `${input.operation} failed`
  )
  recordRouteActivity(
    state,
    makeFailedRequestActivity({
      threadId: input.threadId,
      providerKind: input.providerKind,
      providerInstanceId: input.providerInstanceId ?? undefined,
      requestId: input.requestId,
      requestKind: input.requestKind,
      detail: input.detail,
      sequence: nextRouteActivitySequence(),
    })
  )
  return toProviderRequestHttpError(input.cause, input.detail)
}

function toProviderRequestHttpError(cause: unknown, detail: string): HttpError {
  if (cause instanceof HttpError) return cause
  // A duck-typed 4xx from the hub (request already answered, unknown id) is
  // the caller's problem and keeps its status; its message stays internal.
  const statusCode =
    typeof cause === "object" &&
    cause !== null &&
    typeof (cause as { statusCode?: unknown }).statusCode === "number" &&
    (cause as { statusCode: number }).statusCode >= 400 &&
    (cause as { statusCode: number }).statusCode < 500
      ? (cause as { statusCode: number }).statusCode
      : 502
  return new HttpError(statusCode, detail, "provider_request_failed")
}

export function withChatRecoveryMutation<T>(
  state: AppState,
  threadId: string,
  operation: () => Promise<T> | T,
  explicitWorkspace?: string | null
): Promise<T> {
  return withCheckpointRecoveryMutation(
    state,
    {
      threadIds: [threadId],
      workspaces: chatRecoveryWorkspaces(state, threadId, explicitWorkspace),
    },
    operation
  )
}

export async function respondToChatApproval(
  state: AppState,
  requested: z.output<typeof chatApprovalSchema>,
  access: RemotePermissionAccess = DESKTOP_PERMISSION_ACCESS
): Promise<ApprovalResponse> {
  const permittedUpdates = permittedApprovalUpdates(
    requested.updatedPermissions,
    access
  )
  const body = {
    ...requested,
    updatedPermissions: requested.updatedPermissions ? permittedUpdates : null,
  }
  return withChatRecoveryMutation(state, body.threadId, async () => {
    const rawDecision = body.decision.trim().toLowerCase()
    const decision =
      rawDecision === "approve" ||
      rawDecision === "accept" ||
      rawDecision === "acceptforsession"
        ? "approve"
        : "deny"
    const persistApprovedPermissions = (): void => {
      if (
        decision === "approve" &&
        body.updatedPermissions &&
        body.updatedPermissions.length > 0
      ) {
        recordApprovedPermissionUpdates({
          threadId: body.threadId,
          workspacePath: state.threads.getThreadProjectPath(body.threadId),
          updates: body.updatedPermissions,
          policy: state.agentPermissions,
        })
      }
    }
    const hubKind = asHubProviderKind(body.providerKind)
    if (
      hubKind &&
      (state.providerHub.has(hubKind) || body.providerInstanceId)
    ) {
      let providerInstanceId: string | null = body.providerInstanceId ?? null
      try {
        providerInstanceId = resolveHubInstanceId({
          state,
          providerKind: hubKind,
          threadId: body.threadId,
          explicitInstanceId: body.providerInstanceId,
          operation: "respond to approval",
          requireBinding: true,
        })
        await state.providerHub.respondToRequest(
          hubKind,
          toThreadId(body.threadId),
          toApprovalRequestId(body.requestId),
          {
            kind: "tool_approval",
            decision,
            ...(body.message ? { message: body.message } : {}),
            ...(body.updatedPermissions && body.updatedPermissions.length > 0
              ? { updatedPermissions: body.updatedPermissions }
              : {}),
          },
          providerInstanceId,
          state.providerSessionBindings
        )
        // A rejected or stale request must not change durable/session grants.
        persistApprovedPermissions()
        recordRouteActivity(
          state,
          makeResolvedRequestActivity({
            threadId: body.threadId,
            providerKind: hubKind,
            providerInstanceId: providerInstanceId ?? undefined,
            requestId: body.requestId,
            decision,
            sequence: nextRouteActivitySequence(),
          })
        )
      } catch (error) {
        throw providerRequestFailure(state, {
          operation: "provider approval response",
          threadId: body.threadId,
          providerKind: hubKind,
          providerInstanceId,
          requestId: body.requestId,
          requestKind: "approval",
          detail: "Provider approval response failed.",
          cause: error,
        })
      }
      return { status: "acknowledged" }
    }
    const kind = state.providers.resolveProviderKind(body.providerKind)
    await state.providers.respondToApproval(
      kind,
      body.threadId,
      body.requestId,
      decision
    )
    persistApprovedPermissions()
    recordRouteActivity(
      state,
      makeResolvedRequestActivity({
        threadId: body.threadId,
        providerKind: kind,
        requestId: body.requestId,
        decision,
        sequence: nextRouteActivitySequence(),
      })
    )
    return { status: "acknowledged" }
  })
}

export async function respondToChatPlan(
  state: AppState,
  body: z.output<typeof chatPlanApprovalSchema>
): Promise<ApprovalResponse> {
  return withChatRecoveryMutation(state, body.threadId, async () => {
    const hubKind = asHubProviderKind(body.providerKind)
    if (!hubKind) {
      // Same contract as every other request failure: non-2xx, never a 200
      // `{status:"failed"}` that clients would treat as an acknowledgement.
      throw new HttpError(
        400,
        `Provider ${body.providerKind} does not support plan approvals`,
        "provider_request_unsupported"
      )
    }
    let providerInstanceId: string | null = body.providerInstanceId ?? null
    try {
      providerInstanceId = resolveHubInstanceId({
        state,
        providerKind: hubKind,
        threadId: body.threadId,
        explicitInstanceId: body.providerInstanceId,
        operation: "respond to plan approval",
        requireBinding: true,
      })
      await state.providerHub.respondToRequest(
        hubKind,
        toThreadId(body.threadId),
        toApprovalRequestId(body.requestId),
        {
          kind: "plan_approval",
          decision: body.decision,
          ...(body.permissionMode
            ? { permissionMode: body.permissionMode }
            : {}),
          ...(body.message ? { message: body.message } : {}),
        },
        providerInstanceId,
        state.providerSessionBindings
      )
      recordRouteActivity(
        state,
        makeResolvedRequestActivity({
          threadId: body.threadId,
          providerKind: hubKind,
          providerInstanceId: providerInstanceId ?? undefined,
          requestId: body.requestId,
          decision: body.decision,
          requestKind: "plan-approval",
          sequence: nextRouteActivitySequence(),
        })
      )
    } catch (error) {
      throw providerRequestFailure(state, {
        operation: "provider plan approval response",
        threadId: body.threadId,
        providerKind: hubKind,
        providerInstanceId,
        requestId: body.requestId,
        requestKind: "plan-approval",
        detail: "Provider plan approval response failed.",
        cause: error,
      })
    }
    return { status: "acknowledged" }
  })
}

export async function updateChatPermissionMode(
  state: AppState,
  body: z.output<typeof chatPermissionModeSchema>,
  access: RemotePermissionAccess = DESKTOP_PERMISSION_ACCESS
): Promise<ApprovalResponse> {
  if (!access.mayBypass && isBypassPermissionLevel(body.permissionLevel)) {
    throw remoteBypassRefusal()
  }
  return withChatRecoveryMutation(state, body.threadId, async () => {
    setSessionPermission(body.threadId, body.permissionLevel)
    const hubKind = asHubProviderKind(body.providerKind)
    if (!hubKind) {
      return { status: "acknowledged", applied: "unsupported" }
    }
    // One alias table for every consumer: `full-access` is `allow-edits`
    // here exactly as it is for the tool gates and the session map, and the
    // adapters receive the canonical spelling rather than re-mapping a raw
    // string of their own.
    const mode = providerPermissionModeForLevel(body.permissionLevel)
    const permissionLevel =
      mode === "plan"
        ? "plan"
        : normalizeGatePermissionLevel(body.permissionLevel)
    try {
      const providerInstanceId = resolveHubInstanceId({
        state,
        providerKind: hubKind,
        threadId: body.threadId,
        explicitInstanceId: body.providerInstanceId,
        operation: "set permission mode",
        requireBinding: false,
      })
      const result = await state.providerHub.setPermissionMode(
        hubKind,
        toThreadId(body.threadId),
        mode,
        providerInstanceId,
        state.providerSessionBindings,
        permissionLevel
      )
      return { status: "acknowledged", applied: result.applied }
    } catch (error) {
      logger.error(
        {
          err: error,
          threadId: body.threadId,
          providerKind: hubKind,
          providerInstanceId: body.providerInstanceId ?? null,
          mode,
        },
        "provider permission mode update failed"
      )
      throw toProviderRequestHttpError(
        error,
        "Provider permission mode update failed."
      )
    }
  })
}

export async function respondToChatInput(
  state: AppState,
  body: z.output<typeof chatUserInputSchema>
): Promise<ApprovalResponse> {
  return withChatRecoveryMutation(state, body.threadId, async () => {
    const hubKind = asHubProviderKind(body.providerKind)
    if (
      hubKind &&
      (state.providerHub.has(hubKind) || body.providerInstanceId)
    ) {
      let providerInstanceId: string | null = body.providerInstanceId ?? null
      try {
        providerInstanceId = resolveHubInstanceId({
          state,
          providerKind: hubKind,
          threadId: body.threadId,
          explicitInstanceId: body.providerInstanceId,
          operation: "respond to user input",
          requireBinding: true,
        })
        await state.providerHub.respondToRequest(
          hubKind,
          toThreadId(body.threadId),
          toApprovalRequestId(body.requestId),
          { kind: "user_input", answers: body.answers },
          providerInstanceId,
          state.providerSessionBindings
        )
        recordRouteActivity(
          state,
          makeResolvedRequestActivity({
            threadId: body.threadId,
            providerKind: hubKind,
            providerInstanceId: providerInstanceId ?? undefined,
            requestId: body.requestId,
            decision: "answer",
            answers: body.answers,
            sequence: nextRouteActivitySequence(),
          })
        )
      } catch (error) {
        throw providerRequestFailure(state, {
          operation: "provider user-input response",
          threadId: body.threadId,
          providerKind: hubKind,
          providerInstanceId,
          requestId: body.requestId,
          requestKind: "user-input",
          detail: "Provider user-input response failed.",
          cause: error,
        })
      }
      return { status: "acknowledged" }
    }
    const kind = state.providers.resolveProviderKind(body.providerKind)
    await state.providers.respondToUserInput(
      kind,
      body.threadId,
      body.requestId,
      body.answers
    )
    recordRouteActivity(
      state,
      makeResolvedRequestActivity({
        threadId: body.threadId,
        providerKind: kind,
        requestId: body.requestId,
        decision: "answer",
        answers: body.answers,
        sequence: nextRouteActivitySequence(),
      })
    )
    return { status: "acknowledged" }
  })
}

export async function rejectChatInput(
  state: AppState,
  body: z.output<typeof chatUserInputRejectSchema>
): Promise<ApprovalResponse> {
  return withChatRecoveryMutation(state, body.threadId, async () => {
    const hubKind = asHubProviderKind(body.providerKind)
    if (
      hubKind &&
      (state.providerHub.has(hubKind) || body.providerInstanceId)
    ) {
      let providerInstanceId: string | null = body.providerInstanceId ?? null
      try {
        providerInstanceId = resolveHubInstanceId({
          state,
          providerKind: hubKind,
          threadId: body.threadId,
          explicitInstanceId: body.providerInstanceId,
          operation: "reject user input",
          requireBinding: true,
        })
        await state.providerHub.respondToRequest(
          hubKind,
          toThreadId(body.threadId),
          toApprovalRequestId(body.requestId),
          { kind: "user_input_reject" },
          providerInstanceId,
          state.providerSessionBindings
        )
        recordRouteActivity(
          state,
          makeResolvedRequestActivity({
            threadId: body.threadId,
            providerKind: hubKind,
            providerInstanceId: providerInstanceId ?? undefined,
            requestId: body.requestId,
            decision: "reject",
            sequence: nextRouteActivitySequence(),
          })
        )
      } catch (error) {
        throw providerRequestFailure(state, {
          operation: "provider user-input rejection",
          threadId: body.threadId,
          providerKind: hubKind,
          providerInstanceId,
          requestId: body.requestId,
          requestKind: "user-input",
          detail: "Provider user-input response failed.",
          cause: error,
        })
      }
      return { status: "acknowledged" }
    }
    const kind = state.providers.resolveProviderKind(body.providerKind)
    await state.providers.respondToUserInput(
      kind,
      body.threadId,
      body.requestId,
      {}
    )
    recordRouteActivity(
      state,
      makeResolvedRequestActivity({
        threadId: body.threadId,
        providerKind: kind,
        requestId: body.requestId,
        decision: "reject",
        sequence: nextRouteActivitySequence(),
      })
    )
    return { status: "acknowledged" }
  })
}
