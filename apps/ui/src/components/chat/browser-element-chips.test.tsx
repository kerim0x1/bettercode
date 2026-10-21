import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  BrowserElementChips,
  BrowserElementDetails,
} from "./browser-element-chips"
import { BrowserElementMessage } from "./browser-element-message"

const elements = [
  {
    url: "https://example.com/",
    selector: "#buy",
    tagName: "button",
    text: "Buy",
    label: "Buy",
  },
]

describe("browser element chips", () => {
  it("renders removable draft tags without raw metadata or executable links", () => {
    const html = renderToStaticMarkup(
      <BrowserElementChips elements={elements} onRemove={() => {}} />
    )
    expect(html).toContain('aria-label="Selected page elements"')
    // Inside a message the chips sit in the `.chat-prose` transcript, whose
    // markdown list rules skip `not-prose` subtrees; without it the <ul> is
    // indented 1.5em like a bullet list.
    expect(html).toMatch(/<ul[^>]*class="[^"]*\bnot-prose\b/)
    expect(html).toContain('aria-label="Inspect @Button: Buy"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain("data:application")
    expect(html).not.toContain("href=")
  })
  it("shows sent references without removal controls and escapes page labels", () => {
    const html = renderToStaticMarkup(
      <BrowserElementChips
        elements={[{ ...elements[0], label: "<img onerror=run()>" }]}
      />
    )
    expect(html).toContain("<button")
    expect(html).not.toContain("Remove mention")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img")
    expect(renderToStaticMarkup(<BrowserElementChips elements={[]} />)).toBe("")
  })
  it("renders captured details as inert text", () => {
    const html = renderToStaticMarkup(
      <BrowserElementDetails
        element={{
          ...elements[0],
          id: "buy",
          className: "cta primary",
          childCount: 2,
          rect: { x: 10, y: 20, w: 100, h: 30 },
          viewport: { width: 1200, height: 800 },
          text: "<script>run()</script>",
          styles: { color: "rgb(1, 2, 3)" },
        }}
      />
    )
    for (const value of [
      "#buy",
      "https://example.com/",
      "cta primary",
      "100 x 30 px",
      "1200 x 800 px",
      "Computed styles",
      "rgb(1, 2, 3)",
    ])
      expect(html).toContain(value)
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
  })
  it("keeps a sent component mention inside the message text", () => {
    const html = renderToStaticMarkup(
      <BrowserElementMessage
        content="Change @Button please"
        elements={[{ ...elements[0], mentionName: "Button" }]}
      />
    )
    expect(html.indexOf("Change ")).toBeLessThan(
      html.indexOf('aria-label="Inspect @Button')
    )
    expect(html.indexOf("</button>")).toBeLessThan(html.indexOf(" please"))
    expect(html).not.toContain("Remove mention")
  })
})
