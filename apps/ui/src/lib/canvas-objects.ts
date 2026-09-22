import type { CanvasPoint, CanvasRect } from "@/lib/project-canvas"

/**
 * Everything on the canvas that is not a project card or a sticky note:
 * text, pictures, embedded pages, shapes, frames and task cards.
 *
 * One flat model with a `kind` tag rather than a class per shape — the board
 * moves, resizes, stores and wires them all the same way, and only the body
 * of the card differs.
 */

export const CANVAS_OBJECTS_STORAGE_KEY = "betterc0de.canvas-objects.v1"

export const CANVAS_OBJECT_KINDS = [
  "text",
  "shape",
  "image",
  "embed",
  "frame",
  "task",
] as const
export type CanvasObjectKind = (typeof CANVAS_OBJECT_KINDS)[number]

export const TEXT_SIZES = ["s", "m", "l", "xl"] as const
export type TextSize = (typeof TEXT_SIZES)[number]

export const TEXT_ALIGNS = ["left", "center", "right"] as const
export type TextAlign = (typeof TEXT_ALIGNS)[number]

export const OBJECT_COLORS = [
  "default",
  "amber",
  "sky",
  "emerald",
  "rose",
  "violet",
] as const
export type ObjectColor = (typeof OBJECT_COLORS)[number]

export const SHAPE_FORMS = ["rect", "rounded", "ellipse", "diamond"] as const
export type ShapeForm = (typeof SHAPE_FORMS)[number]

/** Shared by everything that shows words the user can style. */
export interface CanvasTextStyle {
  size: TextSize
  bold: boolean
  italic: boolean
  mono: boolean
  align: TextAlign
  color: ObjectColor
}

interface CanvasObjectBase extends CanvasRect {
  id: string
}

export interface CanvasTextObject extends CanvasObjectBase, CanvasTextStyle {
  kind: "text"
  text: string
}

export interface CanvasShapeObject extends CanvasObjectBase, CanvasTextStyle {
  kind: "shape"
  shape: ShapeForm
  text: string
  fill: ObjectColor
}

export interface CanvasImageObject extends CanvasObjectBase {
  kind: "image"
  /** Pasted or dropped bytes, kept in the asset store under this id. */
  assetId?: string
  /** A picture left where it lives on the web, referenced by address. */
  src?: string
  alt: string
  /** Natural aspect, so a resize can keep the picture undistorted. */
  ratio?: number
}

/**
 * An embedded page. A local file is stored as project + relative path, never
 * as its live URL: that URL is a one-session grant from the main process and
 * has to be asked for again after a restart.
 */
export interface CanvasEmbedObject extends CanvasObjectBase {
  kind: "embed"
  source: "web" | "local"
  title: string
  url?: string
  projectPath?: string
  relativePath?: string
}

export interface CanvasFrameObject extends CanvasObjectBase {
  kind: "frame"
  title: string
}

export interface CanvasTaskObject extends CanvasObjectBase {
  kind: "task"
  breadcrumb: string
  title: string
  status: string
  statusColor: ObjectColor
  assignee: string
  flagged: boolean
}

export type CanvasObject =
  | CanvasTextObject
  | CanvasShapeObject
  | CanvasImageObject
  | CanvasEmbedObject
  | CanvasFrameObject
  | CanvasTaskObject

export const OBJECT_LABELS: Record<CanvasObjectKind, string> = {
  text: "Text",
  shape: "Shape",
  image: "Image",
  embed: "Embed",
  frame: "Frame",
  task: "Task",
}

interface SizeRule {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export const OBJECT_SIZES: Record<CanvasObjectKind, SizeRule> = {
  text: { width: 320, height: 96, minWidth: 80, minHeight: 40 },
  shape: { width: 260, height: 180, minWidth: 80, minHeight: 60 },
  image: { width: 360, height: 240, minWidth: 60, minHeight: 60 },
  embed: { width: 560, height: 380, minWidth: 200, minHeight: 160 },
  frame: { width: 680, height: 440, minWidth: 160, minHeight: 120 },
  task: { width: 380, height: 168, minWidth: 240, minHeight: 120 },
}

const MAX_SIZE = 4000

export const DEFAULT_TEXT_STYLE: CanvasTextStyle = {
  size: "m",
  bold: false,
  italic: false,
  mono: false,
  align: "left",
  color: "default",
}

/** A new object of the given kind, its top-left corner at `point`. */
export function createCanvasObject(
  kind: CanvasObjectKind,
  point: CanvasPoint,
  patch: Partial<CanvasObject> = {}
): CanvasObject {
  const size = OBJECT_SIZES[kind]
  const base = {
    id: crypto.randomUUID(),
    x: Math.round(point.x),
    y: Math.round(point.y),
    width: size.width,
    height: size.height,
  }
  const made = ((): CanvasObject => {
    switch (kind) {
      case "text":
        return { ...base, kind, text: "", ...DEFAULT_TEXT_STYLE }
      case "shape":
        return {
          ...base,
          kind,
          shape: "rounded",
          text: "",
          fill: "default",
          ...DEFAULT_TEXT_STYLE,
          align: "center",
        }
      case "image":
        return { ...base, kind, alt: "" }
      case "embed":
        return { ...base, kind, source: "web", title: "", url: "" }
      case "frame":
        return { ...base, kind, title: "Frame" }
      case "task":
        return {
          ...base,
          kind,
          breadcrumb: "",
          title: "",
          status: "TO DO",
          statusColor: "sky",
          assignee: "",
          flagged: false,
        }
    }
  })()
  return clampObject({ ...made, ...patch, id: made.id, kind } as CanvasObject)
}

function clampSize(kind: CanvasObjectKind, width: number, height: number) {
  const size = OBJECT_SIZES[kind]
  return {
    width: Math.round(
      Math.min(MAX_SIZE, Math.max(size.minWidth, width || size.width))
    ),
    height: Math.round(
      Math.min(MAX_SIZE, Math.max(size.minHeight, height || size.height))
    ),
  }
}

export function clampObject(object: CanvasObject): CanvasObject {
  return {
    ...object,
    x: Math.round(object.x),
    y: Math.round(object.y),
    ...clampSize(object.kind, object.width, object.height),
  }
}

export function moveObject(
  object: CanvasObject,
  point: CanvasPoint
): CanvasObject {
  return { ...object, x: Math.round(point.x), y: Math.round(point.y) }
}

export function resizeObject(
  object: CanvasObject,
  size: { width: number; height: number }
): CanvasObject {
  return { ...object, ...clampSize(object.kind, size.width, size.height) }
}

export function objectRect(object: CanvasObject): CanvasRect {
  return {
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
  }
}

/** Whether this kind carries words the format bar can style. */
export function hasText(
  object: CanvasObject
): object is CanvasTextObject | CanvasShapeObject {
  return object.kind === "text" || object.kind === "shape"
}

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback
}

