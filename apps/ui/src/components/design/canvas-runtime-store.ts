import { create } from "zustand"
import type { ConsoleLog } from "@/components/browser-preview/types"
import {
  appendCapped,
  parsePreviewRequest,
  type PreviewRequestEntry,
} from "./canvas-runtime"
import { getElectronApi } from "@/services/ipc-facade"

/**
 * What the runtime pane reads: the requests every preview guest made (keyed
 * by the guest's webContents id, which is how the shell identifies them) and
 * the console output each canvas viewport reported. Both are capped ring
 * buffers; a busy dev server would otherwise grow them without bound.
 *
 * A guest's id dies with the guest, so its requests are dropped as soon as
 * the viewport that owned it goes away, and again when the shell reports the
 * guest destroyed (`preview:guest-destroyed`), which also covers a guest
 * whose viewport never noticed. The shell also reports guests no canvas
 * viewport owns (the editor's browser panel); those buckets are kept only for
 * the most recently active guests.
 */

export const MAX_REQUESTS_PER_GUEST = 300
export const MAX_CONSOLE_PER_VIEWPORT = 200
/** Request buckets kept at most; the least recently active unowned go first. */
export const MAX_GUEST_BUCKETS = 24

interface CanvasRuntimeStore {
  requestsByGuest: Record<number, PreviewRequestEntry[]>
  consoleByViewport: Record<string, ConsoleLog[]>
  /** The guest each canvas viewport currently hosts. */
  guestByViewport: Record<string, number>
  /** Guest ids with a request bucket, least recently active first. */
  guestOrder: number[]
  recordRequest: (entry: PreviewRequestEntry) => void
  clearRequests: (guestIds: readonly number[]) => void
  recordConsole: (viewportKey: string, entries: readonly ConsoleLog[]) => void
  clearConsole: (viewportKeys: readonly string[]) => void
  /**
   * Records which guest a viewport hosts. A new id, or null when the guest is
   * destroyed, drops the requests of the guest it replaces.
   */
  bindGuest: (viewportKey: string, webContentsId: number | null) => void
  /**
   * The viewport unmounted: its guest is gone, so its requests go too. The
   * console survives a pause (the preview reloads in place when it comes
   * back) but not a removal.
   */
  releaseViewport: (
    viewportKey: string,
    options?: { keepConsole?: boolean }
  ) => void
  /**
   * The shell destroyed this guest: drop its requests and any viewport
   * binding that still names it.
   */
  forgetGuest: (webContentsId: number) => void
}

function withoutGuests(
  state: Pick<CanvasRuntimeStore, "requestsByGuest" | "guestOrder">,
  ids: readonly number[]
): Pick<CanvasRuntimeStore, "requestsByGuest" | "guestOrder"> {
  if (!ids.some((id) => id in state.requestsByGuest))
    return {
      requestsByGuest: state.requestsByGuest,
      guestOrder: state.guestOrder,
    }
  const requestsByGuest = { ...state.requestsByGuest }
  for (const id of ids) delete requestsByGuest[id]
  return {
    requestsByGuest,
    guestOrder: state.guestOrder.filter((id) => !ids.includes(id)),
  }
}

