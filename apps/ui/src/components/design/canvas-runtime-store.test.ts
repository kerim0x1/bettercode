import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  MAX_CONSOLE_PER_VIEWPORT,
  MAX_GUEST_BUCKETS,
  MAX_REQUESTS_PER_GUEST,
  ensurePreviewRequestFeed,
  resetPreviewRequestFeed,
  useCanvasRuntimeStore,
} from "./canvas-runtime-store"
import type { PreviewRequestEntry } from "./canvas-runtime"

const initial = useCanvasRuntimeStore.getState()
beforeEach(() => useCanvasRuntimeStore.setState(initial, true))
afterEach(() => {
  resetPreviewRequestFeed()
  vi.unstubAllGlobals()
})

describe("canvas runtime store", () => {
  it("keeps requests per guest and console lines per viewport, both capped", () => {
    const store = useCanvasRuntimeStore.getState()
    for (let i = 0; i < MAX_REQUESTS_PER_GUEST + 5; i += 1) {
      store.recordRequest({
        id: String(i),
        webContentsId: 7,
        method: "GET",
        url: `http://localhost:3000/${i}`,
        resourceType: "xhr",
        startedAt: i,
        durationMs: 1,
        statusCode: 200,
        fromCache: false,
        error: null,
      })
    }
    store.recordConsole(
      "a::desktop",
      Array.from({ length: MAX_CONSOLE_PER_VIEWPORT + 3 }, (_, i) => ({
        level: "log" as const,
        message: `line ${i}`,
        timestamp: new Date(i),
      }))
    )
    const state = useCanvasRuntimeStore.getState()
    expect(state.requestsByGuest[7]).toHaveLength(MAX_REQUESTS_PER_GUEST)
    expect(state.requestsByGuest[7][0].id).toBe("5")
    expect(state.consoleByViewport["a::desktop"]).toHaveLength(
      MAX_CONSOLE_PER_VIEWPORT
    )
    expect(state.consoleByViewport["a::desktop"][0].message).toBe("line 3")

    state.clearRequests([7])
    state.clearConsole(["a::desktop"])
    expect(useCanvasRuntimeStore.getState().requestsByGuest).toEqual({})
    expect(useCanvasRuntimeStore.getState().consoleByViewport).toEqual({})
  })

  it("subscribes to the shell feed once and records parsed entries", () => {
    const listeners: Array<(entry: unknown) => void> = []
    const unsubscribe = vi.fn()
    vi.stubGlobal("window", {
      electronAPI: {
        onPreviewRequest: (callback: (entry: unknown) => void) => {
          listeners.push(callback)
          return unsubscribe
        },
      },
    })
    ensurePreviewRequestFeed()
    ensurePreviewRequestFeed()
    expect(listeners).toHaveLength(1)
    listeners[0]({
      id: "1",
      webContentsId: 3,
      method: "get",
      url: "http://localhost:3000/api",
      resourceType: "xhr",
      startedAt: 5,
      durationMs: 9,
      statusCode: 200,
      fromCache: false,
      error: null,
    })
    listeners[0]({ broken: true })
    expect(useCanvasRuntimeStore.getState().requestsByGuest[3]).toHaveLength(1)
    expect(useCanvasRuntimeStore.getState().requestsByGuest[3][0].method).toBe(
      "GET"
    )
    resetPreviewRequestFeed()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it("is a no-op outside Electron", () => {
    vi.stubGlobal("window", {})
    expect(() => ensurePreviewRequestFeed()).not.toThrow()
  })

  it("drops a guest's requests when its viewport releases it or it is replaced", () => {
    const store = useCanvasRuntimeStore.getState()
    store.bindGuest("a::desktop", 7)
    store.recordRequest(request(7, "1"))
    store.recordRequest(request(8, "2"))
    store.recordConsole("a::desktop", [line("hello")])

    // A reload into a new guest: the old guest's bucket goes.
    useCanvasRuntimeStore.getState().bindGuest("a::desktop", 9)
    let state = useCanvasRuntimeStore.getState()
    expect(state.requestsByGuest[7]).toBeUndefined()
    expect(state.guestByViewport["a::desktop"]).toBe(9)
    expect(state.guestOrder).toEqual([8])

    // A pause keeps the console for when the preview loads again...
    useCanvasRuntimeStore.getState().recordRequest(request(9, "3"))
    useCanvasRuntimeStore
      .getState()
      .releaseViewport("a::desktop", { keepConsole: true })
    state = useCanvasRuntimeStore.getState()
    expect(state.requestsByGuest[9]).toBeUndefined()
    expect(state.guestByViewport).toEqual({})
    expect(state.consoleByViewport["a::desktop"]).toHaveLength(1)

    // ...a removal does not. Requests of unrelated guests are untouched.
    useCanvasRuntimeStore.getState().releaseViewport("a::desktop")
    state = useCanvasRuntimeStore.getState()
    expect(state.consoleByViewport).toEqual({})
    expect(state.requestsByGuest[8]).toHaveLength(1)
  })

  it("forgets a destroyed guest", () => {
    const store = useCanvasRuntimeStore.getState()
    store.bindGuest("b::mobile", 4)
    store.recordRequest(request(4, "1"))
    useCanvasRuntimeStore.getState().bindGuest("b::mobile", null)
    const state = useCanvasRuntimeStore.getState()
    expect(state.requestsByGuest).toEqual({})
    expect(state.guestByViewport).toEqual({})
  })

  it("drops a guest the shell reports destroyed, even one its viewport still names", () => {
    const listeners: Array<(event: unknown) => void> = []
    const stopDestroyed = vi.fn()
    vi.stubGlobal("window", {
      electronAPI: {
        onPreviewRequest: () => vi.fn(),
        onPreviewGuestDestroyed: (callback: (event: unknown) => void) => {
          listeners.push(callback)
          return stopDestroyed
        },
      },
    })
    ensurePreviewRequestFeed()
    expect(listeners).toHaveLength(1)

    const store = useCanvasRuntimeStore.getState()
    store.bindGuest("c::desktop", 11)
    store.recordRequest(request(11, "1"))
    store.recordRequest(request(12, "2"))

    listeners[0]({ webContentsId: "11" })
    listeners[0](null)
    expect(useCanvasRuntimeStore.getState().requestsByGuest[11]).toHaveLength(1)

    listeners[0]({ webContentsId: 11 })
    const state = useCanvasRuntimeStore.getState()
    expect(state.requestsByGuest[11]).toBeUndefined()
    expect(state.guestByViewport).toEqual({})
    expect(state.guestOrder).toEqual([12])
    expect(state.requestsByGuest[12]).toHaveLength(1)

    resetPreviewRequestFeed()
    expect(stopDestroyed).toHaveBeenCalledOnce()
  })

  it("keeps request buckets only for the most recently active unowned guests", () => {
    const store = useCanvasRuntimeStore.getState()
    store.bindGuest("a::desktop", 1)
    for (let id = 1; id <= MAX_GUEST_BUCKETS + 5; id += 1)
      useCanvasRuntimeStore.getState().recordRequest(request(id, String(id)))
    const state = useCanvasRuntimeStore.getState()
    const ids = Object.keys(state.requestsByGuest).map(Number)
    expect(ids).toHaveLength(MAX_GUEST_BUCKETS)
    // The owned guest survives although it is the oldest.
    expect(ids).toContain(1)
    expect(ids).not.toContain(2)
    expect(ids).toContain(MAX_GUEST_BUCKETS + 5)
    expect(state.guestOrder).toHaveLength(MAX_GUEST_BUCKETS)
  })
})

function request(webContentsId: number, id: string): PreviewRequestEntry {
  return {
    id,
    webContentsId,
    method: "GET",
    url: `http://localhost:3000/${id}`,
    resourceType: "xhr",
    startedAt: Number(id),
    durationMs: 1,
    statusCode: 200,
    fromCache: false,
    error: null,
  }
}

function line(message: string) {
  return { level: "log" as const, message, timestamp: new Date(0) }
}
