import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PromptInputProvider } from "@/components/ai-elements/prompt-input"
import { ComposerSubmit } from "./composer-submit"

describe("composer commands during a turn", () => {
  it.each(["/goal pause", "/goal continue", "/GOAL Fix the editor"])(
    "offers immediate submission for %s",
    (text) => {
      const html = renderToStaticMarkup(
        <PromptInputProvider initialInput={text}>
          <ComposerSubmit status="streaming" onStop={() => {}} />
        </PromptInputProvider>
      )
      expect(html).toContain('aria-label="Send goal command"')
      expect(html).toContain('title="Apply goal command now"')
      expect(html).not.toContain("Queue message")
      expect(html).toContain('aria-label="Stop"')
    }
  )

  it("continues to queue ordinary messages", () => {
    const html = renderToStaticMarkup(
      <PromptInputProvider initialInput="Check the sidebar too">
        <ComposerSubmit status="streaming" onStop={() => {}} />
      </PromptInputProvider>
    )
    expect(html).toContain('aria-label="Queue message"')
    expect(html).not.toContain("Send goal command")
  })
})
