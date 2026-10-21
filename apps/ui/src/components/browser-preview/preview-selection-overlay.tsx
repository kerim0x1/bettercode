import { useEffect, useRef, useState } from "react"
import type { SelectedElement } from "./types"

export function PreviewSelectionOverlay({
  execute,
  onSelect,
  onExit,
}: {
  execute: (code: string) => Promise<unknown>
  onSelect?: (element: SelectedElement) => void
  onExit?: () => void
}) {
  const overlay = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const revision = useRef(0)
  const point = useRef({ x: 0.5, y: 0.5 })
  const [hovered, setHovered] = useState<SelectedElement | null>(null)
  const [error, setError] = useState(false)

  const inspect = async (x: number, y: number) => {
    const result = await execute(
      `window.__BC_PREVIEW__?.inspectPoint(${x}, ${y})`
    )
    if (!result || typeof result !== "object") return null
    const element = result as SelectedElement
    return typeof element.selector === "string" &&
      typeof element.tagName === "string" &&
      element.rect &&
      element.viewport &&
      [
        element.rect.x,
        element.rect.y,
        element.rect.w,
        element.rect.h,
        element.viewport.width,
        element.viewport.height,
      ].every(Number.isFinite) &&
      element.viewport.width > 0 &&
      element.viewport.height > 0
      ? element
      : null
  }

  useEffect(() => {
    const pendingReads = revision
    overlay.current?.focus({ preventScroll: true })
    return () => {
      cancelAnimationFrame(frame.current)
      pendingReads.current++
    }
  }, [])

  useEffect(() => {
    const node = overlay.current
    if (!node) return
    let scrollFrame = 0,
      dx = 0,
      dy = 0
    const scroll = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      const bounds = node.getBoundingClientRect()
      point.current = {
        x: Math.max(
          0,
          Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))
        ),
        y: Math.max(
          0,
          Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height))
        ),
      }
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? node.clientHeight
            : 1
      dx +=
        (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit
      dy += (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit
      if (scrollFrame) return
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0
        void execute(
          `window.__BC_PREVIEW__?.scrollPoint(${point.current.x}, ${point.current.y}, ${dx}, ${dy})`
        )
        dx = dy = 0
        setHovered(null)
      })
    }
    node.addEventListener("wheel", scroll, { passive: false })
    return () => {
      node.removeEventListener("wheel", scroll)
      cancelAnimationFrame(scrollFrame)
    }
  }, [execute])

  const pick = async (x: number, y: number) => {
    const selected = await inspect(x, y)
    setError(!selected)
    if (selected) {
      setHovered(selected)
      onSelect?.(selected)
    }
  }

  return (
    <div
      ref={overlay}
      role="button"
      tabIndex={0}
      aria-label="Select page elements for chat"
      className="absolute inset-0 z-10 cursor-crosshair outline-none"
      style={{ touchAction: "none" }}
      data-preview-selection-overlay="true"
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        point.current = {
          x: Math.max(
            0,
            Math.min(1, (event.clientX - bounds.left) / bounds.width)
          ),
          y: Math.max(
            0,
            Math.min(1, (event.clientY - bounds.top) / bounds.height)
          ),
        }
        const ticket = ++revision.current
        cancelAnimationFrame(frame.current)
        frame.current = requestAnimationFrame(() => {
          void inspect(point.current.x, point.current.y).then((element) => {
            if (ticket === revision.current) setHovered(element)
          })
        })
      }}
      onPointerLeave={() => {
        revision.current++
        setHovered(null)
      }}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        const bounds = event.currentTarget.getBoundingClientRect()
        void pick(
          (event.clientX - bounds.left) / bounds.width,
          (event.clientY - bounds.top) / bounds.height
        )
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          onExit?.()
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          void pick(point.current.x, point.current.y)
        }
      }}
    >
      {hovered?.viewport && (
        <div
          className="pointer-events-none absolute border-2 border-ring bg-primary/5"
          style={{
            left: `${(100 * hovered.rect.x) / hovered.viewport.width}%`,
            top: `${(100 * hovered.rect.y) / hovered.viewport.height}%`,
            width: `${(100 * hovered.rect.w) / hovered.viewport.width}%`,
            height: `${(100 * hovered.rect.h) / hovered.viewport.height}%`,
          }}
        >
          <span className="absolute top-0 left-0 max-w-60 truncate rounded-br bg-primary px-1.5 py-0.5 font-mono text-[10px] text-primary-foreground">
            &lt;{hovered.tagName}&gt; {hovered.label || hovered.text}
          </span>
        </div>
      )}
      {error && (
        <div
          role="status"
          className="absolute right-2 bottom-2 left-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground"
        >
          The page is not ready for selection. Reload it and try again.
        </div>
      )}
    </div>
  )
}
