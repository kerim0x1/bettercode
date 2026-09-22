import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react"
import {
  anchorKey,
  itemAt,
  type CanvasAnchorRef,
  type CanvasItemRect,
} from "@/lib/canvas-connections"
import type { CanvasPoint } from "@/lib/project-canvas"

export interface ConnectDraft {
  from: CanvasAnchorRef
  /** Where the pointer is, in canvas coordinates. */
  point: CanvasPoint
  /** The item under the pointer, once it is a legal drop. */
  over: CanvasAnchorRef | null
}

/**
 * Dragging a wire from one item's anchor onto another.
 *
 * The drop target is found by testing the canvas rectangles rather than the
 * DOM: a project card is mostly iframe, and an iframe swallows the pointer
 * events a hit test would need.
 */
export function useCanvasConnectDrag({
  toCanvas,
  items,
  canConnect,
  onConnect,
}: {
  toCanvas: (client: CanvasPoint) => CanvasPoint
  items: ReadonlyMap<string, CanvasItemRect>
  /** False for a pair that is already joined, so it reads as an illegal drop. */
  canConnect: (from: CanvasAnchorRef, to: CanvasAnchorRef) => boolean
  onConnect: (from: CanvasAnchorRef, to: CanvasAnchorRef) => void
}) {
  const [draft, setDraft] = useState<ConnectDraft | null>(null)
  const active = useRef<{ from: CanvasAnchorRef; pointerId: number } | null>(
    null
  )
  // Read through a ref so a gesture in flight always sees current geometry
  // without the handlers changing identity mid-drag.
  const latest = useRef({ toCanvas, items, canConnect, onConnect })
  latest.current = { toCanvas, items, canConnect, onConnect }

  const cancel = useCallback(() => {
    active.current = null
    setDraft(null)
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel()
    }
    window.addEventListener("keydown", key)
    window.addEventListener("blur", cancel)
    return () => {
      window.removeEventListener("keydown", key)
      window.removeEventListener("blur", cancel)
    }
  }, [cancel])

  /** The item under the pointer, but only when it is a legal drop. */
  const hit = (point: CanvasPoint, from: CanvasAnchorRef) => {
    const found = itemAt(latest.current.items.values(), point)
    if (!found) return null
    const target: CanvasAnchorRef = { kind: found.kind, id: found.id }
    if (anchorKey(target) === anchorKey(from)) return null
    return latest.current.canConnect(from, target) ? target : null
  }

  const begin = (event: PointerEvent, from: CanvasAnchorRef) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    active.current = { from, pointerId: event.pointerId }
    setDraft({
      from,
      point: latest.current.toCanvas({ x: event.clientX, y: event.clientY }),
      over: null,
    })
  }
  const capture = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && active.current) {
        try {
          node.setPointerCapture(active.current.pointerId)
        } catch {
          cancel()
        }
      }
    },
    [cancel]
  )
  const move = (event: PointerEvent) => {
    const current = active.current
    if (!current || current.pointerId !== event.pointerId) return
    const point = latest.current.toCanvas({
      x: event.clientX,
      y: event.clientY,
    })
    setDraft({ from: current.from, point, over: hit(point, current.from) })
  }
  const end = (event: PointerEvent) => {
    const current = active.current
    if (!current || current.pointerId !== event.pointerId) return
    const target = hit(
      latest.current.toCanvas({ x: event.clientX, y: event.clientY }),
      current.from
    )
    if (target) latest.current.onConnect(current.from, target)
    cancel()
  }
  return {
    draft,
    begin,
    overlayProps: {
      ref: capture,
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
    },
  }
}
