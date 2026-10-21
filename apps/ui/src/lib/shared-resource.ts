import { useCallback, useSyncExternalStore } from "react"

/**
 * Module-level cache for one backend read that many components display.
 *
 * Provider metadata used to be fetched by every hook instance: each mounted
 * consumer owned its own request and its own 30 s poller, so the app shell,
 * every chat pane and the sidebar pill all fetched the same catalog per
 * interval. A shared resource keeps one snapshot, one poller and at most one
 * request in flight. Polling runs only while at least one subscriber is
 * mounted and the window is visible.
 */
export interface SharedResourceOptions<T> {
  /** Snapshot before the first successful load. Keep it referentially stable. */
  readonly initial: T
  /**
   * Performs one request. The signal aborts when a newer forced refresh
   * supersedes this request; its result is dropped either way.
   */
  readonly load: (signal: AbortSignal) => Promise<T>
  /** Poll period while subscribed and visible. `0` disables polling. */
  readonly intervalMs?: number
  /**
   * A new first subscriber, or the window becoming visible again, refetches
   * only when the last successful load is older than this. Defaults to
   * `intervalMs`.
   */
  readonly staleMs?: number
  /** Skips publishing (and re-rendering) when a poll returns the same data. */
  readonly isEqual?: (previous: T, next: T) => boolean
  /** Snapshot to publish after a failed load. Omit to keep the last-known one. */
  readonly onError?: (error: unknown, previous: T) => T
  /** Called when the last subscriber leaves. */
  readonly onIdle?: () => void
}

export interface SharedResource<T> {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => T
  /**
   * Loads the resource. A plain call joins a request already in flight;
   * `force` starts a new one that supersedes it (for example after a
   * settings mutation the older request may predate).
   */
  readonly refresh: (options?: { force?: boolean }) => Promise<void>
  readonly set: (value: T) => void
  /**
   * Marks the cached snapshot stale. A subscribed resource refetches now,
   * an idle one on its next subscriber.
   */
  readonly invalidate: () => void
  readonly isActive: () => boolean
  /** Drops the snapshot, subscribers, poller and any pending result. */
  readonly reset: () => void
}

type Listener = { readonly notify: () => void }

function currentDocument(): Document | undefined {
  return (globalThis as { document?: Document }).document
}

function isDocumentVisible(): boolean {
  return currentDocument()?.visibilityState !== "hidden"
}

export function createSharedResource<T>(
  options: SharedResourceOptions<T>
): SharedResource<T> {
  const {
    initial,
    load,
    intervalMs = 0,
    staleMs = intervalMs,
    isEqual = Object.is,
    onError,
    onIdle,
  } = options
  let snapshot = initial
  // Entries rather than functions so one callback subscribed twice still
  // counts as two references.
  const listeners = new Set<Listener>()
  let revision = 0
  let inFlight: Promise<void> | null = null
  let controller: AbortController | null = null
  let loadedAt: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let observedDocument: Document | undefined

  const emit = () => {
    for (const listener of [...listeners]) listener.notify()
  }

  const set = (value: T) => {
    if (isEqual(snapshot, value)) return
    snapshot = value
    emit()
  }

  const refresh = ({ force = false }: { force?: boolean } = {}) => {
    if (inFlight && !force) return inFlight
    controller?.abort()
    const ownController = new AbortController()
    controller = ownController
    const request = ++revision
    const run = (async () => {
      try {
        const value = await load(ownController.signal)
        if (request !== revision) return
        loadedAt = Date.now()
        set(value)
      } catch (error) {
        if (request !== revision) return
        if (onError) set(onError(error, snapshot))
      } finally {
        if (request === revision) {
          inFlight = null
          controller = null
        }
      }
    })()
    inFlight = run
    return run
  }

  const isStale = () =>
    loadedAt === null || Date.now() - loadedAt >= Math.max(0, staleMs)

  const refreshIfStale = () => {
    if (!inFlight && isStale()) void refresh()
  }

  const startTimer = () => {
    if (timer !== null || intervalMs <= 0) return
    timer = setInterval(() => void refresh(), intervalMs)
  }

  const stopTimer = () => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  const onVisibilityChange = () => {
    if (listeners.size === 0) return
    if (isDocumentVisible()) {
      refreshIfStale()
      startTimer()
    } else {
      stopTimer()
    }
  }

  const activate = () => {
    observedDocument = currentDocument()
    observedDocument?.addEventListener("visibilitychange", onVisibilityChange)
    if (isDocumentVisible()) startTimer()
    // Mounting always loads missing or stale data, even in a hidden window,
    // like the per-hook fetch on mount did.
    refreshIfStale()
  }

  const deactivate = () => {
    observedDocument?.removeEventListener(
      "visibilitychange",
      onVisibilityChange
    )
    observedDocument = undefined
    stopTimer()
  }

  const subscribe = (notify: () => void) => {
    const listener: Listener = { notify }
    listeners.add(listener)
    if (listeners.size === 1) activate()
    return () => {
      if (!listeners.delete(listener)) return
      if (listeners.size > 0) return
      deactivate()
      onIdle?.()
    }
  }

  const invalidate = () => {
    loadedAt = null
    if (listeners.size > 0) {
      void refresh({ force: true })
      return
    }
    // Nobody shows the data now; a pending answer may predate the change.
    revision += 1
    controller?.abort()
    controller = null
    inFlight = null
  }

  const reset = () => {
    deactivate()
    listeners.clear()
    revision += 1
    controller?.abort()
    controller = null
    inFlight = null
    loadedAt = null
    snapshot = initial
  }

  return {
    subscribe,
    getSnapshot: () => snapshot,
    refresh,
    set,
    invalidate,
    isActive: () => listeners.size > 0,
    reset,
  }
}

