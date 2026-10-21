import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { GitBranchIcon, Loader2Icon } from "lucide-react"
import type { GitConfirmAction } from "./git-panel-utils"

/**
 * Not a git repository: a prominent empty state with a clear call to action.
 * Without it the user sees the same minimal sidebar they'd see while loading
 * and assumes the panel is stuck.
 */
export function GitNotRepositoryState({
  isAgent,
  onInitialize,
}: {
  isAgent: boolean
  onInitialize: () => void
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 px-4 py-6 text-center",
        isAgent && "diff-panel diff-empty"
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-muted/40">
        <GitBranchIcon
          className="size-6 text-muted-foreground/70"
          strokeWidth={1.5}
        />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-medium text-foreground">
          Not a git repository
        </p>
        <p className="max-w-[220px] text-[11px] leading-snug text-muted-foreground">
          Initialize git here to track changes, commit, and push to a remote.
        </p>
      </div>
      <Button
        size="sm"
        className="mt-1 gap-1.5 text-xs"
        onClick={() => onInitialize()}
      >
        <GitBranchIcon className="size-3.5" /> Initialize Repository
      </Button>
      <p className="mt-1 max-w-[220px] text-[10px] text-muted-foreground/70">
        Equivalent of{" "}
        <code className="rounded bg-muted/60 px-1 py-0.5 font-mono">
          git init
        </code>{" "}
        in this folder.
      </p>
    </div>
  )
}

/** Shown until the first repository check and status have arrived. */
export function GitLoadingState({ isAgent }: { isAgent: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center py-4",
        isAgent && "diff-panel diff-empty"
      )}
      role="status"
      aria-label="Loading Git status"
    >
      <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
    </div>
  )
}

/** Confirmation for remote, branch, stash and discard actions. */
export function GitConfirmDialog({
  confirmAction,
  onClose,
}: {
  confirmAction: GitConfirmAction | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={confirmAction !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogTitle>{confirmAction?.title}</DialogTitle>
        <p className="text-sm text-muted-foreground">
          {confirmAction?.description}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button
            variant={
              confirmAction?.title?.includes("Discard")
                ? "destructive"
                : "default"
            }
            onClick={() => {
              confirmAction?.action()
              onClose()
            }}
          >
            {confirmAction?.title?.includes("Discard") ? "Discard" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
