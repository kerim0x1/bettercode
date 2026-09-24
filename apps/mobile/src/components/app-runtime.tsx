import { fileDocumentStorage } from "@/lib/file-documents"
import {
  memoryDocumentStorage,
  setDocumentStorage,
} from "@/lib/local-documents"
import { isReplayGapFrame } from "@/lib/runtime-events"
import { useAppStore } from "@/store/app-store"
import { useComposerSettings } from "@/store/composer-settings-store"
import { startQueueRunner } from "@/store/queue-runner"
import { useQueueStore } from "@/store/queue-store"
import { useSessionStore } from "@/store/session-store"
import type { RemoteApi, RemoteChannel } from "@/transport/types"
import { useEffect, useRef } from "react"
import { AppState } from "react-native"

/**
 * Keeps the app connected: restores the pairing at start, opens the live
 * event stream of the current transport (paired desktop or demo), feeds its
 * events into the app store, sends queued messages, and re-checks the
 * session when the app comes back to the foreground and once a minute.
 */
export function AppRuntime() {
  const transport = useSessionStore((state) => state.transport)
  const mode = useSessionStore((state) => state.mode)
  const sessionState = useSessionStore((state) => state.state)
  const hydrate = useSessionStore((state) => state.hydrate)
  const check = useSessionStore((state) => state.check)
  const setSocketState = useSessionStore((state) => state.setSocketState)
  const setProtocol = useSessionStore((state) => state.setProtocol)
  const markAppUpdateRequired = useSessionStore(
    (state) => state.markAppUpdateRequired
  )
  const channelRef = useRef<RemoteChannel | null>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Chat settings and queued messages belong to the connection they were
  // made for: a paired desktop's are kept in the app's documents across
  // restarts, the demo's only in memory, and ending a pairing ends them.
  useEffect(() => {
    if (!mode) return
    setDocumentStorage(
      mode === "live" ? fileDocumentStorage : memoryDocumentStorage()
    )
    useComposerSettings.getState().hydrate()
    useQueueStore.getState().hydrate()
  }, [mode])

  useEffect(() => {
    if (sessionState !== "unpaired") return
    useQueueStore.getState().discardAll()
    useComposerSettings.getState().forgetAll()
  }, [sessionState])

  useEffect(() => {
    if (!transport) {
      channelRef.current?.stop()
      channelRef.current = null
      useAppStore.getState().reset()
      return
    }

    const api = transport.api
    const pendingRefreshes = new Set<ReturnType<typeof setTimeout>>()
    const app = useAppStore.getState()
    app.reset()
    void Promise.allSettled([app.refreshThreads(api), app.refreshProjects(api)])
    const channel = transport.createChannel({
      onState: (state) => {
        setSocketState(state)
        // A reconnect after an outage re-checks the session at once instead
        // of leaving the composer disabled until the next periodic check.
        if (state === "live" && useSessionStore.getState().state !== "online")
          void check()
      },
      onProtocol: setProtocol,
      onUpdateRequired: () => markAppUpdateRequired(),
      // The host refused our token. `check()` clears the pairing when the
      // session is really gone; if the host still accepts it (a race with
      // a token rotation) the channel is told to try again by hand.
      onUnauthorized: () => {
        void check().then((stillPaired) => {
          if (stillPaired && channelRef.current === channel)
            channel.reconnectNow()
        })
      },
      onFrame: (frame) => {
        if (isReplayGapFrame(frame)) {
          void reconcileHydratedState(api)
          return
        }
        const outcome = useAppStore.getState().applyFrame(frame)
        if (!outcome) return
        if (outcome.terminal) {
          const timer = setTimeout(() => {
            pendingRefreshes.delete(timer)
            const store = useAppStore.getState()
            void Promise.allSettled([
              store.loadMessages(api, outcome.threadId, true),
              store.loadActivities(api, outcome.threadId),
              store.refreshThreads(api),
            ])
          }, 180)
          pendingRefreshes.add(timer)
        } else if (outcome.refreshThreads) {
          void useAppStore
            .getState()
            .refreshThreads(api)
            .catch(() => undefined)
        }
      },
    })
    channelRef.current = channel
    channel.start()
    const stopQueue = startQueueRunner(api)

    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return
      channel.reconnectNow()
      void check()
    })
    const healthTimer = setInterval(() => {
      if (AppState.currentState === "active") void check()
    }, 60_000)

    return () => {
      stopQueue()
      for (const timer of pendingRefreshes) clearTimeout(timer)
      clearInterval(healthTimer)
      subscription.remove()
      channel.stop()
      if (channelRef.current === channel) channelRef.current = null
    }
  }, [check, markAppUpdateRequired, setProtocol, setSocketState, transport])

  return null
}

async function reconcileHydratedState(api: RemoteApi): Promise<void> {
  const store = useAppStore.getState()
  const hydratedThreadIds = new Set([
    ...Object.keys(store.messagesByThread),
    ...Object.keys(store.activitiesByThread),
    ...Object.keys(store.requestsByThread),
  ])
  await Promise.allSettled([
    store.refreshThreads(api),
    store.refreshProjects(api),
    ...[...hydratedThreadIds].flatMap((threadId) => [
      store.loadMessages(api, threadId, true),
      store.loadActivities(api, threadId),
    ]),
  ])
  // The gap may have swallowed a turn's terminal event. The thread list is
  // the host's view of what still runs; a stream it does not know about
  // would otherwise spin forever.
  const after = useAppStore.getState()
  for (const [threadId, stream] of Object.entries(after.streamsByThread)) {
    if (!stream.running) continue
    const thread = after.threads.find((item) => item.id === threadId)
    if (thread && !thread.session?.activeTurnId) after.clearStream(threadId)
  }
}
