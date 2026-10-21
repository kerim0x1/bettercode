import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useChatStore } from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { createEmptyThreadForTab } from "@/lib/thread-create"
import { snapshotComposerModelSettings } from "@/lib/composer-settings"
import { isComposerShortcutTextEntryTarget } from "@/lib/composer-shortcuts"
import {
  chatSlotFromKeyEvent,
  openChatListSlot,
  setChatJumpAvailable,
} from "@/lib/chat-list-nav"
import {
  activateThreadTab,
  appendPaneBalanced,
  canSplit,
  countPanes,
  flattenColumns,
  insertPaneAt,
  mapPanes,
  MAX_PANES,
  normalizePlacement,
  removeEmptyPanes,
  removePane,
  type Pane,
  type PaneLayout,
  type PaneLayoutState,
  type PanePlacementInput,
  type PaneTab,
  type PaneTabKind,
} from "@/lib/pane-layout"

/**
 * Agent-mode multi-pane workspace state (Cursor-style grid of independent
 * chats, each pane its own tabbed container).
 *
 * Layout model: columns-of-rows (`columns: Pane[][]`, see lib/pane-layout.ts)
 * so left/right drops create new columns and top/bottom drops stack panes
 * vertically WITHIN a column. The public `paneLayout.panes` array is the
 * derived column-major flatten — read-only consumers (and Ctrl+1..8) keep
 * working against it unchanged.
 *
 * Editor mode keeps using `use-composer-tabs.ts`; this hook drives agent mode
 * only. Both listen to the `betterc0de:open-thread` event and Ctrl-shortcuts,
 * so each guards on `appMode` to avoid double-handling.
 *
 * StrictMode rule (same as use-composer-tabs): NEVER call
 * `createEmptyThreadForTab` inside a setState updater — compute thread ids in
 * the outer handler, then commit pure state.
 */
export type {
  Pane,
  PaneLayout,
  PanePlacement,
  PanePlacementInput,
  PaneTab,
  PaneTabKind,
} from "@/lib/pane-layout"

