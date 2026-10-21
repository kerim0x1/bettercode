import { useEffect } from "react"
import { useChatStore } from "@/lib/chat-store"
import { handleError } from "@/lib/errors"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import { usePullRequestWakeStore } from "@/lib/pull-request-wake-store"
import { toast } from "@/lib/toast"
import { githubClaimWakeNotice } from "@/services/backend/github-api"
import { isRemoteRuntime } from "@/services/backend/runtime"

/** Often enough while a chat waits on its pull request. */
const ACTIVE_POLL_MS = 20_000
/** When no chat has wake-ups on. */
const IDLE_POLL_MS = 120_000

/**
 * Delivers pull request wake-ups. The backend's watcher writes a message
 * for a chat when its pull request gets a failed check, a review or a merge
 * conflict; this desktop window claims it (one window wins) and puts it in
 * the chat's message queue, which sends it right away when the chat is
 * idle and after the running turn when it is busy, with the chat's own
 * model and permissions. Renders nothing; not used in a paired browser.
 */
export function PullRequestWakeBridge() {
  useEffect(() => {
    if (isRemoteRuntime()) return
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = () => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      const active = Object.values(
        usePullRequestWakeStore.getState().watches
      ).some((watch) => watch.enabled)
      timer = setTimeout(
        () => void deliver(),
        active ? ACTIVE_POLL_MS : IDLE_POLL_MS
      )
    }

    const deliver = async () => {
      if (running || stopped) return
      running = true
      try {
        const notices = await usePullRequestWakeStore.getState().refresh()
        for (const notice of notices ?? []) {
          if (stopped) break
          const thread = useChatStore
            .getState()
            .threads.find((entry) => entry.id === notice.threadId)
          // Left for a window that has the chat loaded; it expires in a day.
          if (!thread) continue
          const { notice: claimed } = await githubClaimWakeNotice(notice.id)
          if (!claimed) continue
          try {
            useMessageQueueStore.getState().enqueue(claimed.threadId, {
              text: claimed.text,
              files: [],
              browserElements: [],
            })
            toast.action(claimed.title, {
              id: `pull-request-wake:${claimed.threadId}`,
              description: thread.title || "Chat",
              action: {
                label: "Open chat",
                onClick: () =>
                  window.dispatchEvent(
                    new CustomEvent("betterc0de:open-thread", {
                      detail: {
                        threadId: claimed.threadId,
                        label: thread.title || "Chat",
                      },
                    })
                  ),
              },
            })
          } catch (error) {
            handleError(error, { source: "pull-request-wake" })
          }
        }
      } catch (error) {
        handleError(error, { source: "pull-request-wake", silent: true })
      } finally {
        running = false
        schedule()
      }
    }

    const onFocus = () => void deliver()
    window.addEventListener("focus", onFocus)
    void deliver()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [])
  return null
}
