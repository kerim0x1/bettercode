import { useCallback, useEffect } from "react"
import { usePreferencesStore } from "@/lib/preferences-store"
import { useChatStore } from "@/lib/chat-store"
import type {
  EditorSidebarView,
  PermissionLevel,
} from "@/lib/preferences-store"
import type { ProviderComposerSelection } from "@/lib/provider-composer-selection"
import {
  resolveComposerPreferences,
  selectComposerModel,
  updateProviderComposerSelection,
} from "@/lib/composer-preferences"

/**
 * Returns the entire persisted preferences store as `[value, setter]`
 * pairs on a single object — saves ~50 lines of boilerplate in App.tsx
 * where each field would otherwise need its own `prefs.xxx` read + a
 * wrapped `setXxx` via `useCallback`.
 *
 * Each setter is memoized against the shared `prefs` reference so the
 * identity is stable as long as the store itself doesn't swap.
 *
 * **Per-thread scoping** (Plan-mode tab-leak fix): the seven composer
 * settings (chatMode, thinkingMode, selectedModel, selectedProviderId,
 * contextWindow, permissionLevel, specialMode) read from
 * `settingsByThread[activeThreadId]` with fall-through to the global
 * preferences as the "default for new threads". Setters write to the active
 * thread's overrides, so flipping one tab to Plan no longer flips the other
 * tabs. Provider/model setters additionally refresh the global new-thread
 * default, which makes the next chat start with the last-used model. The
 * non-chat fields (sidebar, console panel, etc.) stay global because they're
 * window-scoped UI chrome, not per-conversation.
 */
