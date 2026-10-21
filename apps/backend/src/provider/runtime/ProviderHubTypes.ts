import type {
  ProviderAdapterShape,
  ProviderAgent,
  ProviderCapabilities,
  ProviderCatalogEntry,
  ProviderInstanceMetadata,
  ProviderKind,
  ProviderModel,
  ProviderSession,
  ProviderSkill,
  ProviderSlashCommand,
  ProviderTool,
} from "./contracts"

// The provider hub's public data shapes. They live apart from the hub so the
// modules it is split into (status, sessions, capacity, approvals) can share
// them without importing ProviderHub.ts; the hub re-exports every one.

export interface ProviderRuntimeInstance {
  readonly instanceId: string
  readonly driver: string
  readonly provider: ProviderKind | null
  readonly displayName?: string
  readonly accentColor?: string
  readonly version?: string | null
  readonly installed?: boolean
  readonly enabled: boolean
  readonly unavailableReason?: string
  readonly continuationKey?: string
  readonly environment?: ReadonlyArray<{
    readonly name: string
    readonly value: string
    readonly sensitive?: boolean
    readonly valueRedacted?: boolean
    readonly secretState?: {
      readonly configured: boolean
      readonly storage: "encrypted" | "plaintext"
    }
  }>
  readonly config?: unknown
  readonly statusProbe?: (input: {
    readonly cwd?: string | null
    readonly refresh?: boolean
  }) =>
    | ProviderRuntimeInstanceStatusProbe
    | Promise<ProviderRuntimeInstanceStatusProbe>
  readonly adapter: ProviderAdapterShape
}

export interface ProviderRuntimeInstanceStatusProbe {
  readonly configured?: boolean
  readonly installed?: boolean
  readonly version?: string | null
  readonly status?: "ready" | "warning" | "error" | "disabled"
  readonly auth?: ProviderRuntimeInstanceSnapshot["auth"]
  readonly message?: string
}

export interface ProviderRuntimeInstanceSnapshot {
  readonly instanceId: string
  readonly driver: string
  readonly displayName: string
  readonly accentColor?: string
  readonly badgeLabel?: string
  readonly enabled: boolean
  readonly configured: boolean
  readonly installed: boolean
  readonly version: string | null
  readonly status: "ready" | "warning" | "error" | "disabled"
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated" | "unknown"
    readonly type?: string
    readonly label?: string
    readonly email?: string
  }
  readonly checkedAt: string
  readonly message?: string
  readonly availability: "available" | "unavailable"
  readonly unavailableReason?: string
  /** Set while this instance's backend refused to retire on replacement. */
  readonly retirementFailure?: string
  readonly continuation?: { readonly groupKey: string }
  readonly continuationKey?: string
  readonly showInteractionModeToggle?: boolean
  readonly environment: ReadonlyArray<{
    readonly name: string
    readonly value: string
    readonly sensitive?: boolean
    readonly valueRedacted?: boolean
    readonly secretState?: {
      readonly configured: boolean
      readonly storage: "encrypted" | "plaintext"
    }
  }>
  readonly config: Record<string, unknown>
  readonly capabilities: ProviderCapabilities
  readonly models: ReadonlyArray<ProviderModel>
  readonly providerCatalog: ReadonlyArray<ProviderCatalogEntry>
  readonly skills: ReadonlyArray<ProviderSkill>
  readonly agents: ReadonlyArray<ProviderAgent>
  readonly tools: ReadonlyArray<ProviderTool>
  readonly slashCommands: ReadonlyArray<ProviderSlashCommand>
  readonly versionAdvisory?: {
    readonly status: "unknown" | "current" | "behind_latest"
    readonly currentVersion: string | null
    readonly latestVersion: string | null
    readonly updateCommand: string | null
    readonly canUpdate: boolean
    readonly checkedAt: string | null
    readonly message: string | null
  }
  readonly updateState?: {
    readonly status:
      | "idle"
      | "queued"
      | "running"
      | "succeeded"
      | "failed"
      | "unchanged"
    readonly startedAt: string | null
    readonly finishedAt: string | null
    readonly message: string | null
    readonly output: string | null
  }
  readonly metadata?: ProviderInstanceMetadata
}

export interface ProviderHubSessionSnapshot extends ProviderSession {
  readonly providerKind: ProviderKind
  readonly instanceId: string
  readonly driver: string
  readonly displayName: string
  readonly runtimeMode?: string | null
  readonly generation: number
  readonly active: boolean
  readonly persisted: boolean
}

export interface ProviderPreDispatchPolicyInput {
  readonly threadId: string
  readonly turnId: string
  readonly projectPath?: string | null
  readonly appMode?: string | null
  readonly providerKind: ProviderKind
  readonly providerInstanceId: string
}

export type ProviderPreDispatchPolicyDecision =
  | { readonly decision: "allow" }
  | {
      readonly decision: "deny"
      readonly reason: string
      readonly toolName?: string
    }

export interface ProviderTurnHandle {
  readonly turnId: string
  /** Adapter dispatch acknowledgement; not necessarily turn terminality. */
  readonly completion: Promise<void>
  /** Correlated terminal lifecycle plus afterTurn/interrupt finalization. */
  readonly settled: Promise<void>
}
