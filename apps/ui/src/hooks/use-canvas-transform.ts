import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react"

/**
 * Zoom/pan state for the design-mode canvas (Figma-style stage).
 *
 * No library: the stage is a single absolutely-positioned div transformed with
 * `translate(pan) scale(zoom)` from the top-left origin. The dot grid lives on
 * the viewport background and tracks the same transform via backgroundSize /
 * backgroundPosition, so it pans and zooms with the artboard for free.
 *
 * The stage transform is intentionally NEVER animated/transitioned — Electron
 * <webview> guests composite out-of-process and animated scaling produces
 * blank or blurry frames.
 */

const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
/** Padding kept around the artboard when fitting, px per side. */
const FIT_MARGIN = 48
const GRID_SIZE = 24
export const EDITABLE_SELECTOR =
  "input,textarea,select,[contenteditable]:not([contenteditable=false])"

/**
 * Whether the caret currently sits in a text field on the canvas.
 *
 * Ctrl and Cmd then belong to the text, not to the camera: arming the zoom
 * shield makes the stage `inert`, which blurs whatever was focused, so the
 * second half of Ctrl+A would land on the document and select the whole app
 * chrome instead of the note being written. The same goes for Cmd+A, and for
 * Ctrl+C / V / Z while typing.
 */
export function isEditingInside(
  viewport: Element | null | undefined,
  active: Element | null
): boolean {
  return Boolean(
    viewport &&
    active &&
    viewport.contains(active) &&
    active.matches(EDITABLE_SELECTOR)
  )
}

interface CanvasTransform {
  zoom: number
  pan: { x: number; y: number }
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

export interface UseCanvasTransformResult {
  zoom: number
  pan: { x: number; y: number }
  stageStyle: CSSProperties
  gridStyle: CSSProperties
  isPanning: boolean
  spaceHeld: boolean
  altHeld: boolean
  zoomHeld: boolean
  /** Transfer a modifier press from a focused preview guest to the canvas. */
  beginZoomGesture: () => void
  beginPanGesture: () => void
  zoomIn: () => void
  zoomOut: () => void
  zoomTo: (zoom: number) => void
  fit: () => void
  fitBounds: (bounds: {
    x?: number
    y?: number
    width: number
    height: number
  }) => void
  /** Pointer handlers for the pan-capture overlay (hand tool / Alt / Space). */
  panHandlers: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerCancel: () => void
    onLostPointerCapture: () => void
  }
}

