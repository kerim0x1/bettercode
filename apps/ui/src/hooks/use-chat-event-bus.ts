import { useRef, useState } from "react"
import {
  PROVIDER_HANDOFF_ACTIVITY,
  providerHandoffProgressSchema,
} from "@betterc0de/schema"
import { handleProviderEvent } from "@/lib/provider-events"
import { useChatStore, type ThreadActivity } from "@/lib/chat-store"
import { useWsConnection } from "@/hooks/use-ws-connection"
import { useProviderEvents } from "@/hooks/use-provider-events"
import { maybeNotifyRuntimeEvent } from "@/lib/native-notifications"
import { mergeCanonicalRuntimeEventFields } from "@/lib/provider-runtime-event-fields"
import type { UiProvider } from "@/lib/provider-types"
import type { SetPlanModalContent } from "@/lib/plan-modal"
import { loadMessages } from "@/services/backend/coreApi"
import { remoteTitleChange } from "@/lib/thread-metadata-sync"

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
    onEvent: (event) => {
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

      // A chat renamed on a paired phone; see thread-metadata-sync.ts.
      if (event.channel === "thread.metadata") {
        const store = useChatStore.getState()
        const change = remoteTitleChange(store.threads, event.data)
        if (change) store.updateThreadTitle(change.threadId, change.title)
        return
      }

      if (event.channel === "thread.activity") {
        const activity = event.data as ThreadActivity
        if (activity?.threadId && activity?.id) {
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
        const data = event.data as Record<string, unknown> & {
          event_type?: string
          thread_id?: string
          type?: string
          threadId?: string
          payload?: Record<string, unknown>
        }
        const eventType = data.event_type ?? data.type
        const threadId = data.thread_id ?? data.threadId
        if (!eventType || !threadId) return
        const payload = mergeCanonicalRuntimeEventFields(
          data.payload ?? data,
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
