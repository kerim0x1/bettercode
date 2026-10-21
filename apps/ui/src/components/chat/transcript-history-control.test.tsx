import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation"
import { TranscriptHistoryControl } from "./transcript-history-control"

function render(
  props: Partial<Parameters<typeof TranscriptHistoryControl>[0]> = {}
): string {
  return renderToStaticMarkup(
    <Conversation>
      <ConversationContent>
        <TranscriptHistoryControl
          hiddenCount={0}
          hasOlderOnServer={false}
          loading={false}
          firstEntryId="m1"
          onShowEarlier={() => {}}
          {...props}
        />
      </ConversationContent>
    </Conversation>
  )
}

describe("TranscriptHistoryControl", () => {
  it("renders nothing when the whole chat is on screen", () => {
    expect(render()).not.toContain("data-betterc0de-transcript-history")
  })

  it("offers earlier messages that are loaded but not mounted", () => {
    const html = render({ hiddenCount: 12 })
    expect(html).toContain("Show earlier messages")
    expect(html).not.toContain('disabled=""')
  })

  it("offers older pages the backend still has", () => {
    expect(render({ hasOlderOnServer: true })).toContain(
      "Show earlier messages"
    )
  })

  it("shows progress and blocks repeat requests while a page loads", () => {
    const html = render({ hasOlderOnServer: true, loading: true })
    expect(html).toContain("Loading earlier messages")
    expect(html).toContain('disabled=""')
  })
})
