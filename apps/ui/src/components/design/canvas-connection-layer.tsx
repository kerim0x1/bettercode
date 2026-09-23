import { useState, type PointerEvent as ReactPointerEvent } from "react"
import { XIcon } from "lucide-react"
import {
  anchorKey,
  connectionGeometry,
  type CanvasAnchorRef,
  type CanvasItemRect,
  type ConnectionGeometry,
} from "@/lib/canvas-connections"
import type { NoteConnector } from "@/lib/canvas-notes"
import type { ConnectDraft } from "@/hooks/use-canvas-connect-drag"
import { cn } from "@/lib/utils"

/** Where a pull handle sits on an item, as a fraction of its box. */
const HANDLES = [
  { side: "top", fx: 0.5, fy: 0 },
  { side: "right", fx: 1, fy: 0.5 },
  { side: "bottom", fx: 0.5, fy: 1 },
  { side: "left", fx: 0, fy: 0.5 },
] as const

const ARROW = "M 0 0 L -9 -4.5 L -9 4.5 Z"

/**
 * Every wire on the canvas, under the cards: the dashed tethers of pinned
 * notes, the workflow edges, and the one being dragged. Its own chrome — pull
 * handles and a cut button per edge — sits above, in stage coordinates.
 */
export function CanvasConnectionLayer({
  geometries,
  tethers,
  items,
  hovered,
  selected,
  draft,
  onBeginConnect,
  onRemove,
}: {
  geometries: ConnectionGeometry[]
  /** Pin tethers, drawn dashed because they mean "moves with". */
  tethers: NoteConnector[]
  items: ReadonlyMap<string, CanvasItemRect>
  /** The item the pointer is over, so only its handles show. */
  hovered: string | null
  /**
   * The selected item, which keeps its handles out too. An embedded page is
   * mostly guest, and a guest's pointer events never reach this window, so
   * hover alone would leave it impossible to wire up.
   */
  selected: string | null
  draft: ConnectDraft | null
  onBeginConnect: (event: ReactPointerEvent, from: CanvasAnchorRef) => void
  onRemove: (id: string) => void
}) {
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)
  const dragging = draft !== null
  const source = draft ? items.get(anchorKey(draft.from)) : undefined
  const wire =
    draft && source
      ? connectionGeometry("draft", source, {
          ...draft.point,
          width: 0,
          height: 0,
        })
      : null

  return (
    <>
      <svg
        aria-hidden="true"
        width="1"
        height="1"
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
      >
        {tethers.map((line) => (
          <line
            key={line.id}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            strokeWidth={2}
            strokeDasharray="6 7"
            strokeLinecap="round"
            className="stroke-foreground/30"
          />
        ))}
        {geometries.map((edge) => {
          const lit = hoverEdge === edge.id
          return (
            <g
              key={edge.id}
              className={cn(
                "transition-colors duration-150",
                lit ? "text-primary" : "text-foreground/45"
              )}
            >
              <path
                d={edge.path}
                fill="none"
                stroke="currentColor"
                strokeWidth={lit ? 2.5 : 2}
                strokeLinecap="round"
              />
              <path
                d={ARROW}
                fill="currentColor"
                transform={`translate(${edge.head.x} ${edge.head.y}) rotate(${edge.headAngle})`}
              />
            </g>
          )
        })}
        {wire && (
          <g
            className={cn(
              draft?.over ? "text-primary" : "text-muted-foreground/70"
            )}
          >
            <path
              d={wire.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={draft?.over ? undefined : "5 6"}
            />
            <path
              d={ARROW}
              fill="currentColor"
              transform={`translate(${wire.head.x} ${wire.head.y}) rotate(${wire.headAngle})`}
            />
          </g>
        )}
      </svg>

      {/* A ring on the item the wire would land on. */}
      {draft?.over &&
        (() => {
          const target = items.get(anchorKey(draft.over))
          if (!target) return null
          return (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-20 rounded-2xl ring-2 ring-primary/70"
              style={{
                transform: `translate(${target.x - 3}px, ${target.y - 3}px)`,
                width: target.width + 6,
                height: target.height + 6,
              }}
            />
          )
        })()}

      {/* One cut button per edge, parked on the curve. */}
      {!dragging &&
        geometries.map((edge) => (
          <button
            key={edge.id}
            type="button"
            aria-label="Remove connection"
            title="Remove connection"
            onPointerEnter={() => setHoverEdge(edge.id)}
            onPointerLeave={() =>
              setHoverEdge((current) => (current === edge.id ? null : current))
            }
            onClick={() => {
              setHoverEdge(null)
              onRemove(edge.id)
            }}
            className="group absolute z-20 grid size-6 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-card hover:text-foreground hover:ring-1 hover:ring-border focus-visible:bg-card focus-visible:outline-2 focus-visible:outline-ring"
            style={{
              transform: `translate(${edge.mid.x - 12}px, ${edge.mid.y - 12}px)`,
            }}
          >
            <span className="size-1.5 rounded-full bg-foreground/45 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0" />
            <XIcon
              className="absolute size-3.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
              strokeWidth={2}
            />
          </button>
        ))}

      {/* Pull handles: only on the hovered item, or on every item mid-drag. */}
      {[...items.values()].map((item) => {
        const key = anchorKey(item)
        const shown = dragging
          ? anchorKey(draft.from) !== key
          : hovered === key || selected === key
        if (!shown) return null
        return HANDLES.map((handle) => (
          <div
            key={`${key}:${handle.side}`}
            data-connect-handle={key}
            className={cn(
              "absolute z-20 grid size-6 place-items-center",
              dragging ? "pointer-events-none" : "cursor-crosshair"
            )}
            style={{
              transform: `translate(${item.x + item.width * handle.fx - 12}px, ${item.y + item.height * handle.fy - 12}px)`,
            }}
            onPointerDown={(event) =>
              onBeginConnect(event, { kind: item.kind, id: item.id })
            }
          >
            <span
              className={cn(
                "size-2.5 rounded-full bg-primary ring-2 ring-background transition-transform duration-150",
                dragging ? "opacity-60" : "hover:scale-[1.45]"
              )}
            />
          </div>
        ))
      })}
    </>
  )
}
