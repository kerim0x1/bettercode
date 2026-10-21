import { useEffect, useRef, useState } from "react"
import {
  BoxesIcon,
  FileSearchIcon,
  FolderOpenIcon,
  Loader2Icon,
  SearchIcon,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getFileIconUrl } from "@/lib/file-icons"
import { useEditorStore, type EditorTab } from "@/lib/editor-store"
import { openSourceTarget } from "@/lib/source-opener"
import { cn } from "@/lib/utils"
import {
  buildOpenEditorWorkspaceSymbolSourcesFromTabs,
  buildWorkspaceSymbols,
  type WorkspaceSymbol,
  type WorkspaceSymbolSource,
} from "@/lib/workspace-symbols"
import {
  quickOpenFiles,
  readFile,
  searchContentDetailed,
  type WorkspaceContentSearchResult,
  type WorkspaceQuickOpenFile,
} from "@/services/backend/workspaceApi"
import { SearchTruncationNotice } from "@/components/search-truncation-notice"

const SYMBOL_SEARCH_LIMIT = 80
const SYMBOL_FILE_LIMIT = 24

interface EditorWorkspaceSymbolsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath?: string | null
  onOpenFolder: () => void
}

export function EditorWorkspaceSymbolsDialog({
  open,
  onOpenChange,
  projectPath,
  onOpenFolder,
}: EditorWorkspaceSymbolsDialogProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<WorkspaceSymbol[]>([])
  // The content search feeding this list is capped; a symbol defined past
  // the cut simply never shows up, so the user has to be told.
  const [truncation, setTruncation] = useState<{
    truncated: boolean
    reason?: string
  }>({ truncated: false })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSeqRef = useRef(0)
  const tabs = useEditorStore((s) => s.tabs)

  useEffect(() => {
    if (!open) return
    setQuery("")
    setResults([])
    setTruncation({ truncated: false })
    setSelectedIndex(0)
    setError(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const term = query.trim()
    if (!projectPath || term.length < 2) {
      setResults([])
      setTruncation({ truncated: false })
      setLoading(false)
      return
    }

    const requestId = requestSeqRef.current + 1
    requestSeqRef.current = requestId
    setLoading(true)
    setError(null)

    const timeout = window.setTimeout(() => {
      loadWorkspaceSymbols(projectPath, term, tabs)
        .then((loaded) => {
          if (requestSeqRef.current !== requestId) return
          setResults(loaded.symbols)
          setTruncation({
            truncated: loaded.truncated,
            reason: loaded.truncatedReason,
          })
          setSelectedIndex(0)
        })
        .catch((err) => {
          if (requestSeqRef.current !== requestId) return
          setResults([])
          setTruncation({ truncated: false })
          setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (requestSeqRef.current === requestId) setLoading(false)
        })
    }, 140)

    return () => window.clearTimeout(timeout)
  }, [open, projectPath, query, tabs])

  const openSymbol = async (symbol: WorkspaceSymbol) => {
    onOpenChange(false)
    await openSourceTarget(
      {
        kind: "symbol",
        filePath: symbol.filePath,
        symbol: symbol.name,
        line: symbol.line,
        column: symbol.column,
      },
      { workspacePath: projectPath }
    )
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelectedIndex((index) => Math.min(results.length - 1, index + 1))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIndex((index) => Math.max(0, index - 1))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const selected = results[selectedIndex]
      if (selected) void openSymbol(selected)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[24%] max-w-2xl translate-y-0 overflow-hidden rounded-3xl p-0"
      >
        <DialogTitle className="sr-only">Workspace Symbols</DialogTitle>
        <DialogDescription className="sr-only">
          Search symbols across the current workspace
        </DialogDescription>

        <div className="border-b border-border/50 p-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              placeholder="Search functions, classes, components..."
              className="h-10 rounded-2xl border-transparent bg-input/55 pr-10 pl-9 text-sm"
            />
            {loading && (
              <Loader2Icon className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
        </div>

        {!projectPath ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <FolderOpenIcon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">No workspace open</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Open a folder before searching workspace symbols.
              </p>
            </div>
            <Button
              size="sm"
              className="gap-2"
              onClick={() => {
                onOpenChange(false)
                onOpenFolder()
              }}
            >
              <FolderOpenIcon className="size-4" />
              Open Folder
            </Button>
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-sm text-destructive">
            {error}
          </div>
        ) : query.trim().length < 2 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted-foreground">
            <BoxesIcon className="size-6" />
            <p className="text-sm">Type at least two characters.</p>
          </div>
        ) : results.length === 0 && !loading ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted-foreground">
            <FileSearchIcon className="size-6" />
            <p className="text-sm">No matching symbols.</p>
            <SearchTruncationNotice
              truncated={truncation.truncated}
              reason={truncation.reason}
              subject="Search"
              hint="the symbol may live past the cut"
              className="justify-center"
            />
          </div>
        ) : (
          <div
            className="max-h-[420px] overflow-y-auto p-1.5"
            role="listbox"
            aria-label="Workspace symbols"
          >
            {results.map((symbol, index) => (
              <button
                key={symbol.id}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => void openSymbol(symbol)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-colors outline-none",
                  index === selectedIndex
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                )}
              >
                <img
                  src={getFileIconUrl(symbol.relativePath)}
                  alt=""
                  className="size-4 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-foreground">
                      {symbol.name}
                    </span>
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {symbol.kind}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                    {symbol.relativePath}:{symbol.line}
                  </span>
                </span>
              </button>
            ))}
            <SearchTruncationNotice
              truncated={truncation.truncated}
              reason={truncation.reason}
              className="px-3"
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface LoadedWorkspaceSymbols {
  symbols: WorkspaceSymbol[]
  truncated: boolean
  truncatedReason?: string
}

async function loadWorkspaceSymbols(
  projectPath: string,
  query: string,
  openTabs: readonly EditorTab[]
): Promise<LoadedWorkspaceSymbols> {
  const openEditorSources = buildOpenEditorWorkspaceSymbolSourcesFromTabs({
    projectPath,
    tabs: openTabs,
  })
  const [contentSearch, fileSearch] = await Promise.allSettled([
    searchContentDetailed(projectPath, query, SYMBOL_SEARCH_LIMIT),
    quickOpenFiles(projectPath, query, SYMBOL_SEARCH_LIMIT),
  ])

  if (contentSearch.status === "rejected" && fileSearch.status === "rejected") {
    throw contentSearch.reason
  }

  const contentResults =
    contentSearch.status === "fulfilled" ? contentSearch.value : null
  const files = uniqueFiles(
    contentResults?.results ?? [],
    fileSearch.status === "fulfilled" ? fileSearch.value : [],
    openEditorSources.sourcePathKeys
  ).slice(0, SYMBOL_FILE_LIMIT)

  const diskSources = (
    await Promise.all(
      files.map(async (file) => {
        const filePath = joinWorkspacePath(projectPath, file.path)
        try {
          const loaded = await readFile(filePath, { silent404: true })
          return {
            filePath,
            relativePath: file.path,
            content: loaded.content,
          } satisfies WorkspaceSymbolSource
        } catch {
          return null
        }
      })
    )
  ).filter((source): source is WorkspaceSymbolSource => source !== null)
  const sources = [...openEditorSources.sources, ...diskSources]
  return {
    symbols: buildWorkspaceSymbols(sources, query),
    truncated: contentResults?.truncated === true,
    ...(contentResults?.truncated && contentResults.truncatedReason
      ? { truncatedReason: contentResults.truncatedReason }
      : {}),
  }
}

function uniqueFiles(
  contentResults: readonly WorkspaceContentSearchResult[],
  fileResults: readonly WorkspaceQuickOpenFile[],
  excludedPathKeys: ReadonlySet<string> = new Set()
): Array<{ path: string; name: string }> {
  const seen = new Set(excludedPathKeys)
  const out: Array<{ path: string; name: string }> = []
  for (const result of [...contentResults, ...fileResults]) {
    const key = result.path.replace(/\\/g, "/").toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ path: result.path, name: result.name })
  }
  return out
}

function joinWorkspacePath(projectPath: string, relativePath: string): string {
  const separator = projectPath.includes("\\") ? "\\" : "/"
  const base = projectPath.replace(/[\\/]+$/, "")
  const relative = relativePath.replace(/^[\\/]+/, "")
  return `${base}${separator}${relative}`
}
