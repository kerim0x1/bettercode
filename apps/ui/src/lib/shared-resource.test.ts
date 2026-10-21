import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createSharedResource,
  createSharedResourceFamily,
  jsonEqual,
} from "./shared-resource"

const flush = () => vi.advanceTimersByTimeAsync(0)

describe("shared resource poller", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("starts one poller for many subscribers and stops after the last leaves", async () => {
    let calls = 0
    const load = vi.fn(async () => ++calls)
    const resource = createSharedResource({
      initial: 0,
      load,
      intervalMs: 1000,
    })

    const first = resource.subscribe(() => {})
    const second = resource.subscribe(() => {})
    const third = resource.subscribe(() => {})
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(resource.getSnapshot()).toBe(1)

    await vi.advanceTimersByTimeAsync(3000)
    expect(load).toHaveBeenCalledTimes(4)

    first()
    second()
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(5)

    third()
    expect(resource.isActive()).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(5)
  })

  it("counts the same callback subscribed twice as two references", async () => {
    const load = vi.fn(async () => 1)
    const resource = createSharedResource({
      initial: 0,
      load,
      intervalMs: 1000,
    })
    const listener = () => {}
    const a = resource.subscribe(listener)
    const b = resource.subscribe(listener)
    a()
    expect(resource.isActive()).toBe(true)
    b()
    expect(resource.isActive()).toBe(false)
  })

  it("joins a request in flight and lets a forced refresh supersede it", async () => {
    const older = Promise.withResolvers<string>()
    const newer = Promise.withResolvers<string>()
    const signals: AbortSignal[] = []
    const load = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockImplementationOnce((signal) => {
        signals.push(signal)
        return older.promise
      })
      .mockImplementationOnce((signal) => {
        signals.push(signal)
        return newer.promise
      })
    const resource = createSharedResource({ initial: "none", load })

    const joined = [resource.refresh(), resource.refresh()]
    expect(load).toHaveBeenCalledTimes(1)
    const forced = resource.refresh({ force: true })
    expect(load).toHaveBeenCalledTimes(2)
    expect(signals[0]?.aborted).toBe(true)

    newer.resolve("new")
    await forced
    older.resolve("old")
    await Promise.all(joined)
    expect(resource.getSnapshot()).toBe("new")
  })

  it("does not refetch fresh data for a remount, but does once it is stale", async () => {
    const load = vi.fn(async () => "value")
    const resource = createSharedResource({
      initial: "",
      load,
      staleMs: 5000,
    })
    resource.subscribe(() => {})()
    await flush()
    resource.subscribe(() => {})()
    await flush()
    expect(load).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)
    resource.subscribe(() => {})()
    await flush()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("keeps the old reference and skips notifications for unchanged data", async () => {
    const load = vi.fn(async () => ({ models: ["a", "b"] }))
    const resource = createSharedResource<{ models: string[] } | null>({
      initial: null,
      load,
      isEqual: jsonEqual,
    })
    const listener = vi.fn()
    resource.subscribe(listener)
    await flush()
    const first = resource.getSnapshot()
    expect(listener).toHaveBeenCalledTimes(1)

    await resource.refresh({ force: true })
    expect(resource.getSnapshot()).toBe(first)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("keeps the last-known snapshot on failure unless onError maps it", async () => {
    const kept = createSharedResource({
      initial: "none",
      load: vi
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce("good")
        .mockRejectedValueOnce(new Error("restarting")),
    })
    await kept.refresh()
    await kept.refresh()
    expect(kept.getSnapshot()).toBe("good")

    const cleared = createSharedResource<string | null>({
      initial: null,
      load: vi
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce("policy")
        .mockRejectedValueOnce(new Error("missing")),
      onError: () => null,
    })
    await cleared.refresh()
    await cleared.refresh()
    expect(cleared.getSnapshot()).toBeNull()
  })

  it("pauses polling while the window is hidden and catches up when shown", async () => {
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "hidden" as DocumentVisibilityState,
    })
    vi.stubGlobal("document", doc)
    const load = vi.fn(async () => 1)
    const resource = createSharedResource({
      initial: 0,
      load,
      intervalMs: 1000,
    })

    const unsubscribe = resource.subscribe(() => {})
    await flush()
    // Mounting still loads once, like the per-hook fetch on mount did.
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(load).toHaveBeenCalledTimes(1)

    doc.visibilityState = "visible"
    doc.dispatchEvent(new Event("visibilitychange"))
    await flush()
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(3)

    unsubscribe()
    doc.dispatchEvent(new Event("visibilitychange"))
    await vi.advanceTimersByTimeAsync(5000)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it("invalidates: refetches now when mounted, drops pending data when idle", async () => {
    const pending = Promise.withResolvers<string>()
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce("fresh")
      .mockResolvedValueOnce("after-change")
    const resource = createSharedResource({ initial: "none", load })

    const idleRequest = resource.refresh()
    resource.invalidate()
    pending.resolve("stale")
    await idleRequest
    expect(resource.getSnapshot()).toBe("none")

    resource.subscribe(() => {})
    await flush()
    expect(resource.getSnapshot()).toBe("fresh")

    resource.invalidate()
    await flush()
    expect(load).toHaveBeenCalledTimes(3)
    expect(resource.getSnapshot()).toBe("after-change")
  })
})

describe("shared resource family", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("shares one resource per key and keeps keys apart", async () => {
    const load = vi.fn(async (key: string) => `catalog:${key}`)
    const family = createSharedResourceFamily<string | null>({
      initial: null,
      create: (key) => ({ load: () => load(key) }),
    })

    expect(family.getSnapshot("/a")).toBeNull()
    expect(family.entries()).toHaveLength(0)

    family.subscribe("/a", () => {})
    family.subscribe("/a", () => {})
    family.subscribe("/b", () => {})
    await flush()
    expect(load.mock.calls.map(([key]) => key)).toEqual(["/a", "/b"])
    expect(family.getSnapshot("/a")).toBe("catalog:/a")
    expect(family.getSnapshot("/b")).toBe("catalog:/b")
    expect(family.get("/a")).toBe(family.get("/a"))
  })

  it("retains only the most recently used idle keys", async () => {
    const family = createSharedResourceFamily<string | null>({
      initial: null,
      create: (key) => ({ load: async () => key }),
      maxIdle: 2,
    })
    for (const key of ["/a", "/b", "/c"]) {
      const unsubscribe = family.subscribe(key, () => {})
      await flush()
      unsubscribe()
    }
    expect(family.entries().map(([key]) => key)).toEqual(["/b", "/c"])
    expect(family.getSnapshot("/a")).toBeNull()
    expect(family.getSnapshot("/c")).toBe("/c")
  })
})

describe("jsonEqual", () => {
  it("compares JSON payloads and maps structurally", () => {
    expect(jsonEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true)
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(jsonEqual(new Map([["x", 1]]), new Map([["x", 1]]))).toBe(true)
    expect(jsonEqual(new Map([["x", 1]]), new Map([["x", 2]]))).toBe(false)
    expect(jsonEqual(null, [])).toBe(false)
  })
})
