import {
  BotIcon,
  Code2Icon,
  FolderOpenIcon,
  ListTreeIcon,
  TerminalIcon,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { CodeIcon as CodeHugeIcon } from "@hugeicons/core-free-icons"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { pickFolder } from "@/services/backend/runtime"
import { useChatStore } from "@/lib/chat-store"

/**
 * Modal prompting the user to pick a project folder before switching into
 * Editor mode.
 *
 * Flow: browse → pick folder → confirm. On confirm we create a new
 * "Editor" thread scoped to that folder, flip the app to editor mode, and
 * force the file tree open so the user lands on the tree immediately.
 *
 * "Skip" switches to editor mode without creating a new folder-scoped
 * thread — useful when the user wants editor mode for the already-open
 * project, or wants to open files ad-hoc without pinning a project root.
 * Dismissing the dialog (ESC / backdrop click) keeps the app in chat mode.
 */
export function EditorModeDialog({
  open,
  onOpenChange,
  editorModalPath,
  setEditorModalPath,
  minimalChat,
  setAppMode,
  setFileTreeOpen,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editorModalPath: string
  setEditorModalPath: (path: string) => void
  minimalChat: boolean
  setAppMode: (mode: "agent" | "editor" | "design") => void
  setFileTreeOpen: (open: boolean) => void
}) {
  const folderName =
    editorModalPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ||
    "Workspace"
  const workspaceItems = [
    { label: "Explorer", value: "Files", icon: ListTreeIcon },
    { label: "Terminal", value: "Shell", icon: TerminalIcon },
    { label: "Assistant", value: "Chat", icon: BotIcon },
  ]

  const openEditorWithoutFolder = () => {
    onOpenChange(false)
    setAppMode("editor")
    setFileTreeOpen(true)
  }

  const openEditorWithFolder = () => {
    if (!editorModalPath) return
    const store = useChatStore.getState()
    store.createThread("Editor", folderName, editorModalPath)
    onOpenChange(false)
    setAppMode("editor")
    setFileTreeOpen(true)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-xl border-border/70 bg-background p-0 shadow-2xl sm:max-w-[640px]">
        <DialogTitle className="sr-only">
          Select a folder for Editor Mode
        </DialogTitle>

        <Card className="gap-0 rounded-none border-0 bg-transparent py-0 shadow-none ring-0">
          <CardHeader
            className={cn(
              "grid-cols-[1fr_auto] border-b border-border/70",
              minimalChat ? "px-4 py-4" : "px-5 py-5"
            )}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-5 rounded-md px-1.5">
                  Editor
                </Badge>
                <span className="font-mono text-[10px] text-muted-foreground/65">
                  WORKSPACE ROOT
                </span>
              </div>
              <CardTitle className="mt-3 text-lg font-semibold tracking-normal">
                Select a project folder
              </CardTitle>
              <CardDescription className="mt-1 max-w-[460px] text-sm leading-6">
                BetterC0de will scope the explorer, terminal, git view, and
                assistant to this folder.
              </CardDescription>
            </div>
            <CardAction className="hidden sm:block">
              <span className="flex size-9 items-center justify-center rounded-md border border-border/60 bg-muted/35 text-muted-foreground">
                <HugeiconsIcon
                  icon={CodeHugeIcon}
                  strokeWidth={2}
                  className="size-4.5"
                />
              </span>
            </CardAction>
          </CardHeader>

          <CardContent
            className={cn("space-y-4", minimalChat ? "px-4 py-4" : "px-5 py-5")}
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">
                  Folder
                </span>
                <Badge
                  variant={editorModalPath ? "secondary" : "outline"}
                  className="h-5 rounded-md px-1.5 font-mono text-[10px]"
                >
                  {editorModalPath ? "READY" : "EMPTY"}
                </Badge>
              </div>

              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="relative min-w-0">
                  <FolderOpenIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    readOnly
                    value={editorModalPath || "No folder selected"}
                    className={cn(
                      "h-10 rounded-md border-border/60 bg-muted/25 pr-3 pl-9 font-mono text-xs",
                      !editorModalPath && "text-muted-foreground"
                    )}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-10 gap-2 rounded-md px-3 text-xs"
                  onClick={async () => {
                    const folder = await pickFolder()
                    if (folder) setEditorModalPath(folder)
                  }}
                >
                  <FolderOpenIcon className="size-3.5" />
                  Browse
                </Button>
              </div>
            </div>

            <div
              className={cn(
                "rounded-md border px-3 py-3",
                editorModalPath
                  ? "border-border/70 bg-muted/20"
                  : "border-dashed border-border/60 bg-muted/10"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {editorModalPath ? folderName : "Waiting for folder"}
                  </p>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {editorModalPath ||
                      "Editor chrome stays hidden until a workspace is attached."}
                  </p>
                </div>
                <Code2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              {workspaceItems.map((item) => {
                const Icon = item.icon
                return (
                  <div
                    key={item.label}
                    className="rounded-md border border-border/60 bg-background/45 px-3 py-2.5"
                  >
                    <div className="flex items-center gap-2 text-xs font-medium">
                      <Icon className="size-3.5 text-muted-foreground" />
                      <span>{item.label}</span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                      {item.value}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>

          <Separator className="bg-border/70" />

          <CardFooter
            className={cn(
              "justify-between gap-2 rounded-none",
              minimalChat ? "px-4 py-3" : "px-5 py-4"
            )}
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-md px-2 text-xs"
              onClick={openEditorWithoutFolder}
            >
              Open Empty Window
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-md px-3 text-xs"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-8 gap-2 rounded-md px-3 text-xs"
                disabled={!editorModalPath}
                onClick={openEditorWithFolder}
              >
                <Code2Icon className="size-3.5" />
                Open in Editor
              </Button>
            </div>
          </CardFooter>
        </Card>
      </DialogContent>
    </Dialog>
  )
}
