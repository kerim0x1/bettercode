/**
 * Codex-style overview card — default view of the right workspace panel.
 *
 *   Environment
 *     Changes            +925 -675   → Review tab
 *     Local / Worktree            ⌄
 *     <branch>                    ⌄  → Git tab
 *     Commit or push                 → Git tab
 *   Sources
 *     <attachments / touched files>
 *     Show all                       → Review tab
 *
 * Read-only glance surface: every row routes into the tab that owns the
 * real workflow. Git state polls at 8s (visibility-gated) like the other
 * workspace surfaces.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  DiffIcon,
  FileCode2Icon,
  FileIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GlobeIcon,
  LinkIcon,
  MonitorIcon,
  PlusIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/lib/chat-store"
import { gitDiff, gitStatus, isGitRepo } from "@/services/backend"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import type { WorkspaceTab } from "@/lib/preferences-store"

interface RepoGlance {
  branch: string | null
  upstream: string | null
  additions: number
  deletions: number
}

/** Sum +/− lines of a unified diff (ignoring the +++/--- file headers). */
function countDiffTotals(text: string): {
  additions: number
  deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions += 1
    else if (line.startsWith("-")) deletions += 1
  }
  return { additions, deletions }
}

function SectionHeader({
  label,
  onAdd,
  addLabel,
}: {
  label: string
  onAdd?: () => void
  addLabel?: string
}) {
  return (
    <div className="flex h-6 items-center justify-between px-2">
      <span className="text-[11px] text-muted-foreground/60">{label}</span>
      {onAdd && (
        <button
          type="button"
          aria-label={addLabel}
          onClick={onAdd}
          className="cursor-pointer text-muted-foreground/40 transition-colors hover:text-foreground"
        >
          <PlusIcon className="size-3.5" strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

function OverviewRow({
  icon,
  label,
  right,
  onClick,
  labelClassName,
}: {
  icon: React.ReactNode
  label: React.ReactNode
  right?: React.ReactNode
  onClick?: () => void
  labelClassName?: string
}) {
  const content = (
    <>
      {icon}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-left text-[12.5px] text-foreground/90",
          labelClassName
        )}
      >
        {label}
      </span>
      {right}
    </>
  )
  if (!onClick) {
    return (
      <div className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2">
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 transition-colors duration-75 hover:bg-foreground/[0.06]"
    >
      {content}
    </button>
  )
}

const iconClass = "size-4 shrink-0 text-muted-foreground"

export function WorkspaceOverviewCard({
  projectPath,
  threadId,
  isWorktree,
  setWorkspaceTab,
}: {
  projectPath: string
  threadId: string | null
  isWorktree: boolean
  setWorkspaceTab: (tab: WorkspaceTab) => void
}) {
  const [repo, setRepo] = useState<RepoGlance | null>(null)

  const load = useCallback(async () => {
    try {
      if (!(await isGitRepo(projectPath))) {
        setRepo(null)
        return
      }
      const [status, diff] = await Promise.all([
        gitStatus(projectPath) as Promise<{
          branch?: string | null
          upstream?: string | null
        }>,
        gitDiff(projectPath) as Promise<{ diffText?: string }>,
      ])
      const totals = countDiffTotals(diff?.diffText ?? "")
      setRepo({
        branch: status?.branch ?? null,
        upstream: status?.upstream ?? null,
        additions: totals.additions,
        deletions: totals.deletions,
      })
    } catch {
      setRepo(null)
    }
  }, [projectPath])

  useEffect(() => {
    void load()
  }, [load])
  useVisibilityInterval(() => void load(), 8000, { runOnVisible: true })

  // "Sources" — everything the thread has touched or been given: message
  // attachments (images/files/links) plus files the assistant edited
  // (message diffs), newest first, deduped.
  const messages = useChatStore((s) =>
    threadId ? s.threads.find((t) => t.id === threadId)?.messages : undefined
  )
  const sources = useMemo(() => {
    const out: Array<{
      key: string
      kind: "image" | "file" | "link" | "diff"
      label: string
      url?: string
    }> = []
    const seen = new Set<string>()
    for (const message of messages ?? []) {
      for (const attachment of message.attachments ?? []) {
        const key = `att:${attachment.url}`
        if (seen.has(key)) continue
        seen.add(key)
        const label =
          attachment.filename ||
          attachment.url.split(/[/\\]/).pop() ||
          attachment.url
        out.push({
          key,
          kind: attachment.mediaType?.startsWith("image/")
            ? "image"
            : /^https?:/i.test(attachment.url)
              ? "link"
              : "file",
          label,
          url: attachment.url,
        })
      }
      for (const diff of message.diffs ?? []) {
        const key = `diff:${diff.path}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          key,
          kind: "diff",
          label: diff.path.split(/[/\\]/).pop() || diff.path,
        })
      }
    }
    return out.reverse()
  }, [messages])
  const visibleSources = sources.slice(0, 4)

  const hasChanges = !!repo && repo.additions + repo.deletions > 0

  return (
    <div className="p-3">
      {/* Flush with the panel it lives in: same `bg-sidebar` fill as the
          surrounding panel (no lighter card tier) and a hairline
          `sidebar-border`, matching the Plan-tab cards. The old `bg-card/50`
          + drop-shadow read as a lighter card floating inside the panel —
          a card-inside-a-card that broke the flat two-tone theme. */}
      <div className="rounded-xl border border-sidebar-border/70 bg-sidebar p-2 pb-3">
        <SectionHeader
          label="Environment"
          onAdd={() => setWorkspaceTab("files")}
          addLabel="Open files"
        />

        {repo && (
          <OverviewRow
            icon={<DiffIcon className={iconClass} strokeWidth={1.75} />}
            label="Changes"
            onClick={() => setWorkspaceTab("diff")}
            right={
              hasChanges ? (
                <span className="shrink-0 text-[12px] tabular-nums">
                  <span className="text-emerald-400">+{repo.additions}</span>{" "}
                  <span className="text-red-400">-{repo.deletions}</span>
                </span>
              ) : (
                <span className="shrink-0 text-[11px] text-muted-foreground/50">
                  None
                </span>
              )
            }
          />
        )}

        <OverviewRow
          icon={<MonitorIcon className={iconClass} strokeWidth={1.75} />}
          label={isWorktree ? "Worktree" : "Local"}
          right={
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
          }
        />

        <OverviewRow
          icon={<GlobeIcon className={iconClass} strokeWidth={1.75} />}
          label="Browser preview"
          onClick={() => setWorkspaceTab("browser")}
        />

        {repo?.branch && (
          <OverviewRow
            icon={<GitBranchIcon className={iconClass} strokeWidth={1.75} />}
            label={repo.branch}
            onClick={() => setWorkspaceTab("git")}
            right={
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
            }
          />
        )}

        {repo && (
          <OverviewRow
            icon={
              <GitCommitHorizontalIcon
                className={iconClass}
                strokeWidth={1.75}
              />
            }
            label="Commit or push"
            onClick={() => setWorkspaceTab("git")}
          />
        )}

        {repo?.upstream && (
          <OverviewRow
            icon={<GitBranchIcon className={iconClass} strokeWidth={1.75} />}
            label="Compare branch"
            onClick={() => setWorkspaceTab("git")}
            right={
              <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
            }
          />
        )}

        {sources.length > 0 && (
          <>
            <div className="mx-2 my-2 h-px bg-border/40" />
            <SectionHeader
              label="Sources"
              onAdd={() => setWorkspaceTab("files")}
              addLabel="Open files"
            />
            {visibleSources.map((source) => (
              <OverviewRow
                key={source.key}
                icon={
                  source.kind === "image" && source.url ? (
                    <img
                      src={source.url}
                      alt=""
                      className="size-4 shrink-0 rounded-[3px] border border-border/40 object-cover"
                    />
                  ) : source.kind === "link" ? (
                    <LinkIcon className={iconClass} strokeWidth={1.75} />
                  ) : source.kind === "diff" ? (
                    <FileCode2Icon className={iconClass} strokeWidth={1.75} />
                  ) : (
                    <FileIcon className={iconClass} strokeWidth={1.75} />
                  )
                }
                label={source.label}
                onClick={
                  source.kind === "diff"
                    ? () => setWorkspaceTab("diff")
                    : undefined
                }
              />
            ))}
            {sources.length > visibleSources.length && (
              <OverviewRow
                icon={<LinkIcon className={iconClass} strokeWidth={1.75} />}
                label={
                  <span className="text-muted-foreground/60">Show all</span>
                }
                onClick={() => setWorkspaceTab("diff")}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
