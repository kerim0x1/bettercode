import {
  chatInterruptSchema,
  chatRotateSessionSchema,
} from "@betterc0de/schema"
import type { z } from "zod"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { threadId as toThreadId } from "../../provider/runtime"
import { autoCompactionContextSnapshot } from "../auto-compaction"
import { asHubProviderKind, resolveHubInstanceId } from "./dispatch"
import { markActiveDispatchInterrupted } from "./dispatch-lifecycle"
import { withChatRecoveryMutation } from "./requests"
import { threadGoals } from "./goal-registry"
import { chatResumes } from "./resume-registry"

export async function interruptChatTurn(
  state: AppState,
  body: z.output<typeof chatInterruptSchema>
): Promise<{ status: "interrupted" }> {
  threadGoals.get(state)?.pauseForMessage(body.threadId)
  // A stopped chat is neither resumed after a limit nor after a restart.
  chatResumes.get(state)?.noteUserStop(body.threadId)
  const interrupt = () =>
    withChatRecoveryMutation(
      state,
      body.threadId,
      async (): Promise<{ status: "interrupted" }> => {
        const hubKind = asHubProviderKind(body.providerKind)
        if (
          hubKind &&
          (state.providerHub.has(hubKind) || body.providerInstanceId)
        ) {
          const providerInstanceId = resolveHubInstanceId({
            state,
            providerKind: hubKind,
            threadId: body.threadId,
            explicitInstanceId: body.providerInstanceId,
            operation: "interrupt",
            requireBinding: true,
          })
          await state.providerHub.interruptTurnForInstance(
            hubKind,
            toThreadId(body.threadId),
            providerInstanceId,
            state.providerSessionBindings
          )
          markActiveDispatchInterrupted(state, body.threadId)
          return { status: "interrupted" }
        }
        const kind = state.providers.resolveProviderKind(body.providerKind)
        await state.providers.interrupt(kind, body.threadId)
        markActiveDispatchInterrupted(state, body.threadId)
        return { status: "interrupted" }
      }
    )
  return state.orchestrator.withInterruptedChildren(body.threadId, interrupt)
}

export async function rotateChatSession(
  state: AppState,
  body: z.output<typeof chatRotateSessionSchema>
) {
  return withChatRecoveryMutation(state, body.threadId, () =>
    state.providerHub.withThreadMaintenance(body.threadId, () =>
      state.providers.withThreadMaintenance(body.threadId, async () => {
        const existing = state.threads.findCompactionCommit(
          body.threadId,
          body.checkpointMessageId,
          {
            checkpointContent: body.checkpointContent,
            commandMessageId: body.commandMessageId,
            commandContent: body.commandContent,
          }
        )
        if (existing) {
          return {
            rotated: true,
            generation: existing.generation,
            messageId: existing.messageId,
          }
        }

        if (body.autoCompactionPrecondition) {
          const currentContext = autoCompactionContextSnapshot(
            state.threads.listMessages(body.threadId, { limit: 2_000 })
          )
          if (
            currentContext.compactionGeneration !==
              body.autoCompactionPrecondition.compactionGeneration ||
            currentContext.lastMessageId !==
              body.autoCompactionPrecondition.lastMessageId
          ) {
            throw new HttpError(
              409,
              `Automatic compaction decision for thread '${body.threadId}' is stale.`,
              "compaction_decision_stale"
            )
          }
        }

        const bindings = state.providerSessionBindings
          .list()
          .filter((binding) => binding.threadId === body.threadId)
        const active = bindings.find(
          (binding) =>
            binding.activeTurnId ||
            binding.status === "starting" ||
            binding.status === "running" ||
            binding.status === "closing"
        )
        if (active) {
          throw new HttpError(
            409,
            `Cannot compact thread '${body.threadId}' while a provider turn is active.`,
            "turn_active"
          )
        }

        // External session shutdown cannot participate in SQLite's
        // transaction. Complete every stop first; only then atomically write
        // command + checkpoint and advance the thread-wide provider epoch.
        await Promise.all(
          bindings.map((binding) =>
            state.providerHub.stopSession(
              binding.providerKind,
              toThreadId(body.threadId),
              binding.providerInstanceId
            )
          )
        )
        const committed = state.threads.commitCompaction({
          thread_id: body.threadId,
          request_id: body.checkpointMessageId,
          command_message: {
            message_id: body.commandMessageId,
            turn_id: null,
            role: "user",
            content: body.commandContent,
            created_at: body.commandCreatedAt,
            extra: {},
          },
          checkpoint_message: {
            message_id: body.checkpointMessageId,
            turn_id: null,
            role: "assistant",
            content: body.checkpointContent,
            created_at: body.checkpointCreatedAt,
            extra: { compactedContext: true },
          },
        })
        return {
          rotated: bindings.length > 0,
          generation: committed.generation,
          messageId: committed.messageId,
        }
      })
    )
  )
}
