export const EDITOR_CHAT_PANEL_DEFAULT_WIDTH = 450
export const EDITOR_CHAT_PANEL_MIN_WIDTH = 300
export const EDITOR_CHAT_PANEL_MAX_WIDTH = 800
const LEGACY_EDITOR_CHAT_PANEL_DEFAULT_WIDTHS = new Set([384, 520])

export const EDITOR_SIDEBAR_MIN_WIDTH = 240
export const EDITOR_SIDEBAR_MAX_WIDTH = 520

// Agent-mode left sidebar bounds (mirrors the resize clamp in left-sidebar.tsx).
export const AGENT_SIDEBAR_MIN_WIDTH = 220
export const AGENT_SIDEBAR_MAX_WIDTH = 500

// Stored sidebar widths are tuned against a 1920px-wide reference display.
// Rendering them as `vw` keeps the sidebar the same proportion of the screen
// on any resolution (laptop → ultrawide); the clamp keeps it usable at the
// extremes. 1920 / 100 = 19.2px per 1vw at the reference width.
export const SIDEBAR_REFERENCE_VIEWPORT = 1920

// Above this viewport width the agent sidebar scales its contents up (via the
// `.betterc0de-left-sidebar-scale` zoom rule in index.css) so the controls stay
// comfortable on larger displays. Keep these in sync with that media query.
export const SIDEBAR_WIDE_BREAKPOINT = 1080
export const SIDEBAR_WIDE_SCALE = 1.15

export function clampEditorChatPanelWidth(value: unknown): number {
  if (
    typeof value === "number" &&
    LEGACY_EDITOR_CHAT_PANEL_DEFAULT_WIDTHS.has(value)
  ) {
    return EDITOR_CHAT_PANEL_DEFAULT_WIDTH
  }

  return clampNumber(
    value,
    EDITOR_CHAT_PANEL_DEFAULT_WIDTH,
    EDITOR_CHAT_PANEL_MIN_WIDTH,
    EDITOR_CHAT_PANEL_MAX_WIDTH
  )
}

export function clampEditorSidebarWidth(value: unknown): number {
  return clampNumber(
    value,
    300,
    EDITOR_SIDEBAR_MIN_WIDTH,
    EDITOR_SIDEBAR_MAX_WIDTH
  )
}

// Convert a reference-px sidebar width into a responsive `vw`-based CSS width,
// clamped to [minPx, maxPx] so it never becomes unusably narrow or wide.
export function responsiveSidebarWidth(
  widthPx: number,
  minPx: number,
  maxPx: number
): string {
  const vw = (widthPx / SIDEBAR_REFERENCE_VIEWPORT) * 100
  return `clamp(${minPx}px, ${vw.toFixed(3)}vw, ${maxPx}px)`
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const number =
    typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

// Design-mode chat column. Wider than the old fixed 390px by default and
// user-resizable; the canvas keeps at least `DESIGN_CANVAS_MIN_WIDTH` so a
// generous chat never squeezes the preview into uselessness.
export const DESIGN_CHAT_PANEL_DEFAULT_WIDTH = 560
export const DESIGN_CHAT_PANEL_MIN_WIDTH = 360
export const DESIGN_CHAT_PANEL_MAX_WIDTH = 960
export const DESIGN_CANVAS_MIN_WIDTH = 480
export const DESIGN_CHAT_PANEL_STORAGE_KEY = "betterc0de-design-chat-width"
// Earlier default; a stored value equal to it was never a user choice.
const LEGACY_DESIGN_CHAT_PANEL_DEFAULT_WIDTHS = new Set([480])

/**
 * Clamp a requested design chat width to [min, max] and to what the viewport
 * leaves for the canvas. The viewport bound wins when the window is small,
 * but never pushes the column under its minimum.
 */
export function clampDesignChatPanelWidth(
  value: unknown,
  viewportWidth: number
): number {
  const viewportMax = Math.max(
    DESIGN_CHAT_PANEL_MIN_WIDTH,
    Math.min(
      DESIGN_CHAT_PANEL_MAX_WIDTH,
      viewportWidth - DESIGN_CANVAS_MIN_WIDTH
    )
  )
  return clampNumber(
    value,
    DESIGN_CHAT_PANEL_DEFAULT_WIDTH,
    DESIGN_CHAT_PANEL_MIN_WIDTH,
    viewportMax
  )
}

/** Stored width or the default; tolerant of missing or blocked storage. */
export function readStoredDesignChatPanelWidth(
  storage: Pick<Storage, "getItem"> | null | undefined
): number {
  try {
    const raw = storage?.getItem(DESIGN_CHAT_PANEL_STORAGE_KEY)
    const parsed = raw === null || raw === undefined ? NaN : Number(raw)
    if (!Number.isFinite(parsed)) return DESIGN_CHAT_PANEL_DEFAULT_WIDTH
    return LEGACY_DESIGN_CHAT_PANEL_DEFAULT_WIDTHS.has(parsed)
      ? DESIGN_CHAT_PANEL_DEFAULT_WIDTH
      : parsed
  } catch {
    return DESIGN_CHAT_PANEL_DEFAULT_WIDTH
  }
}