export const useCanvasRuntimeStore = create<CanvasRuntimeStore>((set) => ({
  requestsByGuest: {},
  consoleByViewport: {},
  guestByViewport: {},
  guestOrder: [],
  recordRequest: (entry) =>
    set((state) => {
      const id = entry.webContentsId
      const requestsByGuest = {
        ...state.requestsByGuest,
        [id]: appendCapped(
          state.requestsByGuest[id] ?? [],
          [entry],
          MAX_REQUESTS_PER_GUEST
        ),
      }
      const guestOrder =
        state.guestOrder[state.guestOrder.length - 1] === id
          ? state.guestOrder
          : [...state.guestOrder.filter((item) => item !== id), id]
      if (guestOrder.length <= MAX_GUEST_BUCKETS)
        return { requestsByGuest, guestOrder }
      const owned = new Set(Object.values(state.guestByViewport))
      const evict: number[] = []
      for (const candidate of guestOrder) {
        if (guestOrder.length - evict.length <= MAX_GUEST_BUCKETS) break
        if (candidate !== id && !owned.has(candidate)) evict.push(candidate)
      }
      return withoutGuests({ requestsByGuest, guestOrder }, evict)
    }),
  clearRequests: (guestIds) =>
    set((state) => {
      const next = { ...state.requestsByGuest }
      for (const id of guestIds) delete next[id]
      return {
        requestsByGuest: next,
        guestOrder: state.guestOrder.filter((id) => !guestIds.includes(id)),
      }
    }),
  recordConsole: (viewportKey, entries) =>
    set((state) => ({
      consoleByViewport: {
        ...state.consoleByViewport,
        [viewportKey]: appendCapped(
          state.consoleByViewport[viewportKey] ?? [],
          entries,
          MAX_CONSOLE_PER_VIEWPORT
        ),
      },
    })),
  clearConsole: (viewportKeys) =>
    set((state) => {
      const next = { ...state.consoleByViewport }
      for (const key of viewportKeys) delete next[key]
      return { consoleByViewport: next }
    }),
  bindGuest: (viewportKey, webContentsId) =>
    set((state) => {
      const previous = state.guestByViewport[viewportKey]
      if (previous === webContentsId) return state
      const guestByViewport = { ...state.guestByViewport }
      if (webContentsId === null) delete guestByViewport[viewportKey]
      else guestByViewport[viewportKey] = webContentsId
      return {
        guestByViewport,
        ...(previous === undefined ? {} : withoutGuests(state, [previous])),
      }
    }),
  releaseViewport: (viewportKey, options) =>
    set((state) => {
      const previous = state.guestByViewport[viewportKey]
      const dropConsole =
        !options?.keepConsole && viewportKey in state.consoleByViewport
      if (previous === undefined && !dropConsole) return state
      const next: Partial<CanvasRuntimeStore> = {}
      if (previous !== undefined) {
        const { [viewportKey]: _released, ...guestByViewport } =
          state.guestByViewport
        next.guestByViewport = guestByViewport
        Object.assign(next, withoutGuests(state, [previous]))
      }
      if (dropConsole) {
        const { [viewportKey]: _dropped, ...consoleByViewport } =
          state.consoleByViewport
        next.consoleByViewport = consoleByViewport
      }
      return next
    }),
  forgetGuest: (webContentsId) =>
    set((state) => {
      const boundViewports = Object.keys(state.guestByViewport).filter(
        (key) => state.guestByViewport[key] === webContentsId
      )
      if (
        boundViewports.length === 0 &&
        !(webContentsId in state.requestsByGuest)
      ) {
        return state
      }
      const next: Partial<CanvasRuntimeStore> = withoutGuests(state, [
        webContentsId,
      ])
      if (boundViewports.length > 0) {
        const guestByViewport = { ...state.guestByViewport }
        for (const key of boundViewports) delete guestByViewport[key]
        next.guestByViewport = guestByViewport
      }
      return next
    }),
}))

/** The guest id in a `preview:guest-destroyed` event, or null. */
export function parseDestroyedGuestId(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null
  const id = (raw as { webContentsId?: unknown }).webContentsId
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null
}

let unsubscribe: (() => void) | null = null

/**
 * Subscribes once to the shell's request feed and to its guest-destroyed
 * notices. Called by the first runtime pane that mounts; outside Electron
 * there is no feed and this is a no-op.
 */
export function ensurePreviewRequestFeed(): void {
  if (unsubscribe) return
  const api = getElectronApi()
  if (!api?.onPreviewRequest) return
  const stopRequests = api.onPreviewRequest((raw) => {
    const entry = parsePreviewRequest(raw)
    if (entry) useCanvasRuntimeStore.getState().recordRequest(entry)
  })
  const stopDestroyed = api.onPreviewGuestDestroyed?.((raw) => {
    const id = parseDestroyedGuestId(raw)
    if (id !== null) useCanvasRuntimeStore.getState().forgetGuest(id)
  })
  unsubscribe = () => {
    stopRequests()
    stopDestroyed?.()
  }
}

/** Test seam: drops the feed so a fresh subscription can be observed. */
export function resetPreviewRequestFeed(): void {
  unsubscribe?.()
  unsubscribe = null
}
