import type { ITheme } from "@xterm/xterm"

/**
 * The terminal's colors. Surface, text, cursor and selection come from the
 * app's tokens, so the terminal sits in the panel like the rest of the UI in
 * every theme. ANSI colors are content with their own identity: an imported
 * VS Code theme's `terminal.ansi*` colors when it has them, otherwise VS
 * Code's default dark or light set, picked by the background's luminance.
 * xterm's minimum contrast ratio keeps any of them readable.
 */

/** sRGB channels 0–255 and alpha 0–1. */
export type Rgba = readonly [number, number, number, number]

export interface TerminalAnsiPalette {
  readonly black: string
  readonly red: string
  readonly green: string
  readonly yellow: string
  readonly blue: string
  readonly magenta: string
  readonly cyan: string
  readonly white: string
  readonly brightBlack: string
  readonly brightRed: string
  readonly brightGreen: string
  readonly brightYellow: string
  readonly brightBlue: string
  readonly brightMagenta: string
  readonly brightCyan: string
  readonly brightWhite: string
}

export const DARK_TERMINAL_PALETTE: TerminalAnsiPalette = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
}

export const LIGHT_TERMINAL_PALETTE: TerminalAnsiPalette = {
  black: "#000000",
  red: "#cd3131",
  green: "#107c10",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
}

const ANSI_COLOR_KEYS = Object.keys(DARK_TERMINAL_PALETTE) as Array<
  keyof TerminalAnsiPalette
>

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; anything else is null. */
export function parseHexColor(value: unknown): Rgba | null {
  if (typeof value !== "string") return null
  const text = value.trim()
  if (!HEX_COLOR.test(text)) return null
  const digits = text.slice(1)
  const full =
    digits.length <= 4
      ? [...digits].map((digit) => digit + digit).join("")
      : digits
  const channel = (index: number) =>
    Number.parseInt(full.slice(index * 2, index * 2 + 2), 16)
  return [
    channel(0),
    channel(1),
    channel(2),
    full.length === 8 ? channel(3) / 255 : 1,
  ]
}

export function rgbaToCss(color: Rgba): string {
  const [r, g, b, a] = color.map((value, index) =>
    index < 3 ? Math.round(Math.min(255, Math.max(0, value))) : value
  ) as unknown as Rgba
  if (a >= 1) {
    return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`
  }
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.round(a * 1000) / 1000)})`
}

function withAlpha(color: Rgba, alpha: number): string {
  return rgbaToCss([color[0], color[1], color[2], alpha])
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: Rgba): number {
  const linear = (value: number) => {
    const channel = value / 255
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * linear(color[0]) +
    0.7152 * linear(color[1]) +
    0.0722 * linear(color[2])
  )
}

/**
 * The colors an imported VS Code theme sets for its terminal (its
 * `terminal.ansi*`, cursor and selection), as xterm takes them. Only hex
 * colors are read: the values come from a theme file.
 */
export function importedTerminalColors(
  colors: Readonly<Record<string, unknown>> | null | undefined
): Partial<ITheme> {
  if (!colors) return {}
  const theme: Partial<
    Record<keyof TerminalAnsiPalette | "cursor" | "selectionBackground", string>
  > = {}
  for (const key of ANSI_COLOR_KEYS) {
    const name = `terminal.ansi${key[0]!.toUpperCase()}${key.slice(1)}`
    const color = parseHexColor(colors[name])
    if (color) theme[key] = rgbaToCss(color)
  }
  const cursor = parseHexColor(colors["terminalCursor.foreground"])
  if (cursor) theme.cursor = rgbaToCss(cursor)
  const selection = parseHexColor(colors["terminal.selectionBackground"])
  if (selection) theme.selectionBackground = rgbaToCss(selection)
  return theme
}

export interface TerminalThemeTokens {
  /** `--background`: the panel's surface. */
  readonly background: Rgba
  /** `--foreground` */
  readonly foreground: Rgba
  /** `--primary`, for the selection. */
  readonly primary: Rgba
  /** `--muted-foreground`, for the scrollbar. */
  readonly mutedForeground: Rgba
}

export function buildTerminalTheme(
  tokens: TerminalThemeTokens,
  imported: Partial<ITheme> = {}
): ITheme {
  const surface: Rgba = [
    tokens.background[0],
    tokens.background[1],
    tokens.background[2],
    1,
  ]
  const dark = relativeLuminance(surface) < 0.4
  const background = rgbaToCss(surface)
  const foreground = rgbaToCss([
    tokens.foreground[0],
    tokens.foreground[1],
    tokens.foreground[2],
    1,
  ])
  return {
    ...(dark ? DARK_TERMINAL_PALETTE : LIGHT_TERMINAL_PALETTE),
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: withAlpha(tokens.primary, dark ? 0.32 : 0.22),
    selectionInactiveBackground: withAlpha(tokens.primary, dark ? 0.18 : 0.12),
    scrollbarSliderBackground: withAlpha(tokens.mutedForeground, 0.25),
    scrollbarSliderHoverBackground: withAlpha(tokens.mutedForeground, 0.4),
    scrollbarSliderActiveBackground: withAlpha(tokens.mutedForeground, 0.5),
    ...imported,
  }
}

// ── Reading the tokens from the page ─────────────────────────────────────

let colorContext: CanvasRenderingContext2D | null | undefined

/**
 * Any CSS color the page can paint (the tokens are OKLCH) as sRGB, by
 * painting one pixel; null without a DOM.
 */
export function resolveCssColor(value: string): Rgba | null {
  const text = value.trim()
  if (!text || typeof document === "undefined") return null
  if (colorContext === undefined) {
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    colorContext = canvas.getContext("2d", { willReadFrequently: true })
  }
  const context = colorContext
  if (!context) return null
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = "#000000"
  context.fillStyle = text
  context.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
  return [r ?? 0, g ?? 0, b ?? 0, (a ?? 255) / 255]
}

const FALLBACK_DARK: TerminalThemeTokens = {
  background: [15, 15, 15, 1],
  foreground: [250, 250, 250, 1],
  primary: [232, 232, 232, 1],
  mutedForeground: [161, 161, 161, 1],
}

/** The terminal theme for the tokens in effect on `element` right now. */
export function resolveTerminalTheme(
  element: Element,
  imported: Partial<ITheme> = {}
): ITheme {
  const style = getComputedStyle(element)
  const read = (name: string, fallback: Rgba): Rgba =>
    resolveCssColor(style.getPropertyValue(name)) ?? fallback
  return buildTerminalTheme(
    {
      background: read("--background", FALLBACK_DARK.background),
      foreground: read("--foreground", FALLBACK_DARK.foreground),
      primary: read("--primary", FALLBACK_DARK.primary),
      mutedForeground: read(
        "--muted-foreground",
        FALLBACK_DARK.mutedForeground
      ),
    },
    imported
  )
}
