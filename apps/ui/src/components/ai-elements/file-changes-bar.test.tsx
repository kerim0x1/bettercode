import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FileChangesBar, findTurnGitCheckpoint } from "./file-changes-bar"
import {
  ChatInputArea,
  type ChatInputComposerProps,
} from "@/components/chat/chat-input-area"
import { ChatComposer } from "@/components/chat/chat-composer"
import { emptyStreamState, useChatStore } from "@/lib/chat-store"
import { useCheckpointStore, type Checkpoint } from "@/lib/checkpoint-store"

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
vi.mock("@/components/file-mentions", () => ({ FileMentionMenu: () => null }))
vi.mock("@/components/slash-commands", () => ({ SlashCommandMenu: () => null }))
vi.mock("@/components/chat/pending-questions-panel", () => ({
  PendingQuestionsPanel: () => null,
}))
vi.mock("@/components/chat/autonomous-status-bar", () => ({
  AutonomousStatusBar: () => null,
}))
vi.mock("@/components/chat/thread-goal-card", () => ({
  ThreadGoalCard: () => null,
}))
vi.mock("@/components/chat/chat-composer", () => ({
  ChatComposer: vi.fn(() => null),
}))

// The composer is mocked, so these tests pass only the props they read.
const composerProps = (props: Partial<ChatInputComposerProps> = {}) =>
  props as ChatInputComposerProps
const deepgram = { error: null, clearError: () => {} }

const initialState = useChatStore.getState()
const diff = (path: string) => ({
  path,
  additions: 1,
  deletions: 1,
  oldText: "before",
  newText: "after",
  isNew: false,
})
beforeEach(() => {
  useChatStore.setState({
    activeThreadId: "left",
    streamingByThread: {
      left: {
        ...emptyStreamState,
        activeTurnId: "turn-left",
        streamingDiffs: [diff("left-only.ts")],
      },
    },
    threads: ["left", "right", "empty"].map((id) => ({
      id,
      title: id,
      projectName: "Shared workspace",
      projectPath: "C:/shared",
      createdAt: "2026-09-05",
      updatedAt: "2026-09-05",
      messages:
        id === "right"
          ? [
              {
                id: "message-right",
                role: "assistant" as const,
                content: "Done",
                createdAt: "2026-09-05",
                diffs: [diff("right-only.ts")],
              },
            ]
          : [],
    })),
  })
})
afterEach(() => useChatStore.setState(initialState, true))

describe("file review ownership", () => {
  it.each(["left", "right", "empty"])(
    "keeps live and saved reviews in their own panes when %s is focused",
    (activeThreadId) => {
      useChatStore.setState({ activeThreadId })
      const left = renderToStaticMarkup(
        createElement(FileChangesBar, { threadId: "left" })
      )
      const right = renderToStaticMarkup(
        createElement(FileChangesBar, { threadId: "right" })
      )
      expect(left).toContain("left-only.ts")
      expect(left).not.toContain("right-only.ts")
      expect(right).toContain("right-only.ts")
      expect(right).not.toContain("left-only.ts")
    }
  )

  it.each([null, "empty", "missing"])(
    "never borrows the active chat review for %s",
    (threadId) => {
      expect(
        renderToStaticMarkup(createElement(FileChangesBar, { threadId }))
      ).toBe("")
    }
  )

  it("passes the pane's identity through the actual chat input area", () => {
    const html = renderToStaticMarkup(
      createElement(ChatInputArea, {
        activeThreadId: "right",
        composerProps: composerProps(),
        deepgram,
      })
    )
    expect(html).toContain("right-only.ts")
    expect(html).not.toContain("left-only.ts")
  })

  it("hides review controls in Bypass without removing the underlying diffs", () => {
    const html = renderToStaticMarkup(
      createElement(ChatInputArea, {
        activeThreadId: "left",
        permissionLevel: "bypass",
        composerProps: composerProps(),
        deepgram,
      })
    )
    expect(html).not.toContain("Review File Changes")
    expect(html).not.toContain("Accept all")
    expect(
      useChatStore.getState().streamingByThread.left.streamingDiffs
    ).toHaveLength(1)
  })

  it("keeps review available in Ask and removes the sticky Plan ready banner", () => {
    const html = renderToStaticMarkup(
      createElement(ChatInputArea, {
        activeThreadId: "left",
        permissionLevel: "ask-on-edit",
        composerProps: composerProps(),
        deepgram,
        activeProposedPlan: { id: "plan", content: "# My implementation plan" },
        setPlanModalContent: vi.fn(),
      })
    )
    expect(html).toContain("Review File Changes")
    expect(html).not.toContain("Plan ready")
    expect(html).not.toContain("Open Plan")
  })

  it.each(["/goal pause", "/goal continue", "/goal Fix My UI"])(
    "does not convert %s into a plan follow-up",
    async (text) => {
      const submit = vi.fn()
      const setChatMode = vi.fn()
      renderToStaticMarkup(
        createElement(ChatInputArea, {
          activeThreadId: "right",
          composerProps: composerProps({ handleSubmit: submit, setChatMode }),
          deepgram,
          activeProposedPlan: { id: "plan", content: "# Proposed plan" },
        })
      )
      const composer = vi.mocked(ChatComposer).mock.calls.at(-1)![0]
      await composer.handleSubmit({ text, files: [] })
      expect(submit).toHaveBeenCalledExactlyOnceWith({
        text,
        files: [],
        threadId: "right",
      })
      expect(setChatMode).not.toHaveBeenCalled()
    }
  )
})

