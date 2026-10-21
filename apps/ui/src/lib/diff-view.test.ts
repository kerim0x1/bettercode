import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isDiffViewOpen, setDiffViewOpen, toggleDiffView } from "./diff-view"
import { PREFERENCE_DEFAULTS, usePreferencesStore } from "./preferences-store"

describe("diff view routing", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    const storage = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
    usePreferencesStore.setState(PREFERENCE_DEFAULTS)
  })
  afterEach(() => {
    usePreferencesStore.getState().reset()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each(["editor", "design"] as const)(
    "opens and closes the %s sidebar without changing mode",
    (appMode) => {
      usePreferencesStore.setState({
        appMode,
        sidebarOpen: false,
        editorSidebarView: "search",
        diffOpen: true,
      })
      expect(toggleDiffView()).toBe(true)
      expect(usePreferencesStore.getState()).toMatchObject({
        appMode,
        sidebarOpen: true,
        editorSidebarView: "diff",
        diffOpen: false,
      })
      expect(isDiffViewOpen(usePreferencesStore.getState())).toBe(true)
      expect(toggleDiffView()).toBe(false)
      expect(usePreferencesStore.getState()).toMatchObject({
        appMode,
        sidebarOpen: true,
        editorSidebarView: "files",
        diffOpen: false,
      })
    }
  )

  it.each(["editor", "design"] as const)(
    "reopens a collapsed %s sidebar with Diff selected",
    (appMode) => {
      usePreferencesStore.setState({
        appMode,
        sidebarOpen: false,
        editorSidebarView: "diff",
      })
      expect(toggleDiffView()).toBe(true)
      expect(usePreferencesStore.getState().sidebarOpen).toBe(true)
      expect(usePreferencesStore.getState().editorSidebarView).toBe("diff")
    }
  )

  it("uses the right panel's Diff view in Agent mode", () => {
    usePreferencesStore.setState({
      appMode: "agent",
      sidebarOpen: false,
      editorSidebarView: "search",
      rightSidebarOpen: false,
      workspaceTab: "files",
    })
    expect(toggleDiffView()).toBe(true)
    expect(usePreferencesStore.getState()).toMatchObject({
      appMode: "agent",
      sidebarOpen: false,
      editorSidebarView: "search",
      rightSidebarOpen: true,
      workspaceTab: "diff",
      diffOpen: false,
    })
    expect(isDiffViewOpen(usePreferencesStore.getState())).toBe(true)
    expect(toggleDiffView()).toBe(false)
    expect(usePreferencesStore.getState().workspaceTab).toBe("overview")
  })

  it("leaves another right panel view alone when Agent Diff is turned off", () => {
    usePreferencesStore.setState({
      appMode: "agent",
      rightSidebarOpen: true,
      workspaceTab: "git",
    })
    setDiffViewOpen(false)
    expect(usePreferencesStore.getState().workspaceTab).toBe("git")
  })

  it("does not replace another sidebar view when Settings disables Diff", () => {
    usePreferencesStore.setState({
      appMode: "design",
      editorSidebarView: "search",
    })
    setDiffViewOpen(false)
    expect(usePreferencesStore.getState().editorSidebarView).toBe("search")
  })

  it("restores the persisted Diff sidebar after a restart", () => {
    usePreferencesStore.setState({ appMode: "design" })
    setDiffViewOpen(true)
    vi.runOnlyPendingTimers()
    usePreferencesStore.setState({ editorSidebarView: "files" })
    usePreferencesStore.getState().load()
    expect(usePreferencesStore.getState().editorSidebarView).toBe("diff")
  })
})
