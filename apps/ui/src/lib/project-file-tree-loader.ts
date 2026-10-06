import { listDirectoryFs } from "@/services/backend/filesystem"
import {
  resolveWorkspaceFilePath,
  editorPathAncestors,
} from "@/lib/editor-path"
import {
  projectDirectoryEntries,
  type ProjectTreeEntry,
} from "@/lib/project-file-tree-data"

interface Directory {
  entries: ProjectTreeEntry[]
  nextOffset?: number
  pages: number
}

interface TreeSnapshot {
  entries: ProjectTreeEntry[]
  loaded: boolean
  loadError: boolean
  totalCount: number
  loadingDirectoryPaths: Set<string>
  failedDirectoryPaths: Set<string>
  moreDirectoryPaths: Set<string>
}

/** A project tree reads only its root and opened folders, never a capped search. */
export class ProjectFileTreeLoader {
  private directories = new Map<string, Directory>()
  private pending = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >()
  private failed = new Set<string>()
  private listeners = new Set<() => void>()
  private refreshVersion = 0
  private cancelVersion = 0
  private snapshot: TreeSnapshot = {
    entries: [],
    loaded: false,
    loadError: false,
    totalCount: 0,
    loadingDirectoryPaths: new Set(),
    failedDirectoryPaths: new Set(),
    moreDirectoryPaths: new Set(),
  }

  private readonly root: string
  private readonly list: typeof listDirectoryFs

  constructor(root: string, list = listDirectoryFs) {
    this.root = root
    this.list = list
  }

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish() {
    let totalCount = 0
    const build = (directory: string): ProjectTreeEntry[] =>
      (this.directories.get(directory)?.entries ?? []).map((entry) => {
        totalCount += 1
        return entry.type === "folder"
          ? { ...entry, children: build(entry.path) }
          : entry
      })
    const entries = build("")
    this.snapshot = {
      entries,
      totalCount,
      loaded: this.directories.has("") || this.failed.has(""),
      loadError: this.failed.has(""),
      loadingDirectoryPaths: new Set(this.pending.keys()),
      failedDirectoryPaths: new Set(this.failed),
      moreDirectoryPaths: new Set(
        [...this.directories]
          .filter(([, data]) => data.nextOffset !== undefined)
          .map(([path]) => path)
      ),
    }
    for (const listener of this.listeners) listener()
  }

  /** Cancel in-flight reads on unmount/project change, including late responses. */
  cancel = () => {
    this.refreshVersion += 1
    this.cancelVersion += 1
    for (const job of this.pending.values()) job.controller.abort()
    this.pending.clear()
    this.publish()
  }

  load = (
    directory: string,
    options: { more?: boolean; refresh?: boolean } = {}
  ): Promise<void> => {
    const previous = this.directories.get(directory)
    const running = this.pending.get(directory)
    if (running && !options.refresh) return running.promise
    const retrying = this.failed.has(directory)
    if (previous && !options.more && !options.refresh && !retrying)
      return Promise.resolve()
    if (options.more && previous?.nextOffset === undefined)
      return Promise.resolve()
    running?.controller.abort()
    const controller = new AbortController()
    const job = { controller, promise: Promise.resolve() }
    this.pending.set(directory, job)
    this.failed.delete(directory)
    this.publish()
    job.promise = (async () => {
      try {
        let offset = options.more ? previous!.nextOffset! : 0
        let entries = options.more ? [...previous!.entries] : []
        let nextOffset: number | undefined
        const pagesToRead =
          options.refresh || (retrying && !options.more)
            ? (previous?.pages ?? 1)
            : 1
        let pages = options.more ? previous!.pages : 0
        for (let page = 0; page < pagesToRead; page += 1) {
          const result = await this.list(
            resolveWorkspaceFilePath(this.root, directory),
            {
              showHidden: true,
              offset,
              signal: controller.signal,
            }
          )
          if (this.pending.get(directory) !== job) return
          nextOffset = result.nextOffset
          if (
            result.truncated &&
            (nextOffset === undefined || nextOffset <= offset)
          ) {
            throw new Error("Folder listing did not provide a continuation")
          }
          entries.push(
            ...projectDirectoryEntries(this.root, result.entries).filter(
              (entry) => entry.name !== ".git" && entry.name !== "node_modules"
            )
          )
          pages += 1
          if (nextOffset === undefined) break
          offset = nextOffset
        }
        // A folder can change between pages. Deduplicate paths and keep the
        // usual folders-first order across the combined listing.
        entries = [
          ...new Map(entries.map((entry) => [entry.path, entry])).values(),
        ]
        entries.sort((a, b) =>
          a.type !== b.type
            ? a.type === "folder"
              ? -1
              : 1
            : a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        )
        this.directories.set(directory, { entries, nextOffset, pages })
      } catch {
        if (this.pending.get(directory) === job) this.failed.add(directory)
      } finally {
        if (this.pending.get(directory) === job) {
          this.pending.delete(directory)
          this.publish()
        }
      }
    })()
    return job.promise
  }

  /** Refresh visible folders while retaining their loaded pages and descendants. */
  refresh = async (expanded: ReadonlySet<string>) => {
    const version = ++this.refreshVersion
    const paths = [...expanded]
      .filter(Boolean)
      .sort((a, b) => a.split("/").length - b.split("/").length)
    const keep = new Set(["", ...paths, ...paths.flatMap(editorPathAncestors)])
    for (const directory of this.directories.keys()) {
      if (!keep.has(directory)) this.directories.delete(directory)
    }
    await this.load("", { refresh: true })
    for (
      let index = 0;
      index < paths.length && version === this.refreshVersion;
      index += 4
    ) {
      await Promise.all(
        paths
          .slice(index, index + 4)
          .map((directory) => this.load(directory, { refresh: true }))
      )
    }
  }

  /** Reveal also walks unloaded ancestors and later pages of a large folder. */
  reveal = async (relativePath: string) => {
    const version = this.cancelVersion
    const parts = relativePath.split("/").filter(Boolean)
    let parent = ""
    for (const part of parts) {
      await this.load(parent)
      if (version !== this.cancelVersion) return
      const child = parent ? `${parent}/${part}` : part
      let listing = this.directories.get(parent)
      while (
        listing &&
        !listing.entries.some((entry) => entry.path === child) &&
        listing.nextOffset !== undefined &&
        !this.failed.has(parent)
      ) {
        await this.load(parent, { more: true })
        if (version !== this.cancelVersion) return
        listing = this.directories.get(parent)
      }
      if (!listing?.entries.some((entry) => entry.path === child)) return
      parent = child
    }
  }
}
