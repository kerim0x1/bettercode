import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { modelThinkingOptions } from "@betterc0de/schema"
import {
  ThinkingEffortSlider,
  thinkingOptionIndex,
} from "./thinking-effort-slider"

const ladder = [
  { mode: null, label: "Off" },
  { mode: "Low", label: "Low" },
  { mode: "Medium", label: "Medium" },
  { mode: "High", label: "High" },
  { mode: "xHigh", label: "Extra High" },
  { mode: "max", label: "Max" },
  { mode: "ultracode", label: "Ultracode" },
]

function render(thinkingMode: string | null, defaultMode?: string | null) {
  return renderToStaticMarkup(
    <ThinkingEffortSlider
      options={ladder}
      thinkingMode={thinkingMode}
      modelName="GPT-6 Astra"
      {...(defaultMode !== undefined ? { defaultMode } : {})}
      onSelect={() => {}}
    />
  )
}

describe("thinkingOptionIndex", () => {
  it("finds a mode regardless of spelling and reports a missing one as -1", () => {
    expect(thinkingOptionIndex(ladder, null)).toBe(0)
    expect(thinkingOptionIndex(ladder, "high")).toBe(3)
    expect(thinkingOptionIndex(ladder, "xhigh")).toBe(4)
    expect(thinkingOptionIndex(ladder, "banana")).toBe(-1)
  })
})

/** Only the levels still ahead of the thumb are drawn as stops; Radix sets
 *  the thumb's numeric value only after mount, so the stop count is what a
 *  static render can vouch for. */
function stopsAhead(html: string): number {
  return (html.match(/data-slot="effort-stop"/g) ?? []).length
}

describe("ThinkingEffortSlider", () => {
  it("puts Grok High one stop before Extra High, with Low at the left", () => {
    const options = modelThinkingOptions({
      providerKind: "grok_cli",
      modelId: "grok-4.6",
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select",
            options: [
              { id: "xhigh", label: "Extra High Effort" },
              { id: "high", label: "High Effort" },
              { id: "medium", label: "Medium Effort" },
              { id: "low", label: "Low Effort" },
            ],
          },
        ],
      },
    })
    const html = renderToStaticMarkup(
      <ThinkingEffortSlider
        options={options}
        thinkingMode="High"
        onSelect={() => {}}
      />
    )
    expect(stopsAhead(html)).toBe(1)
    expect(html).toContain('aria-valuetext="High Effort"')
    expect(thinkingOptionIndex(options, "Low")).toBe(1)
    expect(thinkingOptionIndex(options, "xHigh")).toBe(4)
  })
  it("names the chosen level, says what it means, and puts the thumb on it", () => {
    const html = render("High")
    expect(html).toContain(">High<")
    expect(html).toContain("Thorough")
    expect(stopsAhead(html)).toBe(3)
    expect(html).toContain('aria-valuemax="6"')
    expect(html).toContain('aria-valuetext="High"')
  })

  it("identifies the current model and exposes one slider spanning all supported levels", () => {
    const html = render("Medium")
    expect(stopsAhead(html)).toBe(4)
    expect(render("ultracode")).not.toContain("effort-stop")
    expect(html).not.toContain("<li")
    expect(html).not.toContain("lucide-check")
    expect(html).toContain(">GPT-6 Astra<")
    expect(html.match(/role="slider"/g)).toHaveLength(1)
    expect(html).toContain('aria-valuemin="0"')
    expect(html).toContain('aria-valuemax="6"')
    expect(html).toContain('aria-valuetext="Medium"')
  })

  it("shows a single available level without a degenerate slider", () => {
    const html = renderToStaticMarkup(
      <ThinkingEffortSlider
        options={[{ mode: null, label: "Off" }]}
        thinkingMode={null}
        onSelect={() => {}}
      />
    )
    expect(html).toContain("One level available")
    expect(html).toContain(">Off<")
    expect(html).not.toContain('role="slider"')
    expect(html).not.toContain("Reset to")
  })

  it("offers a reset only when the level differs from the default", () => {
    expect(render("High")).toMatch(
      /<button[^>]*aria-label="Reset to High"[^>]*disabled=""/
    )
    const custom = render("max")
    expect(custom).toContain('aria-label="Reset to High"')
    expect(custom).not.toMatch(
      /<button[^>]*aria-label="Reset to High"[^>]*disabled=""/
    )
    expect(render("max", null)).not.toContain("Reset to")
  })

  it("reads a mode the ladder does not offer as Off", () => {
    const html = render("banana")
    expect(html).toContain(">Off<")
    expect(html).toContain("No extended thinking")
    expect(stopsAhead(html)).toBe(ladder.length - 1)
    expect(html).toContain('aria-valuetext="Off"')
  })

  it("renders nothing for an empty ladder", () => {
    expect(
      renderToStaticMarkup(
        <ThinkingEffortSlider
          options={[]}
          thinkingMode={null}
          onSelect={() => {}}
        />
      )
    ).toBe("")
  })
})
