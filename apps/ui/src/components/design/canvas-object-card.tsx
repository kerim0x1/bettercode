import {
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react"
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  FlagIcon,
  GlobeIcon,
  ImageOffIcon,
  RotateCwIcon,
} from "lucide-react"
import {
  resizeObject,
  type CanvasEmbedObject,
  type CanvasFrameObject,
  type CanvasImageObject,
  type CanvasObject,
  type CanvasShapeObject,
  type CanvasTaskObject,
  type CanvasTextObject,
} from "@/lib/canvas-objects"
import { describeUrl, preferHttps } from "@/lib/canvas-paste"
import type { CanvasPoint } from "@/lib/project-canvas"
import {
  useCanvasAssetUrl,
  useCanvasEmbedUrl,
} from "@/hooks/use-canvas-object-media"
import {
  ALIGN_CLASS,
  DIAMOND_CLIP,
  FILL_SURFACE,
  ON_SOLID,
  SHAPE_RADIUS,
  SOLID,
  TEXT_COLOR,
  TEXT_SIZE_CLASS,
} from "./canvas-object-style"
import { cn } from "@/lib/utils"

export interface CanvasObjectCardProps {
  object: CanvasObject
  selected: boolean
  /** True while the caret is in this object's words. */
  editing: boolean
  panActive: boolean
  zoom: number
  onSelect: (id: string) => void
  onEdit: (id: string | null) => void
  onChange: (object: CanvasObject) => void
  onMoveStart: (event: ReactPointerEvent, origin: CanvasPoint) => void
}

/**
 * One object on the board. Selection and dragging are shared; only the body
 * differs by kind, which is what keeps a text node and an embedded page
 * behaving the same way under the pointer.
 */
export function CanvasObjectCard(props: CanvasObjectCardProps) {
  const { object, selected, editing, panActive, zoom, onSelect, onEdit } = props
  const resize = useRef<{
    pointerId: number
    startX: number
    startY: number
    width: number
    height: number
  } | null>(null)

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    resize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: object.width,
      height: object.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const duringResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = resize.current
    if (!current || current.pointerId !== event.pointerId) return
    const scale = Math.max(zoom, 0.01)
    const width = current.width + (event.clientX - current.startX) / scale
    let height = current.height + (event.clientY - current.startY) / scale
    // Shift keeps a picture's own proportions, as it does everywhere else.
    if (object.kind === "image" && object.ratio && event.shiftKey)
      height = width / object.ratio
    props.onChange(resizeObject(object, { width, height }))
  }
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resize.current?.pointerId !== event.pointerId) return
    resize.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* The capture is already gone when the pointer left the window. */
    }
  }

  return (
    <div
      data-canvas-object={object.id}
      data-object-kind={object.kind}
      data-selected={selected || undefined}
      style={{ width: object.width, height: object.height }}
      className={cn(
        "group relative",
        editing ? "cursor-text" : panActive ? "cursor-grab" : "cursor-default"
      )}
      onPointerDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            "button,a,[data-object-resize],[data-object-live]"
          )
        )
          return
        onSelect(object.id)
        if (editing) return
        event.preventDefault()
        props.onMoveStart(event, { x: object.x, y: object.y })
      }}
      onDoubleClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button,a"))
          return
        onEdit(object.id)
      }}
    >
      <ObjectBody {...props} />

      {selected && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-px rounded-[inherit] ring-2 ring-primary"
          style={{ borderRadius: object.kind === "shape" ? undefined : 12 }}
        />
      )}

      <div
        data-object-resize
        onPointerDown={beginResize}
        onPointerMove={duringResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-hidden="true"
        className={cn(
          "absolute -right-1 -bottom-1 size-4 cursor-nwse-resize touch-none rounded-sm bg-primary opacity-0 ring-2 ring-background transition-opacity duration-150",
          selected ? "opacity-100" : "group-hover:opacity-70"
        )}
      />
    </div>
  )
}

