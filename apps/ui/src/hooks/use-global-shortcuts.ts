import { runEditorSave } from "@/lib/editor-save"
import { useEffect, useRef } from "react"
import { usePreferencesStore } from "@/lib/preferences-store"
import { useChatStore } from "@/lib/chat-store"
import { confirmCloseDirtyEditorTabs } from "@/lib/editor-close-confirmation"
import { dispatchEditorRevealFile } from "@/lib/editor-reveal-event"
import { useEditorStore } from "@/lib/editor-store"
import { useAppearanceStore } from "@/lib/appearance-store"
import { filterThreadsForSessionDirectory } from "@/lib/session-directory-filter"
import { useSettingsStore } from "@/lib/settings-store"
import { queuedMessageForEditKey } from "@/lib/queued-message-editor"
import {
  dispatchTerminalCloseActiveSession,
  dispatchTerminalNewSession,
  dispatchTerminalSplit,
} from "@/lib/terminal-events"
import {
  dispatchBrowserPreviewCommand,
  dispatchEditorPreviewToggle,
} from "@/lib/preview-events"
import { resolveShortcutParityAction } from "@/lib/shortcut-parity"
import { requestChatFind, resolveChatFindScope } from "@/lib/chat-find-events"
import { togglePlanMode } from "@/lib/plan-mode-toggle"
import { normalizeChatMode } from "@/lib/chat-mode-labels"

const CHAT_MODES = ["agent", "plan", "ask"] as const

/**
 * Where Plan was entered from, per thread ("" for no active thread), so
 * Shift+Tab can put the user back rather than always landing on Agent.
 * In-memory on purpose — see the toggle call site.
 */
const prePlanChatMode = new Map<string, string>()
interface ShortcutCallbacks {
  setChatMode: (mode: (typeof CHAT_MODES)[number]) => void
  onNewAgent?: () => void
  onNewProject?: () => void
  onOpenMarketplace?: () => void
  onOpenAutomations?: () => void
  onOpenSearch?: () => void
  onOpenSystemBrowser?: () => void
  onOpenSettings?: () => void
  onOpenCommandPalette?: () => void
  onOpenQuickOpen?: () => void
  onOpenGoToLine?: () => void
  onOpenDocumentSymbols?: () => void
  onOpenWorkspaceSymbols?: () => void
  onOpenExplorer?: () => void
  onOpenSourceControl?: () => void
  onToggleSidebar?: () => void
  onToggleTerminal?: () => void
  onToggleDiff?: () => void
  onToggleShortcuts?: () => void
  onSwitchThread?: (threadId: string) => void
}

