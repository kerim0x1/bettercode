import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatInputArea } from "@/components/chat/chat-input-area"
import { useComposerMenuStore } from "@/lib/composer-menu-store"

vi.mock("@/components/ai-elements/file-changes-bar", () => ({
  FileChangesBar: () => null,
}))
vi.mock("@/components/chat/queued-messages", () => ({
  QueuedMessages: () => null,
}))
vi.mock("@/components/chat/pending-questions-panel", () => ({
  PendingQuestionsPanel: () => null,
}))
vi.mock("@/components/chat/autonomous-status-bar", () => ({
  AutonomousStatusBar: () => null,
}))
vi.mock("@/components/chat/thread-goal-card", () => ({
  ThreadGoalCard: () => null,
}))
vi.mock("@/components/chat/chat-composer", () => ({ ChatComposer: () => null }))
vi.mock("@/components/file-mentions", () => ({
  FileMentionMenu: (props: { visible: boolean; query: string }) =>
    createElement("output", {
      "data-menu": "mention",
      "data-visible": String(props.visible),
      "data-query": props.query,
    }),
}))
vi.mock("@/components/slash-commands", () => ({
  SlashCommandMenu: (props: {
    visible: boolean
    query: string
    trigger: string
  }) =>
    createElement("output", {
      "data-menu": "slash",
      "data-visible": String(props.visible),
      "data-query": props.query,
      "data-trigger": props.trigger,
    }),
}))

const initialMenus = useComposerMenuStore.getState()

type Props = ComponentProps<typeof ChatInputArea>
function render(isActive: boolean) {
  const props = {
    isActive,
    activeThreadId: "thread",
    minimalChat: false,
    composerProps: {},
    deepgram: { error: null, clearError: vi.fn() },
  } as unknown as Props
  return renderToStaticMarkup(createElement(ChatInputArea, props))
}

beforeEach(() => {
  useComposerMenuStore.setState(initialMenus, true)
})

describe("composer menus in the input area", () => {
  it("shows the slash menu with the store's query in the active column", () => {
    useComposerMenuStore.getState().checkSlash("fix $rev")
    const html = render(true)
    expect(html).toContain(
      'data-menu="slash" data-visible="true" data-query="rev" data-trigger="$"'
    )
  })

  it("keeps both menus closed in an inactive column", () => {
    useComposerMenuStore.getState().checkSlash("/pl")
    useComposerMenuStore.getState().checkMention("@src")
    const html = render(false)
    expect(html).toContain(
      'data-menu="slash" data-visible="false" data-query="" data-trigger="/"'
    )
    expect(html).toContain(
      'data-menu="mention" data-visible="false" data-query=""'
    )
  })

  it("hides the file menu while the slash menu is open", () => {
    useComposerMenuStore.getState().checkMention("@src")
    expect(render(true)).toContain(
      'data-menu="mention" data-visible="true" data-query="src"'
    )
    useComposerMenuStore.getState().checkSlash("/pl")
    expect(render(true)).toContain('data-menu="mention" data-visible="false"')
  })
})
