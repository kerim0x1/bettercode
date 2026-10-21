import { describe, expect, it } from "vitest"
import {
  DESIGN_CANVAS_MIN_WIDTH,
  DESIGN_CHAT_PANEL_DEFAULT_WIDTH,
  DESIGN_CHAT_PANEL_MAX_WIDTH,
  DESIGN_CHAT_PANEL_MIN_WIDTH,
  EDITOR_CHAT_PANEL_DEFAULT_WIDTH,
  clampDesignChatPanelWidth,
  clampEditorChatPanelWidth,
  clampEditorSidebarWidth,
  readStoredDesignChatPanelWidth,
} from "@/lib/editor-layout"

describe("editor layout sizing", () => {
  it("clamps editor chat width to an IDE side-panel range", () => {
    expect(clampEditorChatPanelWidth(220)).toBe(300)
    expect(clampEditorChatPanelWidth(600)).toBe(600)
    expect(clampEditorChatPanelWidth(900)).toBe(800)
  })

  it("uses 450px as the editor chat default", () => {
    expect(EDITOR_CHAT_PANEL_DEFAULT_WIDTH).toBe(450)
  })

  it("falls back to the compact editor chat default for invalid values", () => {
    expect(clampEditorChatPanelWidth(undefined)).toBe(
      EDITOR_CHAT_PANEL_DEFAULT_WIDTH
    )
    expect(clampEditorChatPanelWidth(Number.NaN)).toBe(
      EDITOR_CHAT_PANEL_DEFAULT_WIDTH
    )
  })

  it("migrates earlier editor chat defaults to the current width", () => {
    expect(clampEditorChatPanelWidth(384)).toBe(EDITOR_CHAT_PANEL_DEFAULT_WIDTH)
    expect(clampEditorChatPanelWidth(520)).toBe(EDITOR_CHAT_PANEL_DEFAULT_WIDTH)
  })

  it("keeps the editor explorer useful for nested paths and large displays", () => {
    expect(clampEditorSidebarWidth(160)).toBe(240)
    expect(clampEditorSidebarWidth(320)).toBe(320)
    expect(clampEditorSidebarWidth(900)).toBe(520)
  })
})

describe("design chat panel width", () => {
  it("defaults wider than the old fixed column and clamps to its range", () => {
    expect(clampDesignChatPanelWidth(undefined, 1920)).toBe(
      DESIGN_CHAT_PANEL_DEFAULT_WIDTH
    )
    expect(DESIGN_CHAT_PANEL_DEFAULT_WIDTH).toBeGreaterThanOrEqual(560)
    expect(clampDesignChatPanelWidth(100, 1920)).toBe(
      DESIGN_CHAT_PANEL_MIN_WIDTH
    )
    expect(clampDesignChatPanelWidth(5000, 1920)).toBe(
      DESIGN_CHAT_PANEL_MAX_WIDTH
    )
    expect(clampDesignChatPanelWidth("wide", 1920)).toBe(
      DESIGN_CHAT_PANEL_DEFAULT_WIDTH
    )
  })

  it("leaves the canvas its minimum on a small window, but never goes under the column minimum", () => {
    expect(clampDesignChatPanelWidth(700, 1100)).toBe(
      1100 - DESIGN_CANVAS_MIN_WIDTH
    )
    expect(clampDesignChatPanelWidth(700, 700)).toBe(
      DESIGN_CHAT_PANEL_MIN_WIDTH
    )
  })

  it("reads a stored width and survives missing or throwing storage", () => {
    expect(readStoredDesignChatPanelWidth({ getItem: () => "512" })).toBe(512)
    // The previous default was never a choice; it follows the new default.
    expect(readStoredDesignChatPanelWidth({ getItem: () => "480" })).toBe(
      DESIGN_CHAT_PANEL_DEFAULT_WIDTH
    )
    expect(readStoredDesignChatPanelWidth({ getItem: () => null })).toBe(
      DESIGN_CHAT_PANEL_DEFAULT_WIDTH
    )
    expect(readStoredDesignChatPanelWidth({ getItem: () => "abc" })).toBe(
      DESIGN_CHAT_PANEL_DEFAULT_WIDTH
    )
    expect(
      readStoredDesignChatPanelWidth({
        getItem: () => {
          throw new Error("blocked")
        },
      })
    ).toBe(DESIGN_CHAT_PANEL_DEFAULT_WIDTH)
    expect(readStoredDesignChatPanelWidth(null)).toBe(
      DESIGN_CHAT_PANEL_DEFAULT_WIDTH
    )
  })
})