export interface SharedResourceFamily<T> {
  readonly subscribe: (key: string, listener: () => void) => () => void
  readonly getSnapshot: (key: string) => T
  readonly refresh: (
    key: string,
    options?: { force?: boolean }
  ) => Promise<void>
  /** The cached resource for `key`, created on first use. */
  readonly get: (key: string) => SharedResource<T>
  readonly entries: () => Array<[string, SharedResource<T>]>
  readonly reset: () => void
}

/**
 * One shared resource per key (for example per workspace path). Idle keys
 * keep their last snapshot so switching back renders immediately; only the
 * most recent `maxIdle` idle keys are retained.
 */
export function createSharedResourceFamily<T>({
  initial,
  create,
  maxIdle = 8,
}: {
  readonly initial: T
  readonly create: (
    key: string
  ) => Omit<SharedResourceOptions<T>, "initial" | "onIdle">
  readonly maxIdle?: number
}): SharedResourceFamily<T> {
  const resources = new Map<string, SharedResource<T>>()

  const pruneIdle = () => {
    const idle = [...resources].filter(([, resource]) => !resource.isActive())
    for (const [key, resource] of idle.slice(
      0,
      Math.max(0, idle.length - maxIdle)
    )) {
      resource.reset()
      resources.delete(key)
    }
  }

  const get = (key: string) => {
    const existing = resources.get(key)
    if (existing) return existing
    const resource = createSharedResource<T>({
      ...create(key),
      initial,
      onIdle: () => {
        // Most recently used keys go last, so pruning drops the oldest.
        if (resources.get(key) === resource) {
          resources.delete(key)
          resources.set(key, resource)
        }
        pruneIdle()
      },
    })
    resources.set(key, resource)
    return resource
  }

  return {
    subscribe: (key, listener) => get(key).subscribe(listener),
    getSnapshot: (key) => resources.get(key)?.getSnapshot() ?? initial,
    refresh: (key, options) => get(key).refresh(options),
    get,
    entries: () => [...resources],
    reset: () => {
      for (const resource of resources.values()) resource.reset()
      resources.clear()
    },
  }
}

/** Subscribes a component to a shared resource. */
export function useSharedResource<T>(resource: SharedResource<T>): T {
  return useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
}

/** Subscribes a component to one key of a family; `null` subscribes to nothing. */
export function useSharedResourceKey<T>(
  family: SharedResourceFamily<T>,
  key: string | null
): T | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      key === null ? () => {} : family.subscribe(key, listener),
    [family, key]
  )
  const getSnapshot = useCallback(
    () => (key === null ? null : family.getSnapshot(key)),
    [family, key]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const serializedSnapshots = new WeakMap<object, string>()

function serialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  const cached = serializedSnapshots.get(value)
  if (cached !== undefined) return cached
  const text = JSON.stringify(value instanceof Map ? [...value] : value)
  serializedSnapshots.set(value, text)
  return text
}

/**
 * Structural equality for JSON payloads (and Maps of them). Polls that return
 * unchanged data then keep the old reference, so consumers do not re-render.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  try {
    return serialize(a) === serialize(b)
  } catch {
    return false
  }
}
