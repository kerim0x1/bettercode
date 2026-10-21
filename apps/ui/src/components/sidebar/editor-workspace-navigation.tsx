import { useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  FilesIcon,
  FileDiffIcon,
  FolderOpenIcon,
  GitBranchIcon,
  LayoutGridIcon,
  ListTreeIcon,
  MoreHorizontalIcon,
  SearchCodeIcon,
  SearchIcon,
} from "lucide-react"
import { useChatStore } from "@/lib/chat-store"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import type { EditorSidebarView } from "@/lib/preferences-store"
import { editorWorkspaceKey } from "@/lib/editor-workspace"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const primaryViews = [
  { id: "files", label: "Files", icon: FilesIcon },
  { id: "search", label: "Search", icon: SearchIcon },
  { id: "source-control", label: "Git", icon: GitBranchIcon },
  { id: "diff", label: "Diff", icon: FileDiffIcon },
  { id: "map", label: "Code Map", icon: LayoutGridIcon },
] as const
const secondaryViews = [
  { id: "outline", label: "File outline", icon: ListTreeIcon },
  { id: "references", label: "References", icon: SearchCodeIcon },
] as const
const viewButtonClassName =
  "flex h-7 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap"
const viewIconClassName =
  "hidden size-3.5 shrink-0 @min-[380px]/workspace-navigation:block"

