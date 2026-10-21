import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  composerMenuActions,
  detectMentionQuery,
  useComposerMenuStore,
} from "./composer-menu-store"

const initial = useComposerMenuStore.getState()

beforeEach(() => {
  useComposerMenuStore.setState(initial, true)
})

describe("composer slash menu state", () => {
  it("opens for a command at the line start and records the trigger range", () => {
    composerMenuActions().checkSlash("/pla")
    const state = useComposerMenuStore.getState()
    expect(state.slashActive).toBe(true)
    expect(state.slashTrigger).toBe("/")
    expect(state.slashQuery).toBe("pla")
    expect(state.slashRange).toEqual({ start: 0, end: 4 })
  })

  it("closes once the command is followed by prompt text", () => {
    const { checkSlash } = composerMenuActions()
    checkSlash("/plan")
    checkSlash("/plan now")
    expect(useComposerMenuStore.getState()).toMatchObject({
      slashActive: false,
      slashQuery: "",
      slashRange: null,
    })
  })

  it("does not notify subscribers when a keystroke leaves the menu unchanged", () => {
    const listener = vi.fn()
    const unsubscribe = useComposerMenuStore.subscribe(listener)
    const { checkSlash, closeSlash, checkMention, closeMention } =
      composerMenuActions()
    // Ordinary typing with no menu open is the hot path.
    checkSlash("hello")
    checkSlash("hello world")
    checkMention("hello world")
    closeSlash()
    closeMention()
    expect(listener).not.toHaveBeenCalled()

    checkSlash("/pl")
    checkSlash("/pl")
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("resets the trigger when the menu is closed explicitly", () => {
    const { checkSlash, closeSlash } = composerMenuActions()
    checkSlash("fix $rev")
    expect(useComposerMenuStore.getState().slashTrigger).toBe("$")
    closeSlash()
    expect(useComposerMenuStore.getState()).toMatchObject({
      slashActive: false,
      slashTrigger: "/",
      slashQuery: "",
      slashRange: null,
    })
  })

  it("keeps the same action identities across updates", () => {
    const before = composerMenuActions()
    before.checkSlash("/x")
    const after = composerMenuActions()
    expect(after.checkSlash).toBe(before.checkSlash)
    expect(after.closeMention).toBe(before.closeMention)
  })
})

describe("composer @ mention state", () => {
  it.each([
    ["@", ""],
    ["see @src/app", "src/app"],
    ["a@b @c", "c"],
  ])("opens for %j with query %j", (text, query) => {
    expect(detectMentionQuery(text)).toBe(query)
    composerMenuActions().checkMention(text)
    expect(useComposerMenuStore.getState()).toMatchObject({
      mentionActive: true,
      mentionQuery: query,
    })
  })

  it.each(["no mention", "@done with it"])("stays closed for %j", (text) => {
    expect(detectMentionQuery(text)).toBeNull()
    composerMenuActions().checkMention(text)
    expect(useComposerMenuStore.getState()).toMatchObject({
      mentionActive: false,
      mentionQuery: "",
    })
  })

  it("closes and clears the query", () => {
    const { checkMention, closeMention } = composerMenuActions()
    checkMention("@readme")
    closeMention()
    expect(useComposerMenuStore.getState()).toMatchObject({
      mentionActive: false,
      mentionQuery: "",
    })
  })
})
