import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatMessageItem } from "@/components/chat/chat-message-item"
import type { ChatMessage } from "@/lib/chat-store"
import { useWorkspaceTrustPromptStore } from "@/lib/workspace-trust-prompts"

vi.mock("@/components/dialogs/confirm-provider", () => ({
  useConfirm: () => vi.fn(),
}))

const messages: ChatMessage[] = [
  {
    id: "user-1",
    role: "user",
    content: "Edit the README",
    createdAt: "2026-10-07T10:00:00.000Z",
  },
  {
    id: "error-1",
    role: "assistant",
    content:
      "Error: This workspace has not been trusted. Open Settings → Permissions → Trust project to enable Agent Mode here.",
    createdAt: "2026-10-07T10:00:01.000Z",
  },
]

function renderError(): string {
  return renderToStaticMarkup(
    <ChatMessageItem
      msg={messages[1]!}
      idx={1}
      messages={messages}
      activeThreadId="thread-1"
      onRetry={() => {}}
      onOpenConfirm={() => {}}
      onOpenPlanModal={() => {}}
    />
  )
}

afterEach(() => useWorkspaceTrustPromptStore.setState({ byMessageId: {} }))

describe("a refused Agent turn in the transcript", () => {
  it("offers to trust the workspace under the error", () => {
    useWorkspaceTrustPromptStore
      .getState()
      .register("error-1", { workspacePath: "/repo" })
    const html = renderError()
    expect(html).toContain("has not been trusted")
    expect(html).toContain("Trust this workspace")
  })

  it("shows the plain error once the prompt is gone", () => {
    const html = renderError()
    expect(html).toContain("has not been trusted")
    expect(html).not.toContain("Trust this workspace")
  })
})
