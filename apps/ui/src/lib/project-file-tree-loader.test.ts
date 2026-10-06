import { describe, expect, it, vi } from "vitest"
import { ProjectFileTreeLoader } from "./project-file-tree-loader"
import type { ListEntry, ListResult } from "@/services/backend/filesystem"

function entry(path: string, isDir = false): ListEntry {
  return {
    path,
    name: path.split("/").at(-1)!,
    isDir,
    isSymlink: false,
    size: null,
    mtime: null,
  }
}
function listing(entries: ListEntry[], nextOffset?: number): ListResult {
  return {
    path: "/repo",
    parent: "/",
    entries,
    truncated: nextOffset !== undefined,
    nextOffset,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("ProjectFileTreeLoader", () => {
  it("loads only the root initially, and reaches more than 5,000 entries across folders", async () => {
    const read = vi.fn(async (path: string) =>
      path === "/repo"
        ? listing([entry("/repo/a", true), entry("/repo/z", true)])
        : listing(
            Array.from({ length: 3000 }, (_, i) =>
              entry(`${path}/file-${i}.ts`)
            )
          )
    )
    const loader = new ProjectFileTreeLoader("/repo", read)
    await loader.load("")
    expect(read.mock.calls.map(([path]) => path)).toEqual(["/repo"])
    await loader.load("a")
    await loader.load("z")
    expect(loader.getSnapshot().totalCount).toBe(6002)
    expect(loader.getSnapshot().entries[1].children).toHaveLength(3000)
    expect(loader.getSnapshot().moreDirectoryPaths.size).toBe(0)
  })

  it("retains nested children during refresh and includes newly created files", async () => {
    let changed = false
    const read = vi.fn(async (path: string) => {
      if (path === "/repo") return listing([entry("/repo/src", true)])
      if (path === "/repo/src") return listing([entry("/repo/src/deep", true)])
      return listing([entry(`/repo/src/deep/${changed ? "new" : "old"}.ts`)])
    })
    const loader = new ProjectFileTreeLoader("/repo", read)
    await loader.load("")
    await loader.load("src")
    await loader.load("src/deep")
    changed = true
    await loader.refresh(new Set(["src", "src/deep"]))
    expect(
      loader.getSnapshot().entries[0].children?.[0].children?.[0].name
    ).toBe("new.ts")
  })

  it("loads continuation pages, deduplicates concurrent requests, and retains pages on refresh", async () => {
    const read = vi.fn(async (_path: string, options?: { offset?: number }) =>
      options?.offset
        ? listing([entry("/repo/z.ts")])
        : listing([entry("/repo/a.ts")], 5000)
    )
    const loader = new ProjectFileTreeLoader("/repo", read)
    await Promise.all([loader.load(""), loader.load("")])
    expect(read).toHaveBeenCalledTimes(1)
    expect(loader.getSnapshot().moreDirectoryPaths.has("")).toBe(true)
    await Promise.all([
      loader.load("", { more: true }),
      loader.load("", { more: true }),
    ])
    expect(loader.getSnapshot().entries.map((row) => row.name)).toEqual([
      "a.ts",
      "z.ts",
    ])
    expect(loader.getSnapshot().moreDirectoryPaths.size).toBe(0)
    await loader.refresh(new Set())
    expect(read.mock.calls.map(([, options]) => options?.offset)).toEqual([
      0, 5000, 0, 5000,
    ])
    expect(loader.getSnapshot().totalCount).toBe(2)
  })

  it("reveals a file through unloaded ancestors on later pages", async () => {
    const read = vi.fn(async (path: string, options?: { offset?: number }) => {
      if (path === "/repo")
        return options?.offset
          ? listing([entry("/repo/z", true)])
          : listing([entry("/repo/a.ts")], 5000)
      if (path === "/repo/z") return listing([entry("/repo/z/deep", true)])
      return listing([entry("/repo/z/deep/file.ts")])
    })
    const loader = new ProjectFileTreeLoader("/repo", read)
    await loader.reveal("z/deep/file.ts")
    expect(
      loader.getSnapshot().entries[0].children?.[0].children?.[0].path
    ).toBe("z/deep/file.ts")
  })

  it("ignores a slow response replaced by a newer refresh", async () => {
    const slow = deferred<ListResult>()
    const read = vi
      .fn()
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValue(listing([entry("/repo/new.ts")]))
    const loader = new ProjectFileTreeLoader("/repo", read)
    const oldLoad = loader.load("")
    await loader.refresh(new Set())
    slow.resolve(listing([entry("/repo/stale.ts")]))
    await oldLoad
    expect(loader.getSnapshot().entries.map((row) => row.name)).toEqual([
      "new.ts",
    ])
  })

  it("keeps cached files after a failed refresh and retries the folder", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(listing([entry("/repo/a.ts")]))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(listing([entry("/repo/b.ts")]))
    const loader = new ProjectFileTreeLoader("/repo", read)
    await loader.load("")
    await loader.refresh(new Set())
    expect(loader.getSnapshot().entries[0].name).toBe("a.ts")
    expect(loader.getSnapshot().loadError).toBe(true)
    await loader.load("")
    expect(loader.getSnapshot().entries[0].name).toBe("b.ts")
    expect(loader.getSnapshot().loadError).toBe(false)
  })

  it("does not treat an incomplete page without a cursor as a complete folder", async () => {
    const read = vi.fn(async () => ({
      ...listing([entry("/repo/a.ts")]),
      truncated: true,
    }))
    const loader = new ProjectFileTreeLoader("/repo", read)
    await loader.load("")
    expect(loader.getSnapshot().loadError).toBe(true)
  })

  it("stops an in-flight reveal when its project is left", async () => {
    const slow = deferred<ListResult>()
    const read = vi.fn(() => slow.promise)
    const loader = new ProjectFileTreeLoader("/repo", read)
    const revealing = loader.reveal("src/file.ts")
    loader.cancel()
    slow.resolve(listing([entry("/repo/src", true)]))
    await revealing
    expect(read).toHaveBeenCalledTimes(1)
    expect(loader.getSnapshot().entries).toEqual([])
  })
})