function readStyle(entry: Record<string, unknown>): CanvasTextStyle {
  return {
    size: pick(entry.size, TEXT_SIZES, DEFAULT_TEXT_STYLE.size),
    bold: bool(entry.bold),
    italic: bool(entry.italic),
    mono: bool(entry.mono),
    align: pick(entry.align, TEXT_ALIGNS, DEFAULT_TEXT_STYLE.align),
    color: pick(entry.color, OBJECT_COLORS, DEFAULT_TEXT_STYLE.color),
  }
}

/**
 * Storage is rebuilt field by field: it survives an older release, a hand
 * edit, or a half-written entry without taking the whole board down.
 */
export function readCanvasObjects(raw: string | null): CanvasObject[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const objects: CanvasObject[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== "string" || !entry.id) continue
    if (!CANVAS_OBJECT_KINDS.includes(entry.kind as CanvasObjectKind)) continue
    const kind = entry.kind as CanvasObjectKind
    const size = OBJECT_SIZES[kind]
    const base = {
      id: entry.id,
      x: typeof entry.x === "number" && Number.isFinite(entry.x) ? entry.x : 0,
      y: typeof entry.y === "number" && Number.isFinite(entry.y) ? entry.y : 0,
      width: typeof entry.width === "number" ? entry.width : size.width,
      height: typeof entry.height === "number" ? entry.height : size.height,
    }
    let object: CanvasObject
    switch (kind) {
      case "text":
        object = { ...base, kind, text: text(entry.text), ...readStyle(entry) }
        break
      case "shape":
        object = {
          ...base,
          kind,
          shape: pick(entry.shape, SHAPE_FORMS, "rounded"),
          text: text(entry.text),
          fill: pick(entry.fill, OBJECT_COLORS, "default"),
          ...readStyle(entry),
        }
        break
      case "image":
        object = {
          ...base,
          kind,
          alt: text(entry.alt),
          ...(typeof entry.assetId === "string" && entry.assetId
            ? { assetId: entry.assetId }
            : {}),
          ...(typeof entry.src === "string" && entry.src
            ? { src: entry.src }
            : {}),
          ...(typeof entry.ratio === "number" && entry.ratio > 0
            ? { ratio: entry.ratio }
            : {}),
        }
        // A picture with neither bytes nor an address cannot be drawn.
        if (!("assetId" in object) && !("src" in object)) continue
        break
      case "embed": {
        const source = entry.source === "local" ? "local" : "web"
        object = {
          ...base,
          kind,
          source,
          title: text(entry.title),
          ...(typeof entry.url === "string" ? { url: entry.url } : {}),
          ...(typeof entry.projectPath === "string"
            ? { projectPath: entry.projectPath }
            : {}),
          ...(typeof entry.relativePath === "string"
            ? { relativePath: entry.relativePath }
            : {}),
        }
        const embed = object as CanvasEmbedObject
        if (source === "web" ? !embed.url : !embed.projectPath) continue
        break
      }
      case "frame":
        object = { ...base, kind, title: text(entry.title, "Frame") }
        break
      case "task":
        object = {
          ...base,
          kind,
          breadcrumb: text(entry.breadcrumb),
          title: text(entry.title),
          status: text(entry.status, "TO DO"),
          statusColor: pick(entry.statusColor, OBJECT_COLORS, "sky"),
          assignee: text(entry.assignee),
          flagged: bool(entry.flagged),
        }
        break
    }
    objects.push(clampObject(object))
  }
  return objects
}

/**
 * Asset ids still referenced by a board, so the store can drop the rest.
 * Pasted pictures would otherwise pile up for the life of the install.
 */
export function referencedAssets(
  objects: readonly CanvasObject[]
): Set<string> {
  const ids = new Set<string>()
  for (const object of objects) {
    if (object.kind === "image" && object.assetId) ids.add(object.assetId)
  }
  return ids
}
