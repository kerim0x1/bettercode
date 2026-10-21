import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  MAX_CONSOLE_PER_VIEWPORT,
  MAX_REQUESTS_PER_GUEST,
  ensurePreviewRequestFeed,
  resetPreviewRequestFeed,
  useCanvasRuntimeStore,
} from "./canvas-runtime-store"

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
})
