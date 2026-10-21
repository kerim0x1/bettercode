import { useEffect } from "react"
import { handleProviderEvent } from "@/lib/provider-events"
import { useMultiAgentStore } from "@/lib/multi-agent-store"
import { buildSystemInstruction } from "@/lib/mode-instructions"
import { maybeNotifyRuntimeEvent } from "@/lib/native-notifications"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import { mergeCanonicalRuntimeEventFields } from "@/lib/provider-runtime-event-fields"
import type { UiProvider } from "@/lib/provider-types"
import type { SetPlanModalContent } from "@/lib/plan-modal"
import { getElectronApi } from "@/services/ipc-facade"

/**
 * Subscribes the chat app to all non-WebSocket provider event sources
 * that Electron exposes.
 *
 * Two listeners live here:
 *  1. **Generic plugin** events — thread id + event type + payload, plus an
 *     extra `pluginId` we merge into the payload so the reducer can
 *     attribute the event to the right plugin.
 *  2. **Multi-Agent Swarm** lifecycle events — `betterc0de:multi-agent-start`
 *     kicks off a swarm session, and `betterc0de:response-complete` is
 *     forwarded into the multi-agent store so it knows when each sub-agent
 *     turn is done.
 *
 * The Claude Agent SDK listener that used to sit here is gone with the
 * `claude:*` main-process bridge; those turns arrive over the backend
 * WebSocket via `use-chat-event-bus` like every other provider.
 *
 * None of these subscriptions exist in remote mode — they all guard on
 * `window.electronAPI`, so the hook is a no-op when the shell API isn't
 * present.
 */
export function useProviderEvents({
  setPlanModalContent,
  respondToolApproval,
  providers,
}: {
  setPlanModalContent: SetPlanModalContent
  respondToolApproval: (id: string, approved: boolean) => void
  providers: UiProvider[]
}) {
  // Plugin events
  useEffect(() => {
    const desktopBridge = getElectronApi()
    if (!desktopBridge?.onPluginEvent) return
    const cbs = { setPlanModalContent, respondToolApproval }
    const cleanup = desktopBridge.onPluginEvent((event) => {
      const runtimeEvent = event as Record<string, unknown> & {
        threadId: string
        type: string
        payload?: Record<string, unknown>
        pluginId?: string
      }
      const payloadWithPluginId = mergeCanonicalRuntimeEventFields(
        runtimeEvent.payload,
        runtimeEvent
      )
      const { pluginId } = runtimeEvent
      if (pluginId) payloadWithPluginId.pluginId = pluginId
      maybeNotifyRuntimeEvent({
        threadId: runtimeEvent.threadId,
        type: runtimeEvent.type,
        payload: payloadWithPluginId,
      })
      handleProviderEvent(
        runtimeEvent.threadId,
        runtimeEvent.type,
        payloadWithPluginId,
        cbs
      )
    })
    return cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [respondToolApproval])

  // Multi-Agent Swarm — event listeners for start + turn completion
  useEffect(() => {
    const resolveForAgent = async (pid: string, mid: string) => {
      const p = providers.find((pr) => pr.id === pid)
      return resolveProviderTarget(p, mid)
    }
    const onStart = () => {
      useMultiAgentStore
        .getState()
        .startSession(resolveForAgent, (m) => buildSystemInstruction(m))
    }
    const onTurnComplete = (e: Event) => {
      const detail = (e as CustomEvent).detail as { threadId?: string }
      if (detail?.threadId) {
        useMultiAgentStore
          .getState()
          .handleAgentTurnComplete(detail.threadId, resolveForAgent, (m) =>
            buildSystemInstruction(m)
          )
      }
    }
    window.addEventListener("betterc0de:multi-agent-start", onStart)
    window.addEventListener("betterc0de:response-complete", onTurnComplete)
    return () => {
      window.removeEventListener("betterc0de:multi-agent-start", onStart)
      window.removeEventListener("betterc0de:response-complete", onTurnComplete)
    }
  }, [providers])
}
