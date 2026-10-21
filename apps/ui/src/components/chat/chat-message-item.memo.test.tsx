import { describe, expect, it } from "vitest"
import type { ComponentProps } from "react"
import {
  ChatMessageItem,
  chatMessageItemPropsEqual,
} from "@/components/chat/chat-message-item"
import type { ChatMessage } from "@/lib/chat-store"

type Props = ComponentProps<typeof ChatMessageItem>

const answer: ChatMessage = {
  id: "answer",
  role: "assistant",
  content: "Done.",
  createdAt: "2026-08-23T10:01:30.000Z",
}
const followUp: ChatMessage = {
  id: "follow-up",
  role: "user",
  content: "thanks",
  createdAt: "2026-08-23T10:02:00.000Z",
}

const base: Props = {
  msg: answer,
  idx: 0,
  messages: [answer],
  activeThreadId: "thread-1",
  onRetry: () => {},
  onOpenConfirm: () => {},
  onOpenPlanModal: () => {},
  isLastMessage: true,
  turnDuration: 90_000,
}

describe("ChatMessageItem memo comparator", () => {
  it("re-renders the previous answer when a newer message arrives", () => {
    // The restore-checkpoint divider only shows under answers that are not
    // the last message, so the flag flip must reach the render.
    expect(
      chatMessageItemPropsEqual(base, {
        ...base,
        messages: [answer, followUp],
        isLastMessage: false,
      })
    ).toBe(false)
  })

  it("re-renders when the turn time changes", () => {
    expect(
      chatMessageItemPropsEqual(base, { ...base, turnDuration: null })
    ).toBe(false)
  })

  it("skips a new messages array when nothing the render reads changed", () => {
    expect(
      chatMessageItemPropsEqual(base, { ...base, messages: [answer] })
    ).toBe(true)
  })

  it("falls back to the messages identity when the derived props are omitted", () => {
    const legacy: Props = {
      ...base,
      isLastMessage: undefined,
      turnDuration: undefined,
    }
    expect(
      chatMessageItemPropsEqual(legacy, {
        ...legacy,
        messages: [answer, followUp],
      })
    ).toBe(false)
  })
})
