import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { getFileIconUrl } from "@/lib/file-icons"
import {
  ChevronDownIcon,
  MinusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Undo2Icon,
} from "lucide-react"
import {
  GIT_STATUS_META,
  splitGitFilePath,
  type FileDiffStats,
} from "./git-panel-utils"

/** One collapsible group of changed files (staged, modified or untracked). */
export function FileSection({
  title,
  count,
  open,
  onOpenChange,
  files,
  statusChar,
  diffStats,
  onFileClick,
  onDiscard,
  onStage,
  onUnstage,
  editorMode = false,
}: {
  title: string
  count: number
  open: boolean
  onOpenChange: (v: boolean) => void
  files: string[]
  statusChar: string
  diffStats: Record<string, FileDiffStats>
  onFileClick: (path: string) => void
  onDiscard?: (path: string) => void
  onStage?: (path: string) => void
  onUnstage?: (path: string) => void
  editorMode?: boolean
}) {
  const statusMeta = GIT_STATUS_META[statusChar]
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        className={cn(
          "git-section-heading flex w-full items-center gap-1.5 bg-muted/20 px-3 py-1 text-[9.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase transition-colors hover:text-foreground",
          editorMode &&
            "min-h-9 text-xs font-medium tracking-normal normal-case"
        )}
      >
        <ChevronDownIcon
          className={cn("size-2.5 transition-transform", !open && "-rotate-90")}
          strokeWidth={2.5}
        />
        <span className="flex-1 text-left">{title}</span>
        <span className="tracking-normal text-muted-foreground/60 tabular-nums">
          {count}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {files.map((file) => {
          const { fileName, dirPath } = splitGitFilePath(file)
          const stats = diffStats[file]
          if (editorMode) {
            return (
              <div
                key={file}
                className="group flex min-w-0 items-center gap-2 px-3 py-2 transition-colors hover:bg-accent/50"
              >
                <button
                  type="button"
                  onClick={() => onFileClick(file)}
                  title={file}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                >
                  <img
                    src={getFileIconUrl(fileName)}
                    alt=""
                    className="mt-0.5 size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {fileName}
                    </span>
                    <span className="mt-0.5 flex min-w-0 gap-2 text-[10px] text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate">
                        {dirPath || "/"}
                      </span>
                      {stats && (
                        <span className="flex shrink-0 gap-1.5 tabular-nums">
                          {stats.additions > 0 && (
                            <span className="text-success">
                              +{stats.additions}
                            </span>
                          )}
                          {stats.deletions > 0 && (
                            <span className="text-destructive">
                              −{stats.deletions}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                <span
                  title={statusMeta?.label}
                  className={cn(
                    "shrink-0 text-[10px] font-medium",
                    statusMeta?.className
                  )}
                >
                  {statusChar}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${file}`}
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                    >
                      <MoreHorizontalIcon className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onFileClick(file)}>
                      Open file
                    </DropdownMenuItem>
                    {onStage && (
                      <DropdownMenuItem onSelect={() => onStage(file)}>
                        <PlusIcon />
                        Stage file
                      </DropdownMenuItem>
                    )}
                    {onUnstage && (
                      <DropdownMenuItem onSelect={() => onUnstage(file)}>
                        <MinusIcon />
                        Unstage file
                      </DropdownMenuItem>
                    )}
                    {onDiscard && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => onDiscard(file)}>
                          <Undo2Icon />
                          Discard changes…
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          }
          return (
            <div
              key={file}
              className="git-file-row group flex w-full items-center gap-2 px-3 py-1 transition-colors hover:bg-accent/50"
            >
              <button
                type="button"
                onClick={() => onFileClick(file)}
                title={file}
                className="git-file-select flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <img
                  src={getFileIconUrl(fileName)}
                  alt=""
                  className="size-3.5 shrink-0"
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).style.display = "none"
                  }}
                />
                <span className="git-file-label min-w-0 flex-1 truncate text-[11.5px] text-foreground">
                  {fileName}
                  {dirPath && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground/70">
                      {dirPath}
                    </span>
                  )}
                </span>
              </button>
              {stats && (stats.additions > 0 || stats.deletions > 0) && (
                <span className="git-file-stats flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
                  {stats.additions > 0 && (
                    <span className="text-success">+{stats.additions}</span>
                  )}
                  {stats.deletions > 0 && (
                    <span className="text-destructive">−{stats.deletions}</span>
                  )}
                </span>
              )}
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-[11px] font-semibold",
                  statusMeta?.className ?? "text-muted-foreground"
                )}
                title={statusMeta?.label}
              >
                {statusChar}
              </span>
              {/* Stage button */}
              {onStage && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onStage(file)
                  }}
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground"
                  title="Stage file"
                >
                  <PlusIcon className="size-3.5" strokeWidth={2} />
                </button>
              )}
              {/* Unstage button */}
              {onUnstage && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUnstage(file)
                  }}
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground"
                  title="Unstage file"
                >
                  <MinusIcon className="size-3.5" strokeWidth={2} />
                </button>
              )}
              {/* Discard button */}
              {onDiscard && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDiscard(file)
                  }}
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-destructive"
                  title="Discard changes"
                >
                  <Undo2Icon className="size-3.5" strokeWidth={2} />
                </button>
              )}
            </div>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}
