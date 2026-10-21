import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  FilesIcon,
  FolderIcon,
  LayersIcon,
  FileCodeIcon,
  FolderGit2Icon,
  GlobeIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { getFileIconUrl, getFolderIconUrl } from "@/lib/file-icons"
import {
  buildCodebaseOverview,
  type CodebaseOverviewEntry,
  type CodebaseOverview as OverviewData,
} from "@/lib/codebase-overview"
import { searchEntriesDetailed } from "@/services/backend/workspaceApi"
import { listDirectoryFs } from "@/services/backend/filesystem"
import { SearchTruncationNotice } from "@/components/search-truncation-notice"
import "./codebase-overview.css"

interface CodebaseOverviewProps {
  projectPath: string
  onOpenFile: (relativePath: string) => void
  onOpenBrowser: () => void
}

export function CodebaseOverview({
  projectPath,
  onOpenFile,
  onOpenBrowser,
}: CodebaseOverviewProps) {
  const [entries, setEntries] = useState<CodebaseOverviewEntry[]>([])
  const [truncation, setTruncation] = useState<{
    truncated: boolean
    reason?: string
  }>({ truncated: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const overview = useMemo(() => buildCodebaseOverview(entries), [entries])
  const folderName =
    projectPath.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ||
    "Workspace"
  const load = useCallback(async () => {
    const current = ++requestId.current
    setLoading(true)
    setError(null)
    try {
      // Root files remain useful even when a large recursive scan reaches its cap.
      const [scan, root] = await Promise.all([
        searchEntriesDetailed(projectPath, ""),
        listDirectoryFs(projectPath),
      ])
      if (requestId.current !== current) return
      const byPath = new Map(scan.entries.map((entry) => [entry.path, entry]))
      for (const entry of root.entries) {
        if (!entry.isDir)
          byPath.set(entry.name, {
            path: entry.name,
            name: entry.name,
            is_dir: false,
          })
      }
      setEntries([...byPath.values()])
      setTruncation({
        truncated: scan.truncated || root.truncated,
        reason: scan.truncatedReason,
      })
    } catch (err) {
      if (requestId.current === current)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestId.current === current) setLoading(false)
    }
  }, [projectPath])
  useEffect(() => {
    const requests = requestId
    void load()
    return () => {
      requests.current++
    }
  }, [load])
  const openQuickOpen = () =>
    window.dispatchEvent(new Event("betterc0de:open-quick-open"))
  const shortcut =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘ P"
      : "Ctrl P"

  return (
    <section
      aria-label="Workspace overview"
      className="workspace-overview flex min-h-0 flex-1 flex-col bg-background"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 px-4">
        <FolderGit2Icon
          className="size-4 text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden
        />
        <span className="text-xs font-medium">Workspace</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto rounded-md transition-colors"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh workspace overview"
          title="Refresh workspace overview"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </header>
      <div className="workspace-overview-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="workspace-overview-content">
          <div className="workspace-overview-project">
            <div className="workspace-overview-project-icon" aria-hidden>
              <img
                src={getFolderIconUrl(true, folderName)}
                alt=""
                draggable={false}
              />
            </div>
            <div className="min-w-0">
              <p className="workspace-overview-eyebrow">Workspace overview</p>
              <h2 className="workspace-overview-title" title={folderName}>
                {folderName}
              </h2>
              <p className="workspace-overview-path" title={projectPath}>
                {projectPath}
              </p>
            </div>
          </div>

          <div className="workspace-overview-actions">
            <button
              type="button"
              onClick={openQuickOpen}
              className="workspace-overview-search"
            >
              <SearchIcon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                Find and open a file…
              </span>
              <kbd>{shortcut}</kbd>
            </button>
            <button
              type="button"
              onClick={onOpenBrowser}
              className="workspace-overview-preview"
              aria-label="Open browser preview"
            >
              <GlobeIcon className="size-4 shrink-0" aria-hidden />
              <span>Browser preview</span>
              <ArrowUpRightIcon className="size-3.5 shrink-0" aria-hidden />
            </button>
          </div>

          <div aria-busy={loading}>
            {error ? (
              <div
                role="alert"
                className="workspace-overview-state border-destructive/25 bg-destructive/5"
              >
                <p className="text-sm font-medium">
                  Couldn't load this workspace
                </p>
                <p className="mt-2 text-xs break-words text-muted-foreground">
                  {error}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-4 rounded-lg transition-colors"
                  onClick={() => void load()}
                >
                  <RefreshCwIcon className="size-3.5" /> Try again
                </Button>
              </div>
            ) : loading ? (
              <div
                role="status"
                aria-label="Loading workspace"
                className="workspace-overview-loading"
              >
                <div className="h-24 rounded-xl bg-muted/25" />
                <div className="workspace-overview-grid">
                  <div className="h-64 rounded-xl bg-muted/15" />
                  <div className="h-52 rounded-xl bg-muted/15" />
                </div>
                <span className="sr-only">Loading workspace</span>
              </div>
            ) : (
              <>
                <div className="workspace-overview-summary">
                  <div className="workspace-overview-metrics">
                    <dl className="workspace-overview-counts">
                      <div>
                        <dt>
                          <FilesIcon aria-hidden />
                          Files
                        </dt>
                        <dd>
                          {overview.totalFiles.toLocaleString()}
                          {truncation.truncated && <span>+</span>}
                        </dd>
                      </div>
                      <div>
                        <dt>
                          <FolderIcon aria-hidden />
                          Folders
                        </dt>
                        <dd>
                          {overview.totalFolders.toLocaleString()}
                          {truncation.truncated && <span>+</span>}
                        </dd>
                      </div>
                    </dl>
                    <div className="workspace-overview-stack">
                      <p>
                        <LayersIcon aria-hidden />
                        Detected stack
                      </p>
                      <div>
                        {overview.frameworkHints.length ? (
                          overview.frameworkHints.map((hint) => (
                            <span
                              className="workspace-overview-badge"
                              key={hint.label}
                              title={hint.detail}
                            >
                              {hint.label}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            No framework detected
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <SearchTruncationNotice
                    truncated={truncation.truncated}
                    reason={truncation.reason}
                    subject="Scan"
                    hint="showing a partial overview"
                    className="workspace-overview-scan-note"
                  />
                </div>

                <div className="workspace-overview-grid">
                  <section
                    className="workspace-overview-card"
                    aria-label="Project starting points"
                  >
                    <div className="workspace-overview-card-heading">
                      <div>
                        <h3>
                          <FileCodeIcon aria-hidden />
                          Key files
                        </h3>
                        <p>A starting point for your project.</p>
                      </div>
                      {overview.keyFiles.length > 0 && (
                        <span className="workspace-overview-file-count">
                          {overview.keyFiles.length}
                        </span>
                      )}
                    </div>
                    {overview.keyFiles.length ? (
                      <div className="workspace-overview-file-list">
                        {overview.keyFiles.map((file) => (
                          <button
                            key={file.path}
                            type="button"
                            onClick={() => onOpenFile(file.path)}
                            className="workspace-overview-file"
                            title={file.path}
                          >
                            <span className="workspace-overview-file-icon">
                              <img
                                src={getFileIconUrl(file.name)}
                                alt=""
                                draggable={false}
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="workspace-overview-file-name">
                                {file.name}
                              </span>
                              <span className="workspace-overview-file-detail">
                                {file.reason}
                              </span>
                              {file.path !== file.name && (
                                <span className="workspace-overview-file-path">
                                  {file.path}
                                </span>
                              )}
                            </span>
                            <ArrowRightIcon
                              className="workspace-overview-file-arrow"
                              aria-hidden
                            />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="workspace-overview-empty">
                        <FileCodeIcon
                          className="size-7 text-muted-foreground/60"
                          aria-hidden
                        />
                        <p className="text-sm font-medium">
                          {overview.totalFiles
                            ? "Ready to explore"
                            : "A fresh workspace"}
                        </p>
                        <p>
                          {overview.totalFiles
                            ? "Find a file above or browse your folders in the Explorer."
                            : "Create your first file in the Explorer to get started."}
                        </p>
                      </div>
                    )}
                  </section>
                  <WorkspaceFileTypes overview={overview} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

const languageColors: Record<string, string> = {
  TypeScript: "#5199ed",
  "TypeScript React": "#61b9d5",
  JavaScript: "#d8bd59",
  "JavaScript React": "#80c9cd",
  JSON: "#bfaa68",
  CSS: "#ae8bd6",
  HTML: "#df8b65",
  Python: "#719eca",
  Rust: "#c8947c",
  Go: "#69b3bd",
  Vue: "#73b899",
  Svelte: "#db8a72",
  Markdown: "#92a1b6",
}

function WorkspaceFileTypes({ overview }: { overview: OverviewData }) {
  // The summary only returns its top languages. Keep omitted types and files
  // without extensions in the denominator so the chart covers the whole scan.
  const remaining =
    overview.totalFiles -
    overview.languages.reduce((sum, item) => sum + item.count, 0)
  const types = [
    ...overview.languages,
    ...(remaining > 0 ? [{ label: "Remaining files", count: remaining }] : []),
  ].map((item) => {
    const percent = (item.count / overview.totalFiles) * 100
    return {
      ...item,
      percent,
      displayPercent:
        percent < 1
          ? "<1%"
          : percent > 99 && percent < 100
            ? ">99%"
            : `${Math.round(percent)}%`,
      color: languageColors[item.label] ?? "var(--muted-foreground)",
    }
  })

  return (
    <section
      className="workspace-overview-card workspace-overview-types"
      aria-label="Workspace languages"
    >
      <div className="workspace-overview-card-heading">
        <div>
          <h3>
            <LayersIcon aria-hidden />
            File types
          </h3>
          <p>Share of scanned files.</p>
        </div>
      </div>
      {types.length ? (
        <div className="workspace-overview-types-content">
          <div className="workspace-overview-language-bar" aria-hidden>
            {types.map((item) => (
              <span
                key={item.label}
                style={{
                  width: `${item.percent}%`,
                  backgroundColor: item.color,
                }}
              />
            ))}
          </div>
          <ul className="workspace-overview-language-list">
            {types.map((item) => (
              <li
                key={item.label}
                title={`${item.count.toLocaleString()} ${item.count === 1 ? "file" : "files"}`}
              >
                <span
                  className="workspace-overview-language-dot"
                  style={{ backgroundColor: item.color }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span className="workspace-overview-language-percent">
                  {item.displayPercent}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="workspace-overview-no-types">
          File types will appear here once this workspace has files.
        </p>
      )}
    </section>
  )
}
