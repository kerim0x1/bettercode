import type { ComponentProps, CSSProperties, ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { ComposerTabs } from "@/components/layout/composer-tabs"
import { ChatSwitcherMenu } from "@/components/layout/chat-switcher-menu"
import { EditorChatStack } from "@/components/layout/editor-chat-stack"
import { ChatToolbar } from "@/components/chat/chat-toolbar"
import { CompareSwitcher } from "@/components/chat/compare-group"

/**
 * The chat container of the editor-style workbench: an inset rounded card
 * with the chat switcher (open chats + history in one dropdown, git status
 * pill docked right) on top and one `ChatColumn` — or the split stack —
 * below. Editor and canvas mode both mount it as the
 * right column; there is exactly one
 * implementation so the two can never drift apart again.
 *
 * The switcher and the git pill share one row on purpose: a bar of its own
 * above it read as a badge floating in empty space and cost a full row of
 * vertical space.
 */
export function ChatWorkbenchPanel({
  className,
  style,
  mode,
  minimalChat,
  activeThread,
  setConfirmAction,
  tabs,
  activeTabIds,
  splitMode,
  insertIntoSplit,
  renderColumn,
  children,
}: {
  className?: string
  style?: CSSProperties
  mode: "editor" | "design"
  minimalChat: boolean
  activeThread: ComponentProps<typeof ChatToolbar>["thread"]
  setConfirmAction: ComponentProps<typeof ChatToolbar>["onConfirm"]
  tabs: ComponentProps<typeof ComposerTabs>
  activeTabIds: string[]
  splitMode: boolean
  insertIntoSplit: ComponentProps<typeof EditorChatStack>["insertIntoSplit"]
  renderColumn: (tabId: string) => ReactNode
  /** Rendered under the chat, e.g. the console panel. */
  children?: ReactNode
}) {
  return (
    <div
      data-chat-workbench-panel={mode}
      className={cn(
        "editor-chat-panel flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border border-border/40 bg-background",
        className
      )}
      style={style}
    >
      <div className="editor-chat-toolbar flex h-11 shrink-0 items-center gap-1 border-b border-border/40 bg-background px-2">
        <ChatSwitcherMenu
          {...tabs}
          projectPath={activeThread?.worktreePath || activeThread?.projectPath}
        />
        {/* The chats one prompt started with several models. */}
        <CompareSwitcher threadId={activeThread?.id} />
        <ChatToolbar
          thread={activeThread}
          onConfirm={setConfirmAction}
          mode={mode}
          minimal={minimalChat}
          gitStatusOnly
          gitStatusClassName="flex shrink-0 items-center gap-2 pr-1 pl-2"
        />
      </div>

      {splitMode && activeTabIds.length > 1 ? (
        <EditorChatStack
          activeTabIds={activeTabIds}
          insertIntoSplit={insertIntoSplit}
          renderColumn={renderColumn}
        />
      ) : (
        renderColumn(activeTabIds[0]!)
      )}

      {children}
    </div>
  )
}
