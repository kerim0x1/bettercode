import {
  BROWSER_ELEMENT_ATTACHMENT_TYPE,
  type ChatSendBody,
} from "@betterc0de/schema"
import type { ChatSendResponse } from "@betterc0de/schema/http-contracts"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import {
  normalizeLevel,
  setSessionPermission,
} from "../../provider/permissions"
import {
  threadId as toThreadId,
  type ProviderKind,
} from "../../provider/runtime"
import type { ProviderSendTurnInput } from "../../provider/types"
import type { RemoteProviderTurnReservation } from "../../remote/providerTurnOwnership"
import {
  acquireCheckpointRecoveryMutationLease,
  recoveryWorkspacesForThread,
} from "../checkpoint-recovery-fence"
import { resolveTurnSystemInstruction } from "../effective-rules"
import { ensureScratchWorkspace } from "../scratchWorkspace"
import type { WorkspaceRecoveryLease } from "../workspace-recovery-gate"
import { resolveChatWorkspaceRoot } from "../workspace/authorization"
import {
  compactAutomaticallyBeforeSend,
  errorType,
} from "./automatic-compaction"
import {
  bindDispatchProviderTurn,
  dispatchRequestFingerprint,
  existingDispatchResponse,
  existingDurableChatDispatch,
  markAcceptedDispatchMessage,
  markRejectedDispatchMessage,
  persistDispatchUserMessage,
  reserveDurableChatDispatch,
} from "./dispatch-lifecycle"
import { providerHistoryForDispatch } from "./history"
import { prepareProviderHandoff } from "./provider-handoff"
import {
  buildPreparedTurnInstruction,
  runMessageSendHooks,
} from "./turn-preparation"
import { threadGoals } from "./goal-registry"
import type { GoalTurn } from "./goals"

/**
 * Admissions currently running in this process, keyed by client dispatch id.
 *
 * The durable dispatch row is created only *after* the thread turn is
 * reserved, so an identical retry that arrives while the original is still
 * being admitted finds no row and then loses the reservation race with a
 * `turn_active` 409 — the one answer a retry must never get. Coalescing on
 * the in-flight admission lets the retry return the original's outcome with
 * `replayed: true`, exactly as a later retry would from the durable row.
 */
interface InFlightAdmission {
  readonly id: symbol
  readonly threadId: string
  readonly fingerprint: string
  readonly response: Promise<ChatSendResponse>
}

const inFlightAdmissions = new WeakMap<
  AppState,
  Map<string, InFlightAdmission>
>()

function inFlightAdmissionsFor(
  state: AppState
): Map<string, InFlightAdmission> {
  let admissions = inFlightAdmissions.get(state)
  if (!admissions) {
    admissions = new Map()
    inFlightAdmissions.set(state, admissions)
  }
  return admissions
}

/**
 * Admissions are keyed per thread: a client-chosen message id is only unique
 * within its thread, so keying by the id alone let a same-id request on
 * another thread overwrite (and later evict) the original's entry.
 */
function inFlightAdmissionKey(threadId: string, dispatchId: string): string {
  return JSON.stringify([threadId, dispatchId])
}

function findInFlightAdmission(
  state: AppState,
  input: {
    readonly dispatchId: string | null | undefined
    readonly threadId: string
    readonly fingerprint: string | null
    readonly selfId: symbol
  }
): InFlightAdmission | null {
  if (!input.dispatchId || !input.fingerprint) return null
  const admission = inFlightAdmissions
    .get(state)
    ?.get(inFlightAdmissionKey(input.threadId, input.dispatchId))
  if (!admission || admission.id === input.selfId) return null
  if (admission.threadId !== input.threadId) return null
  if (admission.fingerprint !== input.fingerprint) {
    throw new HttpError(
      409,
      `Dispatch id '${input.dispatchId}' is already bound to a different request.`,
      "dispatch_id_conflict"
    )
  }
  return admission
}