let seq = 0
function uid(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function makeChatTab(threadId: string | null): PaneTab {
  return { id: uid("ptab"), kind: "chat", threadId, title: "Chat" }
}

function makePane(threadId: string | null): Pane {
  const tab = makeChatTab(threadId)
  return {
    id: uid("pane"),
    tabs: [tab],
    activeTabId: tab.id,
    primaryThreadId: threadId,
  }
}

function initialLayout(): PaneLayoutState {
  const pane = makePane(null)
  return { columns: [[pane]], activePaneId: pane.id, maximizedPaneId: null }
}

function titleForKind(kind: PaneTabKind): string {
  switch (kind) {
    case "terminal":
      return "Terminal"
    case "plan":
      return "Plan"
    case "diff":
      return "Diff"
    case "files":
      return "Files"
    case "git":
      return "Git"
    default:
      return "Chat"
  }
}

/**
 * The pane's project context follows its active chat tab (or, when a non-chat
 * tab is active, the most-recent chat tab) so terminal/diff/git/files always
 * have a cwd.
 */
function primaryThreadForPane(pane: Pane): string | null {
  const active = pane.tabs.find((t) => t.id === pane.activeTabId)
  if (active?.kind === "chat") return active.threadId
  const lastChat = [...pane.tabs]
    .reverse()
    .find((t) => t.kind === "chat" && t.threadId)
  return lastChat?.threadId ?? pane.primaryThreadId ?? null
}

export function usePanes() {
  const [state, setLayout] = useState<PaneLayoutState>(initialLayout)
  // Public layout = state + derived column-major flat list (Ctrl+1..8
  // order). Keeping `panes` derived means every read-only consumer of the
  // old flat model works unchanged.
  const layout: PaneLayout = useMemo(
    () => ({ ...state, panes: flattenColumns(state.columns) }),
    [state]
  )
  const layoutRef = useRef(layout)
  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  const setActivePane = useCallback((paneId: string) => {
    const pane = layoutRef.current.panes.find((p) => p.id === paneId)
    setLayout((prev) =>
      prev.activePaneId === paneId ? prev : { ...prev, activePaneId: paneId }
    )
    if (
      pane &&
      useChatStore.getState().activeThreadId !== pane.primaryThreadId
    ) {
      useChatStore.getState().setActiveThread(pane.primaryThreadId)
    }
  }, [])

  const addPane = useCallback(() => {
    const current = layoutRef.current
    if (current.panes.length >= MAX_PANES) return
    const threadId = createEmptyThreadForTab(`Chat ${current.panes.length + 1}`)
    const pane = makePane(threadId)
    setLayout((prev) => ({
      columns: appendPaneBalanced(prev.columns, pane),
      activePaneId: pane.id,
      maximizedPaneId: null,
    }))
    useChatStore.getState().setActiveThread(threadId)
  }, [])

  const closePane = useCallback((paneId: string) => {
    setLayout((prev) => {
      const columns = removePane(prev.columns, paneId)
      if (countPanes(columns) === 0) {
        const fresh = makePane(null)
        return {
          columns: [[fresh]],
          activePaneId: fresh.id,
          maximizedPaneId: null,
        }
      }
      const flat = flattenColumns(columns)
      return {
        columns,
        activePaneId:
          prev.activePaneId === paneId
            ? flat[flat.length - 1]!.id
            : prev.activePaneId,
        maximizedPaneId:
          prev.maximizedPaneId === paneId ? null : prev.maximizedPaneId,
      }
    })
  }, [])

  const maximizePane = useCallback((paneId: string) => {
    setLayout((prev) => ({
      ...prev,
      maximizedPaneId: paneId,
      activePaneId: paneId,
    }))
  }, [])

  const restorePane = useCallback(() => {
    setLayout((prev) => ({ ...prev, maximizedPaneId: null }))
  }, [])

  const addTab = useCallback((paneId: string, kind: PaneTabKind) => {
    const threadId = kind === "chat" ? createEmptyThreadForTab("Chat") : null
    const tab: PaneTab = {
      id: uid("ptab"),
      kind,
      threadId,
      title: titleForKind(kind),
    }
    setLayout((prev) => ({
      ...prev,
      activePaneId: paneId,
      columns: mapPanes(prev.columns, (p) => {
        if (p.id !== paneId) return p
        const next = { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }
        return { ...next, primaryThreadId: primaryThreadForPane(next) }
      }),
    }))
    if (kind === "chat" && threadId) {
      useChatStore.getState().setActiveThread(threadId)
    }
  }, [])

  const setActiveTab = useCallback((paneId: string, tabId: string) => {
    setLayout((prev) => ({
      ...prev,
      activePaneId: paneId,
      columns: mapPanes(prev.columns, (p) => {
        if (p.id !== paneId) return p
        const next = { ...p, activeTabId: tabId }
        return { ...next, primaryThreadId: primaryThreadForPane(next) }
      }),
    }))
    const pane = layoutRef.current.panes.find((p) => p.id === paneId)
    const tab = pane?.tabs.find((t) => t.id === tabId)
    if (
      tab?.kind === "chat" &&
      tab.threadId &&
      useChatStore.getState().activeThreadId !== tab.threadId
    ) {
      useChatStore.getState().setActiveThread(tab.threadId)
    }
  }, [])

  const closeTab = useCallback((paneId: string, tabId: string) => {
    setLayout((prev) => ({
      ...prev,
      columns: mapPanes(prev.columns, (p) => {
        if (p.id !== paneId) return p
        const remaining = p.tabs.filter((t) => t.id !== tabId)
        const tabs = remaining.length > 0 ? remaining : [makeChatTab(null)]
        const activeTabId =
          p.activeTabId === tabId ? tabs[tabs.length - 1]!.id : p.activeTabId
        const next = { ...p, tabs, activeTabId }
        return { ...next, primaryThreadId: primaryThreadForPane(next) }
      }),
    }))
  }, [])

  /**
   * Drag-to-split: move a tab from one pane into another (`into`) or split it
   * out into a brand-new pane. `left`/`right` open a new COLUMN next to the
   * target's column; `top`/`bottom` stack the new pane WITHIN the target's
   * column. Splits that would blow a cap fall back to `into`. Emptied source
   * panes (and their emptied columns) are dropped.
   */
  const moveTabToPane = useCallback(
    (
      fromPaneId: string,
      tabId: string,
      toPaneId: string,
      mode: PanePlacementInput
    ) => {
      const fromPane0 = layoutRef.current.panes.find((p) => p.id === fromPaneId)
      const movingTab0 = fromPane0?.tabs.find((t) => t.id === tabId)
      if (!movingTab0) return
      const requested = normalizePlacement(mode)
      if (requested === "into" && fromPaneId === toPaneId) return
      // Splitting a pane's ONLY tab against itself is a visual no-op that
      // would just churn pane ids (remount) — skip it.
      if (
        requested !== "into" &&
        fromPaneId === toPaneId &&
        fromPane0!.tabs.length <= 1
      ) {
        return
      }

      setLayout((prev) => {
        const movingTab = flattenColumns(prev.columns)
          .find((p) => p.id === fromPaneId)
          ?.tabs.find((t) => t.id === tabId)
        if (!movingTab) return prev

        const placement =
          requested !== "into" && !canSplit(prev.columns, toPaneId, requested)
            ? "into"
            : requested

        // 1) remove from source, fixing its active tab. The source pane
        //    stays in place (possibly tabless) so the insert anchor below
        //    still resolves; cleanup happens in step 3.
        let columns = mapPanes(prev.columns, (p) => {
          if (p.id !== fromPaneId) return p
          const tabs = p.tabs.filter((t) => t.id !== tabId)
          const activeTabId =
            p.activeTabId === tabId
              ? (tabs[tabs.length - 1]?.id ?? p.activeTabId)
              : p.activeTabId
          return { ...p, tabs, activeTabId }
        })

        // 2) place the tab
        let newPaneId: string | null = null
        if (placement === "into") {
          columns = mapPanes(columns, (p) => {
            if (p.id !== toPaneId) return p
            const next = {
              ...p,
              tabs: [...p.tabs, movingTab],
              activeTabId: movingTab.id,
            }
            return { ...next, primaryThreadId: primaryThreadForPane(next) }
          })
        } else {
          const newPane: Pane = {
            id: uid("pane"),
            tabs: [movingTab],
            activeTabId: movingTab.id,
            primaryThreadId:
              movingTab.kind === "chat" ? movingTab.threadId : null,
          }
          newPaneId = newPane.id
          columns = insertPaneAt(columns, toPaneId, newPane, placement)
        }

        // 3) recompute source primary, drop now-empty panes + columns
        columns = removeEmptyPanes(
          mapPanes(columns, (p) =>
            p.id === fromPaneId
              ? { ...p, primaryThreadId: primaryThreadForPane(p) }
              : p
          )
        )

        if (countPanes(columns) === 0) {
          const fresh = makePane(null)
          return {
            columns: [[fresh]],
            activePaneId: fresh.id,
            maximizedPaneId: null,
          }
        }

        const flat = flattenColumns(columns)
        const wanted =
          placement === "into" ? toPaneId : (newPaneId ?? prev.activePaneId)
        const activePaneId = flat.some((p) => p.id === wanted)
          ? wanted
          : flat[flat.length - 1]!.id
        return { columns, activePaneId, maximizedPaneId: null }
      })

      if (movingTab0.kind === "chat" && movingTab0.threadId) {
        useChatStore.getState().setActiveThread(movingTab0.threadId)
      }
    },
    []
  )

  /**
   * Drag a sidebar chat onto a pane: `into` adds it as a chat tab in the
   * target pane; `left`/`right` split into a new column, `top`/`bottom`
   * stack a new pane within the target's column. Cap overflow → `into`.
   */
  const openThreadOnPane = useCallback(
    (
      threadId: string,
      label: string | undefined,
      toPaneId: string,
      mode: PanePlacementInput
    ) => {
      if (!threadId) return
      setLayout((prev) => {
        const requested = normalizePlacement(mode)
        const placement =
          requested !== "into" && !canSplit(prev.columns, toPaneId, requested)
            ? "into"
            : requested
        if (placement === "into") {
          const target = flattenColumns(prev.columns).find(
            (p) => p.id === toPaneId
          )
          // Already showing this thread → no-op.
          if (target?.primaryThreadId === threadId) return prev
          return {
            ...prev,
            activePaneId: toPaneId,
            maximizedPaneId: null,
            columns: mapPanes(prev.columns, (p) => {
              if (p.id !== toPaneId) return p
              const tab = makeChatTab(threadId)
              if (label) tab.title = label
              const next = { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }
              return { ...next, primaryThreadId: primaryThreadForPane(next) }
            }),
          }
        }
        const tab = makeChatTab(threadId)
        if (label) tab.title = label
        const newPane: Pane = {
          id: uid("pane"),
          tabs: [tab],
          activeTabId: tab.id,
          primaryThreadId: threadId,
        }
        return {
          ...prev,
          columns: insertPaneAt(prev.columns, toPaneId, newPane, placement),
          activePaneId: newPane.id,
          maximizedPaneId: null,
        }
      })
      if (useChatStore.getState().activeThreadId !== threadId) {
        useChatStore.getState().setActiveThread(threadId)
      }
    },
    []
  )

  /**
   * Open a thread: focus the pane already showing it, else bind the active
   * pane's active chat tab to this thread (Cursor-style — clicking a chat in
   * the sidebar opens it in the focused pane).
   */
  const openThreadInPane = useCallback((threadId: string, label?: string) => {
    if (!threadId) return
    setLayout((prev) => {
      const activated = activateThreadTab(prev, threadId)
      if (activated) return activated

      const columns = mapPanes(prev.columns, (p) => {
        if (p.id !== prev.activePaneId) return p
        const activeTab = p.tabs.find((t) => t.id === p.activeTabId)
        if (activeTab && activeTab.kind === "chat") {
          return {
            ...p,
            primaryThreadId: threadId,
            tabs: p.tabs.map((t) =>
              t.id === activeTab.id
                ? { ...t, threadId, title: label ?? t.title }
                : t
            ),
          }
        }
        const chatTab = makeChatTab(threadId)
        return {
          ...p,
          tabs: [...p.tabs, chatTab],
          activeTabId: chatTab.id,
          primaryThreadId: threadId,
        }
      })
      return { ...prev, columns }
    })
    if (useChatStore.getState().activeThreadId !== threadId) {
      useChatStore.getState().setActiveThread(threadId)
    }
  }, [])

  // The initial tab and last-tab replacement are placeholders. Once there
  // are multiple tabs/panes they need their own identities too, before model
  // clicks or commands can fall through to another chat's defaults.
  const placeholderThreads = useRef(new Map<string, string>())
  const appMode = usePreferencesStore((prefs) => prefs.appMode)
  useEffect(() => {
    if (appMode !== "agent") return
    const panes = flattenColumns(state.columns)
    if (panes.length === 1 && panes[0].tabs.length === 1) return
    const blankTabs = panes.flatMap((pane) =>
      pane.tabs.filter((tab) => tab.kind === "chat" && !tab.threadId)
    )
    const blankIds = new Set(blankTabs.map((tab) => tab.id))
    for (const id of placeholderThreads.current.keys()) {
      if (!blankIds.has(id)) placeholderThreads.current.delete(id)
    }
    if (!blankTabs.length) return

    const store = useChatStore.getState()
    const focusedThreadId = store.activeThreadId
    const defaults = snapshotComposerModelSettings(
      usePreferencesStore.getState()
    )
    const bindings = new Map<string, string>()
    for (const tab of blankTabs) {
      let threadId = placeholderThreads.current.get(tab.id)
      if (!threadId) {
        threadId = createEmptyThreadForTab("New Chat")
        // Blank tabs displayed global defaults, which can differ from the
        // currently focused thread's saved selection.
        store.setThreadSetting(
          threadId,
          "selectedProviderId",
          defaults.selectedProviderId
        )
        store.setThreadSetting(
          threadId,
          "selectedModel",
          defaults.selectedModel
        )
        store.setThreadSetting(
          threadId,
          "modelSelectionByProvider",
          defaults.modelSelectionByProvider
        )
        placeholderThreads.current.set(tab.id, threadId)
      }
      bindings.set(tab.id, threadId)
    }
    const bind = (pane: Pane): Pane => {
      if (!pane.tabs.some((tab) => !tab.threadId && bindings.has(tab.id)))
        return pane
      const next = {
        ...pane,
        tabs: pane.tabs.map((tab) =>
          !tab.threadId && bindings.has(tab.id)
            ? { ...tab, threadId: bindings.get(tab.id)! }
            : tab
        ),
      }
      return { ...next, primaryThreadId: primaryThreadForPane(next) }
    }
    // Creation stays outside React updaters; the cache prevents duplicate
    // threads when StrictMode replays the effect before the binding commits.
    setLayout((prev) => ({ ...prev, columns: mapPanes(prev.columns, bind) }))
    const activePane = panes.find((pane) => pane.id === state.activePaneId)
    store.setActiveThread(
      activePane ? bind(activePane).primaryThreadId : focusedThreadId
    )
  }, [appMode, state.columns, state.activePaneId])

  // Bind the active pane's empty chat tab to a newly-active thread (e.g. one
  // created by the new-thread modal). Guarded like use-composer-tabs so it
  // never clobbers an already-bound chat tab.
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  useEffect(() => {
    if (usePreferencesStore.getState().appMode !== "agent") return
    if (!activeThreadId) return
    setLayout((prev) => {
      const flat = flattenColumns(prev.columns)
      if (flat.some((p) => p.primaryThreadId === activeThreadId)) {
        return prev
      }
      const active = flat.find((p) => p.id === prev.activePaneId)
      if (!active) return prev
      const activeTab = active.tabs.find((t) => t.id === active.activeTabId)
      if (!activeTab || activeTab.kind !== "chat" || activeTab.threadId) {
        return prev
      }
      return {
        ...prev,
        columns: mapPanes(prev.columns, (p) =>
          p.id === active.id
            ? {
                ...p,
                primaryThreadId: activeThreadId,
                tabs: p.tabs.map((t) =>
                  t.id === activeTab.id ? { ...t, threadId: activeThreadId } : t
                ),
              }
            : p
        ),
      }
    })
  }, [activeThreadId])

  // Cross-component bridge: sidebar thread list dispatches this. Agent only.
  useEffect(() => {
    const handler = (e: Event) => {
      if (usePreferencesStore.getState().appMode !== "agent") return
      const detail = (e as CustomEvent<{ threadId?: string; label?: string }>)
        .detail
      if (detail?.threadId) openThreadInPane(detail.threadId, detail.label)
    }
    window.addEventListener("betterc0de:open-thread", handler as EventListener)
    return () =>
      window.removeEventListener(
        "betterc0de:open-thread",
        handler as EventListener
      )
  }, [openThreadInPane])

  // With one pane, Ctrl/Cmd+number opens the sidebar's chats; the hints
  // that show the numbers need to know.
  useEffect(() => {
    setChatJumpAvailable(layout.panes.length <= 1)
  }, [layout.panes.length])

  // Keyboard: Ctrl+1..8 switch pane, Ctrl+T new pane, Ctrl+W close pane.
  // With a single pane, Ctrl+1..9 open the 1st..9th chat of the sidebar's
  // visible order instead (lib/chat-list-nav.ts).
  // Agent only (use-composer-tabs handles the other modes).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (usePreferencesStore.getState().appMode !== "agent") return
      if (!(e.ctrlKey || e.metaKey)) return
      const panes = layoutRef.current.panes
      const num = parseInt(e.key)
      if (panes.length > 1 && num >= 1 && num <= 8 && num <= panes.length) {
        e.preventDefault()
        setActivePane(panes[num - 1].id)
        return
      }
      if (panes.length <= 1) {
        const slot = chatSlotFromKeyEvent(e)
        if (slot !== null && openChatListSlot(slot)) {
          e.preventDefault()
          return
        }
      }
      if (e.key === "t" && !e.shiftKey) {
        e.preventDefault()
        addPane()
        return
      }
      if (e.key === "w" && !e.shiftKey) {
        const target = e.target instanceof Element ? e.target : null
        if (isComposerShortcutTextEntryTarget(target)) return
        e.preventDefault()
        closePane(layoutRef.current.activePaneId)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [setActivePane, addPane, closePane])

  return {
    paneLayout: layout,
    addPane,
    closePane,
    setActivePane,
    maximizePane,
    restorePane,
    addTab,
    setActiveTab,
    closeTab,
    moveTabToPane,
    openThreadOnPane,
    openThreadInPane,
    maxPanes: MAX_PANES,
  }
}