describe("rejecting a turn's file change", () => {
  const gitCheckpoint: Checkpoint = {
    id: "cp-git",
    threadId: "right",
    messageId: "message-right",
    label: "After assistant turn",
    timestamp: "2026-09-05",
    files: {},
    gitBranch: "main",
    projectPath: "C:/shared",
    checkpointRef: "refs/betterc0de/checkpoints/right/turn/1",
    baseCheckpointRef: "refs/betterc0de/checkpoints/right/turn/0",
    turnNumber: 0,
  }
  // Read when the turn's stream ended, i.e. after the edits.
  const afterEditSnapshot: Checkpoint = {
    id: "cp-snapshot",
    threadId: "right",
    messageId: "message-right",
    label: "After editing right-only.ts",
    timestamp: "2026-09-05",
    files: { "C:/shared/right-only.ts": "after" },
    gitBranch: "main",
    projectPath: "C:/shared",
  }
  afterEach(() => useCheckpointStore.setState({ checkpoints: [] }))

  it("offers Reject only once the turn's Git checkpoint exists", () => {
    useCheckpointStore.setState({ checkpoints: [afterEditSnapshot] })
    const withoutGit = renderToStaticMarkup(
      createElement(FileChangesBar, { threadId: "right" })
    )
    expect(withoutGit).toContain("Accept all")
    expect(withoutGit).not.toContain("Reject all")
    expect(withoutGit).not.toContain("Reject &amp; revert changes")

    useCheckpointStore.setState({
      checkpoints: [afterEditSnapshot, gitCheckpoint],
    })
    const withGit = renderToStaticMarkup(
      createElement(FileChangesBar, { threadId: "right" })
    )
    expect(withGit).toContain("Reject all")
    expect(withGit).toContain("Reject &amp; revert changes")
  })

  it("reverts from the turn's Git base, never from an after-edit snapshot", () => {
    const turn = {
      threadId: "right",
      turnId: undefined,
      messageId: "message-right",
      workspacePath: "C:/shared",
    }
    expect(findTurnGitCheckpoint([afterEditSnapshot], turn)).toBeUndefined()
    expect(
      findTurnGitCheckpoint([gitCheckpoint, afterEditSnapshot], turn)
    ).toBe(gitCheckpoint)
    expect(
      findTurnGitCheckpoint([gitCheckpoint], {
        ...turn,
        workspacePath: "C:/elsewhere",
      })
    ).toBeUndefined()
    expect(
      findTurnGitCheckpoint(
        [{ ...gitCheckpoint, turnId: "turn-2", messageId: "other" }],
        {
          ...turn,
          turnId: "turn-1",
          messageId: undefined,
        }
      )
    ).toBeUndefined()
  })
})
