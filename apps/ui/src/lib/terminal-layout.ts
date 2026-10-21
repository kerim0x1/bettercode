/**
 * The desktop terminal's tabs and split panes as plain data, and the pure
 * edits the panel makes to them. A chat (or a folder without a chat) has one
 * group of tabs; each tab holds one terminal or a tree of splits whose
 * leaves are terminals. The terminals themselves (PTY, xterm, output) live
 * in `terminal-sessions.ts`, keyed by the ids used here.
 */

export type TerminalSplitDirection = "row" | "column"

export type TerminalLayoutNode =
  | { readonly type: "pane"; readonly terminalId: string }
  | {
      readonly type: "split"
      readonly id: string
      /** `row`: side by side (split right); `column`: stacked (split down). */
      readonly direction: TerminalSplitDirection
      /** The first child's share of the space. */
      readonly ratio: number
      readonly first: TerminalLayoutNode
      readonly second: TerminalLayoutNode
    }

export interface TerminalTab {
  readonly id: string
  readonly layout: TerminalLayoutNode
  /** The pane that has, or last had, the keyboard. */
  readonly activeTerminalId: string
  /** A name the user gave the tab; otherwise it is named after its terminal. */
  readonly title?: string
}

export interface TerminalGroup {
  readonly tabs: readonly TerminalTab[]
  readonly activeTabId: string | null
}

export const EMPTY_TERMINAL_GROUP: TerminalGroup = {
  tabs: [],
  activeTabId: null,
}

/** Beyond four panes a tab's terminals get too small to use. */
export const MAX_TERMINAL_PANES_PER_TAB = 4
export const MIN_TERMINAL_SPLIT_RATIO = 0.15
export const MAX_TERMINAL_SPLIT_RATIO = 0.85
export const MAX_TERMINAL_TAB_TITLE_CHARS = 60

/** Nesting deeper than this is not something the panel builds. */
const MAX_LAYOUT_DEPTH = 8

export function clampTerminalSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(
    MAX_TERMINAL_SPLIT_RATIO,
    Math.max(MIN_TERMINAL_SPLIT_RATIO, ratio)
  )
}

/** The layout's terminals, left to right and top to bottom. */
export function layoutTerminalIds(node: TerminalLayoutNode): string[] {
  if (node.type === "pane") return [node.terminalId]
  return [...layoutTerminalIds(node.first), ...layoutTerminalIds(node.second)]
}

/** Puts `newTerminalId` beside (row) or below (column) `targetTerminalId`. */
export function splitLayout(
  node: TerminalLayoutNode,
  targetTerminalId: string,
  newTerminalId: string,
  direction: TerminalSplitDirection,
  splitId: string
): TerminalLayoutNode {
  if (node.type === "pane") {
    if (node.terminalId !== targetTerminalId) return node
    return {
      type: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: node,
      second: { type: "pane", terminalId: newTerminalId },
    }
  }
  const first = splitLayout(
    node.first,
    targetTerminalId,
    newTerminalId,
    direction,
    splitId
  )
  const second = splitLayout(
    node.second,
    targetTerminalId,
    newTerminalId,
    direction,
    splitId
  )
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second }
}

/**
 * The layout without `terminalId`: its split gives the space to the other
 * side. Null when it was the only pane.
 */
export function removeFromLayout(
  node: TerminalLayoutNode,
  terminalId: string
): TerminalLayoutNode | null {
  if (node.type === "pane") return node.terminalId === terminalId ? null : node
  const first = removeFromLayout(node.first, terminalId)
  const second = removeFromLayout(node.second, terminalId)
  if (!first) return second
  if (!second) return first
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second }
}

export function setLayoutSplitRatio(
  node: TerminalLayoutNode,
  splitId: string,
  ratio: number
): TerminalLayoutNode {
  if (node.type === "pane") return node
  if (node.id === splitId) {
    const next = clampTerminalSplitRatio(ratio)
    return next === node.ratio ? node : { ...node, ratio: next }
  }
  const first = setLayoutSplitRatio(node.first, splitId, ratio)
  const second = setLayoutSplitRatio(node.second, splitId, ratio)
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second }
}

