import { useRef, useState } from "react"
import {
  PROVIDER_HANDOFF_ACTIVITY,
  isRecord,
  parseRealtimeEvent,
  providerHandoffProgressSchema,
} from "@betterc0de/schema"
import { handleProviderEvent } from "@/lib/provider-events"
import { useChatStore } from "@/lib/chat-store"
import { useWsConnection } from "@/hooks/use-ws-connection"
import { useProviderEvents } from "@/hooks/use-provider-events"
import { maybeNotifyRuntimeEvent } from "@/lib/native-notifications"
import { mergeCanonicalRuntimeEventFields } from "@/lib/provider-runtime-event-fields"
import type { UiProvider } from "@/lib/provider-types"
import type { SetPlanModalContent } from "@/lib/plan-modal"
import { loadMessages } from "@/services/backend/coreApi"
import { reportDroppedRealtimeEvent } from "@/services/backend/wsClient"
import { remoteTitleChange } from "@/lib/thread-metadata-sync"
import { storedThreadSettingsChange } from "@/lib/thread-settings-sync"
import { applyThreadResumePush } from "@/lib/chat-resume-store"

/**
 * Wires up every "inbound event from a provider" subscription the app
 * needs, in one hook:
 *  - WebSocket connection to the local backend (+ reconnect logic).
 *  - Claude Agent SDK events via Electron IPC.
 *  - Generic plugin events via Electron IPC.
 *  - Multi-Agent Swarm start / turn-complete `window` events.
 *
 * All four converge on `handleProviderEvent`, which dispatches into
 * the chat store. The two callbacks the dispatcher needs — opening the
 * plan modal and responding to tool-approval requests — come in as
 * props so the hook stays agnostic about where those live in the app.
 *
 * Every WebSocket payload is parsed with its channel's schema
 * (`parseRealtimeEvent`, `@betterc0de/schema`) before it reaches a store; a
 * frame that does not match is dropped and logged, never cast.
 *
 * Returns `wsRef` + `wsReady` for callers that want to inspect the
 * connection state (e.g. to show a reconnect toast).
 */
export function useChatEventBus({
  setPlanModalContent,
  respondToolApproval,
  providers,
}: {
  setPlanModalContent: SetPlanModalContent
  respondToolApproval: (
    id: string,
    approved: boolean,
    ctx?: { pluginId?: string }
  ) => void
  providers: UiProvider[]
}) {
  const wsRef = useRef<WebSocket | null>(null)
  const [wsReady, setWsReady] = useState(false)

  useWsConnection({
    wsRef,
    setWsReady,
    onEvent: (frame) => {
      const parsed = parseRealtimeEvent(frame.channel, frame.data)
      if (parsed.kind === "unknown") return
      if (parsed.kind === "invalid") {
        reportDroppedRealtimeEvent(parsed.channel, parsed.issue)
        return
      }
      const event = parsed.event

      if (event.channel === "provider.replayGap") {
        const store = useChatStore.getState()
        const loadedThreadIds = store.threads
          .map((thread) => thread.id)
          .filter(
            (threadId) =>
              store.messagesLoadedByThread[threadId] ||
              store.activitiesLoadedByThread[threadId]
          )
        for (const threadId of loadedThreadIds) store.clearStreaming(threadId)
        void Promise.all(
          loadedThreadIds.flatMap((threadId) => [
            store.hydrateThreadMessages(threadId, true),
            store.hydrateThreadActivities(threadId, true),
          ])
        )
        return
      }

      // A chat renamed on a paired phone (thread-metadata-sync.ts), or its
      // settings changed on another client (thread-settings-sync.ts).
      if (event.channel === "thread.metadata") {
        const store = useChatStore.getState()
        const change = remoteTitleChange(store.threads, event.data)
        if (change) store.updateThreadTitle(change.threadId, change.title)
        const { threadId, settings } = event.data
        if (settings) {
          void storedThreadSettingsChange(settings).then(
            (settingsChange) =>
              useChatStore
                .getState()
                .applyStoredThreadSettings(threadId, settingsChange),
            (error: unknown) => {
              console.warn("[thread-settings] push not applied", error)
            }
          )
        }
        // A limit or a restart stopped the chat, or it resumed (chat-resume-store).
        if (event.data.resume !== undefined)
          applyThreadResumePush(
            threadId,
            event.data.resume,
            event.data.resumePrompt
          )
        return
      }

      if (event.channel === "thread.activity") {
        const activity = event.data
        if (activity.threadId && activity.id) {
          useChatStore
            .getState()
            .upsertThreadActivity(activity.threadId, activity)
          if (activity.kind === PROVIDER_HANDOFF_ACTIVITY) {
            const progress = providerHandoffProgressSchema.safeParse(
              activity.payload
            )
            if (progress.success && progress.data.status === "completed") {
              // The checkpoint is committed before this notification. Fetch it
              // even if starting the next provider subsequently fails.
              void loadMessages(activity.threadId)
                .then((messages) => {
                  const checkpoint = messages.find(
                    (message) =>
                      message.id === progress.data.checkpointMessageId
                  )
                  const store = useChatStore.getState()
                  const thread = store.threads.find(
                    (thread) => thread.id === activity.threadId
                  )
                  const activityStillPresent = store.activitiesByThread[
                    activity.threadId
                  ]?.some((current) => current.id === activity.id)
                  if (
                    checkpoint &&
                    thread &&
                    activityStillPresent &&
                    store.messagesLoadedByThread[activity.threadId] &&
                    !thread.messages.some(
                      (message) => message.id === checkpoint.id
                    )
                  ) {
                    // Merge just this checkpoint. Replacing the whole transcript
                    // could erase an answer that streamed while the read ran.
                    store.addMessage(activity.threadId, checkpoint, {
                      persist: false,
                    })
                  }
                })
                .catch(() => {
                  // sendChatMessage also projects the checkpoint from its response;
                  // reconnect hydration retries the durable read if HTTP failed.
                })
            }
          }
        }
        return
      }

      if (event.channel === "provider.runtimeEvent") {
        const { data, eventType, threadId } = event
        const payload = mergeCanonicalRuntimeEventFields(
          isRecord(data.payload) ? data.payload : data,
          data
        )
        maybeNotifyRuntimeEvent({ threadId, type: eventType, payload })
        handleProviderEvent(threadId, eventType, payload, {
          setPlanModalContent,
          projectActivities: false,
          respondToolApproval,
        })
      }
    },
    depKey: respondToolApproval,
  })

  useProviderEvents({
    setPlanModalContent,
    respondToolApproval,
    providers,
  })

  return { wsRef, wsReady }
}