function ObjectBody(props: CanvasObjectCardProps) {
  switch (props.object.kind) {
    case "text":
      return <TextBody {...props} object={props.object} />
    case "shape":
      return <ShapeBody {...props} object={props.object} />
    case "image":
      return <ImageBody object={props.object} />
    case "embed":
      return (
        <EmbedBody
          object={props.object}
          panActive={props.panActive}
          onChange={props.onChange}
        />
      )
    case "frame":
      return <FrameBody {...props} object={props.object} />
    case "task":
      return <TaskBody {...props} object={props.object} />
  }
}

/** Keeps the caret in the field for as long as the board says it is editing. */
function useEditFocus(editing: boolean) {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) return
    const node = ref.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [editing])
  return ref
}

function typography(style: {
  size: CanvasTextObject["size"]
  align: CanvasTextObject["align"]
  color: CanvasTextObject["color"]
  bold: boolean
  italic: boolean
  mono: boolean
}): string {
  return cn(
    TEXT_SIZE_CLASS[style.size],
    ALIGN_CLASS[style.align],
    TEXT_COLOR[style.color],
    style.bold && "font-semibold",
    style.italic && "italic",
    style.mono && "font-mono"
  )
}

function TextBody({
  object,
  editing,
  onChange,
  onEdit,
}: CanvasObjectCardProps & { object: CanvasTextObject }) {
  const ref = useEditFocus(editing)
  return (
    <textarea
      ref={ref as React.RefObject<HTMLTextAreaElement>}
      value={object.text}
      readOnly={!editing}
      spellCheck={false}
      placeholder="Type…"
      aria-label="Canvas text"
      onChange={(event) => onChange({ ...object, text: event.target.value })}
      onBlur={() => onEdit(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          onEdit(null)
        }
      }}
      style={{ pointerEvents: editing ? "auto" : "none" }}
      className={cn(
        "size-full resize-none bg-transparent p-1 outline-none placeholder:text-foreground/30",
        typography(object)
      )}
    />
  )
}

function ShapeBody({
  object,
  editing,
  onChange,
  onEdit,
}: CanvasObjectCardProps & { object: CanvasShapeObject }) {
  const ref = useEditFocus(editing)
  const clipped = object.shape === "diamond"
  const surface: CSSProperties = clipped ? { clipPath: DIAMOND_CLIP } : {}
  return (
    <div className="relative size-full">
      <div
        aria-hidden="true"
        style={surface}
        className={cn(
          "absolute inset-0 ring-1",
          !clipped && SHAPE_RADIUS[object.shape],
          FILL_SURFACE[object.fill]
        )}
      />
      <div
        className={cn(
          "relative flex size-full items-center",
          // A diamond's corners are empty, so its words keep clear of them.
          clipped ? "px-[22%] py-[22%]" : "p-4",
          object.align === "left"
            ? "justify-start"
            : object.align === "right"
              ? "justify-end"
              : "justify-center"
        )}
      >
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          value={object.text}
          readOnly={!editing}
          spellCheck={false}
          placeholder="Label…"
          aria-label="Shape label"
          onChange={(event) =>
            onChange({ ...object, text: event.target.value })
          }
          onBlur={() => onEdit(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation()
              onEdit(null)
            }
          }}
          style={{ pointerEvents: editing ? "auto" : "none" }}
          className={cn(
            "max-h-full w-full resize-none bg-transparent outline-none placeholder:text-foreground/30",
            typography(object)
          )}
        />
      </div>
    </div>
  )
}

function ImageBody({ object }: { object: CanvasImageObject }) {
  const stored = useCanvasAssetUrl(object.assetId)
  const source = object.src ?? stored
  if (!source) {
    return (
      <div className="flex size-full items-center justify-center rounded-xl bg-foreground/[0.04] ring-1 ring-border/60">
        {object.assetId ? (
          <span className="text-[11px] text-muted-foreground">Loading…</span>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ImageOffIcon className="size-3.5" strokeWidth={1.5} />
            Picture unavailable
          </span>
        )}
      </div>
    )
  }
  return (
    <img
      src={source}
      alt={object.alt || "Canvas image"}
      draggable={false}
      className="size-full rounded-xl object-contain select-none"
    />
  )
}

