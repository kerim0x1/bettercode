import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ReactNode,
} from "react"
import {
  CaseSensitiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderSearchIcon,
  ListFilterIcon,
  RegexIcon,
  ReplaceIcon,
  SearchIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { EditorMatchPreview } from "./editor-match-preview"
import { SearchTruncationNotice } from "@/components/search-truncation-notice"
import {
  buildOpenEditorContentSearch,
  mergeContentSearchResultsWithOpenEditors,
  type OpenEditorContentSearch,
} from "@/lib/editor-content-search"
import { useEditorStore } from "@/lib/editor-store"
import { getFileIconUrl } from "@/lib/file-icons"
import { replaceWorkspaceSearchResults } from "@/lib/workspace-search-replace"
import { openSourceTarget } from "@/lib/source-opener"
import { cn } from "@/lib/utils"
import {
  searchContentDetailed,
  type WorkspaceContentSearchMatch,
  type WorkspaceContentSearchResult,
} from "@/services/backend"

const SEARCH_RESULT_LIMIT = 500

export function EditorSearchSidebarView({
  projectPath,
}: {
  projectPath: string
}) {
  const tabs = useEditorStore((s) => s.tabs)
  const inputRef = useRef<HTMLInputElement>(null)
  const controlsId = useId()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [replaceValue, setReplaceValue] = useState("")
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [includePattern, setIncludePattern] = useState("")
  const [excludePattern, setExcludePattern] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regexSearch, setRegexSearch] = useState(false)
  const [preserveCase, setPreserveCase] = useState(false)
  const [diskResults, setDiskResults] = useState<
    WorkspaceContentSearchResult[]
  >([])
  // When the backend stopped early, "Replace all" only touches what is
  // listed — the notice at the end of the list is what tells the user that.
  const [truncation, setTruncation] = useState<{
    truncated: boolean
    reason?: string
  }>({ truncated: false })
  const [loading, setLoading] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [replaceStatus, setReplaceStatus] = useState<string | null>(null)
  const trimmedQuery = query.trim()
  const searchOptions = useMemo(
    () => ({
      limit: SEARCH_RESULT_LIMIT,
      caseSensitive,
      wholeWord,
      regex: regexSearch,
      include: includePattern.trim(),
      exclude: excludePattern.trim(),
    }),
    [caseSensitive, excludePattern, includePattern, regexSearch, wholeWord]
  )
  const openEditorSearch = useMemo<{
    data: OpenEditorContentSearch
    error: string | null
  }>(() => {
    const empty: OpenEditorContentSearch = {
      results: [],
      searchedPathKeys: new Set(),
    }
    if (trimmedQuery.length < 2) return { data: empty, error: null }
    try {
      return {
        data: buildOpenEditorContentSearch({
          projectPath,
          tabs,
          query: trimmedQuery,
          options: searchOptions,
        }),
        error: null,
      }
    } catch (err) {
      return {
        data: empty,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [projectPath, searchOptions, tabs, trimmedQuery])
  const results = useMemo(
    () =>
      mergeContentSearchResultsWithOpenEditors({
        diskResults,
        openEditors: openEditorSearch.data,
      }),
    [diskResults, openEditorSearch.data]
  )
  const searchError = error ?? openEditorSearch.error
  const matchCount = useMemo(
    () => results.reduce((total, result) => total + result.matches.length, 0),
    [results]
  )

  useEffect(() => {
    const term = query.trim()
    if (term.length < 2) {
      setDiskResults([])
      setTruncation({ truncated: false })
      setError(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setDiskResults([])
    setTruncation({ truncated: false })
    setReplaceStatus(null)
    const timer = window.setTimeout(() => {
      searchContentDetailed(projectPath, term, searchOptions)
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
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [projectPath, query, searchOptions])

  const openMatch = useCallback(
    async (
      result: WorkspaceContentSearchResult,
      match: WorkspaceContentSearchMatch
    ) => {
      await openSourceTarget(
        {
          kind: "file",
          filePath: result.path,
          line: match.line,
          column: match.column,
          endLine: match.line,
          endColumn: match.column + match.length,
        },
        { workspacePath: projectPath }
      )
    },
    [projectPath]
  )

  const replaceResultSet = useCallback(
    async (targetResults: readonly WorkspaceContentSearchResult[]) => {
      if (trimmedQuery.length < 2 || targetResults.length === 0 || replacing)
        return
      setReplacing(true)
      setError(null)
      setReplaceStatus(null)
      try {
        const outcome = await replaceWorkspaceSearchResults({
          projectPath,
          query: trimmedQuery,
          replacement: replaceValue,
          results: targetResults,
          caseSensitive,
          wholeWord,
          regex: regexSearch,
          preserveCase,
        })
        setReplaceStatus(
          `Replaced ${outcome.replacements.toLocaleString()} match${outcome.replacements === 1 ? "" : "es"} in ${outcome.changedFiles.toLocaleString()} file${outcome.changedFiles === 1 ? "" : "s"}.`
        )
        const next = await searchContentDetailed(
          projectPath,
          trimmedQuery,
          searchOptions
        )
        setDiskResults(next.results)
        setTruncation({
          truncated: next.truncated,
          reason: next.truncatedReason,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setReplacing(false)
      }
    },
    [
      caseSensitive,
      projectPath,
      preserveCase,
      replaceValue,
      replacing,
      regexSearch,
      searchOptions,
      trimmedQuery,
      wholeWord,
    ]
  )

  const activeFilters =
    Number(Boolean(includePattern.trim())) +
    Number(Boolean(excludePattern.trim()))
  const canReplace =
    !replacing && !loading && trimmedQuery.length >= 2 && results.length > 0

  return (
    <section
      aria-label="Workspace search"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-sidebar-foreground"
    >
      <div className="max-h-[65%] shrink-0 overflow-y-auto px-3 pb-2 [scrollbar-color:var(--sidebar-border)_transparent] [scrollbar-width:thin]">
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
          />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find in files…"
            aria-label="Search workspace code"
            aria-describedby={
              trimmedQuery.length < 2 ? controlsId + "-hint" : undefined
            }
            className="h-10 rounded-lg border border-sidebar-border/60 bg-background/50 pr-10 pl-9 text-[13px] md:text-[13px]"
          />
          {query && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Clear search"
              onClick={() => {
                setQuery("")
                setReplaceStatus(null)
                inputRef.current?.focus()
              }}
              className="absolute top-0 right-0 size-10 rounded-lg text-muted-foreground transition-colors"
            >
              <XIcon className="size-3.5" />
            </Button>
          )}
        </div>

        <div
          role="group"
          aria-label="Search matching options"
          className="mt-2 flex min-w-0 gap-1"
        >
          <SearchOption
            label="Case"
            title="Match case"
            pressed={caseSensitive}
            onClick={() => setCaseSensitive((value) => !value)}
          >
            <CaseSensitiveIcon className="size-4" />
          </SearchOption>
          <SearchOption
            label="Word"
            title="Match whole word"
            pressed={wholeWord}
            onClick={() => setWholeWord((value) => !value)}
          >
            <WholeWordIcon className="size-4" />
          </SearchOption>
          <SearchOption
            label="Regex"
            title="Use regular expression"
            pressed={regexSearch}
            onClick={() => setRegexSearch((value) => !value)}
          >
            <RegexIcon className="size-4" />
          </SearchOption>
        </div>

        <div className="mt-1 flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            aria-expanded={filtersOpen}
            aria-controls={controlsId + "-filters"}
            onClick={() => setFiltersOpen((value) => !value)}
            className="h-10 min-w-0 flex-1 justify-start gap-2 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors"
          >
            <ListFilterIcon className="size-3.5" />
            Filters
            {activeFilters > 0 && (
              <span
                aria-label={activeFilters + " active file filters"}
                className="rounded-md bg-sidebar-accent px-1.5 text-[10px] text-sidebar-foreground tabular-nums"
              >
                {activeFilters}
              </span>
            )}
            <ChevronDownIcon
              className={cn(
                "ml-auto size-3 transition-transform",
                filtersOpen && "rotate-180"
              )}
            />
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-expanded={replaceOpen}
            aria-controls={controlsId + "-replace"}
            onClick={() => setReplaceOpen((value) => !value)}
            className="h-10 min-w-0 flex-1 justify-start gap-2 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors"
          >
            <ReplaceIcon className="size-3.5" />
            Replace
            <ChevronDownIcon
              className={cn(
                "ml-auto size-3 transition-transform",
                replaceOpen && "rotate-180"
              )}
            />
          </Button>
        </div>

        <div id={controlsId + "-filters"} hidden={!filtersOpen}>
          <div className="mt-1 space-y-3 rounded-lg bg-muted/20 p-3">
            <SearchField
              label="Include files"
              value={includePattern}
              onChange={setIncludePattern}
              placeholder="src/**, *.tsx"
            />
            <SearchField
              label="Exclude files"
              value={excludePattern}
              onChange={setExcludePattern}
              placeholder="node_modules/**, dist/**"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] leading-4 text-muted-foreground">
                Separate patterns with commas.
              </p>
              {activeFilters > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setIncludePattern("")
                    setExcludePattern("")
                  }}
                  className="h-10 rounded-lg px-2 text-[11px] transition-colors"
                  aria-label="Reset file filters"
                >
                  Reset
                </Button>
              )}
            </div>
          </div>
        </div>

        <div id={controlsId + "-replace"} hidden={!replaceOpen}>
          <div className="mt-2 space-y-2 rounded-lg bg-muted/20 p-3">
            <SearchField
              label="Replace with"
              value={replaceValue}
              onChange={setReplaceValue}
              placeholder="Replacement text"
            />
            {!replaceValue && (
              <p className="text-[11px] leading-4 text-muted-foreground">
                Leave empty to remove matches.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-1">
              <Button
                type="button"
                variant="ghost"
                aria-pressed={preserveCase}
                onClick={() => setPreserveCase((value) => !value)}
                className="h-10 gap-1.5 rounded-lg px-1.5 text-[11px] text-muted-foreground transition-colors"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-3.5 items-center justify-center rounded border border-sidebar-border",
                    preserveCase &&
                      "border-primary bg-primary text-primary-foreground"
                  )}
                >
                  {preserveCase && <CheckIcon className="size-3" />}
                </span>
                Preserve case
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!canReplace}
                onClick={() => void replaceResultSet(results)}
                title={
                  truncation.truncated
                    ? "Replace only the listed matches"
                    : "Replace all matches"
                }
                className="h-10 gap-1.5 rounded-lg px-3 text-[11px] transition-colors"
              >
                <ReplaceIcon className="size-3.5" />
                {replacing
                  ? "Replacing…"
                  : truncation.truncated
                    ? "Replace listed"
                    : "Replace all"}
                {matchCount > 0 && (
                  <span className="tabular-nums opacity-60">{matchCount}</span>
                )}
              </Button>
            </div>
          </div>
        </div>

        {replaceStatus && !searchError && (
          <p
            role="status"
            className="mt-2 flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2 text-xs leading-5 text-success"
          >
            <CheckIcon className="mt-0.5 size-3.5 shrink-0" />
            {replaceStatus}
          </p>
        )}
      </div>

      {trimmedQuery.length >= 2 && (
        <div
          role="status"
          className="flex min-h-10 shrink-0 items-center border-y border-sidebar-border/50 px-4 text-xs text-muted-foreground"
        >
          {searchError ? (
            "Search could not finish"
          ) : loading ? (
            "Searching…"
          ) : (
            <span>
              <strong className="font-medium text-sidebar-foreground tabular-nums">
                {matchCount.toLocaleString()}
                {truncation.truncated ? "+" : ""}
              </strong>{" "}
              {matchCount === 1 ? "match" : "matches"} in{" "}
              <span className="tabular-nums">{results.length}</span>{" "}
              {results.length === 1 ? "file" : "files"}
            </span>
          )}
        </div>
      )}

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3 [scrollbar-color:var(--sidebar-border)_transparent] [scrollbar-width:thin]"
        aria-busy={loading}
      >
        {searchError ? (
          <div
            role="alert"
            className="mx-1.5 mt-3 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs leading-5 text-destructive"
          >
            <p className="font-medium">Unable to search</p>
            <p className="mt-1 break-words">{searchError}</p>
          </div>
        ) : trimmedQuery.length < 2 ? (
          <SearchEmptyState title="Find in your workspace">
            <p
              id={controlsId + "-hint"}
              className="mt-1 max-w-56 text-xs leading-5 text-muted-foreground"
            >
              {trimmedQuery.length === 1
                ? "Enter one more character to search."
                : "Search across your files. Enter at least 2 characters to get started."}
            </p>
          </SearchEmptyState>
        ) : loading && results.length === 0 ? (
          <SearchLoadingState />
        ) : results.length === 0 ? (
          <SearchEmptyState
            title={
              truncation.truncated
                ? "No matches in the scanned files"
                : "No matches found"
            }
          >
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Try another term or adjust your filters.
            </p>
            <SearchTruncationNotice
              truncated={truncation.truncated}
              reason={truncation.reason}
              subject="Search"
              hint="narrow the query or add an include pattern"
              className="mt-2 justify-center"
            />
          </SearchEmptyState>
        ) : (
          <div>
            {results.map((result) => {
              const directory = result.path
                .replace(/\\/g, "/")
                .split("/")
                .slice(0, -1)
                .join("/")
              return (
                <details
                  key={result.path}
                  open
                  className="group/result min-w-0 border-b border-sidebar-border/40 pb-1 last:border-0"
                >
                  <summary
                    title={result.path}
                    className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-sidebar-accent/50 focus-visible:bg-sidebar-accent focus-visible:outline-none [&::-webkit-details-marker]:hidden"
                  >
                    <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground group-open/result:rotate-90" />
                    <img
                      src={getFileIconUrl(result.name)}
                      alt=""
                      className="size-4 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">
                        {result.name}
                      </span>
                      {directory && (
                        <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                          {directory}
                        </span>
                      )}
                    </span>
                    <span className="min-w-5 rounded-md bg-sidebar-accent/60 px-1.5 py-0.5 text-center text-[11px] text-muted-foreground tabular-nums">
                      {result.matches.length}
                    </span>
                  </summary>
                  <div className="ml-3 border-l border-sidebar-border/50 pl-1">
                    {result.matches.map((match) => (
                      <button
                        key={
                          result.path + ":" + match.line + ":" + match.column
                        }
                        type="button"
                        onClick={() => void openMatch(result, match)}
                        aria-label={
                          result.name +
                          ", line " +
                          match.line +
                          ", column " +
                          match.column
                        }
                        title={match.preview}
                        className="group grid min-h-10 w-full grid-cols-[42px_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/50 focus-visible:bg-sidebar-accent focus-visible:outline-none"
                      >
                        <span className="pt-px text-right font-mono text-[10px] leading-5 text-muted-foreground tabular-nums">
                          {match.line}:{match.column}
                        </span>
                        <EditorMatchPreview
                          preview={match.preview}
                          matchColumn={match.previewColumn}
                          matchLength={match.previewLength}
                          className="text-xs leading-5"
                        />
                      </button>
                    ))}
                  </div>
                  {replaceOpen && (
                    <div className="flex justify-end px-2">
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={!canReplace}
                        onClick={() => void replaceResultSet([result])}
                        aria-label={"Replace matches in " + result.name}
                        className="h-10 gap-1.5 rounded-lg px-2 text-[11px] text-muted-foreground transition-colors"
                      >
                        <ReplaceIcon className="size-3.5" />
                        Replace in file
                      </Button>
                    </div>
                  )}
                </details>
              )
            })}
            <SearchTruncationNotice
              truncated={truncation.truncated}
              reason={truncation.reason}
              hint="narrow the query or add an include pattern"
              className="mt-2 text-[11px]"
            />
          </div>
        )}
      </div>
    </section>
  )
}

function SearchOption({
  label,
  title,
  pressed,
  onClick,
  children,
}: {
  label: string
  title: string
  pressed: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      aria-label={title}
      aria-pressed={pressed}
      title={title}
      className={cn(
        "h-10 min-w-0 flex-1 gap-2 rounded-lg px-2 text-[11px] text-muted-foreground transition-colors",
        pressed &&
          "border-sidebar-border bg-sidebar-accent text-sidebar-foreground"
      )}
    >
      {children}
      {label}
    </Button>
  )
}

function SearchField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 rounded-lg border-sidebar-border/50 bg-background/50 px-2.5 text-xs md:text-xs"
      />
    </label>
  )
}

function SearchEmptyState({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-5 pt-9 pb-6 text-center">
      <FolderSearchIcon
        aria-hidden
        className="mb-3 size-6 text-muted-foreground/60"
        strokeWidth={1.5}
      />
      <p className="text-[13px] font-medium">{title}</p>
      {children}
    </div>
  )
}

function SearchLoadingState() {
  return (
    <div aria-hidden className="space-y-5 px-3 py-4">
      {[1, 2, 3].map((item) => (
        <div key={item}>
          <div className="h-3 w-28 rounded bg-sidebar-accent" />
          <div className="mt-3 ml-4 h-2 w-3/4 rounded bg-sidebar-accent/50" />
          <div className="mt-2 ml-4 h-2 w-1/2 rounded bg-sidebar-accent/50" />
        </div>
      ))}
    </div>
  )
}
