import { FolderOpenIcon, SquarePenIcon } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { pickFolder } from "@/services/backend/runtime"
import { useChatStore } from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import {
  resolveNewThreadContext,
  resolveThreadRuntimePath,
} from "@/lib/thread-context"

/**
 * "New Thread" modal — the first-click entry point from the sidebar's
 * "New Agent" button.
 *
 * Folder selection is optional: if the user hits Create without picking a
 * folder, the thread is scoped to the default "BetterC0de" project (same
 * as older chats without a project path). Picking a folder takes the last
 * path segment as the project name — matches how `ChatToolbar`'s "Attach
 * Folder" affordance works.
 *
 * On confirm the thread is created and immediately set as the active
 * thread so the user lands directly in the new chat.
 */
export function NewThreadDialog({
  open,
  onOpenChange,
  newThreadModalPath,
  setNewThreadModalPath,
  minimalChat,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  newThreadModalPath: string
  setNewThreadModalPath: (path: string) => void
  minimalChat: boolean
}) {
  const appMode = usePreferencesStore((state) => state.appMode)
  const activeThread = useChatStore((state) =>
    state.activeThreadId
      ? state.threads.find((thread) => thread.id === state.activeThreadId)
      : null
  )
  const previewContext = resolveNewThreadContext({
    selectedPath: newThreadModalPath,
    activeThread,
  })
  const previewRuntimePath = resolveThreadRuntimePath({
    projectPath: previewContext.projectPath,
    worktreePath: previewContext.options?.worktreePath,
  })
  const requiresFolder = appMode === "agent" && !previewRuntimePath

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">New Thread</DialogTitle>
        {/* Header */}
        <div
          className={cn(
            "border-b border-border/30",
            minimalChat ? "px-4 pt-3 pb-3" : "px-6 pt-5 pb-4"
          )}
        >
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
              <SquarePenIcon className="size-4 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">New Thread</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {appMode === "agent"
                  ? "Select a project folder or keep using the current workspace."
                  : "Optionally select a project folder for the new thread."}
              </p>
            </div>
          </div>
        </div>

        {/* Folder path */}
        <div
          className={cn("space-y-3", minimalChat ? "px-4 py-3" : "px-6 py-5")}
        >
          <div className="flex h-9 items-center gap-2">
            <div
              className={cn(
                "flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md border border-border/50 bg-muted/30 px-3 text-xs transition-colors",
                newThreadModalPath
                  ? "text-foreground"
                  : "text-muted-foreground/60"
              )}
            >
              <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">
                {newThreadModalPath ||
                  previewRuntimePath ||
                  (requiresFolder
                    ? "Select a project folder"
                    : "No folder selected (optional)")}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0 gap-2 text-xs"
              onClick={async () => {
                const folder = await pickFolder()
                if (folder) setNewThreadModalPath(folder)
              }}
            >
              <FolderOpenIcon className="size-3.5" />
              Browse
            </Button>
          </div>

          {(newThreadModalPath || previewRuntimePath) && (
            <p className="flex items-center gap-1.5 text-[11px] text-emerald-400/80">
              <span className="inline-block size-1.5 rounded-full bg-emerald-400" />
              {newThreadModalPath
                ? "Folder selected"
                : "Using current workspace"}
            </p>
          )}
          {requiresFolder && (
            <p className="text-[11px] text-amber-400/90">
              Agent Mode needs a project folder before a task can be created.
            </p>
          )}
        </div>

        {/* Footer */}
        <div
          className={cn(
            "flex items-center justify-end gap-2 border-t border-border/30",
            minimalChat ? "px-4 py-3" : "px-6 py-4"
          )}
        >
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-2 text-xs"
            disabled={requiresFolder}
            onClick={() => {
              const store = useChatStore.getState()
              const latestActiveThread = store.activeThreadId
                ? store.threads.find(
                    (thread) => thread.id === store.activeThreadId
                  )
                : null
              const context = resolveNewThreadContext({
                selectedPath: newThreadModalPath,
                activeThread: latestActiveThread,
              })
              const runtimePath = resolveThreadRuntimePath({
                projectPath: context.projectPath,
                worktreePath: context.options?.worktreePath,
              })
              if (
                usePreferencesStore.getState().appMode === "agent" &&
                !runtimePath
              ) {
                return
              }
              const newId = store.createThread(
                "New Chat",
                context.projectName,
                context.projectPath,
                context.options
              )
              window.dispatchEvent(
                new CustomEvent("betterc0de:open-thread", {
                  detail: { threadId: newId, label: "New Chat" },
                })
              )
              onOpenChange(false)
            }}
          >
            <SquarePenIcon className="size-3.5" />
            Create Thread
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
