import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import {
  decideCanvasGuests,
  liveGuestIds,
  sameGuestStates,
  touchRecentGuest,
  type CanvasCamera,
  type CanvasGuestCandidate,
  type CanvasGuestState,
} from "@/lib/canvas-live-guests"
import type { CanvasPoint } from "@/lib/project-canvas"

/** Camera changes settle this long before guests are mounted or paused. */
export const LIVE_GUEST_SETTLE_MS = 250

const NO_DECISION: ReadonlyMap<string, CanvasGuestState> = new Map()

/**
 * The board's decision for every guest it hosts. A guest the board has not
 * decided on is live, which is also what any host outside the board gets.
 */
export const CanvasGuestStatesContext =
  createContext<ReadonlyMap<string, CanvasGuestState>>(NO_DECISION)

export function useCanvasGuestState(id: string): CanvasGuestState {
  return useContext(CanvasGuestStatesContext).get(id) ?? "live"
}

function useViewportSize(viewportRef: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null
  )
  useLayoutEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const measure = () => {
      const rect = node.getBoundingClientRect()
      setSize((previous) =>
        previous &&
        previous.width === rect.width &&
        previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height }
      )
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [viewportRef])
  return size
}

/**
 * Decides which canvas guests stay mounted; provide `states` through
 * `CanvasGuestStatesContext`. The decision is made during render, so once the
 * viewport is measured a guest the board would pause is never mounted. Before
 * that every guest counts as visible (the cap still applies). Pan and zoom are
 * followed once they settle, so a gesture never mounts and unmounts pages
 * frame by frame. `touch` records that the user just used a guest.
 */
export function useCanvasLiveGuests(
  viewportRef: RefObject<HTMLElement | null>,
  view: { zoom: number; pan: CanvasPoint },
  candidates: readonly CanvasGuestCandidate[]
): {
  states: ReadonlyMap<string, CanvasGuestState>
  touch: (id: string) => void
} {
  const size = useViewportSize(viewportRef)
  const [camera, setCamera] = useState<CanvasCamera | null>(null)
  const settledOnce = camera !== null
  const { zoom } = view
  const { x, y } = view.pan
  const width = size?.width ?? 0
  const height = size?.height ?? 0
  useEffect(() => {
    if (!width || !height) return
    const next = { zoom, pan: { x, y }, width, height }
    // The first measurement applies at once; later moves wait to settle.
    if (!settledOnce) {
      setCamera(next)
      return
    }
    const timer = setTimeout(() => setCamera(next), LIVE_GUEST_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [zoom, x, y, width, height, settledOnce])

  // Until the first settled camera exists, decide on the measured one: the
  // layout-effect measurement re-renders before paint, so guests the board
  // would pause are dropped before anything is shown.
  const measured = useMemo<CanvasCamera | null>(
    () =>
      camera === null && width && height
        ? { zoom, pan: { x, y }, width, height }
        : null,
    [camera, zoom, x, y, width, height]
  )
  const effectiveCamera = camera ?? measured

  const [recent, setRecent] = useState<string[]>([])
  // The last committed decision: hysteresis needs what was live, and an
  // unchanged decision keeps its identity so consumers do not re-render.
  const committed = useRef<ReadonlyMap<string, CanvasGuestState>>(NO_DECISION)
  const states = useMemo(() => {
    const next = decideCanvasGuests({
      candidates,
      camera: effectiveCamera,
      previous: liveGuestIds(committed.current),
      recent,
    })
    return sameGuestStates(committed.current, next) ? committed.current : next
  }, [candidates, effectiveCamera, recent])
  useEffect(() => {
    committed.current = states
  }, [states])

  const touch = useCallback((id: string) => {
    setRecent((previous) =>
      previous[0] === id ? previous : touchRecentGuest(previous, id)
    )
  }, [])
  return { states, touch }
}
