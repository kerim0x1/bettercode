import { describe, expect, it } from "vitest"
import {
  EMPTY_TERMINAL_GROUP,
  MAX_TERMINAL_PANES_PER_TAB,
  MAX_TERMINAL_SPLIT_RATIO,
  activeTerminalIdOf,
  addTerminalTab,
  focusTerminalPane,
  groupTerminalIds,
  layoutTerminalIds,
  parseTerminalGroup,
  removeTerminalPane,
  removeTerminalTab,
  renameTerminalTab,
  resizeTerminalSplit,
  splitTerminalPane,
  type TerminalGroup,
} from "./terminal-layout"

function twoTabs(): TerminalGroup {
  return addTerminalTab(
    addTerminalTab(EMPTY_TERMINAL_GROUP, "t1", "a"),
    "t2",
    "b"
  )
}

describe("terminal tabs", () => {
  it("adds tabs after the others and activates the new one", () => {
    const group = twoTabs()
    expect(group.tabs.map((tab) => tab.id)).toEqual(["t1", "t2"])
    expect(group.activeTabId).toBe("t2")
    expect(activeTerminalIdOf(group)).toBe("b")
  })

  it("activates the right neighbour, else the left, when the active tab closes", () => {
    const three = addTerminalTab(twoTabs(), "t3", "c")
    const middle = removeTerminalTab({ ...three, activeTabId: "t2" }, "t2")
    expect(middle.removed).toEqual(["b"])
    expect(middle.group.activeTabId).toBe("t3")
    const last = removeTerminalTab(three, "t3")
    expect(last.group.activeTabId).toBe("t2")
    const all = removeTerminalTab(
      addTerminalTab(EMPTY_TERMINAL_GROUP, "t1", "a"),
      "t1"
    )
    expect(all.group).toEqual({ tabs: [], activeTabId: null })
  })

  it("names a tab and gives the name back when it is cleared", () => {
    const named = renameTerminalTab(twoTabs(), "t1", "  dev server  ")
    expect(named.tabs[0]?.title).toBe("dev server")
    const cleared = renameTerminalTab(named, "t1", "   ")
    expect(cleared.tabs[0]).not.toHaveProperty("title")
  })
})

describe("terminal splits", () => {
  it("splits the focused pane right and down, focusing the new terminal", () => {
    const right = splitTerminalPane(twoTabs(), "a", "a2", "row", "s1")!
    expect(right.activeTabId).toBe("t1")
    expect(layoutTerminalIds(right.tabs[0]!.layout)).toEqual(["a", "a2"])
    expect(right.tabs[0]!.layout).toMatchObject({
      type: "split",
      direction: "row",
      ratio: 0.5,
    })
    const down = splitTerminalPane(right, "a", "a3", "column", "s2")!
    expect(layoutTerminalIds(down.tabs[0]!.layout)).toEqual(["a", "a3", "a2"])
    expect(activeTerminalIdOf(down)).toBe("a3")
    expect(groupTerminalIds(down)).toEqual(["a", "a3", "a2", "b"])
  })

  it(`refuses a split past ${MAX_TERMINAL_PANES_PER_TAB} panes`, () => {
    let group: TerminalGroup = addTerminalTab(EMPTY_TERMINAL_GROUP, "t1", "p0")
    for (let index = 1; index < MAX_TERMINAL_PANES_PER_TAB; index += 1) {
      group = splitTerminalPane(
        group,
        `p${index - 1}`,
        `p${index}`,
        "row",
        `s${index}`
      )!
    }
    expect(splitTerminalPane(group, "p0", "extra", "row", "s9")).toBeNull()
    expect(splitTerminalPane(group, "unknown", "extra", "row", "s9")).toBeNull()
  })

  it("gives a closed pane's space to its neighbour, which gets the keyboard", () => {
    const split = splitTerminalPane(twoTabs(), "a", "a2", "row", "s1")!
    const closed = removeTerminalPane(split, "a2")
    expect(closed.tabs[0]!.layout).toEqual({ type: "pane", terminalId: "a" })
    expect(closed.tabs[0]!.activeTerminalId).toBe("a")
    const first = removeTerminalPane(split, "a")
    expect(first.tabs[0]!.layout).toEqual({ type: "pane", terminalId: "a2" })
  })

  it("closes the tab with its last pane", () => {
    const closed = removeTerminalPane(twoTabs(), "b")
    expect(closed.tabs.map((tab) => tab.id)).toEqual(["t1"])
    expect(closed.activeTabId).toBe("t1")
  })

  it("focuses a pane in another tab by switching to that tab", () => {
    const split = splitTerminalPane(twoTabs(), "a", "a2", "row", "s1")!
    const focused = focusTerminalPane({ ...split, activeTabId: "t2" }, "a")
    expect(focused.activeTabId).toBe("t1")
    expect(focused.tabs[0]!.activeTerminalId).toBe("a")
  })

  it("keeps a resized split within its bounds", () => {
    const split = splitTerminalPane(twoTabs(), "a", "a2", "row", "s1")!
    const wide = resizeTerminalSplit(split, "t1", "s1", 0.99)
    expect(wide.tabs[0]!.layout).toMatchObject({
      ratio: MAX_TERMINAL_SPLIT_RATIO,
    })
    expect(resizeTerminalSplit(wide, "t1", "s1", 0.99)).toBe(wide)
  })
})

describe("saved terminal layouts", () => {
  const exists = (id: string) => ["a", "b", "c"].includes(id)

  it("reads back a saved group and drops panes whose terminal is gone", () => {
    const group = parseTerminalGroup(
      {
        activeTabId: "t2",
        tabs: [
          {
            id: "t1",
            title: "server",
            activeTerminalId: "gone",
            layout: {
              type: "split",
              id: "s1",
              direction: "column",
              ratio: 2,
              first: { type: "pane", terminalId: "a" },
              second: { type: "pane", terminalId: "gone" },
            },
          },
          {
            id: "t2",
            activeTerminalId: "b",
            layout: { type: "pane", terminalId: "b" },
          },
        ],
      },
      exists
    )
    expect(group).toEqual({
      activeTabId: "t2",
      tabs: [
        {
          id: "t1",
          title: "server",
          activeTerminalId: "a",
          layout: { type: "pane", terminalId: "a" },
        },
        {
          id: "t2",
          activeTerminalId: "b",
          layout: { type: "pane", terminalId: "b" },
        },
      ],
    })
  })

  it("refuses malformed input and a terminal held by two tabs", () => {
    expect(parseTerminalGroup(null, exists)).toBeNull()
    expect(parseTerminalGroup({ tabs: "x" }, exists)).toBeNull()
    expect(
      parseTerminalGroup(
        { tabs: [{ id: "t1", layout: { type: "pane", terminalId: "../x" } }] },
        exists
      )
    ).toBeNull()
    const twice = parseTerminalGroup(
      {
        tabs: [
          { id: "t1", layout: { type: "pane", terminalId: "a" } },
          { id: "t2", layout: { type: "pane", terminalId: "a" } },
        ],
      },
      exists
    )
    expect(twice?.tabs.map((tab) => tab.id)).toEqual(["t1"])
    expect(twice?.activeTabId).toBe("t1")
  })
})
