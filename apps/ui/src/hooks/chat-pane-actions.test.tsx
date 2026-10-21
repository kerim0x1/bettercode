import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useChatStop } from "./use-chat-stop"
import { useChatStreamingState } from "./use-chat-streaming-state"
import { applyPermissionModeLive } from "@/lib/permission-mode-live"
import { emptyStreamState, useChatStore } from "@/lib/chat-store"
import { interruptTurn } from "@/lib/chat/send-message"
import { setChatPermissionMode } from "@/services/backend/chatApi"
import { toast } from "sonner"

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }))

vi.mock("@/lib/chat/send-message", () => ({
  interruptTurn: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/services/backend/chatApi", () => ({
  setChatPermissionMode: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/chat-store", async (original) => {
  const actual = await original<typeof import("@/lib/chat-store")>()
  const store = actual.useChatStore
  return {
    ...actual,
    useChatStore: Object.assign(
      <T,>(selector: (state: ReturnType<typeof store.getState>) => T) =>
        selector(store.getState()),
      store
    ),
  }
})
const initial = useChatStore.getState()
afterEach(() => {
  useChatStore.setState(initial, true)
  vi.clearAllMocks()
})

describe("chat pane actions", () => {
  it("stops only the specified chat using that pane's provider", () => {
    const finalize = vi.fn()
    useChatStore.setState({ activeThreadId: "other", finalizeStream: finalize })
    let stop!: () => void
    function Probe() {
      stop = useChatStop(
        {
          id: "codex",
          providerKind: "codex",
          providerInstanceId: "owner-instance",
          name: "Codex",
          logo: "",
          models: [],
        },
        "owner"
      )
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    stop()
    expect(interruptTurn).toHaveBeenCalledWith(
      "owner",
      "codex",
      "owner-instance"
    )
    expect(finalize).toHaveBeenCalledExactlyOnceWith("owner")
  })

  it("never stops the focused chat from an empty pane", () => {
    useChatStore.setState({ activeThreadId: "other", finalizeStream: vi.fn() })
    function Probe() {
      const stop = useChatStop(undefined, null)
      stop()
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    expect(interruptTurn).not.toHaveBeenCalled()
  })

  it("keeps live permission updates attached to their initiating chat", async () => {
    useChatStore.setState({ activeThreadId: "other" })
    await applyPermissionModeLive(
      "bypass",
      { providerKind: "codex", providerInstanceId: "owner-instance" },
      "owner"
    )
    expect(setChatPermissionMode).toHaveBeenCalledExactlyOnceWith(
      "owner",
      "codex",
      "bypass",
      "owner-instance"
    )
    applyPermissionModeLive("read-only", undefined, null)
    expect(setChatPermissionMode).toHaveBeenCalledTimes(1)
  })

  it("reports a queued permission change for the running chat", async () => {
    vi.mocked(setChatPermissionMode).mockResolvedValueOnce({
      status: "acknowledged",
      applied: "queued",
    })
    useChatStore.setState({
      activeThreadId: "other",
      streamingByThread: { owner: { ...emptyStreamState, isStreaming: true } },
    })
    await applyPermissionModeLive(
      "ask-on-edit",
      { providerKind: "codex" },
      "owner"
    )
    expect(toast.info).toHaveBeenCalledWith(
      "Permission mode saved for the next turn",
      expect.any(Object)
    )
  })

  it("reports failed live changes instead of silently leaving approvals pending", async () => {
    vi.mocked(setChatPermissionMode).mockRejectedValueOnce(new Error("offline"))
    await applyPermissionModeLive("bypass", { providerKind: "codex" }, "owner")
    expect(toast.error).toHaveBeenCalledWith(
      "Could not update the running turn's permissions",
      expect.any(Object)
    )
    expect(toast.info).not.toHaveBeenCalled()
  })

  it("does not show a queued notice for an idle chat or a successful live switch", async () => {
    useChatStore.setState({ streamingByThread: {} })
    vi.mocked(setChatPermissionMode).mockResolvedValueOnce({
      status: "acknowledged",
      applied: "queued",
    })
    await applyPermissionModeLive("bypass", { providerKind: "codex" }, "owner")
    useChatStore.setState({
      streamingByThread: { owner: { ...emptyStreamState, isStreaming: true } },
    })
    vi.mocked(setChatPermissionMode).mockResolvedValueOnce({
      status: "acknowledged",
      applied: "live",
    })
    await applyPermissionModeLive("bypass", { providerKind: "codex" }, "owner")
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("keeps an explicitly empty pane empty while another chat streams a plan", () => {
    useChatStore.setState({
      activeThreadId: "other",
      streamingByThread: {
        other: {
          ...emptyStreamState,
          isStreaming: true,
          streamingText: "foreign answer",
          streamingPlanText: "foreign plan",
          isPlanStreaming: true,
        },
      },
    })
    function Probe() {
      const stream = useChatStreamingState([], null, { includeShimmer: false })
      return createElement(
        "span",
        { "data-streaming": stream.isStreaming },
        stream.streamingText,
        stream.streamingPlanText
      )
    }
    const html = renderToStaticMarkup(createElement(Probe))
    expect(html).toContain('data-streaming="false"')
    expect(html).not.toContain("foreign")
  })

  it("keeps an autonomous run with its chat whichever chat is active", () => {
    const run = {
      id: "run",
      status: "working" as const,
      tasks: [],
      iterations: 2,
      maxIterations: 50,
      timeBudgetMin: 90,
      startedAt: 1,
      updatedAt: 5,
      stopReason: null,
    }
    useChatStore.setState({ activeThreadId: "owner" })
    useChatStore.getState().setThreadAutonomy("owner", run)
    useChatStore.setState({ activeThreadId: "other" })
    expect(useChatStore.getState().autonomyByThread).toEqual({ owner: run })
    // A control's late answer never replaces a newer push of the same run.
    useChatStore
      .getState()
      .setThreadAutonomy("owner", { ...run, iterations: 1, updatedAt: 4 })
    expect(useChatStore.getState().autonomyByThread.owner?.iterations).toBe(2)
    useChatStore.getState().setThreadAutonomy("owner", null)
    expect(useChatStore.getState().autonomyByThread).toEqual({})
  })
})
