import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useAppearanceStore } from "@/lib/appearance-store"
import { usePreferencesStore } from "@/lib/preferences-store"

/**
 * Confirmation dialog shown before resetting UI preferences + appearance.
 *
 * The reset action is scoped: it clears the `preferences` and `appearance`
 * stores (UI layout, theme, hidden providers, …) but deliberately leaves
 * API keys, custom rules, skills, MCP servers, hooks, chat threads, and
 * CLI tool registrations untouched. A full page reload follows so every
 * already-mounted component picks up the default values.
 */
export function ResetSettingsDialog({
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
      <DialogContent
        showCloseButton={false}
        className={cn("sm:max-w-md", isSimple && "gap-3 p-4")}
      >
        <DialogTitle>Reset preferences and appearance?</DialogTitle>
        <DialogDescription>
          Layout, model choices and appearance go back to their defaults. This
          can't be undone.
        </DialogDescription>
        <div className="rounded-lg border border-border/50 bg-muted/30 p-3 text-xs text-muted-foreground">
          <p className="mb-1.5 font-medium">What will be reset:</p>
          <ul className="ml-1 list-inside list-disc space-y-0.5">
            <li>UI layout (sidebar widths, panel states)</li>
            <li>Model preferences (selected model, context window)</li>
            <li>Appearance (theme, colors, fonts)</li>
            <li>Hidden providers and models</li>
          </ul>
          <p className="mt-3 mb-1.5 font-medium">What stays:</p>
          <ul className="ml-1 list-inside list-disc space-y-0.5">
            <li>Chat, notification and privacy settings</li>
            <li>API keys and provider configurations</li>
            <li>Custom rules and skills</li>
            <li>MCP servers and hooks</li>
            <li>Chat history and threads</li>
            <li>External CLI tools (Claude CLI, Codex)</li>
          </ul>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              usePreferencesStore.getState().reset()
              useAppearanceStore.getState().reset()
              onOpenChange(false)
              // Reload the page to apply all defaults
              window.location.reload()
            }}
          >
            Reset Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
