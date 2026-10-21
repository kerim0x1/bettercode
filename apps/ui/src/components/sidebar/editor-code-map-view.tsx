import { copyText } from "@/lib/clipboard"
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  AlertCircleIcon,
  CheckIcon,
  ClipboardIcon,
  ChevronRightIcon,
  FileCode2Icon,
  FilesIcon,
  FolderOpenIcon,
  GaugeIcon,
  LayoutGridIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { getFileIconUrl, getFolderIconUrl } from "@/lib/file-icons"
import { dispatchEditorRevealFile } from "@/lib/editor-reveal-event"
import { useEditorStore } from "@/lib/editor-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { cn } from "@/lib/utils"
import { buildWorkspaceMapBrief } from "@/lib/workspace-map-brief"
import {
  getWorkspaceMap,
  type WorkspaceMapFile,
  type WorkspaceMapFileKind,
  type WorkspaceMapOverview,
} from "@/services/backend"

import "./editor-code-map-view.css"

interface EditorCodeMapViewProps {
  projectPath: string
}

type CodeMapKindFilter = "all" | WorkspaceMapFileKind

const CODE_MAP_KIND_FILTERS: Array<{
  id: CodeMapKindFilter
  label: string
}> = [
  { id: "all", label: "All" },
  { id: "source", label: "Source" },
  { id: "config", label: "Config" },
  { id: "docs", label: "Docs" },
  { id: "data", label: "Data" },
]

const FILE_INDEX_VISIBLE_LIMIT = 80

