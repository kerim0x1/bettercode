import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildRemoteWsUrl,
  configureRemoteBackend,
  getBackendMode,
  getConfig,
  getRemoteBaseUrl,
  getRemoteToken,
  invoke,
  onBackendReady,
  pickFolder,
  whenBackendReady,
} from "./runtime"

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal("window", {
    location: {
      origin: "http://127.0.0.1:3773",
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
})

describe("workspace folder selection", () => {
  it("waits for registration before exposing a native selection", async () => {
    window.__BETTERC0DE__ = { port: 3773, mode: "local_sidecar" }
    window.electronAPI = {
      pickFolder: vi.fn().mockResolvedValue("C:\\project"),
    } as unknown as NonNullable<Window["electronAPI"]>
    let respond!: (response: Response) => void
    let requested!: () => void
    const requestSeen = new Promise<void>((resolve) => {
      requested = resolve
    })
    const fetchMock = vi.fn(() => {
      requested()
      return new Promise<Response>((resolve) => {
        respond = resolve
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    let exposed = false
    const picked = pickFolder().then((folder) => {
      exposed = true
      return folder
    })
    await requestSeen
    expect(exposed).toBe(false)
    expect(fetchMock.mock.calls[0]).toEqual([
      expect.stringContaining("/workspace/open"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspacePath: "C:\\project" }),
      }),
    ])
    respond(new Response(JSON.stringify({ path: "C:\\project" })))
    await expect(picked).resolves.toBe("C:\\project")
  })

  it("does not open a cancelled selection", async () => {
    window.electronAPI = {
      pickFolder: vi.fn().mockResolvedValue(null),
    } as unknown as NonNullable<Window["electronAPI"]>
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(pickFolder()).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("remote backend security", () => {
  it("requires encryption off-loopback and keeps bearer tokens memory-only", () => {
    expect(() =>
      configureRemoteBackend({ baseUrl: "http://remote.example" })
    ).toThrow(/encrypted transport/)
    expect(() =>
      configureRemoteBackend({
        baseUrl: "https://remote.example",
        wsUrl: "ws://remote.example",
      })
    ).toThrow(/encrypted transport/)

    configureRemoteBackend({
      baseUrl: "https://remote.example",
      wsUrl: "wss://remote.example/socket",
      token: "remote-secret",
    })

    expect(storage.get("betterc0de.remote.token")).toBeUndefined()
    expect(getRemoteToken()).toBe("remote-secret")
    expect(buildRemoteWsUrl()).toBe("wss://remote.example/socket/ws")
  })

  it("allows unencrypted loopback development endpoints", () => {
    configureRemoteBackend({
      baseUrl: "http://127.0.0.1:4773",
      wsUrl: "ws://127.0.0.1:4773",
    })
    expect(buildRemoteWsUrl()).toBe("ws://127.0.0.1:4773/ws")
  })

  it("clears stale credentials and websocket routing when the backend origin changes", () => {
    configureRemoteBackend({
      baseUrl: "https://first.example",
      wsUrl: "wss://first.example/socket",
      token: "first-secret",
    })

    configureRemoteBackend({ baseUrl: "https://second.example" })

    expect(getRemoteToken()).toBe("")
    expect(storage.get("betterc0de.remote.wsUrl")).toBeUndefined()
    expect(buildRemoteWsUrl()).toBe("wss://second.example/ws")
  })

  it("rejects websocket endpoints that would receive another origin's bearer token", () => {
    expect(() =>
      configureRemoteBackend({
        baseUrl: "https://api.example",
        wsUrl: "wss://socket.example",
        token: "secret",
      })
    ).toThrow(/same credential origin/)
    expect(storage.get("betterc0de.remote.baseUrl")).toBeUndefined()
    expect(getRemoteToken()).toBe("")
  })
})

describe("local sidecar runtime config", () => {
  it("stops fetching while the shell reports downtime and resumes on the new port", async () => {
    let report!: (event: unknown) => void
    window.electronAPI = {
      onBackendStatus: (callback: (event: unknown) => void) => {
        report = callback
        return vi.fn()
      },
    } as unknown as NonNullable<Window["electronAPI"]>
    window.__BETTERC0DE__ = { port: 3773, mode: "local_sidecar" }
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"ok"}'))
    vi.stubGlobal("fetch", fetchMock)
    getConfig()
    report({ status: "failed", reason: "backend exited" })
    await expect(
      invoke("/workspace/search", { method: "POST", body: {} })
    ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" })
    expect(fetchMock).not.toHaveBeenCalled()
    report({ status: "restarting" })
    await expect(invoke("/ws-port")).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
    })
    expect(fetchMock).not.toHaveBeenCalled()
    report({ status: "ready", port: 4774 })
    await invoke("/ws-port")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4774/api/v1/ws-port",
      expect.anything()
    )
  })

  it("picks up a replacement backend port after a development restart", () => {
    window.__BETTERC0DE__ = { port: 3773, mode: "electron" }
    expect(getConfig().port).toBe(3773)

    window.__BETTERC0DE__ = { port: 3774, mode: "electron" }
    expect(getConfig().port).toBe(3774)
  })

  it("does not retain a previous mode when an injected runtime changes at the same port", () => {
    window.__BETTERC0DE__ = { port: 3773, mode: "electron" }
    expect(getConfig().mode).toBe("electron")

    window.__BETTERC0DE__ = {
      port: 3773,
      mode: "remote_http",
      baseUrl: "http://127.0.0.1:3773",
    }
    expect(getConfig().mode).toBe("remote_http")
    expect(getBackendMode()).toBe("remote_http")
  })
})

describe("backend-served remote runtime", () => {
  it("uses the exact page origin, cookie credentials, and no JavaScript bearer", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "http://192.168.1.50:4773" },
    })
    window.__BETTERC0DE__ = {
      port: 4773,
      mode: "remote_http",
      baseUrl: "http://192.168.1.50:4773",
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: "ok" })))
    vi.stubGlobal("fetch", fetchMock)

    expect(getRemoteBaseUrl()).toBe("http://192.168.1.50:4773")
    expect(buildRemoteWsUrl()).toBe("ws://192.168.1.50:4773/ws")
    await invoke("/runtime/health")

    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.50:4773/api/v1/runtime/health",
      expect.objectContaining({
        credentials: "include",
        headers: expect.not.objectContaining({
          Authorization: expect.anything(),
        }),
      })
    )
  })
})