async function replayInFlightAdmission(
  admission: InFlightAdmission
): Promise<ChatSendResponse> {
  const response = await admission.response
  return { ...response, replayed: true }
}

function isTurnActiveError(error: unknown): boolean {
  return error instanceof HttpError && error.code === "turn_active"
}

const HUB_PROVIDER_KINDS: ReadonlySet<string> = new Set([
  "codex",
  "claude",
  "cursor",
  "grok_cli",
  "betterc0de",
])

export function asHubProviderKind(raw: string): ProviderKind | null {
  const normalized = raw.trim().toLowerCase()
  if (HUB_PROVIDER_KINDS.has(normalized)) return normalized as ProviderKind
  return null
}

export function resolveHubInstanceId(input: {
  readonly state: AppState
  readonly providerKind: ProviderKind
  readonly threadId: string
  readonly explicitInstanceId?: string | null
  readonly operation: string
  readonly requireBinding: boolean
}): string | null {
  if (input.explicitInstanceId) return input.explicitInstanceId
  const binding =
    input.state.providerSessionBindings.getLatestForThreadProvider(
      input.threadId,
      input.providerKind
    )
  if (binding) return binding.providerInstanceId
  if (!input.requireBinding) return null
  throw new HttpError(
    409,
    `Cannot ${input.operation} for thread '${input.threadId}' because no provider session binding exists.`
  )
}

function recordPendingSourceProposedPlanImplementation(
  state: AppState,
  input: {
    readonly sourceProposedPlan?: { threadId: string; planId: string } | null
    readonly implementationThreadId: string
    readonly providerKind: string
    readonly providerInstanceId?: string | null
    readonly acceptedTurnId: string
  }
): void {
  const source = input.sourceProposedPlan
  if (!source) return

  state.sourceProposedPlanImplementations?.recordPending({
    sourceProposedPlan: source,
    implementationThreadId: input.implementationThreadId,
    providerKind: input.providerKind,
    providerInstanceId: input.providerInstanceId ?? null,
    acceptedTurnId: input.acceptedTurnId,
  })
}

function clearPendingSourceProposedPlanImplementation(
  state: AppState,
  input: {
    readonly sourceProposedPlan?: { threadId: string; planId: string } | null
    readonly implementationThreadId: string
    readonly providerKind: string
    readonly providerInstanceId?: string | null
    readonly acceptedTurnId?: string | null
  }
): void {
  if (!input.sourceProposedPlan) return
  state.sourceProposedPlanImplementations?.clearPending?.({
    implementationThreadId: input.implementationThreadId,
    providerKind: input.providerKind,
    providerInstanceId: input.providerInstanceId ?? null,
    acceptedTurnId: input.acceptedTurnId ?? null,
  })
}

function reserveDispatchTurn(
  state: AppState,
  threadId: string,
  owner: string
): symbol {
  const coordinator = state.threadTurnCoordinator
  const token = coordinator.reserveTurn(threadId, owner)
  if (!token) {
    throw new HttpError(
      409,
      `Thread '${threadId}' already has active provider work.`,
      "turn_active"
    )
  }
  return token
}

