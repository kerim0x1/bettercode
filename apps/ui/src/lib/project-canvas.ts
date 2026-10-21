import type { ThreadSettings } from "@/lib/chat/types"
import { CANVAS_DEVICE_PRESETS } from "@/components/browser-preview/constants"

export type CanvasPoint = { x: number; y: number }
export type CanvasRect = CanvasPoint & { width: number; height: number }
export type CanvasPlacement = CanvasPoint & {
  threadId: string
  hidden?: boolean
}
export const PROJECT_CANVAS_STORAGE_KEY = "betterc0de.project-canvas.v1"
export const PREVIEW_SCALE = 0.5
export const PROJECT_PADDING = 16
export const PROJECT_HEADER_HEIGHT = 156
export const PROJECT_TOOLBAR_HEIGHT = 52
export const PROJECT_FOOTER_HEIGHT = 44
export const PROJECT_GAP = 64
/** Unscaled card pixels of the runtime pane, about a mobile preview. */
export const RUNTIME_PANE_WIDTH = 420
export const RUNTIME_PANE_MIN_HEIGHT = 280

export function canvasDevices(settings?: ThreadSettings) {
  const ids = settings?.designDevicePresets
  const selected = CANVAS_DEVICE_PRESETS.filter((device) =>
    ids?.includes(device.id)
  )
  if (selected.length) return selected
  return [
    CANVAS_DEVICE_PRESETS.find(
      (device) => device.id === settings?.designDevicePreset
    ) ?? CANVAS_DEVICE_PRESETS[0],
  ]
}

export const CARD_SCALE_MIN = 0.25
export const CARD_SCALE_MAX = 2

/** The card's own size factor, defaulting to 1 and clamped to the range. */
export function canvasCardScale(
  settings?: Pick<ThreadSettings, "designCardScale">
): number {
  const value = settings?.designCardScale
  if (typeof value !== "number" || !Number.isFinite(value)) return 1
  return Math.min(CARD_SCALE_MAX, Math.max(CARD_SCALE_MIN, value))
}

/**
 * The scale a corner drag lands on: the card keeps its aspect ratio, so the
 * horizontal travel alone decides. `deltaX` is in screen pixels; the stage
 * zoom turns it back into stage pixels.
 */
export function resizeCardScale(input: {
  startScale: number
  startWidth: number
  deltaX: number
  zoom: number
}): number {
  const width = input.startWidth + input.deltaX / Math.max(input.zoom, 0.01)
  const ratio = width / Math.max(input.startWidth, 1)
  const next = Math.round(input.startScale * ratio * 100) / 100
  return Math.min(CARD_SCALE_MAX, Math.max(CARD_SCALE_MIN, next))
}

/** Layout in card-local pixels. The entire card is scaled once at its root. */
export function canvasProjectLayout(settings?: ThreadSettings) {
  const devices = canvasDevices(settings)
  const runtimePaneWidth = settings?.designRuntimePane ? RUNTIME_PANE_WIDTH : 0
  const previewHeight = Math.max(
    ...devices.map((device) => device.height * PREVIEW_SCALE),
    runtimePaneWidth > 0 ? RUNTIME_PANE_MIN_HEIGHT : 0
  )
  return {
    runtimePaneWidth,
    previewHeight,
    width: Math.max(
      520,
      devices.reduce((sum, device) => sum + device.width * PREVIEW_SCALE, 0) +
        (runtimePaneWidth > 0 ? runtimePaneWidth + PROJECT_PADDING : 0) +
        (devices.length - 1) * PROJECT_PADDING +
        PROJECT_PADDING * 2
    ),
    height:
      PROJECT_HEADER_HEIGHT +
      PROJECT_TOOLBAR_HEIGHT +
      PROJECT_FOOTER_HEIGHT +
      PROJECT_PADDING * 2 +
      28 +
      previewHeight,
  }
}

/** Occupied stage pixels, shared by rendering, placement, fitting and resizing. */
export function canvasProjectSize(settings?: ThreadSettings) {
  const layout = canvasProjectLayout(settings)
  const scale = canvasCardScale(settings)
  return { width: layout.width * scale, height: layout.height * scale }
}

/** Height of the device caption row above each preview, in card pixels. */
export const DEVICE_LABEL_HEIGHT = 28

/**
 * Where each device preview sits inside a card placed at `origin`, in stage
 * pixels (card scale applied). Mirrors the card markup: header, padded
 * toolbar, then the devices side by side under their caption rows.
 */
export function canvasDeviceSlots(
  settings: ThreadSettings | undefined,
  origin: CanvasPoint
): Array<CanvasRect & { deviceId: string }> {
  const scale = canvasCardScale(settings)
  const top = PROJECT_HEADER_HEIGHT + PROJECT_PADDING + PROJECT_TOOLBAR_HEIGHT
  let left = PROJECT_PADDING
  return canvasDevices(settings).map((device) => {
    const width = device.width * PREVIEW_SCALE
    const slot = {
      deviceId: device.id,
      x: origin.x + left * scale,
      y: origin.y + top * scale,
      width: width * scale,
      height: (DEVICE_LABEL_HEIGHT + device.height * PREVIEW_SCALE) * scale,
    }
    left += width + PROJECT_PADDING
    return slot
  })
}

export function readCanvasPlacements(raw: string | null): CanvasPlacement[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]")
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return []
      const { threadId, x, y, hidden } = item as CanvasPlacement
      if (
        typeof threadId !== "string" ||
        !threadId.trim() ||
        seen.has(threadId) ||
        typeof x !== "number" ||
        typeof y !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        Math.abs(x) > 1e6 ||
        Math.abs(y) > 1e6
      )
        return []
      seen.add(threadId)
      return [{ threadId, x, y, ...(hidden === true ? { hidden: true } : {}) }]
    })
  } catch {
    return []
  }
}

export function canvasBounds(rects: CanvasRect[]): CanvasRect {
  if (!rects.length) return { x: 0, y: 0, ...canvasProjectSize() }
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  }
}

export function nextCanvasPosition(rects: CanvasRect[]): CanvasPoint {
  if (!rects.length) return { x: 0, y: 0 }
  const bounds = canvasBounds(rects)
  return { x: bounds.x + bounds.width + PROJECT_GAP, y: bounds.y }
}

export function screenToCanvas(
  point: CanvasPoint,
  viewport: CanvasPoint,
  pan: CanvasPoint,
  zoom: number
): CanvasPoint {
  return {
    x: (point.x - viewport.x - pan.x) / zoom,
    y: (point.y - viewport.y - pan.y) / zoom,
  }
}

export function moveOnCanvas(
  origin: CanvasPoint,
  delta: CanvasPoint,
  zoom: number
): CanvasPoint {
  return { x: origin.x + delta.x / zoom, y: origin.y + delta.y / zoom }
}