export function EditorWorkspaceNavigation({
  projectPath,
  projectName,
  view,
  onViewChange,
  onOpenFolder,
}: {
  projectPath: string | null
  projectName?: string | null
  view: EditorSidebarView
  onViewChange: (view: EditorSidebarView) => void
  onOpenFolder: () => void
}) {
  const navRef = useRef<HTMLElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [indicator, setIndicator] = useState<{
    left: number
    width: number
  } | null>(null)
  const [visibleViews, setVisibleViews] = useState<readonly string[]>(() =>
    primaryViews.map(({ id }) => id)
  )
  useLayoutEffect(() => {
    const nav = navRef.current
    const measure = measureRef.current
    const more = moreRef.current
    if (!nav || !measure || !more) return

    const fitViews = () => {
      const style = getComputedStyle(nav)
      const gap = parseFloat(style.columnGap) || 0
      let remaining =
        nav.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        more.getBoundingClientRect().width
      const widths = Array.from(
        measure.children,
        (child) => child.getBoundingClientRect().width
      )
      const activeIndex = primaryViews.findIndex(({ id }) => id === view)
      const priority = activeIndex >= 0 ? activeIndex : 0
      const indices = [priority, ...primaryViews.keys()].filter(
        (index, position) => position === 0 || index !== priority
      )
      const fitted = new Set<string>()
      for (const index of indices) {
        const width = widths[index] + gap
        if (index !== priority && width > remaining) continue
        fitted.add(primaryViews[index].id)
        remaining -= width
      }
      const next = primaryViews
        .filter(({ id }) => fitted.has(id))
        .map(({ id }) => id)
      setVisibleViews((previous) =>
        previous.length === next.length &&
        previous.every((id, index) => id === next[index])
          ? previous
          : next
      )
    }

    fitViews()
    if (typeof ResizeObserver === "undefined") return
    // Measure natural label widths too, so font and container-icon changes
    // refit the tabs without tying them to the window width.
    const observer = new ResizeObserver(fitViews)
    observer.observe(nav)
    observer.observe(measure)
    return () => observer.disconnect()
  }, [view])
  const overflowViews = primaryViews.filter(
    ({ id }) => !visibleViews.includes(id)
  )
  // The thumb follows the active tab, or the More button when the active
  // view lives in its menu.
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const place = () => {
      const target = tabRefs.current.get(view) ?? moreRef.current
      setIndicator((previous) =>
        !target
          ? null
          : previous?.left === target.offsetLeft &&
              previous.width === target.offsetWidth
            ? previous
            : { left: target.offsetLeft, width: target.offsetWidth }
      )
    }
    place()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(place)
    observer.observe(nav)
    return () => observer.disconnect()
  }, [view, visibleViews])
  const threads = useChatStore((state) => state.threads)
  const workspaces = useMemo(() => {
    const seen = new Set<string>()
    return threads.flatMap((thread) => {
      const path = resolveThreadRuntimePath(thread)
      if (!path) return []
      const key = editorWorkspaceKey(path)
      if (seen.has(key)) return []
      seen.add(key)
      return [
        {
          path,
          threadId: thread.id,
          name:
            thread.projectName ||
            path.split(/[\\/]/).filter(Boolean).pop() ||
            path,
        },
      ]
    })
  }, [threads])
  const name =
    projectName ||
    projectPath?.split(/[\\/]/).filter(Boolean).pop() ||
    "Open workspace"
  return (
    <div className="@container/workspace-navigation shrink-0 px-2 pt-2 pb-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Workspace: ${name}. Switch workspace`}
            className="flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            <FolderOpenIcon
              className="size-4 shrink-0 text-muted-foreground"
              strokeWidth={1.75}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-sidebar-foreground">
                {name}
              </span>
              <span
                className="block truncate text-[11px] text-muted-foreground"
                title={projectPath ?? undefined}
              >
                {projectPath || "Choose a project to start"}
              </span>
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {workspaces.map((workspace) => (
            <DropdownMenuItem
              key={workspace.path}
              onSelect={() => {
                useChatStore.getState().setActiveThread(workspace.threadId)
                window.dispatchEvent(
                  new CustomEvent("betterc0de:open-thread", {
                    detail: { threadId: workspace.threadId },
                  })
                )
              }}
            >
              <FolderOpenIcon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{workspace.name}</span>
                <span className="block truncate text-[11px] font-normal text-muted-foreground">
                  {workspace.path}
                </span>
              </span>
              {projectPath &&
                editorWorkspaceKey(workspace.path) ===
                  editorWorkspaceKey(projectPath) && (
                  <CheckIcon className="size-3.5 shrink-0" />
                )}
            </DropdownMenuItem>
          ))}
          {workspaces.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={onOpenFolder}>
            <FolderOpenIcon />
            Open folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Drawn like the title bar's mode switch and the canvas toolbar: a
          slightly raised bar and a flat active fill that slides to the
          selected view. */}
      <nav
        ref={navRef}
        aria-label="Editor views"
        className="relative mt-2 flex min-w-0 items-center gap-0.5 rounded-[10px] border border-border/60 bg-card/70 p-[3px]"
      >
        {indicator && (
          <span
            aria-hidden="true"
            data-slot="editor-view-indicator"
            className="pointer-events-none absolute inset-y-[3px] left-0 rounded-md bg-primary/15 transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={{
              width: indicator.width,
              transform: `translateX(${indicator.left}px)`,
            }}
          />
        )}
        <div
          aria-hidden="true"
          className="pointer-events-none invisible absolute inset-0 overflow-hidden"
        >
          <div ref={measureRef} className="flex w-max">
            {primaryViews.map(({ id, label, icon: Icon }) => (
              <span key={id} className={viewButtonClassName}>
                <Icon className={viewIconClassName} strokeWidth={1.75} />
                <span>{label}</span>
              </span>
            ))}
          </div>
        </div>
        {primaryViews
          .filter(({ id }) => visibleViews.includes(id))
          .map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              ref={(node) => {
                if (node) tabRefs.current.set(id, node)
                else tabRefs.current.delete(id)
              }}
              type="button"
              aria-current={view === id ? "page" : undefined}
              title={label}
              onClick={() => onViewChange(id)}
              className={cn(
                viewButtonClassName,
                "relative z-10 transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
                view === id
                  ? "text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              )}
            >
              <Icon className={viewIconClassName} strokeWidth={1.75} />
              <span className="truncate">{label}</span>
            </button>
          ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              ref={moreRef}
              type="button"
              aria-label="More editor views"
              title="More editor views"
              className={cn(
                "relative z-10 flex h-7 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
                visibleViews.includes(view)
                  ? "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  : "text-primary"
              )}
            >
              <MoreHorizontalIcon className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {overflowViews.map(({ id, label, icon: Icon }) => (
              <DropdownMenuItem key={id} onSelect={() => onViewChange(id)}>
                <Icon />
                {label}
              </DropdownMenuItem>
            ))}
            {overflowViews.length > 0 && <DropdownMenuSeparator />}
            {secondaryViews.map(({ id, label, icon: Icon }) => (
              <DropdownMenuItem key={id} onSelect={() => onViewChange(id)}>
                <Icon />
                {label}
                {view === id && <CheckIcon className="ml-auto" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </div>
  )
}
