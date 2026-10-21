import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SHORTCUT_PARITY_MANIFEST } from "@/lib/shortcut-parity"

const PARITY_SHORTCUT_GROUPS = (["Terminal", "Preview"] as const).map(
  (category) => ({
    category,
    shortcuts: SHORTCUT_PARITY_MANIFEST.filter(
      (entry) =>
        entry.showInShortcutDialog === true &&
        entry.id.startsWith(category.toLowerCase())
    ).map((entry) => ({
      keys: entry.displayBinding,
      action: entry.actionLabel,
    })),
  })
)

const SHORTCUT_GROUPS: ReadonlyArray<{
  category: string
  shortcuts: ReadonlyArray<{ keys: string; action: string }>
}> = [
  {
    category: "General",
    shortcuts: [
      { keys: "Ctrl+,", action: "Open Settings" },
      { keys: "Ctrl+N", action: "New Agent" },
      { keys: "Ctrl+Shift+N", action: "New Project" },
      { keys: "Ctrl+Shift+M", action: "Marketplace / Problems" },
      { keys: "Ctrl+Shift+A", action: "Automations" },
      { keys: "Ctrl+Shift+F", action: "Search Chats / Workspace" },
      { keys: "Ctrl+Shift+O", action: "System Browser / File Symbols" },
      { keys: "Ctrl+B", action: "Toggle Sidebar" },
      { keys: "Ctrl+Shift+E", action: "Explorer / Reveal Active File" },
      { keys: "Ctrl+K", action: "Command Palette" },
      { keys: "Ctrl+Shift+P", action: "Command Palette" },
      { keys: "Ctrl+/", action: "Keyboard Shortcuts" },
    ],
  },
  {
    category: "Chat",
    shortcuts: [
      { keys: "Enter", action: "Send Message" },
      { keys: "Shift+Enter", action: "New Line" },
      { keys: "Ctrl+Enter", action: "Steer or Queue While Working" },
      { keys: "Alt+Up", action: "Edit Last Queued Message" },
      { keys: "Escape", action: "Interrupt Response" },
      { keys: "/", action: "Slash Commands" },
      { keys: "@", action: "Mention Files" },
      { keys: "Ctrl+F", action: "Find in Chat" },
      { keys: "F3 / Shift+F3", action: "Next / Previous Match in Chat" },
    ],
  },
  {
    category: "Chat List",
    shortcuts: [
      { keys: "Ctrl+1…9", action: "Open Chat 1–9 in the Sidebar (one pane)" },
      { keys: "Ctrl+Z", action: "Undo Archive, Delete, Pin, Snooze or Move" },
      { keys: "Ctrl+Click / Space", action: "Select Chats" },
      { keys: "Shift+Click", action: "Select a Range of Chats" },
      { keys: "Escape", action: "Clear the Selection" },
      { keys: "Shift+F10", action: "Chat Menu" },
    ],
  },
  {
    category: "Editor",
    shortcuts: [
      { keys: "Ctrl+S", action: "Save File" },
      { keys: "Ctrl+Alt+S", action: "Save All" },
      { keys: "Ctrl+PageUp", action: "Previous Editor" },
      { keys: "Ctrl+PageDown", action: "Next Editor" },
      { keys: "Ctrl+Shift+PageUp", action: "Move Editor Left" },
      { keys: "Ctrl+Shift+PageDown", action: "Move Editor Right" },
      { keys: "Ctrl+W", action: "Close Active Editor" },
      { keys: "Ctrl+Shift+T", action: "Reopen Closed Editor" },
      { keys: "Ctrl+K", action: "Edit with AI" },
      { keys: "Ctrl+P", action: "Quick Open File" },
      { keys: "Ctrl+G", action: "Go to Line" },
      { keys: "Ctrl+Shift+O", action: "Go to Symbol in File" },
      { keys: "Ctrl+T", action: "Workspace Symbols" },
      { keys: "Alt+Z", action: "Toggle Word Wrap" },
      { keys: "Shift+Alt+F", action: "Format Document" },
      { keys: "F2", action: "Rename Symbol" },
      { keys: "F12", action: "Go to Definition" },
      { keys: "Shift+F12", action: "Find References" },
      { keys: "Alt+Left", action: "Go Back" },
      { keys: "Alt+Right", action: "Go Forward" },
      { keys: "Ctrl+`", action: "Toggle Terminal" },
      { keys: "Ctrl+Shift+G", action: "Source Control" },
      { keys: "Ctrl+Shift+D", action: "Toggle Diff Panel" },
    ],
  },
  ...PARITY_SHORTCUT_GROUPS,
]

/**
 * Keyboard shortcuts reference dialog.
 *
 * Core shortcuts remain listed beside their owning surfaces; Phase-5
 * compatibility aliases are derived from the tested parity manifest.
 */
export function KeyboardShortcutsDialog({
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
        <DialogTitle>Keyboard Shortcuts</DialogTitle>
        <DialogDescription>All available keybindings</DialogDescription>
        <div className={cn(isSimple ? "space-y-2" : "space-y-3")}>
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.category}>
              <p className="mb-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                {group.category}
              </p>
              <div className="divide-y divide-border/50 rounded-xl border border-border/50">
                {group.shortcuts.map((s) => (
                  <div
                    key={s.keys}
                    className="flex items-center justify-between px-4 py-2"
                  >
                    <span className="text-xs">{s.action}</span>
                    <kbd className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[10px]">
                      {s.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
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
