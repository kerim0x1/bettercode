import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * "Getting Started" dialog — a numbered 5-step primer on how to use the IDE.
 *
 * Lives alongside the Docs tab in settings. `isSimple` tightens padding
 * when the user is in Simple UI mode so the primer feels as light as the
 * rest of that layout.
 */
export function GettingStartedDialog({
  open,
  onOpenChange,
  isSimple,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  isSimple: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("sm:max-w-lg", isSimple && "gap-3 p-4")}>
        <DialogTitle>Getting Started</DialogTitle>
        <DialogDescription>
          Learn the basics of BetterC0de IDE
        </DialogDescription>
        <div className={cn("text-sm", isSimple ? "space-y-2" : "space-y-4")}>
          <div>
            <h4 className="mb-1 font-semibold">1. Create or open a project</h4>
            <p className="text-xs text-muted-foreground">
              Use the sidebar to create a new project or open an existing
              folder. BetterC0de will automatically detect your project type.
            </p>
          </div>
          <div>
            <h4 className="mb-1 font-semibold">2. Chat with the AI agent</h4>
            <p className="text-xs text-muted-foreground">
              Type your request in the chat input. The AI can write code, run
              commands, create files, and more. Use slash commands like /plan or
              /commit for specific actions.
            </p>
          </div>
          <div>
            <h4 className="mb-1 font-semibold">3. Review changes</h4>
            <p className="text-xs text-muted-foreground">
              Use the Diff panel to review file changes. You can accept, reject,
              or modify any change before committing.
            </p>
          </div>
          <div>
            <h4 className="mb-1 font-semibold">4. Switch to Editor mode</h4>
            <p className="text-xs text-muted-foreground">
              Toggle between Agent and Editor mode in the sidebar. Editor mode
              gives you a full code editor with file tree alongside the chat.
            </p>
          </div>
          <div>
            <h4 className="mb-1 font-semibold">5. Configure providers</h4>
            <p className="text-xs text-muted-foreground">
              Go to Settings &gt; Models to set up API keys for Claude, OpenAI,
              Grok, and more, or connect your 9Router. You can also use local
              models via LM Studio.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