export function useAppPreferences(threadId?: string | null) {
  const prefs = usePreferencesStore()
  const activeThreadId = useChatStore((s) =>
    threadId === undefined ? s.activeThreadId : threadId
  )
  const threadSettings = useChatStore((s) =>
    activeThreadId ? s.settingsByThread[activeThreadId] : undefined
  )
  const setThreadSetting = useChatStore((s) => s.setThreadSetting)
  useEffect(() => {
    if (activeThreadId)
      useChatStore.getState().initializeThreadModelSettings(activeThreadId)
  }, [activeThreadId])
  const selection = resolveComposerPreferences(prefs, threadSettings)

  const updateProviderSelection = useCallback(
    (providerId: string | undefined, patch: ProviderComposerSelection) => {
      updateProviderComposerSelection(activeThreadId, providerId, patch)
    },
    [activeThreadId]
  )

  return {
    prefs,
    sidebarOpen: prefs.sidebarOpen,
    setSidebarOpen: useCallback(
      (v: boolean) => prefs.set("sidebarOpen", v),
      [prefs]
    ),
    selectedModel: selection.selectedModel,
    setSelectedModel: useCallback(
      (v: string, providerId?: string) => {
        selectComposerModel(activeThreadId, v, providerId)
      },
      [activeThreadId]
    ),
    selectedProviderId: selection.selectedProviderId,
    setSelectedProviderId: useCallback(
      (v: string) => {
        prefs.set("selectedProviderId", v)
        if (activeThreadId)
          setThreadSetting(activeThreadId, "selectedProviderId", v)
      },
      [prefs, activeThreadId, setThreadSetting]
    ),
    // Pinned to the model's maximum ("1m" where the model exposes the
    // descriptor; models without it ignore the value). The 200k/1M dropdown
    // was removed — stale persisted "200k" selections are overridden here.
    contextWindow: "1m" as const,
    setContextWindow: useCallback(
      (v: "200k" | "1m", providerId?: string) => {
        updateProviderSelection(providerId, { contextWindow: v })
        if (activeThreadId) setThreadSetting(activeThreadId, "contextWindow", v)
        else prefs.set("contextWindow", v)
      },
      [prefs, activeThreadId, setThreadSetting, updateProviderSelection]
    ),
    thinkingMode: selection.thinkingMode,
    setThinkingMode: useCallback(
      (v: string | null, providerId?: string) => {
        updateProviderSelection(providerId, { thinkingMode: v })
        if (activeThreadId) setThreadSetting(activeThreadId, "thinkingMode", v)
        else prefs.set("thinkingMode", v)
      },
      [prefs, activeThreadId, setThreadSetting, updateProviderSelection]
    ),
    webSearch: prefs.webSearch,
    setWebSearch: useCallback(
      (v: boolean) => prefs.set("webSearch", v),
      [prefs]
    ),
    // Codex / Claude CLI Fast Mode (priority compute). BetterC0de models it as a
    // provider/model option, so keep the legacy global value as fallback
    // while storing the active provider's explicit choice in the scoped map.
    fastMode: selection.fastMode,
    setFastMode: useCallback(
      (v: boolean) => {
        updateProviderSelection(undefined, { fastMode: v })
        prefs.set("fastMode", v)
      },
      [prefs, updateProviderSelection]
    ),
    chatMode: selection.chatMode,
    setChatMode: useCallback(
      (v: string) => {
        if (activeThreadId) setThreadSetting(activeThreadId, "chatMode", v)
        else prefs.set("chatMode", v)
      },
      [prefs, activeThreadId, setThreadSetting]
    ),
    specialMode: selection.specialMode,
    agentWindowMode: prefs.agentWindowMode,
    setAgentWindowMode: useCallback(
      (v: "sidebar" | "tab" | "popout" | "fullscreen") =>
        prefs.set("agentWindowMode", v),
      [prefs]
    ),
    terminalOpen: prefs.terminalOpen,
    setTerminalOpen: useCallback(
      (v: boolean) => prefs.set("terminalOpen", v),
      [prefs]
    ),
    diffOpen: prefs.diffOpen,
    setDiffOpen: useCallback((v: boolean) => prefs.set("diffOpen", v), [prefs]),
    consolePanelOpen: prefs.consolePanelOpen,
    setConsolePanelOpen: useCallback(
      (v: boolean) => prefs.set("consolePanelOpen", v),
      [prefs]
    ),
    consolePanelHeight: prefs.consolePanelHeight,
    setConsolePanelHeight: useCallback(
      (v: number) => prefs.set("consolePanelHeight", v),
      [prefs]
    ),
    editorSplitRatio: prefs.editorSplitRatio,
    setEditorSplitRatio: useCallback(
      (v: number) => prefs.set("editorSplitRatio", v),
      [prefs]
    ),
    editorWordWrap: prefs.editorWordWrap,
    setEditorWordWrap: useCallback(
      (v: boolean) => prefs.set("editorWordWrap", v),
      [prefs]
    ),
    editorMinimap: prefs.editorMinimap,
    setEditorMinimap: useCallback(
      (v: boolean) => prefs.set("editorMinimap", v),
      [prefs]
    ),
    editorStickyScroll: prefs.editorStickyScroll,
    setEditorStickyScroll: useCallback(
      (v: boolean) => prefs.set("editorStickyScroll", v),
      [prefs]
    ),
    editorRenderWhitespace: prefs.editorRenderWhitespace,
    setEditorRenderWhitespace: useCallback(
      (v: boolean) => prefs.set("editorRenderWhitespace", v),
      [prefs]
    ),
    editorInlayHints: prefs.editorInlayHints,
    setEditorInlayHints: useCallback(
      (v: boolean) => prefs.set("editorInlayHints", v),
      [prefs]
    ),
    editorLineNumbers: prefs.editorLineNumbers,
    setEditorLineNumbers: useCallback(
      (v: boolean) => prefs.set("editorLineNumbers", v),
      [prefs]
    ),
    explorerWidth: prefs.explorerWidth,
    setExplorerWidth: useCallback(
      (v: number) => prefs.set("explorerWidth", v),
      [prefs]
    ),
    chatPanelWidth: prefs.chatPanelWidth,
    setChatPanelWidth: useCallback(
      (v: number) => prefs.set("chatPanelWidth", v),
      [prefs]
    ),
    permissionLevel: selection.permissionLevel,
    setPermissionLevel: useCallback(
      (v: PermissionLevel) => {
        if (activeThreadId)
          setThreadSetting(activeThreadId, "permissionLevel", v)
        else prefs.set("permissionLevel", v)
      },
      [prefs, activeThreadId, setThreadSetting]
    ),
    workspaceTab: prefs.workspaceTab,
    setWorkspaceTab: useCallback(
      (v: "overview" | "plan" | "files" | "git" | "diff" | "browser") =>
        prefs.set("workspaceTab", v),
      [prefs]
    ),
    appMode: prefs.appMode,
    setAppMode: useCallback(
      (v: "agent" | "editor" | "design") => prefs.set("appMode", v),
      [prefs]
    ),
    sidebarWidth: prefs.sidebarWidth,
    setSidebarWidth: useCallback(
      (v: number) => prefs.set("sidebarWidth", v),
      [prefs]
    ),
    rightSidebarWidth: prefs.rightSidebarWidth,
    setRightSidebarWidth: useCallback(
      (v: number) => prefs.set("rightSidebarWidth", v),
      [prefs]
    ),
    rightSidebarOpen: prefs.rightSidebarOpen,
    setRightSidebarOpen: useCallback(
      (v: boolean) => prefs.set("rightSidebarOpen", v),
      [prefs]
    ),
    workspaceSidebarOpen: prefs.workspaceSidebarOpen,
    setWorkspaceSidebarOpen: useCallback(
      (v: boolean) => prefs.set("workspaceSidebarOpen", v),
      [prefs]
    ),
    fileTreeOpen: prefs.fileTreeOpen,
    setFileTreeOpen: useCallback(
      (v: boolean) => prefs.set("fileTreeOpen", v),
      [prefs]
    ),
    editorSidebarView: prefs.editorSidebarView,
    setEditorSidebarView: useCallback(
      (v: EditorSidebarView) => prefs.set("editorSidebarView", v),
      [prefs]
    ),
  }
}
