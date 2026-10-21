import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import type { ConfirmAction } from "@/lib/confirm-action"

export type { ConfirmAction }

/**
 * Generic destructive-action confirmation dialog.
 *
 * The parent keeps a single `confirmAction | null` state and passes the
 * payload here when any destructive operation (delete thread, delete
 * project chats, discard changes, …) wants to go through a single shared
 * "Are you sure?" flow. Cancel just clears the state; Confirm runs the
 * payload's `action()` and clears the state.
 */
export function ConfirmActionDialog({
  action,
  onClear,
  minimalChat,
}: {
  action: ConfirmAction | null
  onClear: () => void
  minimalChat: boolean
}) {
  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onClear()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("sm:max-w-sm", minimalChat && "gap-3 p-4")}
      >
        <DialogTitle>{action?.title || "Are you sure?"}</DialogTitle>
        {/* `whitespace-pre-line` so a destructive action can enumerate exactly
            what it will do on separate lines. A confirmation the user cannot
            read properly is not a confirmation. */}
        <DialogDescription className="whitespace-pre-line">
          {action?.description || ""}
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={onClear}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              action?.action()
              onClear()
            }}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
