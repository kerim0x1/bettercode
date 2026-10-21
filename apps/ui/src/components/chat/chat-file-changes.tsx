import { useId, useMemo, useState } from "react"
import { ChevronDownIcon, FilesIcon } from "lucide-react"
import {
  FILE_CHANGE_PAGE_SIZE,
  FILE_CHANGE_PREVIEW_COUNT,
  groupFileChanges,
} from "@betterc0de/schema"
import {
  FileChangeItem,
  type FileDiff,
} from "@/components/ai-elements/file-changes-bar"
import type { FullMessageSource } from "@/hooks/use-full-message-payload"
import { mergeDiffs } from "@/lib/message-utils"
import { cn } from "@/lib/utils"

export function ChatFileChanges({
  diffs,
  workspaceRoot,
  source,
}: {
  diffs: FileDiff[]
  workspaceRoot?: string | null
  /** The saved message, for diffs a light transcript page left without text. */
  source?: FullMessageSource | null
}) {
  const grouped = useMemo(
    () => groupFileChanges(mergeDiffs(diffs), workspaceRoot),
    [diffs, workspaceRoot]
  )
  if (diffs.length === 0) return null
  return (
    <section
      aria-label="File changes"
      className="not-prose mb-3 min-w-0 overflow-hidden rounded-lg border border-border/50 bg-background text-foreground"
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs">
        <FilesIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">File changes</span>
        <span className="text-muted-foreground">
          {grouped.projectFiles.length} project{" "}
          {grouped.projectFiles.length === 1 ? "file" : "files"}
        </span>
        <span className="ml-auto flex gap-2 font-mono text-[11px] tabular-nums">
          {grouped.additions > 0 && (
            <span className="text-emerald-500">+{grouped.additions}</span>
          )}
          {grouped.deletions > 0 && (
            <span className="text-rose-500">−{grouped.deletions}</span>
          )}
        </span>
      </div>
      <FileChangeList
        files={grouped.projectFiles}
        workspaceRoot={workspaceRoot}
        source={source}
      />
      <GeneratedFileChanges
        files={grouped.generatedFiles}
        workspaceRoot={workspaceRoot}
        source={source}
      />
    </section>
  )
}

function GeneratedFileChanges({
  files,
  workspaceRoot,
  source,
}: {
  files: FileDiff[]
  workspaceRoot?: string | null
  source?: FullMessageSource | null
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (files.length === 0) return null
  return (
    <div className="border-t border-border/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronDownIcon
          className={cn("size-3.5 shrink-0", !open && "-rotate-90")}
        />
        <span className="min-w-0 flex-1">Temporary &amp; generated</span>
        <span className="tabular-nums">{files.length}</span>
      </button>
      <div id={id} hidden={!open}>
        {open && (
          <FileChangeList
            files={files}
            workspaceRoot={workspaceRoot}
            source={source}
            initialLimit={FILE_CHANGE_PAGE_SIZE}
          />
        )}
      </div>
    </div>
  )
}

function FileChangeList({
  files,
  workspaceRoot,
  source,
  initialLimit = FILE_CHANGE_PREVIEW_COUNT,
}: {
  files: FileDiff[]
  workspaceRoot?: string | null
  source?: FullMessageSource | null
  initialLimit?: number
}) {
  const [limit, setLimit] = useState(initialLimit)
  if (!files.length) return null
  const expanded = limit > initialLimit
  return (
    <div>
      <div
        aria-label="Changed files"
        tabIndex={expanded ? 0 : undefined}
        className="max-h-72 overflow-y-auto overscroll-contain border-t border-border/40"
      >
        {files.slice(0, limit).map((file) => (
          <div
            key={file.path}
            data-file-change={file.path}
            className="border-b border-border/40 last:border-b-0"
          >
            <FileChangeItem
              diff={file}
              workspaceRoot={workspaceRoot}
              source={source}
            />
          </div>
        ))}
        {limit < files.length && (
          <button
            type="button"
            onClick={() => setLimit((value) => value + FILE_CHANGE_PAGE_SIZE)}
            className="flex min-h-9 w-full items-center justify-center gap-1 border-t border-border/40 px-3 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            Show {Math.min(files.length - limit, FILE_CHANGE_PAGE_SIZE)} more{" "}
            <span className="tabular-nums">
              ({files.length - limit} remaining)
            </span>
          </button>
        )}
      </div>
      {expanded && (
        <button
          type="button"
          onClick={() => setLimit(initialLimit)}
          className="min-h-8 w-full border-t border-border/40 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        >
          Show less
        </button>
      )}
    </div>
  )
}