export function groupTerminalIds(group: TerminalGroup): string[] {
  return group.tabs.flatMap((tab) => layoutTerminalIds(tab.layout))
}

export function findTerminalTab(
  group: TerminalGroup,
  terminalId: string
): TerminalTab | undefined {
  return group.tabs.find((tab) =>
    layoutTerminalIds(tab.layout).includes(terminalId)
  )
}

export function activeTerminalTab(group: TerminalGroup): TerminalTab | null {
  return (
    group.tabs.find((tab) => tab.id === group.activeTabId) ??
    group.tabs[0] ??
    null
  )
}

/** The terminal that has the keyboard in the group's active tab. */
export function activeTerminalIdOf(group: TerminalGroup): string | null {
  return activeTerminalTab(group)?.activeTerminalId ?? null
}

/** A new tab with one terminal, after the others, and active. */
export function addTerminalTab(
  group: TerminalGroup,
  tabId: string,
  terminalId: string
): TerminalGroup {
  return {
    tabs: [
      ...group.tabs,
      {
        id: tabId,
        layout: { type: "pane", terminalId },
        activeTerminalId: terminalId,
      },
    ],
    activeTabId: tabId,
  }
}

export function activateTerminalTab(
  group: TerminalGroup,
  tabId: string
): TerminalGroup {
  if (group.activeTabId === tabId) return group
  if (!group.tabs.some((tab) => tab.id === tabId)) return group
  return { ...group, activeTabId: tabId }
}

/** Gives `terminalId` the keyboard: its tab becomes active, and it that tab's pane. */
export function focusTerminalPane(
  group: TerminalGroup,
  terminalId: string
): TerminalGroup {
  const tab = findTerminalTab(group, terminalId)
  if (!tab) return group
  if (group.activeTabId === tab.id && tab.activeTerminalId === terminalId) {
    return group
  }
  return {
    tabs: group.tabs.map((candidate) =>
      candidate.id === tab.id
        ? { ...candidate, activeTerminalId: terminalId }
        : candidate
    ),
    activeTabId: tab.id,
  }
}

/**
 * Splits `terminalId`'s pane and focuses the new terminal; null when the
 * terminal is unknown or its tab is full.
 */
export function splitTerminalPane(
  group: TerminalGroup,
  terminalId: string,
  newTerminalId: string,
  direction: TerminalSplitDirection,
  splitId: string
): TerminalGroup | null {
  const tab = findTerminalTab(group, terminalId)
  if (!tab) return null
  if (layoutTerminalIds(tab.layout).length >= MAX_TERMINAL_PANES_PER_TAB) {
    return null
  }
  const layout = splitLayout(
    tab.layout,
    terminalId,
    newTerminalId,
    direction,
    splitId
  )
  return {
    tabs: group.tabs.map((candidate) =>
      candidate.id === tab.id
        ? { ...candidate, layout, activeTerminalId: newTerminalId }
        : candidate
    ),
    activeTabId: tab.id,
  }
}

/**
 * Removes one pane. The neighbour that took its space gets the keyboard; a
 * tab left without panes closes, and the tab to its right (or else left)
 * becomes active.
 */
export function removeTerminalPane(
  group: TerminalGroup,
  terminalId: string
): TerminalGroup {
  const tab = findTerminalTab(group, terminalId)
  if (!tab) return group
  const layout = removeFromLayout(tab.layout, terminalId)
  if (!layout) return removeTerminalTab(group, tab.id).group
  const before = layoutTerminalIds(tab.layout)
  const after = layoutTerminalIds(layout)
  const activeTerminalId =
    tab.activeTerminalId === terminalId
      ? (after[Math.max(0, before.indexOf(terminalId) - 1)] ?? after[0]!)
      : tab.activeTerminalId
  return {
    ...group,
    tabs: group.tabs.map((candidate) =>
      candidate.id === tab.id
        ? { ...candidate, layout, activeTerminalId }
        : candidate
    ),
  }
}

