import type {
  ProviderInstanceSnapshot,
  ProviderAgent,
  ProviderCatalogEntry,
  ProviderModel,
  ProviderSkill,
  ProviderSlashCommand,
  ProviderTool,
} from "@betterc0de/schema"

export interface ProviderInstanceEntry {
  readonly instanceId: string
  readonly driverKind: string
  readonly displayName: string
  readonly accentColor?: string | undefined
  readonly badgeLabel?: string | undefined
  readonly continuationKey?: string | undefined
  readonly continuationGroupKey?: string | undefined
  readonly enabled: boolean
  readonly configured: boolean
  readonly installed: boolean
  readonly status: ProviderInstanceSnapshot["status"]
  readonly authStatus: ProviderInstanceSnapshot["auth"]["status"]
  readonly isDefault: boolean
  readonly isAvailable: boolean
  readonly snapshot: ProviderInstanceSnapshot
  readonly models: ReadonlyArray<ProviderModel>
  readonly providerCatalog: ReadonlyArray<ProviderCatalogEntry>
  readonly skills: ReadonlyArray<ProviderSkill>
  readonly agents: ReadonlyArray<ProviderAgent>
  readonly tools: ReadonlyArray<ProviderTool>
  readonly slashCommands: ReadonlyArray<ProviderSlashCommand>
}

export function normalizeProviderDriverKind(driver: string): string {
  const value = driver.trim()
  const key = value.toLowerCase()
  const compactKey = key.replace(/[_-]+/g, "")
  if (compactKey === "codex" || compactKey === "codexcli") return "codex"
  if (
    compactKey === "anthropiccli" ||
    compactKey === "claude" ||
    compactKey === "claudecli" ||
    compactKey === "claudeagent" ||
    compactKey === "claudeterminal" ||
    compactKey === "claudepty" ||
    compactKey === "claudeptywrapper"
  ) {
    return "claude"
  }
  if (
    compactKey === "cursor" ||
    compactKey === "cursorcli" ||
    compactKey === "cursoragent" ||
    compactKey === "cursoracp"
  ) {
    return "cursor"
  }
  if (
    compactKey === "betterc0de" ||
    compactKey === "bettercode" ||
    compactKey === "betterc0decli" ||
    compactKey === "bettercodecli" ||
    compactKey === "betterc0deagent" ||
    compactKey === "bettercodeagent" ||
    compactKey === "BetterC0de" ||
    compactKey === "BetterC0decli" ||
    compactKey === "BetterC0deagent"
  ) {
    return "betterc0de"
  }
  if (
    compactKey === "opencodecli" ||
    compactKey === "opencodeserver" ||
    compactKey === "opencodeacp"
  ) {
    return "opencode-cli"
  }
  // Legacy BetterC0de compatibility alias — "open-code" compacts to
  // "opencode" and predates the upstream opencode driver kind.
  if (compactKey === "opencode") {
    return "betterc0de"
  }
  return value
}

export function defaultInstanceIdForDriver(driver: string): string {
  return normalizeProviderDriverKind(driver)
}

export function normalizeProviderAccentColor(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined
}

export function deriveProviderInstanceEntries(
  snapshots: ReadonlyArray<ProviderInstanceSnapshot>
): ReadonlyArray<ProviderInstanceEntry> {
  return snapshots.map((snapshot) => {
    const driverKind = normalizeProviderDriverKind(snapshot.driver)
    const instanceId = snapshot.instanceId
    const isDefault = instanceId === defaultInstanceIdForDriver(driverKind)
    const unavailable =
      snapshot.availability === "unavailable" ||
      (typeof snapshot.unavailableReason === "string" &&
        snapshot.unavailableReason.length > 0)
    const configured = snapshot.configured && !unavailable
    const continuationGroupKey =
      snapshot.continuation?.groupKey ?? snapshot.continuationKey
    return {
      instanceId,
      driverKind,
      displayName: resolveInstanceDisplayName(snapshot, driverKind, isDefault),
      accentColor: normalizeProviderAccentColor(snapshot.accentColor),
      badgeLabel: snapshot.badgeLabel,
      continuationKey: continuationGroupKey,
      continuationGroupKey,
      enabled: snapshot.enabled,
      configured,
      installed: snapshot.installed,
      status: snapshot.status,
      authStatus: snapshot.auth.status,
      isDefault,
      isAvailable: snapshot.availability !== "unavailable",
      snapshot,
      models: snapshot.models ?? [],
      providerCatalog: snapshot.providerCatalog ?? [],
      skills: snapshot.skills ?? [],
      agents: snapshot.agents ?? [],
      tools: snapshot.tools ?? [],
      slashCommands: snapshot.slashCommands ?? [],
    } satisfies ProviderInstanceEntry
  })
}

export function sortProviderInstanceEntries(entries: ReadonlyArray<ProviderInstanceEntry>): ReadonlyArray<ProviderInstanceEntry> {
  const kinds = new Map<string, number>()
  for (const entry of entries) {
    if (!kinds.has(entry.driverKind)) kinds.set(entry.driverKind, kinds.size)
  }
  return [...entries].sort((a, b) =>
    kinds.get(a.driverKind)! - kinds.get(b.driverKind)! || Number(b.isDefault) - Number(a.isDefault),
  )
}

export function getProviderInstanceEntry(
  snapshots: ReadonlyArray<ProviderInstanceSnapshot>,
  instanceId: string
): ProviderInstanceEntry | undefined {
  return deriveProviderInstanceEntries(snapshots).find(
    (entry) => entry.instanceId === instanceId
  )
}

export function resolveSelectableProviderInstance(
  snapshots: ReadonlyArray<ProviderInstanceSnapshot>,
  instanceId: string | undefined
): string | undefined {
  const entries = deriveProviderInstanceEntries(snapshots)
  if (instanceId === undefined) {
    return entries.find(isSelectableProviderInstance)?.instanceId
  }
  const requested = entries.find((entry) => entry.instanceId === instanceId)
  if (requested && isSelectableProviderInstance(requested)) {
    return instanceId
  }
  return entries.find(isSelectableProviderInstance)?.instanceId
}

export function resolveProviderDriverKindForInstanceSelection(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  selection: string | null | undefined
): string | undefined {
  return entries.find((entry) => entry.instanceId === selection)?.driverKind
}

function isSelectableProviderInstance(entry: ProviderInstanceEntry): boolean {
  return entry.enabled && entry.isAvailable && entry.configured
}

function resolveInstanceDisplayName(
  snapshot: ProviderInstanceSnapshot,
  driverKind: string,
  isDefault: boolean
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim()
  const kindLabel = driverKindLabel(driverKind)
  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) {
    return trimmedSnapshotName
  }
  if (!isDefault) {
    const humanized = humanizeInstanceId(snapshot.instanceId)
    if (humanized.length > 0) return humanized
  }
  return trimmedSnapshotName || kindLabel
}

function driverKindLabel(driverKind: string): string {
  if (driverKind === "codex") return "Codex"
  if (driverKind === "claude") return "Claude"
  if (driverKind === "cursor") return "Cursor"
  if (driverKind === "betterc0de") return "BetterC0de"
  if (driverKind === "BetterC0de") return "BetterC0de"
  return humanizeInstanceId(driverKind)
}

function humanizeInstanceId(instanceId: string): string {
  return instanceId
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter((token) => token.length > 0)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ")
}
