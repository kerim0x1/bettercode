import { afterEach, describe, expect, it } from "vitest"
import {
  COMPARE_MAX_MODELS,
  compareBaseTitle,
  compareChatTitle,
  compareEntries,
  compareGroupThreadIds,
  compareModelKey,
  compareModelLabel,
  compareModelLabels,
  isCompareModifier,
  toggleCompareModel,
  useCompareSelectionStore,
  type CompareModelEntry,
} from "./compare-models"

const model = (
  providerId: string,
  modelId: string,
  thinkingMode: string | null = "high"
): CompareModelEntry => ({ providerId, modelId, thinkingMode })

const opus = model("claude", "opus")
const gpt = model("codex", "gpt-5")
const grok = model("grok", "grok-4")
const gemini = model("openrouter", "google/gemini")
const sonnet = model("claude", "sonnet")

describe("compare selection", () => {
  it("adds with Shift, Ctrl or ⌘ held, and only then", () => {
    expect(isCompareModifier({ shiftKey: true })).toBe(true)
    expect(isCompareModifier({ ctrlKey: true })).toBe(true)
    expect(isCompareModifier({ metaKey: true })).toBe(true)
    expect(isCompareModifier({ shiftKey: false, ctrlKey: false })).toBe(false)
  })

  it("adds a model after the composer's own and removes it again", () => {
    const added = toggleCompareModel(opus, [], gpt)
    expect(added).toEqual({ kind: "changed", extras: [gpt] })
    const removed = toggleCompareModel(opus, [gpt, grok], gpt)
    expect(removed).toEqual({ kind: "changed", extras: [grok] })
  })

  it("treats the same model of another provider as a different model", () => {
    const other = model("claude-api", "opus")
    expect(toggleCompareModel(opus, [], other)).toEqual({
      kind: "changed",
      extras: [other],
    })
  })

  it("hands the lead to the next model when the composer's own is removed", () => {
    expect(toggleCompareModel(opus, [gpt, grok], opus)).toEqual({
      kind: "promoted",
      primary: gpt,
      extras: [grok],
    })
    // The only model stays.
    expect(toggleCompareModel(opus, [], opus)).toEqual({ kind: "unchanged" })
  })

  it(`stops at ${COMPARE_MAX_MODELS} models`, () => {
    expect(toggleCompareModel(opus, [gpt, grok, gemini], sonnet)).toEqual({
      kind: "full",
    })
    // Removing still works at the limit.
    expect(toggleCompareModel(opus, [gpt, grok, gemini], grok)).toEqual({
      kind: "changed",
      extras: [gpt, gemini],
    })
  })

  it("drops an added copy of the composer's model and anything past the limit", () => {
    expect(
      compareEntries(opus, [opus, gpt, gpt, grok, gemini, sonnet])
    ).toEqual([opus, gpt, grok, gemini])
    expect(compareModelKey(opus)).not.toBe(compareModelKey(gpt))
  })
})

describe("compare titles", () => {
  it("names a chat after its model", () => {
    expect(compareChatTitle("Fix login", "GPT-5")).toBe("Fix login · GPT-5")
    expect(compareChatTitle("Fix login · GPT-5", "GPT-5")).toBe(
      "Fix login · GPT-5"
    )
    expect(compareChatTitle("  ", "Opus 4.5")).toBe("Opus 4.5")
  })

  it("drops Claude from the model's name", () => {
    expect(compareModelLabel("Claude Opus 4.5")).toBe("Opus 4.5")
    expect(compareModelLabel("GPT-5.5")).toBe("GPT-5.5")
    expect(compareModelLabel("Claude")).toBe("Claude")
  })

  it("tells two models with one name apart by provider", () => {
    expect(
      compareModelLabels([
        { name: "Claude Opus 4.5", providerName: "Claude Code" },
        { name: "Opus 4.5", providerName: "Claude API" },
        { name: "GPT-5", providerName: "Codex" },
      ])
    ).toEqual(["Opus 4.5 (Claude Code)", "Opus 4.5 (Claude API)", "GPT-5"])
  })

  it("shortens the prompt's first line for the shared title", () => {
    expect(compareBaseTitle("Fix the login\nwith details")).toBe(
      "Fix the login"
    )
    expect(compareBaseTitle(`  ${"word ".repeat(20)}`, 12)).toBe(
      "word word wo…"
    )
  })
})

describe("compare groups", () => {
  const threads = [
    { id: "b", createdAt: "2026-10-20T10:00:01.000Z" },
    { id: "a", createdAt: "2026-10-20T10:00:00.000Z" },
    { id: "c", createdAt: "2026-10-20T10:00:01.000Z" },
    { id: "d", createdAt: "2026-10-20T09:00:00.000Z" },
  ]
  const settings = {
    a: { compareGroupId: "g1" },
    b: { compareGroupId: "g1" },
    c: { compareGroupId: "g1" },
    d: { compareGroupId: "g2" },
  }

  it("lists a group's chats oldest first", () => {
    expect(compareGroupThreadIds(threads, settings, "g1")).toEqual([
      "a",
      "b",
      "c",
    ])
    expect(compareGroupThreadIds(threads, settings, undefined)).toEqual([])
  })
})

describe("compare draft store", () => {
  afterEach(() => {
    useCompareSelectionStore.setState({
      extrasByThread: {},
      progressByThread: {},
    })
  })

  it("keeps each added model's own reasoning level", () => {
    const store = useCompareSelectionStore.getState()
    store.setExtras("t1", [gpt, grok])
    store.setThinking("t1", gpt, "xhigh")
    expect(useCompareSelectionStore.getState().extrasByThread.t1).toEqual([
      { ...gpt, thinkingMode: "xhigh" },
      grok,
    ])
  })

  it("forgets a chat's comparison when it is cleared or emptied", () => {
    const store = useCompareSelectionStore.getState()
    store.setExtras("t1", [gpt])
    store.setExtras("t2", [grok])
    store.clear("t1")
    store.setExtras("t2", [])
    expect(useCompareSelectionStore.getState().extrasByThread).toEqual({})
  })

  it("tracks progress until it is cleared", () => {
    const store = useCompareSelectionStore.getState()
    store.setProgress("t1", "Creating worktree 1 of 3…")
    expect(useCompareSelectionStore.getState().progressByThread.t1).toBe(
      "Creating worktree 1 of 3…"
    )
    store.setProgress("t1", null)
    expect(useCompareSelectionStore.getState().progressByThread).toEqual({})
  })
})
