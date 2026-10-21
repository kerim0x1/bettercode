import {
  BROWSER_ELEMENT_ATTACHMENT_TYPE,
  type ChatSteerBody,
} from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { threadId as toThreadId } from "../../provider/runtime"
import { resolveChatWorkspaceRoot } from "../workspace/authorization"
import { autoSaveConversationsEnabled } from "./automatic-compaction"
import { asHubProviderKind, resolveHubInstanceId } from "./dispatch"
import { withChatRecoveryMutation } from "./requests"
import { runMessageSendHooks } from "./turn-preparation"

export type ChatSteerStatus =
  | "steered"
  | "unsupported"
  | "not_running"
  | "not_steerable"

/**
 * `/chat/steer`: puts a user message into the chat's running turn so the
 * agent changes course without stopping. Only the provider that runs the
 * turn can take it (`ProviderAdapterShape.steerTurn`, today Codex); anything
 * else answers `unsupported` and the desktop stops the turn and sends the
 * message next instead. Nothing is stored or sent unless the answer is
 * `steered`.
 *
 * The message passes the user's "on message send" hooks like any other, so
 * a hook that blocks a message blocks it here too. Once the provider took
 * it, it is stored as a user message of the chat, in front of the turn's
 * answer (`persistSteeredUserMessage`).
 */
export async function steerChatTurn(
  state: AppState,
  body: ChatSteerBody
): Promise<{ status: ChatSteerStatus }> {
  if (
    autoSaveConversationsEnabled(state) &&
    !state.threads.hasThread(body.threadId)
  )
    throw new HttpError(
      404,
      `Chat '${body.threadId}' was not found.`,
      "thread_not_found"
    )
  // Provider plugins and the API providers run a turn as one request; they
  // take no input until it ends.
  const hubKind = asHubProviderKind(body.providerKind)
  if (!hubKind) return { status: "unsupported" }
  return withChatRecoveryMutation(
    state,
    body.threadId,
    async (): Promise<{ status: ChatSteerStatus }> => {
      const instanceId = resolveHubInstanceId({
        state,
        providerKind: hubKind,
        threadId: body.threadId,
        explicitInstanceId: body.providerInstanceId,
        operation: "steer the running turn",
        requireBinding: false,
      })
      const adapter = state.providerHub.resolve({
        provider: hubKind,
        instanceId,
      })
      if (!adapter?.steerTurn) return { status: "unsupported" }
      const thread = toThreadId(body.threadId)
      if (!adapter.hasSession(thread)) return { status: "not_running" }

      const projectPath = await resolveChatWorkspaceRoot(
        state,
        body.threadId,
        null
      )
      await runMessageSendHooks(state, {
        thread_id: body.threadId,
        message: body.message,
        model_id: body.modelId ?? "",
        provider_kind: body.providerKind,
        provider_instance_id: instanceId,
        project_path: projectPath,
      })
      const result = await adapter.steerTurn({
        threadId: thread,
        message: body.message,
        // Picked browser elements are already in the text; their attachments
        // only describe them for the transcript.
        attachments: body.attachments.filter(
          (attachment) => attachment.type !== BROWSER_ELEMENT_ATTACHMENT_TYPE
        ),
      })
      if (result.status === "steered")
        persistSteeredMessage(state, body, projectPath)
      return { status: result.status }
    }
  )
}

function persistSteeredMessage(
  state: AppState,
  body: ChatSteerBody,
  projectPath: string | null
): void {
  if (!autoSaveConversationsEnabled(state)) return
  const createdAt = body.userMessageCreatedAt ?? new Date().toISOString()
  state.threads.persistSteeredUserMessage(
    {
      thread_id: body.threadId,
      // The chat exists; its title and project are left as they are.
      title: "New Chat",
      project_name: "BetterC0de",
      project_path: projectPath ?? "",
      created_at: createdAt,
      message: {
        message_id: body.userMessageId,
        turn_id: null,
        role: "user",
        content: body.userMessageContent ?? body.message,
        created_at: createdAt,
        extra: {
          ...(body.modelId ? { modelId: body.modelId } : {}),
          providerKind: body.providerKind,
          ...(body.attachments.length > 0
            ? { attachments: body.attachments }
            : {}),
        },
      },
    },
    state.chatDispatches.getActiveForThread(body.threadId)?.messageId ?? null
  )
}
