export type ShortcutParityStatus =
  | "active"
  | "contextual"
  | "preserved-existing"
  | "unavailable"

export type ShortcutParityScope = "global" | "editor" | "terminal" | "preview"

export type ShortcutParityAction =
  | "command-palette"
  | "terminal-toggle"
  | "terminal-new"
  | "terminal-close"
  | "terminal-split-right"
  | "terminal-split-down"
  | "preview-toggle"
  | "preview-refresh"
  | "preview-focus-location"
  | "preview-zoom-in"
  | "preview-zoom-out"
  | "preview-zoom-reset"
  | "new-agent"
  | "new-project"
  | "open-shift-o"

type ShortcutFocusGuard = "monaco" | "text-entry" | "terminal"

interface ShortcutChord {
  codes: readonly string[]
  keys?: readonly string[]
  shift?: boolean | "optional"
  alt?: boolean
}

export interface ShortcutParityManifestEntry {
  id: string
  binding: string
  displayBinding: string
  actionLabel: string
  scope: ShortcutParityScope
  status: ShortcutParityStatus
  action: ShortcutParityAction | null
  chord: ShortcutChord
  guards?: readonly ShortcutFocusGuard[]
  showInShortcutDialog?: boolean
  note?: string
}

/**
 * Compatibility bindings tracked by the Phase-5 parity inventory.
 *
 * Entries marked `preserved-existing` intentionally retain BetterC0de's
 * current action for a colliding chord. `unavailable` entries document
 * reference bindings that have no authoritative BetterC0de primitive and are
 * therefore not installed.
 */
export const SHORTCUT_PARITY_MANIFEST: readonly ShortcutParityManifestEntry[] =
  [
    {
      id: "terminal-new",
      binding: "mod+n",
      displayBinding: "Ctrl+N",
      actionLabel: "New Terminal",
      scope: "terminal",
      status: "contextual",
      action: "terminal-new",
      chord: { codes: ["KeyN"] },
      showInShortcutDialog: true,
    },
    {
      id: "terminal-close",
      binding: "mod+w",
      displayBinding: "Ctrl+W",
      actionLabel: "Close Active Terminal",
      scope: "terminal",
      status: "contextual",
      action: "terminal-close",
      chord: { codes: ["KeyW"] },
      showInShortcutDialog: true,
    },
    {
      id: "command-palette",
      binding: "mod+k",
      displayBinding: "Ctrl+K",
      actionLabel: "Command Palette",
      scope: "global",
      status: "active",
      action: "command-palette",
      chord: { codes: ["KeyK"] },
      guards: ["monaco", "text-entry", "terminal"],
    },
    {
      id: "terminal-toggle",
      binding: "mod+j",
      displayBinding: "Ctrl+J",
      actionLabel: "Toggle Terminal",
      scope: "global",
      status: "active",
      action: "terminal-toggle",
      chord: { codes: ["KeyJ"] },
      guards: ["monaco", "text-entry", "terminal"],
      showInShortcutDialog: true,
    },
    {
      id: "preview-toggle",
      binding: "mod+shift+j",
      displayBinding: "Ctrl+Shift+J",
      actionLabel: "Toggle Browser Preview",
      scope: "editor",
      status: "contextual",
      action: "preview-toggle",
      chord: { codes: ["KeyJ"], shift: true },
      guards: ["monaco", "text-entry", "terminal"],
      showInShortcutDialog: true,
    },
    {
      id: "preview-refresh",
      binding: "mod+r",
      displayBinding: "Ctrl+R",
      actionLabel: "Refresh Preview",
      scope: "preview",
      status: "contextual",
      action: "preview-refresh",
      chord: { codes: ["KeyR"] },
      guards: ["monaco", "text-entry", "terminal"],
      showInShortcutDialog: true,
    },
    {
      id: "preview-focus-location",
      binding: "mod+l",
      displayBinding: "Ctrl+L",
      actionLabel: "Focus Preview URL",
      scope: "preview",
      status: "contextual",
      action: "preview-focus-location",
      chord: { codes: ["KeyL"] },
      guards: ["monaco", "text-entry", "terminal"],
      showInShortcutDialog: true,
    },
    {
      id: "preview-zoom-in",
      binding: "mod+=",
      displayBinding: "Ctrl+=",
      actionLabel: "Zoom Preview In",
      scope: "preview",
      status: "contextual",
      action: "preview-zoom-in",
      chord: {
        codes: ["Equal", "NumpadAdd"],
        keys: ["=", "+"],
        shift: "optional",
      },
      guards: ["monaco", "text-entry", "terminal"],
      showInShortcutDialog: true,
    },
    {
      id: "preview-zoom-out",
      binding: "mod+-",
      displayBinding: "Ctrl+-",
      actionLabel: "Zoom Preview Out",
      scope: "preview",
      status: "contextual",
      action: "preview-zoom-out",
      chord: {
        codes: ["Minus", "NumpadSubtract"],
        keys: ["-"],
      },
      guards: ["monaco", "text-entry", "terminal"],
      showInShortcutDialog: true,
    },
    {
      id: "preview-zoom-reset",
      binding: "mod+0",
      displayBinding: "Ctrl+0",
      actionLabel: "Reset Preview Zoom",
      scope: "preview",
      status: "contextual",
      action: "preview-zoom-reset",
      chord: {
        codes: ["Digit0", "Numpad0"],
        keys: ["0"],
      },
      guards: ["monaco", "text-entry", "terminal"],
      showInShortcutDialog: true,
    },
    {
      id: "new-chat",
      binding: "mod+n",
      displayBinding: "Ctrl+N",
      actionLabel: "New Agent",
      scope: "global",
      status: "preserved-existing",
      action: "new-agent",
      chord: { codes: ["KeyN"] },
      note: "Retains BetterC0de's existing New Agent action.",
    },
    {
      id: "new-task-shift-n",
      binding: "mod+shift+n",
      displayBinding: "Ctrl+Shift+N",
      actionLabel: "New Project",
      scope: "global",
      status: "preserved-existing",
      action: "new-project",
      chord: { codes: ["KeyN"], shift: true },
      note: "Retains BetterC0de's existing New Project action.",
    },
    {
      id: "new-task-shift-o",
      binding: "mod+shift+o",
      displayBinding: "Ctrl+Shift+O",
      actionLabel: "File Symbols / System Browser",
      scope: "global",
      status: "preserved-existing",
      action: "open-shift-o",
      chord: { codes: ["KeyO"], shift: true },
      note: "Retains BetterC0de's mode-specific existing action.",
    },
    {
      id: "terminal-split",
      binding: "mod+d",
      displayBinding: "Ctrl+D",
      actionLabel: "Split Terminal Right",
      scope: "terminal",
      status: "contextual",
      action: "terminal-split-right",
      chord: { codes: ["KeyD"] },
      showInShortcutDialog: true,
      note: "Takes Ctrl+D from the shell while a terminal has focus; type exit to end a shell.",
    },
    {
      id: "terminal-split-down",
      binding: "mod+shift+d",
      displayBinding: "Ctrl+Shift+D",
      actionLabel: "Split Terminal Down",
      scope: "terminal",
      status: "contextual",
      action: "terminal-split-down",
      chord: { codes: ["KeyD"], shift: true },
      showInShortcutDialog: true,
      note: "Outside a terminal Ctrl+Shift+D keeps toggling the diff panel.",
    },
    {
      id: "open-favorite",
      binding: "mod+o",
      displayBinding: "Ctrl+O",
      actionLabel: "Open Favorite",
      scope: "global",
      status: "unavailable",
      action: null,
      chord: { codes: ["KeyO"] },
      note: "No authoritative open-favorite action exists.",
    },
  ]

