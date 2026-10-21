import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { PromptInputProvider } from "@/components/ai-elements/prompt-input"
import type { UiProvider } from "@/lib/provider-types"
import { useSettingsStore } from "@/lib/settings-store"
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

describe("steering from the composer", () => {
  afterEach(() => useSettingsStore.setState({ whileWorkingEnter: "queue" }))

  const render = (text: string, provider: UiProvider) =>
    renderToStaticMarkup(
      <PromptInputProvider initialInput={text}>
        <ComposerSubmit
          status="streaming"
          onStop={() => {}}
          provider={provider}
        />
      </PromptInputProvider>
    )

  it("says Enter steers into a Codex turn and Ctrl+Enter queues", () => {
    useSettingsStore.setState({ whileWorkingEnter: "steer" })
    const html = render("Use the other API", {
      id: "codex",
      name: "Codex",
      logo: "",
      providerKind: "codex",
      models: [],
    })
    expect(html).toContain('aria-label="Steer now"')
    expect(html).toContain("Sends into the running turn now")
    expect(html).toContain("queue instead")
  })

  it("says steering stops the step for providers without mid-turn input", () => {
    useSettingsStore.setState({ whileWorkingEnter: "steer" })
    const html = render("Use the other API", {
      id: "claude",
      name: "Claude",
      logo: "",
      providerKind: "claude",
      models: [],
    })
    expect(html).toContain("Stops the current step and sends now")
  })

  it("keeps commands out of the turn", () => {
    useSettingsStore.setState({ whileWorkingEnter: "steer" })
    const html = render("/review", {
      id: "codex",
      name: "Codex",
      logo: "",
      providerKind: "codex",
      models: [],
    })
    expect(html).toContain('aria-label="Queue message"')
    expect(html).not.toContain("Steer now")
  })
})