export function useCanvasTransform(
  viewportRef: RefObject<HTMLDivElement | null>,
  artboard: { x?: number; y?: number; width: number; height: number },
  autoFitOnChange = true
): UseCanvasTransformResult {
  const [transform, setTransform] = useState<CanvasTransform>({
    zoom: 1,
    pan: { x: 0, y: 0 },
  })
  const [isPanning, setIsPanning] = useState(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [altHeld, setAltHeld] = useState(false)
  const altHeldRef = useRef(false)
  const updateAltHeld = useCallback((held: boolean) => {
    if (altHeldRef.current === held) return
    altHeldRef.current = held
    setAltHeld(held)
  }, [])
  const [zoomHeld, setZoomHeld] = useState(false)
  const zoomHeldRef = useRef(false)
  const updateZoomHeld = useCallback((held: boolean) => {
    if (zoomHeldRef.current === held) return
    zoomHeldRef.current = held
    setZoomHeld(held)
  }, [])
  const beginZoomGesture = useCallback(() => {
    updateZoomHeld(true)
    // Guest key events do not bubble into the renderer. Return focus so the
    // corresponding keyup releases the shield even without moving the mouse.
    viewportRef.current?.focus({ preventScroll: true })
  }, [updateZoomHeld, viewportRef])
  const beginPanGesture = useCallback(() => {
    updateAltHeld(true)
    viewportRef.current?.focus({ preventScroll: true })
  }, [updateAltHeld, viewportRef])
  const fitted = useRef(false)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    panX: number
    panY: number
  } | null>(null)

  // Step/absolute zoom about the viewport center. Uses a functional update
  // (not zoomAtPoint) so rapid clicks compose off the latest zoom value.
  const applyCenterZoom = useCallback(
    (compute: (prevZoom: number) => number) => {
      const rect = viewportRef.current?.getBoundingClientRect()
      const cx = (rect?.width ?? 0) / 2
      const cy = (rect?.height ?? 0) / 2
      setTransform((prev) => {
        const zoom = clampZoom(compute(prev.zoom))
        if (zoom === prev.zoom) return prev
        const ratio = zoom / prev.zoom
        return {
          zoom,
          pan: {
            x: cx - (cx - prev.pan.x) * ratio,
            y: cy - (cy - prev.pan.y) * ratio,
          },
        }
      })
    },
    [viewportRef]
  )

  const zoomIn = useCallback(
    () => applyCenterZoom((z) => z * 1.25),
    [applyCenterZoom]
  )
  const zoomOut = useCallback(
    () => applyCenterZoom((z) => z / 1.25),
    [applyCenterZoom]
  )
  const zoomTo = useCallback(
    (zoom: number) => applyCenterZoom(() => zoom),
    [applyCenterZoom]
  )

  const fitBounds = useCallback(
    (bounds: typeof artboard) => {
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect || rect.width < 10 || rect.height < 10) return
      const availW = rect.width - FIT_MARGIN * 2
      const availH = rect.height - FIT_MARGIN * 2
      // Fit shrinks to show the whole artboard but never enlarges past 100%.
      const zoom = clampZoom(
        Math.min(availW / bounds.width, availH / bounds.height, 1)
      )
      setTransform({
        zoom,
        pan: {
          x: (rect.width - bounds.width * zoom) / 2 - (bounds.x ?? 0) * zoom,
          y: (rect.height - bounds.height * zoom) / 2 - (bounds.y ?? 0) * zoom,
        },
      })
      fitted.current = true
    },
    [viewportRef]
  )
  const fit = useCallback(
    () =>
      fitBounds({
        x: artboard.x,
        y: artboard.y,
        width: artboard.width,
        height: artboard.height,
      }),
    [artboard.x, artboard.y, artboard.width, artboard.height, fitBounds]
  )

  // Fit on mount and whenever the artboard size (device preset) changes.
  useLayoutEffect(() => {
    if (autoFitOnChange || !fitted.current) fit()
    const node = viewportRef.current
    if (!node || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (autoFitOnChange || !fitted.current) fit()
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [fit, autoFitOnChange, viewportRef])

  // Wheel: ctrl/cmd+wheel zooms about the cursor, plain wheel pans.
  // Attached manually because React's synthetic onWheel is passive and we
  // must preventDefault to suppress browser page-zoom / overscroll.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented) return
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        e.target instanceof Element &&
        e.target.closest("[data-canvas-controls]")
      )
        return
      e.preventDefault()
      const unit =
        e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      const deltaX = e.deltaX * unit
      const deltaY = e.deltaY * unit
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        setTransform((prev) => {
          const zoom = clampZoom(prev.zoom * Math.exp(-deltaY * 0.0015))
          if (zoom === prev.zoom) return prev
          const ratio = zoom / prev.zoom
          return {
            zoom,
            pan: {
              x: cx - (cx - prev.pan.x) * ratio,
              y: cy - (cy - prev.pan.y) * ratio,
            },
          }
        })
        return
      }
      const dx = e.shiftKey && !deltaX ? deltaY : deltaX
      const dy = e.shiftKey && !deltaX ? 0 : deltaY
      setTransform((prev) => ({
        zoom: prev.zoom,
        pan: { x: prev.pan.x - dx, y: prev.pan.y - dy },
      }))
    }
    // Preview selection overlays own ordinary scrolling. Modifier-wheel must
    // reach the canvas first, including trackpad pinch events without keydown.
    const onZoomWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      onWheel(e)
      e.stopPropagation()
    }
    el.addEventListener("wheel", onZoomWheel, { passive: false, capture: true })
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      el.removeEventListener("wheel", onZoomWheel, true)
      el.removeEventListener("wheel", onWheel)
    }
  }, [viewportRef])

  // Temporary navigation restores the selected tool when the modifier lifts.
  useEffect(() => {
    const isTypingTarget = () => {
      const el = document.activeElement
      if (!el) return false
      const tag = el.tagName
      return (
        !viewportRef.current?.contains(el) ||
        Boolean(el.closest("[data-canvas-controls]")) ||
        tag === "BUTTON" ||
        tag === "SUMMARY" ||
        tag === "SELECT" ||
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (el as HTMLElement).isContentEditable
      )
    }
    const editing = () =>
      isEditingInside(viewportRef.current, document.activeElement)
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !editing()) updateZoomHeld(true)
      // AltGr produces Ctrl+Alt on Windows; it must remain available for text.
      updateAltHeld(e.altKey && !e.ctrlKey && !e.metaKey)
      if (
        e.key === "Alt" &&
        !e.ctrlKey &&
        !e.metaKey &&
        viewportRef.current?.contains(document.activeElement) &&
        !editing()
      )
        e.preventDefault()
      if (e.code !== "Space" || e.repeat || isTypingTarget()) return
      e.preventDefault()
      setSpaceHeld(true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      updateZoomHeld((e.ctrlKey || e.metaKey) && !editing())
      updateAltHeld(e.altKey && !e.ctrlKey && !e.metaKey)
      if (e.code !== "Space") return
      setSpaceHeld(false)
    }
    const onBlur = () => {
      updateZoomHeld(false)
      updateAltHeld(false)
      setSpaceHeld(false)
      dragRef.current = null
      setIsPanning(false)
    }
    const onPointerMove = (e: PointerEvent) => {
      updateZoomHeld((e.ctrlKey || e.metaKey) && !editing())
      updateAltHeld(e.altKey && !e.ctrlKey && !e.metaKey)
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onBlur()
    }
    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp, true)
    window.addEventListener("pointermove", onPointerMove, true)
    window.addEventListener("blur", onBlur)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp, true)
      window.removeEventListener("pointermove", onPointerMove, true)
      window.removeEventListener("blur", onBlur)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [viewportRef, updateZoomHeld, updateAltHeld])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Left or middle button starts a drag on the capture overlay.
      if (e.button !== 0 && e.button !== 1) return
      e.preventDefault()
      viewportRef.current?.focus({ preventScroll: true })
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        panX: transform.pan.x,
        panY: transform.pan.y,
      }
      setIsPanning(true)
    },
    [transform.pan.x, transform.pan.y, viewportRef]
  )

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    setTransform((prev) => ({
      zoom: prev.zoom,
      pan: { x: drag.panX + dx, y: drag.panY + dy },
    }))
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    setIsPanning(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }, [])

  const stageStyle: CSSProperties = {
    transform: `translate(${transform.pan.x}px, ${transform.pan.y}px) scale(${transform.zoom})`,
    transformOrigin: "0 0",
  }

  const gridStyle: CSSProperties = {
    backgroundImage:
      "radial-gradient(circle, color-mix(in srgb, var(--border) 70%, transparent) 1px, transparent 1px)",
    backgroundSize: `${GRID_SIZE * transform.zoom}px ${GRID_SIZE * transform.zoom}px`,
    backgroundPosition: `${transform.pan.x}px ${transform.pan.y}px`,
  }

  return {
    zoom: transform.zoom,
    pan: transform.pan,
    stageStyle,
    gridStyle,
    isPanning,
    spaceHeld,
    altHeld,
    zoomHeld,
    beginZoomGesture,
    beginPanGesture,
    zoomIn,
    zoomOut,
    zoomTo,
    fit,
    fitBounds,
    panHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: () => {
        dragRef.current = null
        setIsPanning(false)
      },
      onLostPointerCapture: () => {
        dragRef.current = null
        setIsPanning(false)
      },
    },
  }
}
