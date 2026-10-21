import { describe, expect, it } from "vitest"
import {
  resolveShortcutParityAction,
  SHORTCUT_PARITY_MANIFEST,
  type ShortcutKeyEventLike,
  type ShortcutParityContext,
} from "@/lib/shortcut-parity"

const DEFAULT_CONTEXT: ShortcutParityContext = {
  appMode: "agent",
  inMonaco: false,
  inTextEntry: false,
  inTerminal: false,
  previewAvailable: false,
}

function key(
  code: string,
  options: Partial<ShortcutKeyEventLike> = {}
): ShortcutKeyEventLike {
  return { code, ctrlKey: true, ...options }
}

describe("SHORTCUT_PARITY_MANIFEST", () => {
  it("tracks every Phase-5 compatibility binding and unsupported seam", () => {
    const byId = new Map(
      SHORTCUT_PARITY_MANIFEST.map((entry) => [entry.id, entry])
    )

    expect(byId.get("command-palette")?.binding).toBe("mod+k")
    expect(byId.get("terminal-toggle")?.binding).toBe("mod+j")
    expect(byId.get("terminal-split")?.status).toBe("contextual")
    expect(byId.get("terminal-split")?.scope).toBe("terminal")
    expect(byId.get("terminal-split-down")?.binding).toBe("mod+shift+d")
    expect(byId.get("terminal-split-down")?.scope).toBe("terminal")
    expect(byId.get("terminal-new")?.scope).toBe("terminal")
    expect(byId.get("terminal-close")?.scope).toBe("terminal")
    expect(byId.get("preview-toggle")?.binding).toBe("mod+shift+j")
    expect(byId.get("preview-refresh")?.binding).toBe("mod+r")
    expect(byId.get("preview-focus-location")?.binding).toBe("mod+l")
    expect(byId.get("preview-zoom-in")?.binding).toBe("mod+=")
    expect(byId.get("preview-zoom-out")?.binding).toBe("mod+-")
    expect(byId.get("preview-zoom-reset")?.binding).toBe("mod+0")
    expect(byId.get("new-chat")?.status).toBe("preserved-existing")
    expect(byId.get("new-task-shift-o")?.status).toBe("preserved-existing")
    expect(byId.get("new-task-shift-n")?.status).toBe("preserved-existing")
    expect(byId.get("open-favorite")?.status).toBe("unavailable")
  })
})

describe("resolveShortcutParityAction", () => {
  it("opens the command palette without stealing Monaco or input chords", () => {
    expect(resolveShortcutParityAction(key("KeyK"), DEFAULT_CONTEXT)).toBe(
      "command-palette"
    )
    expect(
      resolveShortcutParityAction(key("KeyK"), {
        ...DEFAULT_CONTEXT,
        inMonaco: true,
      })
    ).toBeNull()
    expect(
      resolveShortcutParityAction(key("KeyK"), {
        ...DEFAULT_CONTEXT,
        inTextEntry: true,
      })
    ).toBeNull()
  })

  it("adds terminal toggle without overriding composer newline handling", () => {
    expect(resolveShortcutParityAction(key("KeyJ"), DEFAULT_CONTEXT)).toBe(
      "terminal-toggle"
    )
    expect(
      resolveShortcutParityAction(key("KeyJ"), {
        ...DEFAULT_CONTEXT,
        inTextEntry: true,
      })
    ).toBeNull()
    expect(
      resolveShortcutParityAction(key("KeyJ"), {
        ...DEFAULT_CONTEXT,
        inTerminal: true,
        inTextEntry: true,
      })
    ).toBeNull()
  })

  it("gives terminal-focused new and close precedence over global actions", () => {
    const terminalContext = {
      ...DEFAULT_CONTEXT,
      inTerminal: true,
      inTextEntry: true,
    }

    expect(resolveShortcutParityAction(key("KeyN"), terminalContext)).toBe(
      "terminal-new"
    )
    expect(resolveShortcutParityAction(key("KeyW"), terminalContext)).toBe(
      "terminal-close"
    )
  })

  it("splits the focused terminal right or down, and only inside a terminal", () => {
    const terminalContext = {
      ...DEFAULT_CONTEXT,
      inTerminal: true,
      inTextEntry: true,
    }

    expect(resolveShortcutParityAction(key("KeyD"), terminalContext)).toBe(
      "terminal-split-right"
    )
    expect(
      resolveShortcutParityAction(
        key("KeyD", { shiftKey: true }),
        terminalContext
      )
    ).toBe("terminal-split-down")
    // Elsewhere Ctrl+Shift+D stays the diff panel's (use-global-shortcuts).
    expect(resolveShortcutParityAction(key("KeyD"), DEFAULT_CONTEXT)).toBeNull()
    expect(
      resolveShortcutParityAction(
        key("KeyD", { shiftKey: true }),
        DEFAULT_CONTEXT
      )
    ).toBeNull()
  })

  it("keeps BetterC0de's existing new-task chord behavior", () => {
    expect(resolveShortcutParityAction(key("KeyN"), DEFAULT_CONTEXT)).toBe(
      "new-agent"
    )
    expect(
      resolveShortcutParityAction(
        key("KeyN", { shiftKey: true }),
        DEFAULT_CONTEXT
      )
    ).toBe("new-project")
    expect(
      resolveShortcutParityAction(
        key("KeyO", { shiftKey: true }),
        DEFAULT_CONTEXT
      )
    ).toBe("open-shift-o")
    expect(resolveShortcutParityAction(key("KeyO"), DEFAULT_CONTEXT)).toBeNull()
  })

  it("routes preview commands only to an applicable, non-editable surface", () => {
    const editorContext = {
      ...DEFAULT_CONTEXT,
      appMode: "editor" as const,
    }
    const previewContext = {
      ...editorContext,
      previewAvailable: true,
    }

    expect(
      resolveShortcutParityAction(
        key("KeyJ", { shiftKey: true }),
        editorContext
      )
    ).toBe("preview-toggle")
    expect(resolveShortcutParityAction(key("KeyR"), previewContext)).toBe(
      "preview-refresh"
    )
    expect(resolveShortcutParityAction(key("KeyL"), previewContext)).toBe(
      "preview-focus-location"
    )
    expect(
      resolveShortcutParityAction(
        key("Equal", { key: "+", shiftKey: true }),
        previewContext
      )
    ).toBe("preview-zoom-in")
    expect(
      resolveShortcutParityAction(key("Minus", { key: "-" }), previewContext)
    ).toBe("preview-zoom-out")
    expect(
      resolveShortcutParityAction(key("Digit0", { key: "0" }), previewContext)
    ).toBe("preview-zoom-reset")
    expect(
      resolveShortcutParityAction(key("KeyR"), {
        ...editorContext,
        previewAvailable: false,
      })
    ).toBeNull()
    expect(
      resolveShortcutParityAction(key("KeyR"), {
        ...previewContext,
        inTextEntry: true,
      })
    ).toBeNull()
  })

  it("supports the platform meta key as mod", () => {
    expect(
      resolveShortcutParityAction(
        { code: "KeyJ", metaKey: true },
        DEFAULT_CONTEXT
      )
    ).toBe("terminal-toggle")
  })
})
