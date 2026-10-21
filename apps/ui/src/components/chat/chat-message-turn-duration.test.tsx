import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ChatMessageItem } from "@/components/chat/chat-message-item"
import type { ChatMessage } from "@/lib/chat-store"

/**
 * The answer time has to be readable without hovering. It first shipped inside
 * the actions toolbar, which then faded in on hover, so how long a turn took
 * was only discoverable by pointing at it — and a touch client never could.
 * The actions themselves are always visible now too.
 *
 * These tests assert the *structure* that keeps it visible, because "renders
 * the text somewhere" would have passed for the broken version too.
 */

const HOVER_FADE = "opacity-0"
const DURATION = "Total time for this turn"
/** Copy is the first answer action; its accessible name marks the block. */
const FIRST_ACTION = '<span class="sr-only">Copy</span>'

function message(
  role: ChatMessage["role"],
  createdAt: string,
  content: string
): ChatMessage {
  return { id: `${role}-${createdAt}`, role, content, createdAt } as ChatMessage
}

function renderTurn(messages: ChatMessage[], idx: number): string {
  return renderToStaticMarkup(
    <ChatMessageItem
      msg={messages[idx]}
      idx={idx}
      messages={messages}
      activeThreadId="thread-1"
      onRetry={() => {}}
      onOpenConfirm={() => {}}
      onOpenPlanModal={() => {}}
    />
  )
}

/** Where the actions container opens, or -1 without actions. */
function actionsStart(html: string): number {
  const action = html.indexOf(FIRST_ACTION)
  return action === -1 ? -1 : html.lastIndexOf("<div", action)
}

/** The markup of the actions container itself. */
function actionsBlock(html: string): string {
  const start = actionsStart(html)
  if (start === -1) return ""
  const tail = html.slice(start)
  return tail.slice(0, tail.indexOf("</div>"))
}

/** The row under an answer, from its opening tag through the actions. */
function toolbarRow(html: string): string {
  const start = html.lastIndexOf("<div", html.indexOf(DURATION))
  return html.slice(start, actionsStart(html)) + actionsBlock(html)
}

const ANSWERED_IN_90_SECONDS = [
  message("user", "2026-08-23T10:00:00.000Z", "add a test"),
  message("assistant", "2026-08-23T10:01:30.000Z", "Done."),
]

describe("turn duration under an answer", () => {
  it("shows how long the turn took, with a clock", () => {
    const html = renderTurn(ANSWERED_IN_90_SECONDS, 1)
    expect(html).toContain("Total time for this turn")
    expect(html).toContain("1m 30s")
    expect(html).toContain("lucide-clock")
  })

  it("keeps the duration outside the actions block", () => {
    // If the duration is ever moved back inside MessageActions, it takes on
    // whatever the actions do, which is how it once vanished until hover.
    const html = renderTurn(ANSWERED_IN_90_SECONDS, 1)
    expect(actionsBlock(html)).toContain("Revert to here")
    expect(actionsBlock(html)).not.toContain(DURATION)
  })

  it("shows the actions without hovering", () => {
    // Hover-only actions were easy to miss and never appeared on a touch
    // screen, so neither the row nor the actions block may fade.
    const html = renderTurn(ANSWERED_IN_90_SECONDS, 1)
    expect(toolbarRow(html)).toContain(DURATION)
    expect(toolbarRow(html)).toContain("Revert to here")
    expect(toolbarRow(html)).not.toContain(HOVER_FADE)
  })

  it("puts the duration before the actions so it sits flush left", () => {
    // Rendered after the buttons, it was pushed right by their width and
    // looked randomly indented; first, it lines up with the message text.
    const html = renderTurn(ANSWERED_IN_90_SECONDS, 1)
    expect(actionsStart(html)).toBeGreaterThan(-1)
    expect(html.indexOf(DURATION)).toBeLessThan(actionsStart(html))
  })

  it("says nothing when the turn cannot be measured honestly", () => {
    // A restored history whose assistant stamp predates the user stamp would
    // otherwise render a negative or absurd number.
    const reversed = [
      message("user", "2026-08-23T10:01:30.000Z", "add a test"),
      message("assistant", "2026-08-23T10:00:00.000Z", "Done."),
    ]
    expect(renderTurn(reversed, 1)).not.toContain("Total time for this turn")
  })

  it("shows no duration on the user's own message", () => {
    expect(renderTurn(ANSWERED_IN_90_SECONDS, 0)).not.toContain(
      "Total time for this turn"
    )
  })
})
