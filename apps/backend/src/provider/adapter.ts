import type { EventEmitter } from "node:events"
import type {
  ModelDefinition,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
} from "./types"

export interface ProviderAdapter {
  providerKind(): ProviderKind
  displayName(): string
  availableModels(): ModelDefinition[]
  /** Authenticated catalog request for API-backed providers. */
  discoverModels?(force?: boolean): Promise<ModelDefinition[]>
  isConfigured(): boolean
  /** Return true when the adapter emits its own authoritative turn lifecycle
   *  (`turn_started` / terminal events) asynchronously after `sendMessage`
   *  resolves. ProviderService skips its synthetic lifecycle wrapper for
   *  these adapters to avoid premature completion. */
  managesOwnTurnLifecycle?(): boolean
  /** Emits `ProviderRuntimeEvent`s via the global provider event bus. */
  sendMessage(input: ProviderSendTurnInput): Promise<void>
  /** Cancel an in-flight turn. Fires a `turn_interrupted` event on success. */
  interrupt(threadId: string): Promise<void>
  /** Abort every in-flight turn across all threads. Returns a count of how
   *  many turns were interrupted so callers can decide whether to drain. */
  interruptAll(): Promise<number>
  /** Subscribe to this adapter's runtime events (for testing / direct consumers). */
  subscribeEvents(): EventEmitter
  /** Respond to a provider-issued approval request (shell/file_edit/file_read).
   *  Implemented by adapters that emit `tool_approval_requested` events. */
  respondToApproval?(
    threadId: string,
    requestId: string,
    decision: "approve" | "deny"
  ): Promise<void>
  /** Respond to a provider-issued `user_input_requested` prompt with a set of
   *  typed answers (one per question in the original prompt). */
  respondToUserInput?(
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>
  ): Promise<void>
  /** Update this adapter's API key at runtime. Called when the user adds,
   *  changes, or clears a provider key in settings — without it the live
   *  adapter would keep its constructor-time client (or `null` for unset
   *  keys) until the app restarted, and `isConfigured()` would lie until
   *  then. Adapters that don't authenticate via API key (CLI-spawning
   *  adapters like claude-agent, codex-cli) may omit this. */
  setApiKey?(apiKey: string | null): void
  /** Returns metadata describing how this adapter authenticates and what
   *  the user needs to do to set it up.  Surfaces in `/providers/status`
   *  so the renderer can render meaningful tooltips on disabled model
   *  picker items ("API key fehlt", "CLI nicht eingeloggt", "LM Studio
   *  nicht erreichbar", …) instead of a generic "not configured" message.
   *
   *  - `authType`: stable string the renderer uses for fallback copy
   *    when `hint` is absent. One of `"api-key" | "cli" | "local-server"
   *    | "oauth"` — but kept as `string` so future adapters can introduce
   *    their own kinds without expanding a hard-coded enum.
   *  - `hint`: optional, human-readable, provider-specific setup
   *    instruction. Wins over the renderer's per-`authType` default
   *    when present.
   */
  authMeta?(): { authType: string; hint?: string }
}

/** Shared shape an adapter uses to push events to the global bus. */
export type EmitProviderEvent = (event: ProviderRuntimeEvent) => void