describe("waiting for the local backend", () => {
  function withStatusChannel() {
    let report!: (event: unknown) => void
    window.electronAPI = {
      onBackendStatus: (callback: (event: unknown) => void) => {
        report = callback
        return vi.fn()
      },
    } as unknown as NonNullable<Window["electronAPI"]>
    return (event: unknown) => report(event)
  }

  it("resolves at once when the shell already published the port", async () => {
    withStatusChannel()
    window.__BETTERC0DE__ = { port: 4100, mode: "local_sidecar" }
    await expect(whenBackendReady()).resolves.toBe(4100)
  })

  it("waits for the backend-ready event instead of polling", async () => {
    vi.useFakeTimers()
    try {
      const report = withStatusChannel()
      const settled = vi.fn()
      void whenBackendReady().then(settled)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(settled).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)

      report({ status: "ready", port: 4200 })
      await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(4200))
      expect(window.__BETTERC0DE__?.port).toBe(4200)
    } finally {
      vi.useRealTimers()
    }
  })

  it("notices the runtime config the shell injects without an event", async () => {
    withStatusChannel()
    const ready = whenBackendReady()
    // What the shell's executeJavaScript does once the backend is up.
    window.__BETTERC0DE__ = { port: 4300, mode: "local_sidecar" }
    await expect(ready).resolves.toBe(4300)
    expect(window.__BETTERC0DE__).toEqual({ port: 4300, mode: "local_sidecar" })
  })

  it("keeps waiting while the shell reports the backend down", async () => {
    const report = withStatusChannel()
    window.__BETTERC0DE__ = { port: 4400, mode: "local_sidecar" }
    getConfig()
    report({ status: "restarting" })
    const settled = vi.fn()
    void whenBackendReady().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    report({ status: "ready", port: 4401 })
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(4401))
  })

  it("stops waiting when the caller aborts", async () => {
    withStatusChannel()
    const controller = new AbortController()
    const ready = whenBackendReady(controller.signal)
    controller.abort()
    await expect(ready).rejects.toThrow("cancelled")
  })

  it("tells subscribers about every (re)start until they unsubscribe", () => {
    const report = withStatusChannel()
    const listener = vi.fn()
    const unsubscribe = onBackendReady(listener)
    report({ status: "ready", port: 4500 })
    report({ status: "restarting" })
    report({ status: "ready", port: 4501 })
    unsubscribe()
    report({ status: "ready", port: 4502 })
    expect(listener.mock.calls).toEqual([[4500], [4501]])
  })
})

describe("per-request headers", () => {
  it("forwards a caller's extra headers to the local backend", async () => {
    window.__BETTERC0DE__ = { port: 3773, mode: "local_sidecar" }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal("fetch", fetchMock)

    await invoke("/shell/run", {
      method: "POST",
      body: { command: "ls" },
      headers: { "X-BetterC0de-Client-Instance": "page-0123456789" },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3773/api/v1/shell/run",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-BetterC0de-Client-Instance": "page-0123456789",
        }),
      })
    )
  })
})