export function EditorCodeMapView({ projectPath }: EditorCodeMapViewProps) {
  const activeTab = useEditorStore((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId)
  )
  const [overview, setOverview] = useState<WorkspaceMapOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [query, setQuery] = useState("")
  const [view, setView] = useState<"overview" | "files">("overview")
  const [directoryFilter, setDirectoryFilter] = useState<string | null>(null)
  const [showAllTypes, setShowAllTypes] = useState(false)
  const [showAllFolders, setShowAllFolders] = useState(false)
  const tabId = useId()
  const [kindFilter, setKindFilter] = useState<CodeMapKindFilter>("all")
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle"
  )
  const copyResetTimerRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    getWorkspaceMap(projectPath)
      .then((next) => {
        if (!cancelled) setOverview(next)
      })
      .catch((err) => {
        if (!cancelled) {
          setOverview(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectPath, reloadKey])

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
      }
    },
    []
  )

  const maxDirectoryFiles = useMemo(
    () =>
      Math.max(
        1,
        ...(overview?.topDirectories.map((entry) => entry.fileCount) ?? [1])
      ),
    [overview]
  )

  const matchingFiles = useMemo(
    () =>
      filterWorkspaceMapFiles(overview?.files ?? [], {
        query,
        kind: "all",
        directory: directoryFilter,
      }),
    [directoryFilter, overview, query]
  )
  const kindCounts = useMemo(
    () => countWorkspaceMapKinds(matchingFiles),
    [matchingFiles]
  )
  const filteredFiles = useMemo(
    () =>
      kindFilter === "all"
        ? matchingFiles
        : matchingFiles.filter((file) => file.kind === kindFilter),
    [kindFilter, matchingFiles]
  )
  const visibleFiles = filteredFiles.slice(0, FILE_INDEX_VISIBLE_LIMIT)
  const activeRelativePath = useMemo(
    () =>
      activeTab
        ? relativeWorkspaceMapPath(projectPath, activeTab.filePath)
        : null,
    [activeTab, projectPath]
  )
  const relatedFiles = useMemo(
    () =>
      buildRelatedWorkspaceMapFiles(overview?.files ?? [], activeRelativePath),
    [activeRelativePath, overview]
  )

  const openFile = useCallback(
    (file: WorkspaceMapFile) => {
      void useEditorStore
        .getState()
        .openFile(resolveProjectFilePath(projectPath, file.path))
    },
    [projectPath]
  )
  const revealFile = useCallback(
    (file: WorkspaceMapFile) => {
      usePreferencesStore.getState().setMultiple({
        sidebarOpen: true,
        editorSidebarView: "files",
      })
      dispatchEditorRevealFile(resolveProjectFilePath(projectPath, file.path), {
        defer: true,
      })
    },
    [projectPath]
  )
  const filterDirectory = useCallback((directoryPath: string) => {
    setKindFilter("all")
    setQuery("")
    setDirectoryFilter(directoryPath)
    setView("files")
  }, [])
  const copyWorkspaceBrief = useCallback(async () => {
    if (!overview) return
    try {
      const copied = await copyText(
        buildWorkspaceMapBrief(overview, { projectPath })
      )
      if (!copied) {
        setCopyState("error")
        return
      }
      setCopyState("copied")
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopyState("idle")
        copyResetTimerRef.current = null
      }, 1400)
    } catch {
      setCopyState("error")
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopyState("idle")
        copyResetTimerRef.current = null
      }, 1800)
    }
  }, [overview, projectPath])

  const renderFile = (file: WorkspaceMapFile, detail?: string) => (
    <CodeMapFileButton
      key={file.path}
      file={file}
      detail={detail}
      isActive={sameWorkspaceMapPath(file.path, activeRelativePath)}
      onOpen={openFile}
      onReveal={revealFile}
    />
  )
  const hasFilters = Boolean(
    query || kindFilter !== "all" || directoryFilter !== null
  )

  return (
    <div
      className="code-map"
      aria-label="Workspace code map"
      aria-busy={loading}
    >
      <div className="code-map-header">
        <div className="code-map-project">
          <img
            src={getFolderIconUrl(true, projectPath)}
            alt=""
            className="size-6 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p className="code-map-project-name" title={projectPath}>
              {overview?.rootName ||
                projectPath
                  .replace(/[\\/]+$/, "")
                  .split(/[\\/]/)
                  .pop()}
            </p>
            <p className="code-map-caption">
              {loading ? "Updating workspace map..." : "Workspace overview"}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "code-map-tool",
              copyState === "copied" &&
                "text-emerald-600 dark:text-emerald-400",
              copyState === "error" && "text-destructive"
            )}
            onClick={() => void copyWorkspaceBrief()}
            disabled={!overview}
            aria-label="Copy workspace brief"
            title={
              copyState === "copied"
                ? "Workspace brief copied"
                : copyState === "error"
                  ? "Could not copy workspace brief"
                  : "Copy workspace brief"
            }
          >
            {copyState === "copied" ? (
              <CheckIcon className="size-3.5" />
            ) : (
              <ClipboardIcon className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="code-map-tool"
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={loading}
            aria-label="Refresh code map"
            title="Refresh code map"
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        <span className="sr-only" role="status">
          {copyState === "copied"
            ? "Workspace brief copied"
            : copyState === "error"
              ? "Could not copy workspace brief"
              : ""}
        </span>
        {overview && !error && (
          <div className="code-map-metrics">
            <CodeMapMetric
              icon={FilesIcon}
              label="Files"
              value={overview.totalFiles}
            />
            <CodeMapMetric
              icon={FileCode2Icon}
              label="Source"
              value={overview.codeFiles}
            />
            <CodeMapMetric
              icon={GaugeIcon}
              label="Size"
              value={formatBytes(overview.totalBytes)}
            />
          </div>
        )}
        <div
          className="code-map-tabs"
          role="tablist"
          aria-label="Code map views"
        >
          {(["overview", "files"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`${tabId}-${value}`}
              aria-controls={`${tabId}-content`}
              aria-selected={view === value}
              tabIndex={view === value ? 0 : -1}
              onClick={() => setView(value)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key
                  )
                )
                  return
                event.preventDefault()
                const next =
                  event.key === "Home"
                    ? "overview"
                    : event.key === "End"
                      ? "files"
                      : value === "overview"
                        ? "files"
                        : "overview"
                setView(next)
                document.getElementById(`${tabId}-${next}`)?.focus()
              }}
            >
              {value === "overview" ? (
                <LayoutGridIcon className="size-3.5" />
              ) : (
                <FilesIcon className="size-3.5" />
              )}
              {value === "overview" ? "Overview" : "Files"}
              {value === "files" && overview && (
                <span className="code-map-tab-count">
                  {overview.files.length.toLocaleString()}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div
        className="code-map-content"
        role="tabpanel"
        id={`${tabId}-content`}
        aria-labelledby={`${tabId}-${view}`}
      >
        {error ? (
          <CodeMapError
            message={error}
            onRetry={() => setReloadKey((key) => key + 1)}
          />
        ) : loading && !overview ? (
          <CodeMapLoading />
        ) : !overview || overview.totalFiles === 0 ? (
          <CodeMapEmpty />
        ) : (
          <>
            {overview.truncated && (
              <p className="code-map-notice">
                <AlertCircleIcon className="size-3.5 shrink-0" />
                <span>
                  Partial scan: {overview.scannedFiles.toLocaleString()} files
                  indexed. Counts cover this scan.
                </span>
              </p>
            )}
            {view === "overview" ? (
              <div className="code-map-scroll code-map-overview">
                <CodeMapSection
                  title="Folders"
                  count={overview.topDirectories.length}
                >
                  {(showAllFolders
                    ? overview.topDirectories
                    : overview.topDirectories.slice(0, 10)
                  ).map((directory) => (
                    <button
                      type="button"
                      key={directory.path || "__root__"}
                      className="code-map-directory"
                      onClick={() => filterDirectory(directory.path)}
                      aria-label={`Show files in ${directory.path || "project root"}`}
                      title={directory.path || "Files in the project root"}
                    >
                      <img
                        src={getFolderIconUrl(false, directory.path)}
                        alt=""
                        className="size-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-baseline justify-between gap-2">
                          <span className="truncate text-[12px] font-medium">
                            {directory.path ? directory.name : "Project root"}
                          </span>
                          <span className="code-map-directory-count">
                            {directory.fileCount.toLocaleString()}{" "}
                            <span>
                              {directory.fileCount === 1 ? "file" : "files"}
                            </span>
                          </span>
                        </span>
                        <span
                          className="code-map-directory-track"
                          aria-hidden="true"
                        >
                          <span
                            style={{
                              width: `${(directory.fileCount / maxDirectoryFiles) * 100}%`,
                            }}
                          />
                        </span>
                      </span>
                      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                  {overview.topDirectories.length > 10 && (
                    <button
                      type="button"
                      className="code-map-text-action"
                      aria-expanded={showAllFolders}
                      onClick={() => setShowAllFolders((value) => !value)}
                    >
                      {showAllFolders
                        ? "Show fewer folders"
                        : `Show all ${overview.topDirectories.length} folders`}
                    </button>
                  )}
                </CodeMapSection>
                <CodeMapSection
                  title="File types"
                  count={overview.extensions.length}
                >
                  <div className="code-map-types">
                    {(showAllTypes
                      ? overview.extensions
                      : overview.extensions.slice(0, 6)
                    ).map((extension) => (
                      <div
                        key={extension.extension}
                        className="code-map-type"
                        title={`${extension.label}: ${extension.fileCount} files, ${extension.codeFileCount} source files`}
                      >
                        <img
                          src={getFileIconUrl(extension.label)}
                          alt=""
                          className="size-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {extension.label}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {extension.fileCount.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                  {overview.extensions.length > 6 && (
                    <button
                      type="button"
                      className="code-map-text-action"
                      aria-expanded={showAllTypes}
                      onClick={() => setShowAllTypes((value) => !value)}
                    >
                      {showAllTypes
                        ? "Show fewer types"
                        : `Show all ${overview.extensions.length} types`}
                    </button>
                  )}
                </CodeMapSection>
                {overview.importantFiles.length > 0 && (
                  <CodeMapSection
                    title="Entry points"
                    count={overview.importantFiles.length}
                  >
                    {overview.importantFiles.map((file) => renderFile(file))}
                  </CodeMapSection>
                )}
                {activeRelativePath && relatedFiles.length > 0 && (
                  <CodeMapSection
                    title="Related files"
                    count={relatedFiles.length}
                  >
                    <p
                      className="code-map-related-caption"
                      title={activeRelativePath}
                    >
                      Near{" "}
                      <strong>
                        {activeTab?.fileName ?? activeRelativePath}
                      </strong>
                    </p>
                    {relatedFiles.map((item) =>
                      renderFile(item.file, item.reason)
                    )}
                  </CodeMapSection>
                )}
                {overview.largestFiles.length > 0 && (
                  <CodeMapSection
                    title="Largest files"
                    count={overview.largestFiles.length}
                    defaultOpen={false}
                  >
                    {overview.largestFiles.map((file) =>
                      renderFile(file, formatBytes(file.sizeBytes))
                    )}
                  </CodeMapSection>
                )}
              </div>
            ) : (
              <>
                <div className="code-map-file-tools">
                  <label className="code-map-search">
                    <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      aria-label="Filter code map files"
                      placeholder="Find a file..."
                    />
                    {query && (
                      <button
                        type="button"
                        onClick={() => setQuery("")}
                        aria-label="Clear file filter"
                      >
                        <XIcon className="size-3" />
                      </button>
                    )}
                  </label>
                  {directoryFilter !== null && (
                    <div className="code-map-folder-filter">
                      <img
                        src={getFolderIconUrl(false, directoryFilter)}
                        alt=""
                        className="size-3.5"
                      />
                      <span>{directoryFilter || "Project root"}</span>
                      <button
                        type="button"
                        onClick={() => setDirectoryFilter(null)}
                        aria-label="Clear folder filter"
                        title="Show files from all folders"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  )}
                  <div
                    className="code-map-kind-filters"
                    role="group"
                    aria-label="Filter by file type"
                  >
                    {CODE_MAP_KIND_FILTERS.map((filter) => (
                      <button
                        key={filter.id}
                        type="button"
                        aria-pressed={kindFilter === filter.id}
                        onClick={() => setKindFilter(filter.id)}
                      >
                        {filter.label}
                        <span>{kindCounts[filter.id]}</span>
                      </button>
                    ))}
                  </div>
                  <p className="code-map-caption" role="status">
                    {filteredFiles.length.toLocaleString()}{" "}
                    {filteredFiles.length === 1 ? "file" : "files"}
                    {hasFilters ? " found" : " indexed"}
                    {filteredFiles.length > FILE_INDEX_VISIBLE_LIMIT
                      ? ` \u00b7 First ${FILE_INDEX_VISIBLE_LIMIT} shown`
                      : ""}
                  </p>
                </div>
                <div className="code-map-scroll code-map-file-list">
                  {visibleFiles.length ? (
                    visibleFiles.map((file) => renderFile(file))
                  ) : (
                    <div className="code-map-no-results">
                      <SearchIcon className="size-5" />
                      <p>No matching files</p>
                      <button
                        type="button"
                        className="code-map-text-action"
                        onClick={() => {
                          setQuery("")
                          setKindFilter("all")
                          setDirectoryFilter(null)
                        }}
                      >
                        Clear filters
                      </button>
                    </div>
                  )}
                  {filteredFiles.length > FILE_INDEX_VISIBLE_LIMIT && (
                    <p className="code-map-list-hint">
                      Refine your search to find more files.
                    </p>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function countWorkspaceMapKinds(
  files: readonly WorkspaceMapFile[] | undefined
): Record<CodeMapKindFilter, number> {
  const counts: Record<CodeMapKindFilter, number> = {
    all: files?.length ?? 0,
    source: 0,
    config: 0,
    docs: 0,
    data: 0,
  }
  for (const file of files ?? []) counts[file.kind] += 1
  return counts
}

export function filterWorkspaceMapFiles(
  files: readonly WorkspaceMapFile[],
  filter: { query: string; kind: CodeMapKindFilter; directory?: string | null }
): WorkspaceMapFile[] {
  const terms = filter.query.trim().toLowerCase().split(/\s+/g).filter(Boolean)
  const directory =
    filter.directory == null
      ? null
      : normalizeWorkspaceMapPath(filter.directory)
          .replace(/\/+$/, "")
          .toLowerCase()
  const filtered = files.filter((file) => {
    if (directory !== null) {
      const parent = normalizeWorkspaceMapPath(file.directory)
        .replace(/\/+$/, "")
        .toLowerCase()
      if (
        parent !== directory &&
        !(directory && parent.startsWith(`${directory}/`))
      )
        return false
    }
    if (filter.kind !== "all" && file.kind !== filter.kind) return false
    if (terms.length === 0) return true
    const haystack = [
      file.name,
      file.path,
      file.directory,
      file.extension,
      file.kind,
    ]
      .join(" ")
      .toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })

  if (terms.length === 0) return filtered

  return filtered
    .map((file) => ({ file, score: scoreWorkspaceMapFile(file, terms) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.file.path.localeCompare(b.file.path, undefined, {
        sensitivity: "base",
      })
    })
    .map((entry) => entry.file)
}

function scoreWorkspaceMapFile(
  file: WorkspaceMapFile,
  terms: readonly string[]
): number {
  const name = file.name.toLowerCase()
  const path = file.path.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (name === term) score += 80
    else if (name.startsWith(term)) score += 50
    else if (name.includes(term)) score += 30
    if (path.startsWith(term)) score += 20
    else if (path.includes(`/${term}`)) score += 12
    else if (path.includes(term)) score += 6
  }
  if (file.kind === "source") score += 3
  if (file.kind === "config") score += 2
  return score
}

interface RelatedWorkspaceMapFile {
  file: WorkspaceMapFile
  reason: string
}

function buildRelatedWorkspaceMapFiles(
  files: readonly WorkspaceMapFile[],
  activePath: string | null
): RelatedWorkspaceMapFile[] {
  if (!activePath) return []
  const active = files.find((file) =>
    sameWorkspaceMapPath(file.path, activePath)
  )
  if (!active) return []

  const activeStem = comparableFileStem(active.name)
  const activeModule = comparableModuleStem(active.name)
  return files
    .filter((file) => !sameWorkspaceMapPath(file.path, active.path))
    .map((file) => {
      let score = 0
      const reasons: string[] = []
      const stem = comparableFileStem(file.name)
      const moduleStem = comparableModuleStem(file.name)

      if (moduleStem === activeModule) {
        score += 120
        reasons.push("same module")
      }
      if (file.directory === active.directory) {
        score += 80
        reasons.push("same folder")
      }
      if (stem === activeStem) {
        score += 60
        reasons.push("same name")
      }
      if (file.extension === active.extension) score += 8
      if (file.kind === active.kind) score += 4

      return {
        file,
        score,
        reason: reasons[0] ?? "related",
      }
    })
    .filter((item) => item.score >= 60)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.file.path.localeCompare(b.file.path, undefined, {
        sensitivity: "base",
      })
    })
    .slice(0, 8)
    .map(({ file, reason }) => ({ file, reason }))
}

function relativeWorkspaceMapPath(
  projectPath: string,
  filePath: string
): string {
  const project = normalizeWorkspaceMapPath(projectPath).replace(/\/+$/, "")
  const file = normalizeWorkspaceMapPath(filePath)
  const projectLower = project.toLowerCase()
  const fileLower = file.toLowerCase()
  if (fileLower.startsWith(`${projectLower}/`)) {
    return file.slice(project.length + 1)
  }
  return file
}

function sameWorkspaceMapPath(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false
  return (
    normalizeWorkspaceMapPath(a).toLowerCase() ===
    normalizeWorkspaceMapPath(b).toLowerCase()
  )
}

function normalizeWorkspaceMapPath(value: string): string {
  return value.replace(/\\/g, "/")
}

function comparableFileStem(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/\.[^.]+$/u, "")
    .replace(/\.(test|spec|stories|story)$/u, "")
}

function comparableModuleStem(fileName: string): string {
  return comparableFileStem(fileName)
    .replace(/[-_.](test|spec|stories|story)$/u, "")
    .replace(/[-_.](component|view|page|styles|style)$/u, "")
}

function CodeMapSection({
  title,
  count,
  children,
  defaultOpen = true,
}: {
  title: string
  count?: number
  children: ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details className="code-map-section" open={defaultOpen}>
      <summary>
        <ChevronRightIcon className="size-3.5" />
        <span>{title}</span>
        {count !== undefined && (
          <span className="code-map-section-count">
            {count.toLocaleString()}
          </span>
        )}
      </summary>
      <div className="code-map-section-body">{children}</div>
    </details>
  )
}

function CodeMapMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: number | string
}) {
  return (
    <div className="code-map-metric">
      <p className="code-map-metric-value" title={String(value)}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      <p className="code-map-metric-label">
        <Icon className="size-3" />
        {label}
      </p>
    </div>
  )
}

function CodeMapFileButton({
  file,
  detail,
  isActive = false,
  onOpen,
  onReveal,
}: {
  file: WorkspaceMapFile
  detail?: string
  isActive?: boolean
  onOpen: (file: WorkspaceMapFile) => void
  onReveal: (file: WorkspaceMapFile) => void
}) {
  return (
    <div className={cn("code-map-file", isActive && "is-active")}>
      <button
        type="button"
        onClick={() => onOpen(file)}
        className="code-map-file-open"
        aria-label={`Open ${file.path}`}
        aria-current={isActive ? "page" : undefined}
        title={file.path}
      >
        <img
          src={getFileIconUrl(file.path)}
          alt=""
          className="size-4 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="code-map-file-name">{file.name}</span>
          <span className="code-map-file-path">
            {file.directory || "Project root"}
          </span>
        </span>
        <span className="code-map-file-detail" title={detail ?? file.kind}>
          {detail ?? file.kind}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onReveal(file)}
        className="code-map-reveal"
        aria-label={`Reveal ${file.name} in Explorer`}
        title="Reveal in Explorer"
      >
        <FolderOpenIcon className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  )
}

function CodeMapLoading() {
  return (
    <div className="space-y-2 p-3" role="status" aria-label="Loading code map">
      {Array.from({ length: 7 }).map((_, index) => (
        <div
          key={index}
          className="rounded-md border border-sidebar-border/45 bg-sidebar-accent/14 p-2"
        >
          <div className="h-3 w-24 rounded bg-sidebar-accent/60" />
          <div className="mt-2 h-2 w-full rounded bg-sidebar-accent/35" />
          <div className="mt-1.5 h-2 w-2/3 rounded bg-sidebar-accent/25" />
        </div>
      ))}
    </div>
  )
}

function CodeMapEmpty() {
  return (
    <div className="code-map-state">
      <LayoutGridIcon className="size-5 text-muted-foreground/55" />
      <p className="text-xs font-medium">Nothing to map yet</p>
      <p className="text-[11px] text-muted-foreground">
        No indexable files were found in this workspace.
      </p>
    </div>
  )
}

function CodeMapError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="code-map-state" role="alert">
      <AlertCircleIcon className="size-5 text-muted-foreground" />
      <p className="text-xs font-medium">Could not load the code map</p>
      <p className="max-w-full text-[11px] leading-relaxed break-words text-muted-foreground">
        {message}
      </p>
      <button
        type="button"
        className="code-map-text-action gap-1.5"
        onClick={onRetry}
      >
        <RefreshCwIcon className="size-3" />
        Try again
      </button>
    </div>
  )
}

function resolveProjectFilePath(
  projectPath: string,
  relativePath: string
): string {
  const separator = projectPath.includes("\\") ? "\\" : "/"
  const base = projectPath.replace(/[\\/]+$/, "")
  const relative = relativePath.replace(/^[\\/]+/, "")
  return `${base}${separator}${relative}`
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
