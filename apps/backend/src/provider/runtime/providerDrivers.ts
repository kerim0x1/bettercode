import type { ProviderKind } from "./contracts"

/**
 * The provider-hub drivers, one row each. Everything the backend needs to know
 * about a driver *without* constructing its adapter lives here: how settings
 * spell it, which provider kind the hub routes it as, which catalog entry
 * documents it, which session protocol it speaks and which settings keys it
 * reads. `providerDriverInstances.ts` pairs each row with the code that builds
 * its instance and its default configuration, keyed by the same `driver`, so
 * a driver cannot exist in one place and be missing from the other.
 *
 * Dispatch (hub vs. legacy routing), driver aliases, default ordering and the
 * session-operation budgets derive from this list instead of keeping their
 * own copies. The legacy API-key providers (`anthropic`, `openai`, `grok`,
 * `openrouter`, `lmstudio`) are not hub drivers yet and are not listed.
 *
 * Still separate (follow-ups): the renderer's provider menus and settings
 * forms (`apps/ui`), the schema's `ProviderKind` enum and alias table
 * (`@betterc0de/schema`), and the orchestration-worker kinds in
 * `services/orchestrator/model-catalog.ts`.
 */
export interface ProviderDriverDescriptor {
  /** The settings spelling instances are configured under (`grok-cli`). */
  readonly driver: string
  /** The kind the hub routes turns by (`grok_cli`). */
  readonly providerKind: ProviderKind
  /**
   * Spellings that normalize to this driver, compacted: lower-cased with
   * every `-` and `_` removed (`cursor_agent` → `cursoragent`).
   */
  readonly aliases: ReadonlyArray<string>
  /**
   * Default instance ids in default-list order. The position across all
   * drivers is the instance's default rank; `BetterC0de` is the legacy
   * capitalized id of the `betterc0de` instance.
   */
  readonly defaultInstanceIds: ReadonlyArray<string>
  /** The `provider/catalog` entry that documents this driver, if any. */
  readonly catalogId: string | null
  /** How sessions talk to the backend; ACP sessions get longer budgets. */
  readonly protocol:
    | "codex-app-server"
    | "claude-agent-sdk"
    | "pty"
    | "acp"
    | "betterc0de-compat"
  /** The string settings keys an instance's `config` may carry. */
  readonly settingsKeys: ReadonlyArray<string>
}

export const PROVIDER_DRIVERS = [
  {
    driver: "codex",
    providerKind: "codex",
    aliases: ["codex", "codexcli"],
    defaultInstanceIds: ["codex"],
    catalogId: "codex",
    protocol: "codex-app-server",
    settingsKeys: ["binaryPath", "homePath", "shadowHomePath", "customModels"],
  },
  {
    driver: "claude",
    providerKind: "claude",
    aliases: ["claude", "claudeagent", "anthropiccli", "claudecli"],
    defaultInstanceIds: ["claude"],
    catalogId: "claude",
    protocol: "claude-agent-sdk",
    settingsKeys: ["binaryPath", "homePath", "customModels"],
  },
  {
    driver: "claude-terminal",
    providerKind: "claude",
    aliases: ["claudeterminal", "claudepty", "claudeptywrapper"],
    defaultInstanceIds: ["claude-terminal"],
    catalogId: "claude",
    protocol: "pty",
    settingsKeys: ["binaryPath", "homePath", "customModels"],
  },
  {
    driver: "cursor",
    providerKind: "cursor",
    aliases: ["cursor", "cursorcli", "cursoragent", "cursoracp"],
    defaultInstanceIds: ["cursor"],
    catalogId: "cursor",
    protocol: "acp",
    settingsKeys: ["binaryPath", "apiEndpoint", "customModels"],
  },
  {
    driver: "betterc0de",
    providerKind: "betterc0de",
    aliases: [
      "betterc0de",
      "bettercode",
      "betterc0decli",
      "bettercodecli",
      "betterc0deagent",
      "bettercodeagent",
      // Legacy compatibility spelling: "open-code" predates the upstream
      // `opencode` driver and must keep resolving to the BetterC0de driver.
      "opencode",
    ],
    defaultInstanceIds: ["betterc0de", "BetterC0de"],
    catalogId: null,
    protocol: "betterc0de-compat",
    settingsKeys: [
      "binaryPath",
      "serverUrl",
      "serverUsername",
      "serverPassword",
      "customModels",
    ],
  },
  {
    // Bare `grok` is NOT an alias: that name belongs to the legacy xAI
    // API-key provider, not to the CLI driver.
    driver: "grok-cli",
    providerKind: "grok_cli",
    aliases: ["grokcli", "grokagent", "grokacp", "grokbuild"],
    defaultInstanceIds: ["grok-cli"],
    catalogId: "grok-cli",
    protocol: "acp",
    settingsKeys: ["binaryPath", "customModels"],
  },
  {
    // The upstream `opencode` binary's ACP server (`opencode acp`). Kept
    // distinct from `betterc0de` so both can be configured side by side. Bare
    // `opencode` is NOT an alias: it is the long-standing spelling of the
    // BetterC0de compatibility driver (`open-code`) and must keep normalizing
    // there.
    driver: "opencode-cli",
    providerKind: "opencode_cli",
    aliases: ["opencodecli", "opencodeserver", "opencodeacp"],
    defaultInstanceIds: ["opencode-cli"],
    catalogId: "opencode-cli",
    protocol: "acp",
    settingsKeys: [
      "binaryPath",
      // Kept for configs saved before the ACP migration; no longer read.
      "serverUrl",
      "serverUsername",
      "serverPassword",
      "customModels",
    ],
  },
] as const satisfies ReadonlyArray<ProviderDriverDescriptor>

