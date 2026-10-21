import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import {
  CheckIcon,
  CloudOffIcon,
  FolderIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  MonitorIcon,
  PlusIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { usePrompt } from "@/components/dialogs/prompt-provider"
import { useChatStore } from "@/lib/chat-store"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  createThreadWorktree,
  listProjects,
  removeThreadWorktree,
} from "@/services/backend/coreApi"
import {
  gitCheckoutBranch,
  gitListBranches,
  gitStatus,
  isGitRepo,
} from "@/services/backend/gitApi"
import { pickFolder } from "@/services/backend/runtime"
import {
  MENU_BUTTON,
  MENU_HEADING,
  MENU_INPUT,
  MENU_ITEM,
  MENU_ITEM_HINT,
  MENU_LIST,
  MENU_NOTE,
  MENU_PANEL,
  MENU_SEPARATOR,
  MENU_WIDTH_MD,
  MENU_WIDTH_SM,
} from "@/components/ui/menu-chrome"

/**
 * The strip above the composer: which project, where it runs, which branch.
 *
 * Each chip opens a picker rather than just reporting state — these are the
 * three things you change most often before sending, and they used to require
 * leaving the composer entirely.
 */

/** Backend failures arrive as Error or as a bare string; both need showing. */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "")
  return message.trim() || "The backend gave no reason."
}

/**
 * Shared trigger look, so the three chips stay one row of equal weight.
 *
 * It MUST spread the rest of its props onto the button. `PopoverTrigger
 * asChild` clones this element to attach the open handler, the ref and the
 * aria wiring — a component that only reads its own named props silently
 * drops all of that, and the chip renders perfectly while doing nothing at
 * all when clicked.
 */
function ChipButton({
  icon: Icon,
  label,
  className,
  ...props
}: ComponentProps<"button"> & {
  icon: typeof FolderIcon
  label: string
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/90",
        className
      )}
      {...props}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{label}</span>
    </button>
  )
}