function EmbedBody({
  object,
  panActive,
  onChange,
}: {
  object: CanvasEmbedObject
  panActive: boolean
  onChange: (object: CanvasObject) => void
}) {
  const { url, error, nonce, reload } = useCanvasEmbedUrl(object)
  if (object.source === "web" && !object.url)
    return <EmbedPrompt onChange={onChange} object={object} />
  const caption =
    object.title ||
    (object.source === "web"
      ? describeUrl(object.url ?? "")
      : (object.relativePath ?? "Local file"))
  // Guarded for the static renderer the component tests use, which has no
  // `window`; every other reader of this flag runs in the browser only.
  const isElectron =
    typeof window !== "undefined" && Boolean(window.electronAPI)
  return (
    <div className="flex size-full flex-col overflow-hidden rounded-xl bg-card ring-1 ring-border/70">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/60 bg-sidebar px-2">
        <GlobeIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {caption}
        </span>
        <button
          type="button"
          title="Reload"
          aria-label="Reload embed"
          onClick={reload}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <RotateCwIcon className="size-3" strokeWidth={1.5} />
        </button>
        {object.source === "web" && object.url && (
          <a
            href={object.url}
            target="_blank"
            rel="noreferrer noopener"
            title="Open in browser"
            aria-label="Open in browser"
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ExternalLinkIcon className="size-3" strokeWidth={1.5} />
          </a>
        )}
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        {error ? (
          <p
            role="alert"
            className="flex size-full items-center justify-center gap-2 px-4 text-center text-[11px] text-muted-foreground"
          >
            <AlertTriangleIcon
              className="size-3.5 shrink-0"
              strokeWidth={1.5}
            />
            {error}
          </p>
        ) : !url ? (
          <p className="flex size-full items-center justify-center text-[11px] text-muted-foreground">
            Opening…
          </p>
        ) : isElectron ? (
          <webview
            key={nonce}
            data-object-live
            src={url}
            // The canvas partition is where the local-file protocol is served.
            partition="betterc0de-canvas-preview"
            className="size-full border-0 bg-background"
            style={{ display: "inline-flex" }}
          />
        ) : (
          <iframe
            key={nonce}
            data-object-live
            src={url}
            title={caption}
            sandbox="allow-scripts allow-forms allow-popups allow-presentation"
            className="size-full border-0 bg-background"
          />
        )}
        {/* While panning, the guest must not eat the gesture. */}
        {panActive && <div className="absolute inset-0" aria-hidden="true" />}
      </div>
    </div>
  )
}

function FrameBody({
  object,
  editing,
  onChange,
  onEdit,
}: CanvasObjectCardProps & { object: CanvasFrameObject }) {
  const ref = useEditFocus(editing)
  return (
    <div className="size-full">
      <input
        ref={ref as React.RefObject<HTMLInputElement>}
        value={object.title}
        readOnly={!editing}
        aria-label="Frame name"
        onChange={(event) => onChange({ ...object, title: event.target.value })}
        onBlur={() => onEdit(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Enter") {
            event.stopPropagation()
            onEdit(null)
          }
        }}
        style={{ pointerEvents: editing ? "auto" : "none" }}
        className="absolute -top-6 left-0 max-w-full truncate rounded bg-transparent text-[12px] text-muted-foreground outline-none focus:bg-card focus:px-1 focus:text-foreground"
      />
      <div className="size-full rounded-lg bg-white ring-1 ring-border/50" />
    </div>
  )
}

