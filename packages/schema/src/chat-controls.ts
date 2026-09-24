/**
 * The chat composer's permission presets and chat modes, shared by the
 * desktop and the phone app so both offer the same choices in the same
 * words. The backend enforces them (apps/backend/src/provider/permissions.ts
 * and the provider adapters); these tables only describe them, and a turn
 * carries the chosen values as `permissionLevel` and `chatMode`.
 */

// ---------------------------------------------------------------------------
// Permission presets
// ---------------------------------------------------------------------------

/** The presets, as preferences and `/chat/send` name them. */
export const PERMISSION_LEVEL_IDS = [
  "ask-on-edit",
  "allow-edits",
  "default",
  "read-only",
  "bypass",
] as const
export type PermissionLevel = (typeof PERMISSION_LEVEL_IDS)[number]

/** What a chat uses until someone picks another preset. */
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = "ask-on-edit"

export type PermissionLevelOption = {
  id: PermissionLevel
  label: string
  desc: string
  danger: boolean
}

/**
 * The permission presets the UI exposes, in menu order: from the one that
 * asks about everything to the one that asks about nothing, with the
 * reach-limiting preset before the unguarded one.
 *
 * The menu keeps the app greys; the destructive colour marks the one preset
 * that removes the guardrails, so it still means something when it shows up.
 */
export const PERMISSION_LEVELS: readonly PermissionLevelOption[] = [
  {
    id: "ask-on-edit",
    label: "Ask first",
    desc: "Approve every command and file change",
    danger: false,
  },
  {
    id: "allow-edits",
    // Was labelled "Full Access" with "auto-approves reads, writes, and
    // commands" — which the gate never did: `evaluatePermission` only
    // auto-allows the `write` class here, and commands still ask. The label
    // promised more permission than the code grants.
    label: "Auto-edit",
    desc: "Files change on their own · commands still ask",
    danger: false,
  },
  {
    id: "default",
    label: "Auto Mode",
    desc: "Routine work runs · anything unusual asks",
    danger: false,
  },
  {
    id: "read-only",
    label: "Read-only",
    desc: "Search and read · never modifies anything",
    danger: false,
  },
  {
    id: "bypass",
    label: "Bypass Permission",
    desc: "Everything runs unattended · no guardrails",
    danger: true,
  },
] as const

/**
 * The label for one preset, for the always-visible composer chip.
 *
 * Derived from the same table the menu renders so the two cannot disagree —
 * the chip used to carry its own hand-written wording and said "Full access"
 * for the preset the menu called something else entirely.
 */
export function permissionLevelLabel(id: string | null | undefined): string {
  const key = id?.trim()
  return (
    PERMISSION_LEVELS.find((level) => level.id === key)?.label ??
    PERMISSION_LEVELS[0]!.label
  )
}

/** A stored or received preset, or the default when it is not one of today's. */
export function normalizePermissionLevel(
  id: string | null | undefined
): PermissionLevel {
  const key = id?.trim()
  return (
    PERMISSION_LEVEL_IDS.find((level) => level === key) ??
    DEFAULT_PERMISSION_LEVEL
  )
}

/** Copy shown in the confirmation dialog before enabling Bypass mode. */
export const BYPASS_CONFIRM_TITLE = "Enable Bypass mode?"
export const BYPASS_CONFIRM_BODY =
  "The assistant will run shell commands, edit files, and read files " +
  "WITHOUT asking for approval — for any provider. Only use this in " +
  "trusted workspaces."
export const BYPASS_CONFIRM_ACTION = "Enable Bypass"

/**
 * Shown when a preset changes while a turn runs and the provider can only
 * apply it to the next turn (`/chat/permission-mode` answered other than
 * `applied: "live"`).
 */
export const PERMISSION_MODE_QUEUED = {
  title: "Permission mode saved for the next turn",
  description:
    "This provider cannot fully change its running turn's permissions. Stop and resend to apply the new mode now.",
} as const

/** Shown when `/chat/permission-mode` fails. */
export const PERMISSION_MODE_FAILED = {
  title: "Could not update the running turn's permissions",
  description:
    "The selected mode will apply to your next message. Pending approvals still need a response.",
} as const

// ---------------------------------------------------------------------------
// Chat modes
// ---------------------------------------------------------------------------

/**
 * Display names for the chat modes.
 *
 * The composer chip used to render the raw mode id with a `capitalize` class,
 * so renaming a mode in the dropdown left the chip showing the old word. One
 * map keeps the two in step.
 */
const CHAT_MODE_LABELS: Record<string, string> = {
  agent: "Agent",
  plan: "Plan",
  // Names what the mode guarantees: the agent may read and search the
  // workspace but never change it.
  ask: "Ask / Read-only",
}

export function chatModeLabel(chatMode: string | null | undefined): string {
  const key = chatMode?.trim().toLowerCase()
  if (!key) return CHAT_MODE_LABELS.agent!
  return CHAT_MODE_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}

/** The modes that still exist. Security and Debug were removed. */
export const CHAT_MODES = ["agent", "plan", "ask"] as const
export type KnownChatMode = (typeof CHAT_MODES)[number]

/**
 * The modes as a menu offers them, in the words of the desktop's /default,
 * /plan and /ask commands. The desktop switches with Shift+Tab or those
 * commands; the phone, without either, shows this menu.
 */
export const CHAT_MODE_OPTIONS: ReadonlyArray<{
  id: KnownChatMode
  label: string
  desc: string
}> = [
  {
    id: "agent",
    label: chatModeLabel("agent"),
    desc: "Normal build mode · edits and commands follow the permission preset",
  },
  {
    id: "plan",
    label: chatModeLabel("plan"),
    desc: "Read-only implementation planning · a plan before any edit",
  },
  {
    id: "ask",
    label: chatModeLabel("ask"),
    desc: "Analysis without file changes",
  },
]

const KNOWN = new Set<string>(CHAT_MODES)

/**
 * Coerce a stored mode to one that still exists.
 *
 * Thread settings persist on each client, so a chat last used in the removed
 * Security or Debug mode still carries that value. Without this it would keep
 * being read as a live mode: labelled from the capitalize fallback, and — worse
 * — still matching the mode-instruction lookups, so the thread would silently
 * behave like a mode the user can no longer see or leave.
 *
 * Anything unrecognised becomes Agent, the mode with no special rules.
 */
export function normalizeChatMode(
  chatMode: string | null | undefined
): KnownChatMode {
  const key = chatMode?.trim().toLowerCase()
  return key && KNOWN.has(key) ? (key as KnownChatMode) : "agent"
}