export type ProviderDriverName = (typeof PROVIDER_DRIVERS)[number]["driver"]

const DRIVERS_BY_NAME: ReadonlyMap<string, ProviderDriverDescriptor> = new Map(
  PROVIDER_DRIVERS.map((descriptor) => [descriptor.driver, descriptor])
)

const DRIVER_BY_ALIAS: ReadonlyMap<string, ProviderDriverName> = new Map(
  PROVIDER_DRIVERS.flatMap((descriptor) =>
    descriptor.aliases.map((alias) => [alias, descriptor.driver] as const)
  )
)

const DEFAULT_INSTANCE_RANK: ReadonlyMap<string, number> = new Map(
  PROVIDER_DRIVERS.flatMap((descriptor) => descriptor.defaultInstanceIds).map(
    (instanceId, rank) => [instanceId, rank] as const
  )
)

/** Ranks after every default instance (explicitly configured extra ones). */
const NON_DEFAULT_INSTANCE_RANK = 10

/** The provider kinds the hub serves; everything else is the legacy stack. */
export const HUB_PROVIDER_KINDS: ReadonlySet<ProviderKind> = new Set(
  PROVIDER_DRIVERS.map((descriptor) => descriptor.providerKind)
)

/** Whether a (normalized) kind is served by the hub rather than legacy. */
export function isHubProviderKind(kind: string): kind is ProviderKind {
  return (HUB_PROVIDER_KINDS as ReadonlySet<string>).has(kind)
}

/**
 * Canonical driver for a configured spelling (`Claude_Agent` → `claude`).
 * An unknown driver comes back trimmed but otherwise as written, so the
 * instance manager can report it as unsupported under its own name.
 */
export function normalizeProviderDriver(driver: string): string {
  const value = driver.trim()
  const compactKey = value.toLowerCase().replace(/[_-]+/g, "")
  return DRIVER_BY_ALIAS.get(compactKey) ?? value
}

/** The descriptor of a canonical driver name, or null for an unknown one. */
export function providerDriverDescriptor(
  driver: string
): ProviderDriverDescriptor | null {
  return DRIVERS_BY_NAME.get(driver) ?? null
}

/** Default-list position of an instance id; unknown ids sort last. */
export function defaultProviderInstanceRank(instanceId: string): number {
  return DEFAULT_INSTANCE_RANK.get(instanceId) ?? NON_DEFAULT_INSTANCE_RANK
}

/** Whether an instance's sessions speak ACP (child spawn, auth, setup). */
export function isAcpProviderDriver(driver: string): boolean {
  return providerDriverDescriptor(driver)?.protocol === "acp"
}
