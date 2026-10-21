import { afterEach, describe, expect, it, vi } from "vitest"
import { getHighlighter, resetHighlighterForTests } from "./shiki-highlighter"

afterEach(() => {
  vi.restoreAllMocks()
  resetHighlighterForTests()
})

describe("shared shiki highlighter", () => {
  it("returns one instance for every language and theme request", async () => {
    const first = await getHighlighter({
      language: "typescript",
      themes: ["github-light", "github-dark"],
    })
    const second = await getHighlighter({
      language: "python",
      themes: ["light-plus", "dark-plus"],
    })
    expect(second.highlighter).toBe(first.highlighter)
    const loaded = first.highlighter.getLoadedLanguages()
    expect(loaded).toContain("typescript")
    expect(loaded).toContain("python")
    expect(first.highlighter.getLoadedThemes()).toEqual(
      expect.arrayContaining([
        "github-light",
        "github-dark",
        "light-plus",
        "dark-plus",
      ])
    )
  })

  it("falls back to plain text for unknown or missing languages", async () => {
    const unknown = await getHighlighter({
      language: "not-a-real-language",
      themes: ["github-dark"],
    })
    expect(unknown.language).toBe("text")
    const { tokens } = unknown.highlighter.codeToTokens("plain words", {
      lang: unknown.language,
      theme: "github-dark",
    })
    expect(
      tokens
        .flat()
        .map((token) => token.content)
        .join("")
    ).toBe("plain words")
    expect((await getHighlighter({ language: "" })).language).toBe("text")
    expect((await getHighlighter({})).language).toBe("text")
  })

  it("resolves aliases and ignores case", async () => {
    expect((await getHighlighter({ language: "TS" })).language).toBe("ts")
    const { highlighter } = await getHighlighter({ language: "JavaScript" })
    expect(highlighter.getLoadedLanguages()).toContain("javascript")
  })

  it("shares one in-flight load between concurrent requests", async () => {
    const { highlighter } = await getHighlighter()
    const loadLanguage = vi.spyOn(highlighter, "loadLanguage")
    const results = await Promise.all([
      getHighlighter({ language: "rust" }),
      getHighlighter({ language: "rust" }),
      getHighlighter({ language: "rust" }),
    ])
    expect(results.map((result) => result.language)).toEqual([
      "rust",
      "rust",
      "rust",
    ])
    expect(loadLanguage).toHaveBeenCalledTimes(1)
    await getHighlighter({ language: "rust" })
    expect(loadLanguage).toHaveBeenCalledTimes(1)
  })

  it("falls back to plain text when a grammar fails to load", async () => {
    const { highlighter } = await getHighlighter()
    vi.spyOn(highlighter, "loadLanguage").mockRejectedValueOnce(
      new Error("chunk failed")
    )
    expect((await getHighlighter({ language: "go" })).language).toBe("text")
    // The failure is not cached, so a later request can still load it.
    expect((await getHighlighter({ language: "go" })).language).toBe("go")
  })
})