function TaskBody({
  object,
  editing,
  onChange,
  onEdit,
}: CanvasObjectCardProps & { object: CanvasTaskObject }) {
  const ref = useEditFocus(editing)
  const initial = object.assignee.trim().slice(0, 1).toUpperCase()
  return (
    <div className="flex size-full flex-col gap-2 overflow-hidden rounded-xl bg-card p-4 ring-1 ring-border/70">
      <input
        value={object.breadcrumb}
        readOnly={!editing}
        placeholder="Space / List"
        aria-label="Task location"
        onChange={(event) =>
          onChange({ ...object, breadcrumb: event.target.value })
        }
        onBlur={() => onEdit(null)}
        style={{ pointerEvents: editing ? "auto" : "none" }}
        className="w-full truncate bg-transparent text-[12px] text-muted-foreground outline-none placeholder:text-muted-foreground/50"
      />
      <textarea
        ref={ref as React.RefObject<HTMLTextAreaElement>}
        value={object.title}
        readOnly={!editing}
        spellCheck={false}
        placeholder="Task name"
        aria-label="Task name"
        onChange={(event) => onChange({ ...object, title: event.target.value })}
        onBlur={() => onEdit(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation()
            onEdit(null)
          }
        }}
        style={{ pointerEvents: editing ? "auto" : "none" }}
        className="min-h-0 flex-1 resize-none bg-transparent text-[19px] leading-tight font-semibold text-foreground outline-none placeholder:text-foreground/30"
      />
      <div className="flex shrink-0 items-center gap-2">
        <span
          className={cn(
            "rounded px-2 py-1 text-[11px] font-semibold tracking-wide",
            SOLID[object.statusColor],
            ON_SOLID[object.statusColor]
          )}
        >
          {object.status || "TO DO"}
        </span>
        <button
          type="button"
          aria-pressed={object.flagged}
          aria-label={object.flagged ? "Clear flag" : "Flag task"}
          title={object.flagged ? "Clear flag" : "Flag task"}
          onClick={() => onChange({ ...object, flagged: !object.flagged })}
          className={cn(
            "flex size-6 items-center justify-center rounded transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
            object.flagged ? "text-rose-400" : "text-muted-foreground"
          )}
        >
          <FlagIcon
            className="size-3.5"
            strokeWidth={1.5}
            fill={object.flagged ? "currentColor" : "none"}
          />
        </button>
        <div className="flex-1" />
        <span
          title={object.assignee || "Unassigned"}
          className="flex size-7 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground"
        >
          {initial || "?"}
        </span>
      </div>
    </div>
  )
}

/** An embed added from the toolbar has no address yet; this asks for one. */
function EmbedPrompt({
  object,
  onChange,
}: {
  object: CanvasEmbedObject
  onChange: (object: CanvasObject) => void
}) {
  return (
    <form
      className="flex size-full flex-col items-center justify-center gap-2 rounded-xl bg-card p-6 ring-1 ring-border/70"
      onSubmit={(event) => {
        event.preventDefault()
        const field = new FormData(event.currentTarget).get("url")
        const value = typeof field === "string" ? field.trim() : ""
        if (!value) return
        // A bare host gets https; a typed http:// one is upgraded unless it
        // points at this machine.
        const url = preferHttps(
          /^https?:\/\//i.test(value) ? value : `https://${value}`
        )
        onChange({ ...object, url, title: describeUrl(url) })
      }}
    >
      <GlobeIcon className="size-5 text-muted-foreground" strokeWidth={1.5} />
      <p className="text-[11px] text-muted-foreground">
        Paste a link to embed the page.
      </p>
      <div className="flex w-full max-w-sm items-center gap-1.5">
        <input
          name="url"
          type="text"
          autoFocus
          placeholder="https://…"
          aria-label="Page address"
          className="min-w-0 flex-1 rounded-md border border-border/60 bg-input/30 px-2 py-1.5 text-[12px] outline-none focus-visible:border-ring"
        />
        <button
          type="submit"
          className="rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring"
        >
          Embed
        </button>
      </div>
    </form>
  )
}
