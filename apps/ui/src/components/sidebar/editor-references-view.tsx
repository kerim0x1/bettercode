import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  FileSearchIcon,
  PencilLineIcon,
  RefreshCwIcon,
  SearchCodeIcon,
  TargetIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { getFileIconUrl } from "@/lib/file-icons"
import { useEditorStore } from "@/lib/editor-store"
import {
  buildOpenEditorReferenceSearch,
  mergeReferenceResultsWithOpenEditors,
} from "@/lib/editor-reference-search"
import {
  isReferenceSearchableSymbol,
  useEditorReferencesStore,
} from "@/lib/editor-references-store"
import { EditorMatchPreview } from "@/components/sidebar/editor-match-preview"
import {
  searchContentDetailed,
  type WorkspaceContentSearchMatch,
  type WorkspaceContentSearchResult,
} from "@/services/backend"
import { SearchTruncationNotice } from "@/components/search-truncation-notice"
import { relativeEditorPath } from "@/lib/editor-path"
import { openSourceTarget } from "@/lib/source-opener"

interface EditorReferencesViewProps {
  projectPath: string
}

export function EditorReferencesView({
  projectPath,
}: EditorReferencesViewProps) {
  const request = useEditorReferencesStore((s) => s.request)
  const clearReferenceRequest = useEditorReferencesStore(
    (s) => s.clearReferenceRequest
  )
  const tabs = useEditorStore((s) => s.tabs)
  const [diskResults, setDiskResults] = useState<
    WorkspaceContentSearchResult[]
  >([])
  // A reference list the backend cut short is not "all references".
  const [truncation, setTruncation] = useState<{
    truncated: boolean
    reason?: string
  }>({ truncated: false })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const openEditorResults = useMemo(
    () =>
      buildOpenEditorReferenceSearch({
        projectPath,
        tabs,
        symbol: request?.symbol ?? "",
      }),
    [projectPath, request?.symbol, tabs]
  )
  const results = useMemo(
    () =>
      mergeReferenceResultsWithOpenEditors({
        diskResults,
        openEditors: openEditorResults,
      }),
    [diskResults, openEditorResults]
  )
  const matchCount = useMemo(
    () => results.reduce((total, result) => total + result.matches.length, 0),
    [results]
  )

  useEffect(() => {
    if (!request || !isReferenceSearchableSymbol(request.symbol)) {
      setDiskResults([])
      setTruncation({ truncated: false })
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setDiskResults([])
    setTruncation({ truncated: false })
    searchContentDetailed(projectPath, request.symbol, {
      limit: 300,
      caseSensitive: true,
      wholeWord: true,
    })
      .then((next) => {
        if (cancelled) return
        setDiskResults(next.results)
        setTruncation({
          truncated: next.truncated,
          reason: next.truncatedReason,
        })
      })
      .catch((err) => {
        if (!cancelled) {
          setDiskResults([])
          setTruncation({ truncated: false })
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectPath, refreshToken, request])

  const openMatch = useCallback(
    async (
      result: WorkspaceContentSearchResult,
      match: WorkspaceContentSearchMatch
    ) => {
      if (!request) return
      await openSourceTarget(
        {
          kind: "symbol",
          filePath: result.path,
          symbol: request.symbol,
          line: match.line,
          column: match.column,
          endLine: match.line,
          endColumn: match.column + match.length,
        },
        { workspacePath: projectPath }
      )
    },
    [projectPath, request]
  )

  const openOrigin = useCallback(
    async (mode: "goto" | "rename" = "goto") => {
      if (!request) return
      await openSourceTarget(
        {
          kind: "symbol",
          filePath: request.originFilePath,
          symbol: request.symbol,
          line: request.originLine,
          column: request.originColumn,
          endLine: request.originLine,
          endColumn: request.originColumn + request.symbol.length,
        },
        { workspacePath: projectPath }
      )
      window.setTimeout(() => {
        if (mode !== "rename") return
        window.dispatchEvent(
          new CustomEvent("betterc0de:editor-rename-symbol", {
            detail: {
              filePath: request.originFilePath,
              line: request.originLine,
              column: request.originColumn,
            },
          })
        )
      }, 0)
    },
    [projectPath, request]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-sidebar-border/60 p-2">
        {request ? (
          <div className="rounded-md border border-sidebar-border/55 bg-sidebar-accent/16 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <TargetIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs font-semibold text-sidebar-foreground">
                  {request.symbol}
                </p>
                <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
                  {relativeEditorPath(projectPath, request.originFilePath)}:
                  {request.originLine}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                onClick={() => setRefreshToken((value) => value + 1)}
                aria-label="Refresh references"
                title="Refresh references"
                disabled={loading}
              >
                <RefreshCwIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                onClick={() => void openOrigin("goto")}
                aria-label="Go to reference origin"
                title="Go to origin"
              >
                <TargetIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                onClick={() => void openOrigin("rename")}
                aria-label="Rename reference symbol"
                title="Rename symbol"
              >
                <PencilLineIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                onClick={clearReferenceRequest}
                aria-label="Clear references"
                title="Clear references"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 px-0.5">
              <p className="font-mono text-[10px] text-muted-foreground">
                {loading
                  ? "searching..."
                  : `${matchCount.toLocaleString()} references`}
              </p>
              {results.length > 0 && (
                <p className="font-mono text-[10px] text-muted-foreground/70">
                  {results.length} files
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-sidebar-border/55 bg-sidebar-accent/16 px-2 py-2">
            <div className="flex items-center gap-2">
              <SearchCodeIcon className="size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs font-medium text-sidebar-foreground">
                No symbol selected
              </p>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
              Use Shift+F12 or the editor context menu on a symbol.
            </p>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {!request ? (
          <ReferenceEmptyState title="Find references from the editor" />
        ) : !isReferenceSearchableSymbol(request.symbol) ? (
          <ReferenceEmptyState title="Selected text is not a symbol" />
        ) : error ? (
          <div className="mx-1 mt-2 rounded-md border border-destructive/25 bg-destructive/10 px-2.5 py-2 text-xs leading-relaxed text-destructive">
            {error}
          </div>
        ) : loading && results.length === 0 ? (
          <ReferenceLoadingState />
        ) : results.length === 0 ? (
          <ReferenceEmptyState title="No references found">
            <SearchTruncationNotice
              truncated={truncation.truncated}
              reason={truncation.reason}
              subject="Search"
              hint="references may exist past the cut"
              className="justify-center"
            />
          </ReferenceEmptyState>
        ) : (
          <div className="space-y-2">
            {results.map((result) => (
              <section key={result.path} className="min-w-0">
                <div className="flex items-center gap-2 px-2 py-1">
                  <img
                    src={getFileIconUrl(result.name)}
                    alt=""
                    className="size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-sidebar-foreground">
                      {result.name}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/70">
                      {result.path}
                    </span>
                  </span>
                  <span className="rounded bg-sidebar-accent/35 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                    {result.matches.length}
                  </span>
                </div>
                <div className="space-y-0.5">
                  {result.matches.map((match) => (
                    <button
                      key={`${result.path}:${match.line}:${match.column}`}
                      type="button"
                      onClick={() => void openMatch(result, match)}
                      className="group grid w-full grid-cols-[54px_minmax(0,1fr)] gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/55 focus-visible:bg-sidebar-accent focus-visible:outline-none"
                    >
                      <span className="font-mono text-[10px] text-muted-foreground/60">
                        {match.line}:{match.column}
                      </span>
                      <EditorMatchPreview
                        preview={match.preview}
                        matchColumn={match.previewColumn}
                        matchLength={match.previewLength}
                      />
                    </button>
                  ))}
                </div>
              </section>
            ))}
            <SearchTruncationNotice
              truncated={truncation.truncated}
              reason={truncation.reason}
              subject="References"
              hint="more may exist past the cut"
            />
          </div>
        )}
      </div>
    </div>
  )
}

function ReferenceEmptyState({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <FileSearchIcon className="size-5 text-muted-foreground/55" />
      <p className="mt-2 text-xs text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

function ReferenceLoadingState() {
  return (
    <div className="space-y-2 p-1">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="rounded-md border border-sidebar-border/45 bg-sidebar-accent/14 p-2"
        >
          <div className="h-3 w-28 rounded bg-sidebar-accent/60" />
          <div className="mt-2 h-2 w-full rounded bg-sidebar-accent/35" />
          <div className="mt-1.5 h-2 w-3/4 rounded bg-sidebar-accent/25" />
        </div>
      ))}
    </div>
  )
}
