import "@/components/diff-panel.css"
import { useEffect, useMemo, useState, type CSSProperties } from "react"
import {
  AlignJustifyIcon,
  ChevronDownIcon,
  FileDiffIcon,
  SearchIcon,
  SplitIcon,
} from "lucide-react"
import { DiffHunkLines, useDiffSyntax } from "@/components/diff-code"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { getFileIconUrl } from "@/lib/file-icons"
import { parseGitDiff, type DiffFile } from "@/lib/git-diff"
import { pullRequestErrorMessage } from "@/lib/pull-request-create"
import { useSettingsStore } from "@/lib/settings-store"
import { cn } from "@/lib/utils"
import { githubPullRequestDiff } from "@/services/backend/github-api"

/**
 * A pull request's changed files, drawn with the diff panel's parts
 * (`diff-panel.css`, `DiffHunkLines`, syntax colouring): a filterable file
 * list beside the selected file's hunks, unified or split. Read-only: the
 * stage and discard actions of the working-tree diff have no meaning here.
 */
export function PullRequestFiles({
  cwd,
  number,
  headSha,
}: {
  cwd: string
  number: number
  /** Reloads when the pull request's head moves. */
  headSha: string | null
}) {
  const diffWordWrap = useSettingsStore((state) => state.diffWordWrap)
  const diffStyle = useSettingsStore((state) => state.diffStyle)
  const [files, setFiles] = useState<DiffFile[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified")
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let active = true
    setFiles(null)
    setError(null)
    githubPullRequestDiff(cwd, number)
      .then((result) => {
        if (!active) return
        setFiles(parseGitDiff(result.diff))
        setTruncated(result.truncated)
      })
      .catch((failure: unknown) => {
        if (active) setError(pullRequestErrorMessage(failure))
      })
    return () => {
      active = false
    }
  }, [cwd, number, headSha, attempt])

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase()
    return (files ?? []).filter(
      (file) => !query || file.name.toLowerCase().includes(query)
    )
  }, [files, filter])
  const active =
    (selected && files?.find((file) => file.name === selected)) ||
    visible[0] ||
    null
  const syntax = useDiffSyntax(active ?? undefined)
  const mode = diffStyle === "stacked" ? "unified" : viewMode

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load the changes</AlertTitle>
        <AlertDescription className="flex flex-col gap-2 text-xs">
          <span>{error}</span>
          <span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          </span>
        </AlertDescription>
      </Alert>
    )
  }
  if (!files) {
    return (
      <p
        role="status"
        className="py-10 text-center text-xs text-muted-foreground"
      >
        Loading the changes…
      </p>
    )
  }

  return (
    // The diff panel fills its parent; this frame gives it a height.
    <div className="h-[min(72vh,820px)] overflow-hidden rounded-xl border border-border/50">
      <section className="diff-panel" aria-label="Files changed">
        {truncated ? (
          <p
            role="status"
            className="border-b border-border/40 px-3 py-2 text-xs text-muted-foreground"
          >
            This diff is too large to show in full; the rest is on GitHub.
          </p>
        ) : null}
        <div
          className="diff-panel-body"
          style={{ "--diff-file-list-width": "260px" } as CSSProperties}
        >
          <aside className="diff-file-list" aria-label="Changed files">
            <div className="diff-file-list-header">
              <div className="diff-filter">
                <SearchIcon className="size-3.5" aria-hidden="true" />
                <input
                  aria-label="Filter changed files"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Find a file..."
                />
              </div>
            </div>
            <ul>
              {visible.map((file) => {
                const name = file.name.split("/").pop() || file.name
                const dir = file.name.includes("/")
                  ? file.name.slice(0, file.name.lastIndexOf("/"))
                  : ""
                const isActive = active?.name === file.name
                return (
                  <li
                    key={file.name}
                    className="diff-file-row"
                    data-active={isActive}
                  >
                    <button
                      type="button"
                      className="diff-file-select"
                      aria-current={isActive ? "true" : undefined}
                      title={file.name}
                      onClick={() => setSelected(file.name)}
                    >
                      <img
                        src={getFileIconUrl(name)}
                        alt=""
                        className="size-4 shrink-0"
                      />
                      <span className="diff-file-label">
                        <span>{name}</span>
                        {dir && <small>{dir}</small>}
                      </span>
                      <span className="diff-file-stats tabular-nums">
                        {file.additions > 0 ? (
                          <span className="text-[10px] text-success">
                            +{file.additions}
                          </span>
                        ) : null}
                        {file.deletions > 0 ? (
                          <span className="text-[10px] text-destructive">
                            −{file.deletions}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                )
              })}
              {visible.length === 0 ? (
                <li className="diff-no-matches" role="status">
                  {files.length === 0 ? "No file changes." : "No files match."}
                </li>
              ) : null}
            </ul>
            <div className="diff-file-count">
              {filter.trim() ? `${visible.length} of ` : ""}
              {files.length} file{files.length !== 1 && "s"} changed
            </div>
          </aside>
          <div className="diff-main">
            {active ? (
              <div className="diff-file-header">
                <img
                  src={getFileIconUrl(active.name.split("/").pop() ?? "")}
                  alt=""
                  className="size-4 shrink-0"
                />
                <div className="diff-active-path" title={active.name}>
                  <span>{active.name.split("/").pop()}</span>
                </div>
                <div
                  className="diff-layout-control ml-auto"
                  role="group"
                  aria-label="Diff layout"
                >
                  <button
                    type="button"
                    title="Unified view"
                    aria-label="Unified view"
                    aria-pressed={mode === "unified"}
                    className={cn(
                      "diff-toolbar-button",
                      mode === "unified" && "is-active"
                    )}
                    onClick={() => setViewMode("unified")}
                  >
                    <AlignJustifyIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Split view"
                    aria-label="Split view"
                    aria-pressed={mode === "split"}
                    disabled={diffStyle === "stacked"}
                    className={cn(
                      "diff-toolbar-button",
                      mode === "split" && "is-active"
                    )}
                    onClick={() => setViewMode("split")}
                  >
                    <SplitIcon className="size-3.5" />
                  </button>
                </div>
              </div>
            ) : null}
            <div className="diff-scroll" tabIndex={0} aria-label="Code diff">
              {!active ? (
                <div className="diff-empty">
                  <FileDiffIcon className="size-6" />
                  <h3>No changes to show</h3>
                </div>
              ) : active.isBinary ? (
                <div className="diff-empty">
                  <FileDiffIcon className="size-6" />
                  <h3>Binary file changed</h3>
                  <p>This file has no text diff.</p>
                </div>
              ) : (
                active.hunks.map((hunk, index) => {
                  const key = `${active.name}:${index}`
                  const isCollapsed = collapsed.has(key)
                  return (
                    <div key={key} className="diff-hunk">
                      <div className="diff-hunk-header">
                        <button
                          type="button"
                          className="diff-hunk-toggle"
                          aria-expanded={!isCollapsed}
                          aria-label={`${isCollapsed ? "Expand" : "Collapse"} change ${index + 1}`}
                          title={hunk.header}
                          onClick={() =>
                            setCollapsed((previous) => {
                              const next = new Set(previous)
                              if (next.has(key)) next.delete(key)
                              else next.add(key)
                              return next
                            })
                          }
                        >
                          <ChevronDownIcon
                            className={cn(
                              "size-3.5 shrink-0",
                              isCollapsed && "-rotate-90"
                            )}
                          />
                          <span>Change {index + 1}</span>
                          <small>Line {hunk.newStart || hunk.oldStart}</small>
                        </button>
                      </div>
                      {!isCollapsed ? (
                        <>
                          {mode === "split" ? (
                            <div className="diff-revision-labels">
                              <span>Base</span>
                              <span>Pull request</span>
                            </div>
                          ) : null}
                          <DiffHunkLines
                            hunk={hunk}
                            mode={mode}
                            wrap={diffWordWrap}
                            syntax={syntax}
                          />
                        </>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