/** Removes a whole tab; `removed` names the terminals that went with it. */
export function removeTerminalTab(
  group: TerminalGroup,
  tabId: string
): { group: TerminalGroup; removed: string[] } {
  const index = group.tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return { group, removed: [] }
  const removed = layoutTerminalIds(group.tabs[index]!.layout)
  const tabs = group.tabs.filter((tab) => tab.id !== tabId)
  const activeTabId =
    group.activeTabId === tabId
      ? ((tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null)
      : group.activeTabId
  return { group: { tabs, activeTabId }, removed }
}

export function resizeTerminalSplit(
  group: TerminalGroup,
  tabId: string,
  splitId: string,
  ratio: number
): TerminalGroup {
  let changed = false
  const tabs = group.tabs.map((tab) => {
    if (tab.id !== tabId) return tab
    const layout = setLayoutSplitRatio(tab.layout, splitId, ratio)
    if (layout === tab.layout) return tab
    changed = true
    return { ...tab, layout }
  })
  return changed ? { ...group, tabs } : group
}

/** Names a tab; an empty name gives it back its terminal's name. */
export function renameTerminalTab(
  group: TerminalGroup,
  tabId: string,
  title: string
): TerminalGroup {
  const trimmed = title.trim().slice(0, MAX_TERMINAL_TAB_TITLE_CHARS)
  return {
    ...group,
    tabs: group.tabs.map((tab) => {
      if (tab.id !== tabId) return tab
      if (trimmed) return { ...tab, title: trimmed }
      const { title: _previous, ...rest } = tab
      return rest
    }),
  }
}

// ── Reading a saved layout back ──────────────────────────────────────────

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isTerminalId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value)
}

/**
 * A layout read from storage, keeping only panes whose terminal `exists`;
 * null when nothing usable is left. Anything malformed is dropped rather
 * than trusted.
 */
export function parseTerminalLayout(
  value: unknown,
  exists: (terminalId: string) => boolean,
  depth = 0
): TerminalLayoutNode | null {
  if (!isRecord(value) || depth > MAX_LAYOUT_DEPTH) return null
  if (value.type === "pane") {
    return isTerminalId(value.terminalId) && exists(value.terminalId)
      ? { type: "pane", terminalId: value.terminalId }
      : null
  }
  if (value.type !== "split" || !isTerminalId(value.id)) return null
  if (value.direction !== "row" && value.direction !== "column") return null
  const first = parseTerminalLayout(value.first, exists, depth + 1)
  const second = parseTerminalLayout(value.second, exists, depth + 1)
  if (!first) return second
  if (!second) return first
  return {
    type: "split",
    id: value.id,
    direction: value.direction,
    ratio: clampTerminalSplitRatio(
      typeof value.ratio === "number" ? value.ratio : 0.5
    ),
    first,
    second,
  }
}

/** A group read from storage; terminals another tab already holds are dropped. */
export function parseTerminalGroup(
  value: unknown,
  exists: (terminalId: string) => boolean
): TerminalGroup | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return null
  const seen = new Set<string>()
  const tabs: TerminalTab[] = []
  for (const raw of value.tabs.slice(0, 32)) {
    if (!isRecord(raw) || !isTerminalId(raw.id)) continue
    const layout = parseTerminalLayout(
      raw.layout,
      (terminalId) => exists(terminalId) && !seen.has(terminalId)
    )
    if (!layout) continue
    const ids = layoutTerminalIds(layout)
    if (ids.length > MAX_TERMINAL_PANES_PER_TAB) continue
    for (const id of ids) seen.add(id)
    const activeTerminalId =
      typeof raw.activeTerminalId === "string" &&
      ids.includes(raw.activeTerminalId)
        ? raw.activeTerminalId
        : ids[0]!
    const title =
      typeof raw.title === "string"
        ? raw.title.trim().slice(0, MAX_TERMINAL_TAB_TITLE_CHARS)
        : ""
    tabs.push({
      id: raw.id,
      layout,
      activeTerminalId,
      ...(title ? { title } : {}),
    })
  }
  if (tabs.length === 0) return null
  const activeTabId = tabs.some((tab) => tab.id === value.activeTabId)
    ? (value.activeTabId as string)
    : tabs[0]!.id
  return { tabs, activeTabId }
}
