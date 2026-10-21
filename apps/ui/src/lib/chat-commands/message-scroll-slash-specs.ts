import {
  type SlashCommandRun,
  type SlashCommandRunSpec,
  abortSlashRun,
} from "./slash-run"

type ChatMessageScrollTarget =
  | "first"
  | "last"
  | "last-user"
  | "next"
  | "previous"
  | "page-up"
  | "page-down"
  | "half-page-up"
  | "half-page-down"
  | "line-up"
  | "line-down"

function dispatchChatMessageScroll(
  target: ChatMessageScrollTarget,
  threadId: string | null
): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent("betterc0de:chat-scroll-message", {
      detail: { target, threadId },
    })
  )
}

/** Transcript scrolling; these never produce chat output. */
export const MESSAGE_SCROLL_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRun>[] =
  [
    {
      names: ["first", "first-message", "messages.first", "session.first"],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("first", threadId)
        return abortSlashRun(run)
      },
    },
    {
      names: ["last", "last-message", "messages.last", "session.last"],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("last", threadId)
        return abortSlashRun(run)
      },
    },
    {
      names: [
        "last-user",
        "last-user-message",
        "messages-last-user",
        "messages.last_user",
        "session.messages_last_user",
      ],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("last-user", threadId)
        return abortSlashRun(run)
      },
    },
    {
      names: [
        "next-message",
        "message-next",
        "message.next",
        "messages.next",
        "session.message.next",
      ],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("next", threadId)
        return abortSlashRun(run)
      },
    },
    {
      names: [
        "previous-message",
        "prev-message",
        "message-previous",
        "message.previous",
        "messages.previous",
        "session.message.previous",
      ],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("previous", threadId)
        return abortSlashRun(run)
      },
    },
    {
      names: [
        "page-up",
        "pageup",
        "messages-page-up",
        "message.page_up",
        "messages.page_up",
        "session.page.up",
      ],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("page-up", threadId)
        return abortSlashRun(run)
      },
    },
    {
      names: [
        "page-down",
        "pagedown",
        "messages-page-down",
        "message.page_down",
        "messages.page_down",
        "session.page.down",
      ],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("page-down", threadId)
        return abortSlashRun(run)
      },
    },
    {
      names: [
        "line-up",
        "lineup",
        "messages-line-up",
        "message.line_up",
        "messages.line_up",
        "session.line.up",
      ],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("line-up", threadId)
        return abortSlashRun(run)
      },
    },
    {
      names: [
        "line-down",
        "linedown",
        "messages-line-down",
        "message.line_down",
        "messages.line_down",
        "session.line.down",
      ],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("line-down", threadId)
        return abortSlashRun(run)
      },
    },
    {
      names: ["half-page-up", "halfpage-up", "session.half.page.up"],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("half-page-up", threadId)
        return abortSlashRun(run)
      },
    },
    {
      names: ["half-page-down", "halfpage-down", "session.half.page.down"],
      run: (run) => {
        const { threadId } = run
        dispatchChatMessageScroll("half-page-down", threadId)
        return abortSlashRun(run)
      },
    },
  ]
