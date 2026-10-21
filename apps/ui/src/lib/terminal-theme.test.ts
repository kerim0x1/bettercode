import { describe, expect, it } from "vitest"
import {
  DARK_TERMINAL_PALETTE,
  LIGHT_TERMINAL_PALETTE,
  buildTerminalTheme,
  importedTerminalColors,
  parseHexColor,
  relativeLuminance,
  rgbaToCss,
  type TerminalThemeTokens,
} from "./terminal-theme"

const DARK: TerminalThemeTokens = {
  background: [15, 15, 15, 1],
  foreground: [250, 250, 250, 1],
  primary: [232, 232, 232, 1],
  mutedForeground: [161, 161, 161, 1],
}

const LIGHT: TerminalThemeTokens = {
  background: [255, 255, 255, 1],
  foreground: [10, 10, 10, 1],
  primary: [52, 52, 52, 1],
  mutedForeground: [115, 115, 115, 1],
}

describe("terminal colors", () => {
  it("parses the hex forms VS Code themes use", () => {
    expect(parseHexColor("#0f0")).toEqual([0, 255, 0, 1])
    expect(parseHexColor("#11223380")).toEqual([17, 34, 51, 128 / 255])
    expect(parseHexColor("red")).toBeNull()
    expect(parseHexColor("#12345")).toBeNull()
    expect(parseHexColor(undefined)).toBeNull()
  })

  it("writes opaque colors as hex and translucent ones as rgba", () => {
    expect(rgbaToCss([15, 15, 15, 1])).toBe("#0f0f0f")
    expect(rgbaToCss([255, 0, 128, 0.25])).toBe("rgba(255, 0, 128, 0.25)")
    expect(rgbaToCss([300, -4, 12.6, 1])).toBe("#ff000d")
  })

  it("orders luminance from black to white", () => {
    expect(relativeLuminance([0, 0, 0, 1])).toBe(0)
    expect(relativeLuminance([255, 255, 255, 1])).toBeCloseTo(1)
  })
})

describe("buildTerminalTheme", () => {
  it("takes the surface, text and cursor from the app's tokens", () => {
    const theme = buildTerminalTheme(DARK)
    expect(theme.background).toBe("#0f0f0f")
    expect(theme.foreground).toBe("#fafafa")
    expect(theme.cursor).toBe("#fafafa")
    expect(theme.cursorAccent).toBe("#0f0f0f")
    expect(theme.selectionBackground).toBe("rgba(232, 232, 232, 0.32)")
  })

  it("picks the ANSI set that reads on the background", () => {
    expect(buildTerminalTheme(DARK).yellow).toBe(DARK_TERMINAL_PALETTE.yellow)
    expect(buildTerminalTheme(LIGHT).yellow).toBe(LIGHT_TERMINAL_PALETTE.yellow)
  })

  it("uses an imported theme's own terminal colors", () => {
    const imported = importedTerminalColors({
      "terminal.ansiRed": "#ff5555",
      "terminal.ansiBrightBlue": "#6272A4",
      "terminalCursor.foreground": "#f8f8f2",
      "terminal.ansiGreen": "url(javascript:alert(1))",
      "editor.background": "#282a36",
    })
    expect(imported).toEqual({
      red: "#ff5555",
      brightBlue: "#6272a4",
      cursor: "#f8f8f2",
    })
    const theme = buildTerminalTheme(DARK, imported)
    expect(theme.red).toBe("#ff5555")
    expect(theme.green).toBe(DARK_TERMINAL_PALETTE.green)
    expect(theme.background).toBe("#0f0f0f")
  })
})