export interface ShortcutKeyEventLike {
  code: string
  key?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

export interface ShortcutParityContext {
  appMode: "agent" | "editor" | "design"
  inMonaco: boolean
  inTextEntry: boolean
  inTerminal: boolean
  previewAvailable: boolean
}

export function resolveShortcutParityAction(
  event: ShortcutKeyEventLike,
  context: ShortcutParityContext
): ShortcutParityAction | null {
  if (!event.ctrlKey && !event.metaKey) return null

  for (const entry of SHORTCUT_PARITY_MANIFEST) {
    if (!entry.action || entry.status === "unavailable") continue
    if (!matchesChord(event, entry.chord)) continue
    if (entry.scope === "terminal" && !context.inTerminal) continue
    if (entry.scope === "preview" && !context.previewAvailable) continue
    if (entry.scope === "editor" && context.appMode !== "editor") continue
    if (isGuarded(entry.guards, context)) continue
    return entry.action
  }

  return null
}

function matchesChord(
  event: ShortcutKeyEventLike,
  chord: ShortcutChord
): boolean {
  const eventShift = event.shiftKey === true
  const eventAlt = event.altKey === true
  const expectedShift = chord.shift ?? false
  if (expectedShift !== "optional" && eventShift !== expectedShift) return false
  if (eventAlt !== (chord.alt ?? false)) return false
  return (
    chord.codes.includes(event.code) ||
    Boolean(event.key && chord.keys?.includes(event.key))
  )
}

function isGuarded(
  guards: readonly ShortcutFocusGuard[] | undefined,
  context: ShortcutParityContext
): boolean {
  if (!guards) return false
  return (
    (guards.includes("monaco") && context.inMonaco) ||
    (guards.includes("text-entry") && context.inTextEntry) ||
    (guards.includes("terminal") && context.inTerminal)
  )
}
