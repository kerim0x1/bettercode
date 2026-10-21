import { usePreferencesStore, type PreferencesState } from "./preferences-store"

/**
 * Whether the current mode's diff surface is showing: in Agent mode the
 * right panel's Diff view, in Editor and Canvas the sidebar's Diff view.
 * (Agent's inline `diffOpen` panel is not mounted in the pane layout, so it
 * no longer counts.)
 */
export function isDiffViewOpen(
  preferences: Pick<
    PreferencesState,
    | "appMode"
    | "rightSidebarOpen"
    | "workspaceTab"
    | "sidebarOpen"
    | "editorSidebarView"
  >
): boolean {
  return preferences.appMode === "agent"
    ? preferences.rightSidebarOpen && preferences.workspaceTab === "diff"
    : preferences.sidebarOpen && preferences.editorSidebarView === "diff"
}

/** All entry points use the diff surface belonging to the current mode. */
export function setDiffViewOpen(open: boolean): void {
  const preferences = usePreferencesStore.getState()
  if (preferences.appMode === "agent") {
    preferences.setMultiple(
      open
        ? { rightSidebarOpen: true, workspaceTab: "diff", diffOpen: false }
        : preferences.workspaceTab === "diff"
          ? { workspaceTab: "overview", diffOpen: false }
          : { diffOpen: false }
    )
    return
  }
  preferences.setMultiple({
    // Close the legacy editor bottom panel so it cannot duplicate this view.
    diffOpen: false,
    ...(open
      ? { sidebarOpen: true, editorSidebarView: "diff" }
      : preferences.editorSidebarView === "diff"
        ? { editorSidebarView: "files" }
        : {}),
  })
}

export function toggleDiffView(): boolean {
  const open = !isDiffViewOpen(usePreferencesStore.getState())
  setDiffViewOpen(open)
  return open
}