export function chatRecoveryWorkspaces(
  state: AppState,
  threadId: string,
  explicitWorkspace?: string | null
): string[] {
  return [
    ...new Set(
      [explicitWorkspace, ...recoveryWorkspacesForThread(state, threadId)]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ]
}

function releaseLeaseWhenSettled(
  lease: WorkspaceRecoveryLease | null,
  completion: Promise<unknown>
): void {
  if (!lease) return
  void completion.then(
    () => lease.release(),
    () => lease.release()
  )
}

export async function prepareChatSendBody(
  state: AppState,
  body: ChatSendBody
): Promise<ChatSendBody> {
  const boundPath = await resolveChatWorkspaceRoot(
    state,
    body.thread_id,
    body.project_path
  )
  // Give folderless turns an explicit root so adapters never default to the
  // application's install directory. Approved shell commands still run under
  // the user's account; this root is not an operating-system sandbox.
  const projectPath =
    boundPath ??
    (await ensureScratchWorkspace(state.config?.dataDir, body.thread_id))
  let effectiveBody: ChatSendBody = {
    ...body,
    project_path: projectPath,
  }
  const policy = state.agentPermissions

  const trust = policy.evaluateTurnTrust({
    workspacePath: projectPath,
    appMode: body.app_mode,
  })
  if (trust.decision === "deny") {
    throw new HttpError(
      403,
      trust.reason,
      trust.source === "workspace_trust"
        ? "workspace_untrusted"
        : "agent_workspace_required"
    )
  }

  // Not gated on `app_mode`. Lowering a broad preset when the user has
  // configured an ask/deny grant is what stops a provider from executing that
  // tool without ever emitting an approval request — Codex in `bypass` gets
  // `approvalPolicy: "never"` + `sandbox: "danger-full-access"` and asks for
  // nothing, so there is no request for the hub to intercept. Skipping this in
  // Editor/Canvas mode meant an explicit deny grant was simply ignored there.
  const hasRestrictiveGrants =
    projectPath !== null &&
    typeof policy.hasRestrictiveGrants === "function" &&
    policy.hasRestrictiveGrants(projectPath)
  if (!hasRestrictiveGrants) return effectiveBody

  // Keep hard read-only and chat-mode ceilings intact. Every broader preset
  // is lowered before ProviderHub chooses/restarts a session, which maps this
  // to the provider-neutral `approval-required` runtime mode.
  effectiveBody = {
    ...effectiveBody,
    permission_level:
      normalizeLevel(body.permission_level) === "read-only"
        ? "read-only"
        : "ask-on-edit",
  }
  return effectiveBody
}

export async function dispatchChatTurn(
  state: AppState,
  parsedBody: ChatSendBody,
  reserveRemoteTurn: () => RemoteProviderTurnReservation | null,
  goalHooks?: { guard: () => void; started: (turn: GoalTurn) => void }
): Promise<ChatSendResponse> {
  const prepared = await prepareChatSendBody(state, parsedBody)
  const body = prepared
  // Element references are persisted with the message; their text is already
  // in the prompt. Never hand their metadata to a provider as a file.
  const providerAttachments = body.attachments.filter(
    (attachment) => attachment.type !== BROWSER_ELEMENT_ATTACHMENT_TYPE
  )
  const remoteProviderReservation = reserveRemoteTurn()
  let remoteProviderReservationTransferred = false
  try {
    const recoveryWorkspaces = chatRecoveryWorkspaces(
      state,
      body.thread_id,
      body.project_path
    )
    const workspaceLease = await acquireCheckpointRecoveryMutationLease(state, {
      threadIds: [body.thread_id],
      // Adapters launched without an explicit cwd inherit the backend
      // process cwd. Gate that exact fallback instead of leaving a
      // project-less provider turn outside repository recovery.
      workspaces:
        recoveryWorkspaces.length > 0 ? recoveryWorkspaces : [process.cwd()],
    })
    let workspaceLeaseTransferred = false
    try {
      const hubKind = asHubProviderKind(body.provider_kind)
      const useHub = Boolean(
        hubKind && (state.providerHub.has(hubKind) || body.provider_instance_id)
      )
      const hubProviderInstanceId =
        useHub && hubKind
          ? resolveHubInstanceId({
              state,
              providerKind: hubKind,
              threadId: body.thread_id,
              explicitInstanceId:
                body.provider_instance_id ?? body.model_selection?.instanceId,
              operation: "send turn",
              requireBinding: false,
            })
          : null
      const legacyKind = useHub
        ? null
        : state.providers.resolveProviderKind(body.provider_kind)
      const effectiveProviderKind = hubKind ?? legacyKind!
      // Keep the idempotency identity tied to the caller's request. A Hub
      // instance inferred from mutable session state is an execution detail,
      // not part of the immutable retry fingerprint.
      const effectiveProviderInstanceId =
        body.provider_instance_id ?? body.model_selection?.instanceId ?? null
      const admissionId = Symbol("chat-dispatch-admission")
      const requestFingerprint = body.user_message_id
        ? dispatchRequestFingerprint(
            body,
            body.user_message_id,
            effectiveProviderKind,
            effectiveProviderInstanceId
          )
        : null
      const inFlightLookup = {
        dispatchId: body.user_message_id,
        threadId: body.thread_id,
        fingerprint: requestFingerprint,
        selfId: admissionId,
      }
      const inFlight = findInFlightAdmission(state, inFlightLookup)
      if (inFlight) return await replayInFlightAdmission(inFlight)
      const existingDispatch = existingDurableChatDispatch(
        state,
        body,
        effectiveProviderKind,
        effectiveProviderInstanceId
      )
      if (existingDispatch) {
        return existingDispatchResponse(existingDispatch)
      }
      // The admission is registered from inside `admit()` the moment the
      // thread token is reserved — not before — so two racers on one thread
      // cannot both register: the loser's reservation fails, it looks the
      // winner up and replays it. Its response is a deferred that the
      // outer flow settles from `admit()`'s outcome.
      const admissions = inFlightAdmissionsFor(state)
      const admissionKey =
        body.user_message_id && requestFingerprint
          ? inFlightAdmissionKey(body.thread_id, body.user_message_id)
          : null
      let resolveAdmission: (value: ChatSendResponse) => void = () => {}
      let rejectAdmission: (reason: unknown) => void = () => {}
      const admission: InFlightAdmission | null =
        admissionKey && requestFingerprint
          ? {
              id: admissionId,
              threadId: body.thread_id,
              fingerprint: requestFingerprint,
              response: new Promise<ChatSendResponse>((resolve, reject) => {
                resolveAdmission = resolve
                rejectAdmission = reject
              }),
            }
          : null
      // Replayers observe the rejection through their own `await`; without a
      // handler here an admission nobody replayed would surface as an
      // unhandled rejection.
      admission?.response.catch(() => undefined)
      const registerAdmission = (): void => {
        if (admission && admissionKey) admissions.set(admissionKey, admission)
      }
      const admit = async (): Promise<ChatSendResponse> => {
        // A client that does not prepare its turns (the phone app) gets the
        // desktop's preparation: its hooks run first, and one that fails
        // refuses the message before anything is recorded. A goal's turns
        // were prepared with the /goal command (controlThreadGoal), as on
        // the desktop; each still gets the instruction.
        const prepared = body.prepare_turn === true
        if (prepared && !goalHooks) await runMessageSendHooks(state, body)
        const baseSystemInstruction =
          prepared && !body.system_instruction?.trim()
            ? await buildPreparedTurnInstruction(state, body)
            : body.system_instruction
        const effectiveSystemInstruction = await resolveTurnSystemInstruction(
          state,
          {
            workspaceRoot: body.project_path,
            targetPath: body.rule_target_path,
            systemInstruction: baseSystemInstruction,
          }
        )
        let sharedToken: symbol | undefined
        let tokenTransferred = false
        let providerAdmissionStarted = false
        let persistedUserMessageId: string | null = null
        try {
          // Reserve the cross-provider thread token before creating a
          // dispatch row. This prevents two different HTTP callers from
          // persisting pending user turns on the same thread while one of
          // them is generating a pre-turn compaction checkpoint.
          try {
            sharedToken = reserveDispatchTurn(
              state,
              body.thread_id,
              `http:${useHub ? `hub:${hubKind}` : `legacy:${legacyKind}`}`
            )
          } catch (error) {
            if (!isTurnActiveError(error)) throw error
            // The thread is busy. If it is busy with *this very request* —
            // an identical retry that raced the original past the durable
            // check above — replay it instead of reporting a conflict.
            const racedAdmission = findInFlightAdmission(state, inFlightLookup)
            if (racedAdmission)
              return await replayInFlightAdmission(racedAdmission)
            const racedDispatch = existingDurableChatDispatch(
              state,
              body,
              effectiveProviderKind,
              effectiveProviderInstanceId
            )
            if (racedDispatch) return existingDispatchResponse(racedDispatch)
            throw error
          }
          registerAdmission()
          if (remoteProviderReservation) {
            state.remoteProviderTurns?.assertActive(remoteProviderReservation)
          }
          if (useHub && hubKind) {
            state.providerHub.assertCanStartTurn?.(
              hubKind,
              body.thread_id,
              hubProviderInstanceId
            )
          }
          if (legacyKind) {
            state.providers.assertCanDispatch?.(body.thread_id, legacyKind)
          }

          goalHooks?.guard()
          if (!goalHooks)
            threadGoals.get(state)?.pauseForMessage(body.thread_id)
          const durableDispatch = reserveDurableChatDispatch(
            state,
            body,
            effectiveProviderKind,
            effectiveProviderInstanceId
          )
          if (durableDispatch?.reservation.kind === "existing") {
            return existingDispatchResponse(durableDispatch.reservation.record)
          }
          persistedUserMessageId = durableDispatch?.messageId ?? null
          if (!durableDispatch) {
            persistedUserMessageId = persistDispatchUserMessage(state, body)
          }
          const dispatchMessageId = persistedUserMessageId
          const providerHandoff = await prepareProviderHandoff(
            state,
            body,
            effectiveProviderKind,
            dispatchMessageId
          )
          const automaticCompaction = providerHandoff
            ? null
            : await compactAutomaticallyBeforeSend(
                state,
                body,
                dispatchMessageId
              )
          const providerHistory = providerHistoryForDispatch(
            state,
            body,
            persistedUserMessageId
          )
          setSessionPermission(body.thread_id, body.permission_level)
          const orchestrated = state.orchestrator
            ? await state.orchestrator.prepareForTurn({
                ...body,
                provider_instance_id:
                  hubProviderInstanceId ?? body.provider_instance_id,
              })
            : body
          goalHooks?.guard()
          state.orchestrator?.assertDispatchAllowed(body.thread_id)
          // Hub and legacy providers share the admission, permission,
          // compaction, and durable-dispatch work above. The launch below
          // is the only provider-specific step; settlement (owner attach,
          // accepted receipt, error mapping) stays in this function.
          if (useHub && hubKind) {
            const providerInstanceId = hubProviderInstanceId
            let durableProviderInstanceId = providerInstanceId
            let acceptedTurnId: string | null = null
            // Transfer the token reserved before durable message persistence;
            // the Hub owns and releases it after this call succeeds.
            try {
              const turn = state.providerHub.startTurn(
                hubKind,
                {
                  providerInstanceId: providerInstanceId ?? undefined,
                  threadId: body.thread_id,
                  message: orchestrated.message,
                  modelId: body.model_id,
                  modelSelection: body.model_selection ?? undefined,
                  history: providerHistory,
                  ...(providerAttachments.length > 0
                    ? { attachments: providerAttachments }
                    : {}),
                  projectPath: body.project_path ?? null,
                  systemInstruction: effectiveSystemInstruction,
                  permissionLevel: body.permission_level ?? undefined,
                  reasoningEffort: body.reasoning_effort ?? null,
                  chatMode: body.chat_mode ?? null,
                  appMode: body.app_mode ?? null,
                  designContext: body.design_context ?? null,
                  collaborationMode: body.collaborationMode,
                  // Codex Fast Mode (priority compute, serviceTier: "fast").
                  // Boolean flag — adapter decides whether to forward to wire
                  // based on per-model `additionalSpeedTiers` capability.
                  fastMode: body.fast_mode ?? null,
                  sourceProposedPlan: body.source_proposed_plan,
                },
                {
                  bindings: state.providerSessionBindings,
                  sharedToken,
                  onAccepted: (turnId, acceptedProviderInstanceId) => {
                    acceptedTurnId = turnId
                    durableProviderInstanceId =
                      acceptedProviderInstanceId ?? providerInstanceId
                    bindDispatchProviderTurn(state, {
                      messageId: dispatchMessageId,
                      providerTurnId: turnId,
                      providerInstanceId: durableProviderInstanceId,
                    })
                    recordPendingSourceProposedPlanImplementation(state, {
                      sourceProposedPlan: body.source_proposed_plan,
                      implementationThreadId: body.thread_id,
                      providerKind: hubKind,
                      providerInstanceId: durableProviderInstanceId,
                      acceptedTurnId: turnId,
                    })
                  },
                }
              )
              goalHooks?.started({
                turnId: turn.turnId,
                settled: turn.settled ?? turn.completion,
              })
              const ownerAttachment =
                remoteProviderReservation && state.remoteProviderTurns
                  ? state.remoteProviderTurns.attach(
                      remoteProviderReservation,
                      {
                        turnId: turn.turnId,
                        settled: turn.settled ?? turn.completion,
                        interrupt: () =>
                          state.providerHub.interruptTurnIfActive(
                            toThreadId(body.thread_id),
                            turn.turnId
                          ),
                      }
                    )
                  : Promise.resolve()
              remoteProviderReservationTransferred =
                remoteProviderReservation !== null
              providerAdmissionStarted = true
              tokenTransferred = true
              releaseLeaseWhenSettled(
                workspaceLease,
                turn.settled ?? turn.completion
              )
              workspaceLeaseTransferred = true
              void turn.completion.catch((err) => {
                if (dispatchMessageId) {
                  markRejectedDispatchMessage(state, {
                    threadId: body.thread_id,
                    messageId: dispatchMessageId,
                    phase: "asynchronous",
                    error: err,
                  })
                }
                clearPendingSourceProposedPlanImplementation(state, {
                  sourceProposedPlan: body.source_proposed_plan,
                  implementationThreadId: body.thread_id,
                  providerKind: hubKind,
                  providerInstanceId: durableProviderInstanceId,
                  acceptedTurnId: turn.turnId,
                })
                logger.error(
                  {
                    err: (err as Error).message,
                    thread: body.thread_id,
                    provider: hubKind,
                  },
                  "hub sendTurn failed"
                )
              })
              markAcceptedDispatchMessage(state, {
                messageId: dispatchMessageId,
                providerTurnId: turn.turnId,
                providerInstanceId: durableProviderInstanceId,
              })
              await ownerAttachment
              return {
                status: "streaming",
                turnId: turn.turnId,
                ...(automaticCompaction ? { automaticCompaction } : {}),
                ...(providerHandoff ? { providerHandoff } : {}),
              }
            } catch (err) {
              clearPendingSourceProposedPlanImplementation(state, {
                sourceProposedPlan: body.source_proposed_plan,
                implementationThreadId: body.thread_id,
                providerKind: hubKind,
                providerInstanceId: durableProviderInstanceId,
                acceptedTurnId,
              })
              throw err
            }
          }
          const kind = legacyKind!
          let acceptedTurnId: string | null = null
          const input: ProviderSendTurnInput = {
            thread_id: body.thread_id,
            message: orchestrated.message,
            model_id: body.model_id,
            reasoning_effort: body.reasoning_effort,
            chat_mode: body.chat_mode,
            app_mode: body.app_mode,
            design_context: body.design_context,
            project_path: body.project_path,
            history: providerHistory,
            ...(providerAttachments.length > 0
              ? { attachments: providerAttachments }
              : {}),
            system_instruction: effectiveSystemInstruction,
            permission_level: body.permission_level,
            openai_transport: body.openai_transport,
            sandbox: body.sandbox,
            approvalPolicy: body.approvalPolicy,
            personality: body.personality,
            serviceTier: body.serviceTier,
            effort: body.effort,
            collaborationMode: body.collaborationMode,
            sourceProposedPlan: body.source_proposed_plan,
          }
          try {
            const turn = state.providers.dispatchTurnWithHandle(input, kind, {
              sharedToken,
              onAccepted: (turnId) => {
                acceptedTurnId = turnId
                bindDispatchProviderTurn(state, {
                  messageId: dispatchMessageId,
                  providerTurnId: turnId,
                  providerInstanceId: body.provider_instance_id,
                })
                recordPendingSourceProposedPlanImplementation(state, {
                  sourceProposedPlan: body.source_proposed_plan,
                  implementationThreadId: body.thread_id,
                  providerKind: kind,
                  providerInstanceId: body.provider_instance_id,
                  acceptedTurnId: turnId,
                })
              },
            })
            const ownerAttachment =
              remoteProviderReservation && state.remoteProviderTurns
                ? state.remoteProviderTurns.attach(remoteProviderReservation, {
                    turnId: turn.turnId,
                    settled: turn.settled ?? turn.completion,
                    interrupt: () =>
                      state.providers.interruptTurnIfActive(
                        body.thread_id,
                        turn.turnId
                      ),
                  })
                : Promise.resolve()
            remoteProviderReservationTransferred =
              remoteProviderReservation !== null
            providerAdmissionStarted = true
            tokenTransferred = true
            releaseLeaseWhenSettled(
              workspaceLease,
              turn.settled ?? turn.completion
            )
            workspaceLeaseTransferred = true
            void turn.completion.catch((err) => {
              if (dispatchMessageId) {
                markRejectedDispatchMessage(state, {
                  threadId: body.thread_id,
                  messageId: dispatchMessageId,
                  phase: "asynchronous",
                  error: err,
                })
              }
              clearPendingSourceProposedPlanImplementation(state, {
                sourceProposedPlan: body.source_proposed_plan,
                implementationThreadId: body.thread_id,
                providerKind: kind,
                providerInstanceId: body.provider_instance_id,
                acceptedTurnId: turn.turnId,
              })
              logger.error(
                {
                  errorType: errorType(err),
                  thread: body.thread_id,
                  provider: kind,
                },
                "legacy sendTurn failed"
              )
            })
            markAcceptedDispatchMessage(state, {
              messageId: dispatchMessageId,
              providerTurnId: turn.turnId,
              providerInstanceId: body.provider_instance_id,
            })
            await ownerAttachment
            return {
              status: "streaming",
              turnId: turn.turnId,
              ...(automaticCompaction ? { automaticCompaction } : {}),
              ...(providerHandoff ? { providerHandoff } : {}),
            }
          } catch (err) {
            clearPendingSourceProposedPlanImplementation(state, {
              sourceProposedPlan: body.source_proposed_plan,
              implementationThreadId: body.thread_id,
              providerKind: kind,
              providerInstanceId: body.provider_instance_id,
              acceptedTurnId,
            })
            throw err
          }
        } catch (err) {
          if (persistedUserMessageId && !providerAdmissionStarted) {
            markRejectedDispatchMessage(state, {
              threadId: body.thread_id,
              messageId: persistedUserMessageId,
              phase: "synchronous",
              error: err,
            })
          }
          throw err
        } finally {
          if (sharedToken && !tokenTransferred) {
            state.threadTurnCoordinator.releaseTurn(body.thread_id, sharedToken)
          }
        }
      }
      const response = admit()
      response.then(resolveAdmission, rejectAdmission)
      try {
        return await response
      } finally {
        if (
          admission &&
          admissionKey &&
          admissions.get(admissionKey) === admission
        ) {
          admissions.delete(admissionKey)
        }
      }
    } finally {
      if (!workspaceLeaseTransferred) workspaceLease?.release()
    }
  } finally {
    if (remoteProviderReservation && !remoteProviderReservationTransferred) {
      state.remoteProviderTurns?.cancel(remoteProviderReservation)
    }
  }
}