export function useGlobalShortcuts(callbacks: ShortcutCallbacks) {
  // [FIX] react-hooks/refs — update the ref after render commits so the
  // keydown handler (installed once in the effect below) always sees the
  // latest callback identities without reinstalling the listener.
  const ref = useRef(callbacks)
  useEffect(() => {
    ref.current = callbacks
  })

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      const shift = e.shiftKey
      const alt = e.altKey
      const code = e.code
      const cb = ref.current
      // The interactive terminal owns its unmodified and Alt chords: shells
      // and full-screen programs use Shift+Tab and Alt+arrows themselves.
      // On macOS the app's chords use Cmd, so Ctrl chords there (Ctrl+C,
      // Ctrl+R, Ctrl+W…) belong to the shell too, except Ctrl+` (toggle).
      if (isInsideTerminal(e.target)) {
        const appChord =
          e.metaKey || (e.ctrlKey && (!APPLE_PLATFORM || code === "Backquote"))
        if (!appChord) return
      }

      // Shift+Tab → toggle Plan mode for the ACTIVE thread. Reads and
      // writes both go through `useChatStore.getState()` directly with
      // the same snapshot, so the "read per-thread → write per-thread"
      // invariant holds even across rapid keyrepeats where a `useCallback`
      // closure captured on the previous render could still be stale.
      // (Earlier bug: the mode got stuck because the write was landing on
      // global prefs while the read kept falling back to global's unchanged
      // value — read and write were out of sync.)
      if (shift && e.key === "Tab") {
        e.preventDefault()
        const chatState = useChatStore.getState()
        const activeId = chatState.activeThreadId
        const threadOverride = activeId
          ? chatState.settingsByThread[activeId]?.chatMode
          : undefined
        const cur = normalizeChatMode(
          threadOverride ?? usePreferencesStore.getState().chatMode
        )
        const rememberKey = activeId ?? ""
        const { next, remember } = togglePlanMode(
          cur,
          prePlanChatMode.get(rememberKey)
        )
        // Deliberately not persisted: "where Plan was entered from" is a
        // property of this keypress pair, not of the thread.
        if (remember) prePlanChatMode.set(rememberKey, remember)
        else prePlanChatMode.delete(rememberKey)
        if (activeId) {
          chatState.setThreadSetting(activeId, "chatMode", next)
        } else {
          usePreferencesStore.getState().set("chatMode", next)
        }
        return
      }
      const isArrowUp = code === "ArrowUp" || e.key === "ArrowUp"
      const isArrowDown = code === "ArrowDown" || e.key === "ArrowDown"
      const isArrowLeft = code === "ArrowLeft" || e.key === "ArrowLeft"
      const isArrowRight = code === "ArrowRight" || e.key === "ArrowRight"
      if (e.altKey && !ctrl && !shift && (isArrowLeft || isArrowRight)) {
        const editorState = useEditorStore.getState()
        const canNavigate = isArrowLeft
          ? editorState.navigationBackStack.length > 0
          : editorState.navigationForwardStack.length > 0
        if (!canNavigate) return
        e.preventDefault()
        e.stopPropagation()
        void (isArrowLeft ? editorState.goBack() : editorState.goForward())
        return
      }

      if (e.altKey && !ctrl && !shift && (isArrowUp || isArrowDown)) {
        // Alt+Up in an empty composer edits its last queued message
        // (components/chat/queued-messages.tsx) instead of switching chats.
        if (isArrowUp && queuedMessageForEditKey(e)) return
        const chatState = useChatStore.getState()
        const archivedIds = new Set(
          useSettingsStore.getState().archivedThreadIds
        )
        const loadedMap = chatState.messagesLoadedByThread
        const directoryFilteredThreads = filterThreadsForSessionDirectory(
          chatState.threads,
          chatState.activeThreadId,
          useAppearanceStore.getState().sessionDirectoryFilterEnabled
        )
        const visible = directoryFilteredThreads.filter((t) => {
          if (t.title?.startsWith("__inline-edit-")) return false
          if (archivedIds.has(t.id)) return false
          const hasUserMessage = t.messages?.some((m) => m.role === "user")
          const isHydrated = loadedMap[t.id] === true
          if (
            isHydrated
              ? !hasUserMessage
              : !(t.messageCount && t.messageCount > 0)
          ) {
            return false
          }
          return true
        })
        if (visible.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        const activeId = chatState.activeThreadId
        const idx = activeId ? visible.findIndex((t) => t.id === activeId) : -1
        const step = isArrowUp ? -1 : 1
        const nextIdx =
          idx < 0
            ? step === -1
              ? visible.length - 1
              : 0
            : Math.max(0, Math.min(visible.length - 1, idx + step))
        const nextId = visible[nextIdx]?.id
        if (nextId && nextId !== activeId) {
          if (cb.onSwitchThread) {
            cb.onSwitchThread(nextId)
          } else {
            chatState.setActiveThread(nextId)
          }
        }
        return
      }

      // Alt+Z → Toggle editor word wrap, matching the VS Code/Cursor chord.
      if (alt && !ctrl && !shift && code === "KeyZ") {
        const { activeTabId } = useEditorStore.getState()
        if (!activeTabId) return
        e.preventDefault()
        e.stopPropagation()
        const prefs = usePreferencesStore.getState()
        prefs.set("editorWordWrap", !prefs.editorWordWrap)
        return
      }

      // Shift+Alt+F → Format the active editor document.
      if (shift && alt && code === "KeyF") {
        const editorState = useEditorStore.getState()
        const activeTab = editorState.tabs.find(
          (tab) => tab.id === editorState.activeTabId
        )
        if (!activeTab) return
        e.preventDefault()
        e.stopPropagation()
        window.dispatchEvent(
          new CustomEvent("betterc0de:editor-format-document", {
            detail: { filePath: activeTab.filePath },
          })
        )
        return
      }

      if (!ctrl) return

      const target = e.target instanceof Element ? e.target : null
      const isInsideMonaco = Boolean(target?.closest(".monaco-editor"))
      const isTextEntryTarget = isEditableShortcutTarget(target)
      const terminalRoot = target?.closest(
        ".betterc0de-terminal"
      ) as HTMLElement | null
      const terminalPanelId = terminalRoot?.dataset.terminalPanelId
      const appMode = usePreferencesStore.getState().appMode
      const parityAction = resolveShortcutParityAction(e, {
        appMode,
        inMonaco: isInsideMonaco,
        inTextEntry: isTextEntryTarget,
        inTerminal: Boolean(terminalRoot),
        previewAvailable: Boolean(
          document.querySelector("[data-betterc0de-preview='browser']")
        ),
      })

      if (parityAction) {
        e.preventDefault()
        if (
          parityAction.startsWith("terminal-") ||
          parityAction.startsWith("preview-")
        ) {
          e.stopPropagation()
        }
        switch (parityAction) {
          case "command-palette":
            cb.onOpenCommandPalette?.()
            break
          case "terminal-toggle":
            cb.onToggleTerminal?.()
            break
          case "terminal-new":
            if (terminalPanelId) {
              dispatchTerminalNewSession({ targetPanelId: terminalPanelId })
            }
            break
          case "terminal-close":
            if (terminalPanelId) {
              dispatchTerminalCloseActiveSession({
                targetPanelId: terminalPanelId,
              })
            }
            break
          case "terminal-split-right":
          case "terminal-split-down":
            if (terminalPanelId) {
              dispatchTerminalSplit({
                targetPanelId: terminalPanelId,
                direction:
                  parityAction === "terminal-split-right" ? "right" : "down",
              })
            }
            break
          case "preview-toggle":
            dispatchEditorPreviewToggle()
            break
          case "preview-refresh":
            dispatchBrowserPreviewCommand("reload-page")
            break
          case "preview-focus-location":
            dispatchBrowserPreviewCommand("focus-url-bar")
            break
          case "preview-zoom-in":
            dispatchBrowserPreviewCommand("zoom-in")
            break
          case "preview-zoom-out":
            dispatchBrowserPreviewCommand("zoom-out")
            break
          case "preview-zoom-reset":
            dispatchBrowserPreviewCommand("zoom-reset")
            break
          case "new-agent":
            cb.onNewAgent?.()
            break
          case "new-project":
            cb.onNewProject?.()
            break
          case "open-shift-o":
            if (appMode === "editor") {
              cb.onOpenDocumentSymbols?.()
            } else {
              cb.onOpenSystemBrowser?.()
            }
            break
        }
        return
      }

      // Ctrl+F / Cmd+F → Find in Chat, while the chat (its transcript or its
      // composer) is where the user is. Monaco, terminals and the browser
      // preview keep their own find; anywhere else the key is left alone.
      // Ctrl+Shift+F stays the cross-chat search below.
      if (!shift && !alt && code === "KeyF") {
        if (isInsideMonaco || terminalRoot) return
        const scope = resolveChatFindScope(e.target, {
          fallbackToActiveChat: appMode === "agent",
        })
        if (!scope) return
        e.preventDefault()
        e.stopPropagation()
        requestChatFind(scope.id)
        return
      }

      // Ctrl+W / Cmd+W → close active editor tab in Editor Mode. Leave this
      // alone in Agent Mode so the composer-tab handler keeps its existing
      // behavior, and never steal it from regular inputs/search fields.
      if (!shift && !alt && code === "KeyW") {
        if (usePreferencesStore.getState().appMode !== "editor") return
        if (isTextEntryTarget && !isInsideMonaco) return
        const editorState = useEditorStore.getState()
        const activeTab = editorState.tabs.find(
          (tab) => tab.id === editorState.activeTabId
        )
        if (!activeTab) return
        e.preventDefault()
        e.stopPropagation()
        if (!confirmCloseDirtyEditorTabs([activeTab], "closing this editor"))
          return
        editorState.closeTab(activeTab.id)
        return
      }

      // Ctrl+, → Settings
      if (!shift && !alt && code === "Comma") {
        e.preventDefault()
        e.stopPropagation()
        cb.onOpenSettings?.()
        return
      }

      // Ctrl+B → Toggle sidebar.
      if (!shift && !alt && code === "KeyB") {
        e.preventDefault()
        e.stopPropagation()
        cb.onToggleSidebar?.()
        return
      }

      // Ctrl+` → Toggle terminal panel.
      if (!shift && !alt && (code === "Backquote" || e.key === "`")) {
        e.preventDefault()
        e.stopPropagation()
        cb.onToggleTerminal?.()
        return
      }

      // Ctrl+Shift+D → Toggle diff panel.
      if (shift && !alt && code === "KeyD") {
        e.preventDefault()
        e.stopPropagation()
        cb.onToggleDiff?.()
        return
      }

      // Ctrl+Shift+E → Explorer.
      if (shift && !alt && code === "KeyE") {
        e.preventDefault()
        e.stopPropagation()
        cb.onOpenExplorer?.()
        const editorState = useEditorStore.getState()
        const activeTab = editorState.tabs.find(
          (tab) => tab.id === editorState.activeTabId
        )
        if (activeTab) {
          dispatchEditorRevealFile(activeTab.filePath, { defer: true })
        }
        return
      }

      // Ctrl+Shift+G → Source Control.
      if (shift && !alt && code === "KeyG") {
        e.preventDefault()
        e.stopPropagation()
        cb.onOpenSourceControl?.()
        return
      }

      // Ctrl+Shift+PageUp/PageDown → move active editor tab left/right.
      if (shift && (code === "PageUp" || code === "PageDown")) {
        const editorState = useEditorStore.getState()
        const { activeTabId } = editorState
        if (!activeTabId) return
        const index = editorState.tabs.findIndex(
          (tab) => tab.id === activeTabId
        )
        const activeTab = editorState.tabs[index]
        const targetTab =
          code === "PageUp"
            ? editorState.tabs[index - 1]
            : editorState.tabs[index + 1]
        const canMove =
          index !== -1 &&
          Boolean(activeTab) &&
          Boolean(targetTab) &&
          activeTab?.isPinned === targetTab?.isPinned
        if (!canMove) return
        e.preventDefault()
        e.stopPropagation()
        editorState.moveTab(activeTabId, code === "PageUp" ? "left" : "right")
        return
      }

      // Ctrl+PageUp/PageDown → activate previous/next editor tab.
      if (!shift && (code === "PageUp" || code === "PageDown")) {
        const editorState = useEditorStore.getState()
        if (editorState.tabs.length <= 1) return
        e.preventDefault()
        e.stopPropagation()
        editorState.activateAdjacentTab(code === "PageUp" ? "previous" : "next")
        return
      }

      // Ctrl+\ → Split the active editor to the right.
      if (!shift && !alt && code === "Backslash") {
        const { activeTabId } = useEditorStore.getState()
        if (!activeTabId) return
        e.preventDefault()
        e.stopPropagation()
        window.dispatchEvent(
          new CustomEvent("betterc0de:editor-split-right", {
            detail: { tabId: activeTabId },
          })
        )
        return
      }

      // Ctrl+Shift+P → Command Palette. Ctrl+K is resolved above so Monaco,
      // regular text inputs, and terminals keep their focused key handling.
      if (shift && code === "KeyP") {
        e.preventDefault()
        cb.onOpenCommandPalette?.()
        return
      }

      // Ctrl+P → Quick Open File
      if (!shift && code === "KeyP") {
        e.preventDefault()
        cb.onOpenQuickOpen?.()
        return
      }
      // Ctrl+G → Go to Line in the active editor
      if (!shift && code === "KeyG") {
        const { activeTabId } = useEditorStore.getState()
        if (!activeTabId) return
        e.preventDefault()
        cb.onOpenGoToLine?.()
        return
      }
      // Ctrl+Shift+T → Reopen the most recently closed editor.
      if (shift && code === "KeyT") {
        const editorState = useEditorStore.getState()
        if (editorState.recentlyClosedTabs.length === 0) return
        e.preventDefault()
        void editorState.reopenClosedTab()
        return
      }
      // Ctrl+T → Workspace Symbols
      if (!shift && code === "KeyT") {
        e.preventDefault()
        cb.onOpenWorkspaceSymbols?.()
        return
      }

      // Ctrl+Alt+S → save all modified editor tabs
      if (!shift && alt && code === "KeyS") {
        const { tabs } = useEditorStore.getState()
        if (tabs.some((tab) => tab.isDirty)) {
          e.preventDefault()
          void runEditorSave(() => useEditorStore.getState().saveAllTabs())
        }
        return
      }

      // Ctrl+S → save active editor tab
      if (!shift && !alt && code === "KeyS") {
        const { activeTabId } = useEditorStore.getState()
        if (activeTabId) {
          e.preventDefault()
          void runEditorSave(() => useEditorStore.getState().saveActiveTab())
        }
        return
      }
      // Ctrl+Shift+M → Marketplace outside Editor Mode, Problems in Editor Mode.
      if (shift && code === "KeyM") {
        e.preventDefault()
        cb.onOpenMarketplace?.()
        return
      }
      // Ctrl+Shift+A → Automations
      if (shift && code === "KeyA") {
        e.preventDefault()
        cb.onOpenAutomations?.()
        return
      }
      // Ctrl+Shift+F → Search. The app-level callback routes this to
      // workspace content search in Editor Mode and chat/project search
      // everywhere else.
      if (shift && code === "KeyF") {
        e.preventDefault()
        cb.onOpenSearch?.()
        return
      }
      // Ctrl+/ → Toggle keyboard shortcuts dialog
      if (!shift && (code === "Slash" || e.key === "/")) {
        e.preventDefault()
        cb.onToggleShortcuts?.()
        return
      }
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [])
}

/** macOS, where the app's chords use Cmd and Ctrl stays with the shell. */
const APPLE_PLATFORM =
  typeof navigator !== "undefined" && /^mac/i.test(navigator.platform)

function isInsideTerminal(target: EventTarget | null): boolean {
  return (
    target instanceof Element && Boolean(target.closest(".betterc0de-terminal"))
  )
}

function isEditableShortcutTarget(target: Element | null): boolean {
  if (!target) return false
  if (target.closest("[contenteditable='true']")) return true
  const element = target.closest("input, textarea, select")
  if (!element) return false
  if (element instanceof HTMLInputElement) {
    return !element.readOnly && !element.disabled
  }
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return !element.disabled
  }
  return true
}