function ProjectChip({
  activatePane,
  projectName,
  projectPath,
}: {
  activatePane?: () => void
  projectName: string
  projectPath: string | null
}) {
  const [open, setOpen] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [known, setKnown] = useState<Array<{ name: string; path: string }>>([])
  const threads = useChatStore((s) => s.threads)
  const setActiveThread = useChatStore((s) => s.setActiveThread)

  /**
   * The authoritative list lives in the backend's project projection — every
   * folder that was ever opened. Deriving it from the loaded threads instead
   * (the first version of this menu) silently hid any project whose threads
   * were not in the current page.
   */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const rows = (await listProjects()) as Array<{
          name?: unknown
          path?: unknown
        }>
        if (cancelled) return
        setKnown(
          rows
            .map((row) => ({
              name: typeof row?.name === "string" ? row.name : "",
              path: typeof row?.path === "string" ? row.path.trim() : "",
            }))
            .filter((row) => row.path && row.name)
        )
      } catch {
        /* backend down — the thread-derived fallback below still applies */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  /**
   * One entry per project. Threads contribute the "take me back to what I was
   * doing there" target and cover anything the projection has not caught up
   * with yet; a project with no thread simply opens a fresh one.
   */
  const projects = useMemo(() => {
    const byPath = new Map<
      string,
      { path: string; name: string; threadId?: string; updatedAt: string }
    >()
    for (const project of known) {
      byPath.set(project.path, { ...project, updatedAt: "" })
    }
    for (const thread of threads) {
      const path = thread.projectPath?.trim()
      if (!path || !thread.projectName) continue
      const existing = byPath.get(path)
      if (!existing?.threadId || thread.updatedAt > existing.updatedAt) {
        byPath.set(path, {
          path,
          name: thread.projectName,
          threadId: thread.id,
          updatedAt: thread.updatedAt,
        })
      }
    }
    return [...byPath.values()].sort((a, b) => {
      // Most recently worked in first; projects with no thread trail behind
      // in name order rather than jumping to the top on an empty timestamp.
      if (a.updatedAt && b.updatedAt)
        return b.updatedAt.localeCompare(a.updatedAt)
      if (a.updatedAt) return -1
      if (b.updatedAt) return 1
      return a.name.localeCompare(b.name)
    })
  }, [known, threads])

  const openThread = useCallback(
    (threadId: string, label?: string) => {
      activatePane?.()
      setActiveThread(threadId)
      window.dispatchEvent(
        new CustomEvent("betterc0de:open-thread", {
          detail: { threadId, label },
        })
      )
      setOpen(false)
    },
    [setActiveThread, activatePane]
  )

  const startThread = useCallback(
    (name: string, path: string) => {
      activatePane?.()
      const id = useChatStore.getState().createThread("New Task", name, path)
      openThread(id, "New Task")
    },
    [openThread, activatePane]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ChipButton
          icon={FolderIcon}
          label={projectName}
          title={projectPath ?? projectName}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(MENU_WIDTH_MD, MENU_PANEL)}>
        <Command>
          <CommandInput className={MENU_INPUT} placeholder="Search projects" />
          <CommandList className={MENU_LIST}>
            <CommandEmpty className="px-2 py-2 text-[11px] text-muted-foreground">
              No projects yet.
            </CommandEmpty>
            <CommandGroup>
              {projects.map((project) => (
                <CommandItem
                  className={MENU_ITEM}
                  key={project.path}
                  value={`${project.name} ${project.path}`}
                  title={project.path}
                  onSelect={() =>
                    project.threadId
                      ? openThread(project.threadId, project.name)
                      : // Known folder with nothing in it yet — open a fresh
                        // task there rather than doing nothing.
                        startThread(project.name, project.path)
                  }
                >
                  <FolderIcon className="size-3.5" strokeWidth={1.75} />
                  <span className="flex-1 truncate">{project.name}</span>
                  {project.path === projectPath && (
                    <CheckIcon className="size-3.5 text-primary" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator className={MENU_SEPARATOR} />
            <CommandGroup>
              <CommandItem
                className={MENU_ITEM}
                value="new project open folder"
                onSelect={() => {
                  void (async () => {
                    const folder = await pickFolder()
                    if (!folder || !mounted.current) return
                    const name =
                      folder
                        .replace(/[/\\]+$/, "")
                        .split(/[/\\]/)
                        .pop() || folder
                    startThread(name, folder)
                  })()
                }}
              >
                <PlusIcon className="size-3.5" strokeWidth={1.75} />
                <span className="flex-1">New project…</span>
              </CommandItem>
              <CommandItem
                className={MENU_ITEM}
                value="start task without project scratch"
                onSelect={() => {
                  // No folder: the backend gives the thread a scratch
                  // workspace so the agent still has a real cwd.
                  const id = useChatStore
                    .getState()
                    .createThread("New Task", "", "")
                  openThread(id, "New Task")
                }}
              >
                <XIcon className="size-3.5" strokeWidth={1.75} />
                <span className="flex-1">Without a project</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function EnvironmentChip({
  threadId,
  isWorktree,
  repoPath,
  branch,
}: {
  threadId: string
  isWorktree: boolean
  repoPath: string | null
  branch: string | null
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()

  const label = isWorktree ? "Worktree" : "Local"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ChipButton icon={MonitorIcon} label={label} title="Where this runs" />
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(MENU_WIDTH_SM, MENU_PANEL)}>
        <div className={MENU_HEADING}>Run in</div>
        <button
          type="button"
          disabled={busy}
          className={cn(MENU_BUTTON, "items-start")}
          onClick={() => {
            if (!isWorktree) return setOpen(false)
            void (async () => {
              const ok = await confirm({
                title: "Move back to the repository?",
                description:
                  "The worktree folder is removed. Its branch is kept, so committed work stays.",
                confirmLabel: "Remove worktree",
                destructive: true,
              })
              if (!ok) return
              setBusy(true)
              try {
                await removeThreadWorktree(threadId)
                setOpen(false)
              } catch (err) {
                toast.error("Could not remove the worktree", {
                  description: errorText(err),
                })
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          <MonitorIcon className="mt-px size-3.5" strokeWidth={1.75} />
          <span className="min-w-0 flex-1">
            <span className="block">Local</span>
            <span className={MENU_ITEM_HINT}>In the project folder</span>
          </span>
          {!isWorktree && <CheckIcon className="mt-px size-3.5 text-primary" />}
        </button>
        <button
          type="button"
          disabled={busy || !repoPath}
          title={repoPath ? undefined : "Needs a project folder"}
          className={cn(MENU_BUTTON, "items-start")}
          onClick={() => {
            if (!repoPath) return
            void (async () => {
              setBusy(true)
              try {
                await createThreadWorktree(threadId, {
                  baseRepoPath: repoPath,
                  ...(branch ? { baseBranch: branch } : {}),
                })
                setOpen(false)
              } catch (err) {
                toast.error("Could not create the worktree", {
                  description: errorText(err),
                })
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          <GitBranchPlusIcon className="mt-px size-3.5" strokeWidth={1.75} />
          <span className="min-w-0 flex-1">
            <span className="block">New worktree</span>
            <span className={MENU_ITEM_HINT}>Own copy on a new branch</span>
          </span>
          {isWorktree && <CheckIcon className="mt-px size-3.5 text-primary" />}
        </button>
        {/* Named rather than hidden: BetterC0de runs on the user's own
            machine by design, so "no cloud" is a property worth stating
            instead of an empty row where a cloud option would sit. */}
        <p className={MENU_NOTE}>
          <CloudOffIcon strokeWidth={1.75} />
          <span>Runs on this machine only</span>
        </p>
      </PopoverContent>
    </Popover>
  )
}

function BranchChip({
  branch,
  repoPath,
  projectName,
  uncommitted,
  onChanged,
}: {
  branch: string
  repoPath: string
  projectName: string
  uncommitted: number
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  // What git says is checked out, which outranks the label we were handed:
  // that one can be a moment stale right after a checkout.
  const [current, setCurrent] = useState(branch)
  const [busy, setBusy] = useState(false)
  const prompt = usePrompt()

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const result = await gitListBranches(repoPath)
        if (cancelled) return
        setBranches(result.branches ?? [])
        if (result.current) setCurrent(result.current)
      } catch {
        /* not a repo, or the backend is down — the list just stays empty */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, repoPath])

  const checkout = useCallback(
    (name: string, create: boolean) => {
      void (async () => {
        setBusy(true)
        try {
          await gitCheckoutBranch(repoPath, name, create)
          setCurrent(name)
          setOpen(false)
          // Tell the strip to re-read git: without this the chip kept showing
          // the branch you switched away from.
          onChanged()
        } catch (err) {
          // Checkout fails routinely — uncommitted changes block it. Silence
          // made it look like the click was ignored.
          toast.error(
            create ? "Could not create branch" : "Could not switch branch",
            { description: errorText(err) }
          )
        } finally {
          setBusy(false)
        }
      })()
    },
    [repoPath, onChanged]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ChipButton icon={GitBranchIcon} label={current} title="Branch" />
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(MENU_WIDTH_MD, MENU_PANEL)}>
        <Command>
          <CommandInput
            className={MENU_INPUT}
            placeholder={`Search branches in ${projectName}`}
          />
          <CommandList className={MENU_LIST}>
            <CommandEmpty className="px-2 py-2 text-[11px] text-muted-foreground">
              No branches found.
            </CommandEmpty>
            <CommandGroup heading="Branches">
              {branches.map((name) => (
                <CommandItem
                  className={cn(MENU_ITEM, "items-start")}
                  key={name}
                  value={name}
                  disabled={busy}
                  onSelect={() => checkout(name, false)}
                >
                  <GitBranchIcon
                    className="mt-px size-3.5"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{name}</span>
                    {/* Only for the checked-out branch: it is the one whose
                        dirty state git can report without a checkout, and the
                        one whose answer changes whether a switch will even
                        succeed. */}
                    {name === current && uncommitted > 0 && (
                      <span className={MENU_ITEM_HINT}>
                        Uncommitted: {uncommitted}{" "}
                        {uncommitted === 1 ? "file" : "files"}
                      </span>
                    )}
                  </span>
                  {name === current && (
                    <CheckIcon className="mt-px size-3.5 text-primary" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator className={MENU_SEPARATOR} />
            <CommandGroup>
              <CommandItem
                className={MENU_ITEM}
                value="create and checkout new branch"
                disabled={busy}
                onSelect={() => {
                  void (async () => {
                    const name = await prompt({
                      title: "New branch",
                      description: `Created from ${branch} and checked out.`,
                      placeholder: "feature/my-change",
                      confirmLabel: "Create",
                    })
                    if (name?.trim()) checkout(name.trim(), true)
                  })()
                }}
              >
                <PlusIcon className="size-3.5" strokeWidth={1.75} />
                <span className="flex-1">New branch…</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function ComposerContextChips({
  threadId,
  activatePane,
}: {
  threadId: string | null
  activatePane?: () => void
}) {
  const thread = useChatStore((s) => s.threads.find((t) => t.id === threadId))
  const runtimePath = thread ? resolveThreadRuntimePath(thread) : null
  const threadBranch = thread?.branch ?? null
  const [probed, setProbed] = useState<{
    path?: string | null
    branch: string | null
    uncommitted: number
  }>({ branch: null, uncommitted: 0 })
  const [reloadKey, setReloadKey] = useState(0)

  /**
   * Always probe, even when the thread carries a branch: for a worktree that
   * field records the branch it was created on, and a checkout inside it
   * leaves the field behind. Git is the only source that cannot be stale.
   */
  useEffect(() => {
    if (!runtimePath) return
    let cancelled = false
    void (async () => {
      try {
        if (!(await isGitRepo(runtimePath))) return
        const status = (await gitStatus(runtimePath)) as {
          branch?: string | null
          staged?: string[]
          modified?: string[]
          untracked?: string[]
        }
        if (cancelled) return
        setProbed({
          path: runtimePath,
          branch:
            typeof status?.branch === "string" && status.branch
              ? status.branch
              : null,
          uncommitted:
            (status?.staged?.length ?? 0) +
            (status?.modified?.length ?? 0) +
            (status?.untracked?.length ?? 0),
        })
      } catch {
        /* non-repo / backend unavailable — just omit the branch chip */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runtimePath, reloadKey])

  const refresh = useCallback(() => setReloadKey((key) => key + 1), [])

  if (!thread?.projectName) return null
  // Probe first: `thread.branch` only seeds the label before git answers.
  const branch =
    (probed.path === runtimePath ? probed.branch : null) ?? threadBranch

  return (
    // Sits inside the composer's outer card (see chat-composer.tsx), so the
    // width and centring come from there. The inset puts the folder icon just
    // right of the "+" button in the recessed input below it.
    <div className="flex w-full items-center gap-4 px-4 pt-1.5 pb-2.5 text-[11.5px] text-muted-foreground/70">
      <ProjectChip
        activatePane={activatePane}
        projectName={thread.projectName}
        projectPath={thread.projectPath?.trim() || null}
      />
      <EnvironmentChip
        threadId={thread.id}
        isWorktree={Boolean(thread.worktreePath)}
        repoPath={thread.projectPath?.trim() || null}
        branch={branch}
      />
      {branch && runtimePath && (
        <BranchChip
          branch={branch}
          repoPath={runtimePath}
          projectName={thread.projectName}
          uncommitted={probed.path === runtimePath ? probed.uncommitted : 0}
          onChanged={refresh}
        />
      )}
    </div>
  )
}
