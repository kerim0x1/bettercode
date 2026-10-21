import { useEffect } from "react"
import { cn } from "@/lib/utils"
import {
  ChatColumn,
  type ChatColumnSharedProps,
} from "@/components/layout/chat-column"
import { PaneTabBar } from "@/components/layout/panes/pane-tab-bar"
import { WorkspacePanelBody } from "@/components/layout/panes/workspace-panel-body"
import { useChatStore, useThreadById } from "@/lib/chat-store"
import { deriveThreadTitle } from "@/lib/thread-title"
import type { Pane as PaneType, PaneTabKind } from "@/hooks/use-panes"

/** Props every pane's chat column shares, plus the editor opener. */
export type PaneChatBag = ChatColumnSharedProps & {
  setEditingFile: (path: string) => void
}

/**
 * One pane = a combined tab/title bar + the active tab's body. Chat tabs render
 * the existing `ChatColumn` (per-thread); the other kinds render
 * `WorkspacePanelBody` bound to the pane's thread + projectPath.
 */
export function Pane({
  pane,
  isActive,
  canClose,
  chatBag,
  onActivate,
  onClose,
  onSelectTab,
  onCloseTab,
  onAddTab,
}: {
  pane: PaneType
  isActive: boolean
  canClose: boolean
  chatBag: PaneChatBag
  onActivate: () => void
  onClose: () => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onAddTab: (kind: PaneTabKind) => void
}) {
  const thread = useThreadById(pane.primaryThreadId)
  const title = deriveThreadTitle(thread, "New Chat")
  const projectPath =
    (thread as { worktreePath?: string | null } | undefined)?.worktreePath ||
    thread?.projectPath ||
    null

  // Pin the pane's thread so the LRU can't evict a visible thread mid-render.
  useEffect(() => {
    const tid = pane.primaryThreadId
    if (!tid) return
    useChatStore.getState().pinThread(tid)
    return () => useChatStore.getState().unpinThread(tid)
  }, [pane.primaryThreadId])

  const activeTab =
    pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0]

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        !isActive && "opacity-95"
      )}
      onMouseDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
      <PaneTabBar
        pane={pane}
        chatTitle={title}
        isActive={isActive}
        canClose={canClose}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onAddTab={onAddTab}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab?.kind === "chat" ? (
          <ChatColumn
            {...chatBag}
            tabId={pane.id}
            threadId={activeTab.threadId}
            isActive={isActive}
            onActivate={onActivate}
            showHeader={false}
          />
        ) : (
          <WorkspacePanelBody
            kind={activeTab.kind}
            projectPath={projectPath}
            threadId={pane.primaryThreadId}
            setPlanModalContent={chatBag.setPlanModalContent}
            setEditingFile={chatBag.setEditingFile}
            onCloseToChat={() => {
              const chatTab = pane.tabs.find((t) => t.kind === "chat")
              if (chatTab) onSelectTab(chatTab.id)
            }}
          />
        )}
      </div>
    </div>
  )
}
