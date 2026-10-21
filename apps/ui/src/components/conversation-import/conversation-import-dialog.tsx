import { ImportIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useConversationImport } from "@/hooks/use-conversation-import"
import { ConversationImportPicker } from "./conversation-import-picker"

/**
 * Settings → General → Chats & History: the conversation import picker in a
 * dialog. Its content mounts only while open, so the scan runs on opening.
 */
export function ConversationImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from Claude Code and Codex</DialogTitle>
          <DialogDescription>
            Bring earlier conversations from this computer into BetterC0de. Each
            joins the project of the folder it ran in; continuing it resumes the
            original session where the CLI allows.
          </DialogDescription>
        </DialogHeader>
        {open ? <ImportDialogBody onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function ImportDialogBody({ onClose }: { onClose: () => void }) {
  const state = useConversationImport()
  const finished = state.outcome !== null && state.selectedCount === 0
  return (
    <>
      <ConversationImportPicker
        state={state}
        listClassName="max-h-[min(50vh,440px)]"
      />
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {finished ? "Done" : "Cancel"}
        </Button>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={state.importing || state.selectedCount === 0}
          aria-busy={state.importing || undefined}
          onClick={() => void state.runImport()}
        >
          {state.importing ? (
            <Spinner className="size-3.5" />
          ) : (
            <ImportIcon className="size-3.5" aria-hidden="true" />
          )}
          {state.selectedCount > 0
            ? `Import ${state.selectedCount} ${state.selectedCount === 1 ? "chat" : "chats"}`
            : "Import"}
        </Button>
      </DialogFooter>
    </>
  )
}
