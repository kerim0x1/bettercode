import path from "node:path"
import { configureBackendLogging, logger } from "../observability/logger"
import { SettingsService } from "../settings/service"
import { AssistantTranscriptRecoveryStore } from "../provider/runtime/AssistantTranscriptRecoveryStore"
import { removeLegacyCredentialStore } from "../auth/legacyCredentialCleanup"
import { migrateDesktopConfig } from "../services/desktop-config/migration"
import { desktopConfigStoreFor } from "../services/desktop-config/store"
import { RemoteAccessService } from "../remote/service"
import { RemoteProviderTurnOwnership } from "../remote/providerTurnOwnership"
import {
  createTailscaleRemoteAccess,
  reconcileTailscaleServe,
} from "../remote/tailscale"
import type { BootRoot, PersistenceContext, SettingsContext } from "./context"

/**
 * Phase 2: settings, logging, remote access (with the per-session process
 * cleanup that follows a revocation), the assistant transcript recovery
 * store with its startup replay, and removal of the retired OAuth credential
 * store. Binds the settings service into the permission policy the moment it
 * exists.
 */
export function loadSettingsAndRemote(
  root: BootRoot,
  persistence: PersistenceContext
): SettingsContext {
  const { options, config, startupCleanup } = root
  const { taintBackend } = root.taint
  const { db, threads } = persistence
  // ── Settings ──────────────────────────────────────────────────────────
  const settings = new SettingsService(config.settingsPath)
  persistence.bindSettingsForTrust(settings)
  // Remote Access listens on the network only while "Local network" is on.
  // Without it the backend stays on loopback, where Tailscale Serve (which
  // tailscaled itself accepts) or a tunnel still reaches it: no firewall
  // rule, nothing listening on the Wi-Fi.
  if (
    settings.get().remote_access_enabled === true &&
    settings.get().remote_access_lan !== false
  ) {
    config.host = process.env.BETTERC0DE_REMOTE_HOST?.trim() || "0.0.0.0"
  }
  // Tailscale Serve proxies from this machine; its forwarded headers are
  // trusted exactly while the setting says that proxy is ours. Kept in sync
  // by the settings watcher in the providers phase.
  config.trustLoopbackProxyHeaders =
    settings.get().remote_access_tailscale_serve === true
  configureBackendLogging(settings.get())
  // Rules, skills, MCP servers and hooks live in the runtime home's files,
  // which this backend owns. Values an older version kept in settings.json
  // are merged into them once, then removed from settings (never throws).
  const desktopConfig = desktopConfigStoreFor(config)
  if (desktopConfig) migrateDesktopConfig(desktopConfig, settings)
  const remoteAccess = new RemoteAccessService(db, {
    isEnabled: () => settings.get().remote_access_enabled === true,
  })
  const tailscale = createTailscaleRemoteAccess()
  // Read per request; the snapshot refreshes itself while Tailscale runs.
  config.tailnetSelfAddresses = () => tailscale.selfAddresses()
  const remoteProviderTurns = new RemoteProviderTurnOwnership((sessionId) =>
    remoteAccess.isSessionActive(sessionId)
  )
  const remoteOwnerCleanupByOwner = new Map<string, Promise<void>>()
  const scheduleRemoteOwnerCleanup = (sessionId: string): Promise<void> => {
    const ownerId = `remote:${sessionId}`
    const previous = remoteOwnerCleanupByOwner.get(ownerId) ?? Promise.resolve()
    const cleanup = previous
      .catch(() => undefined)
      .then(async () => {
        const results = await Promise.allSettled([
          root.shellSessions.closeSessionsForOwner(ownerId),
          root.terminalPtys.shutdownForOwner(ownerId),
          remoteProviderTurns.revokeSession(sessionId),
        ])
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        )
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            `Failed to terminate processes owned by revoked remote session '${sessionId}'.`
          )
        }
      })
    remoteOwnerCleanupByOwner.set(ownerId, cleanup)
    void cleanup.then(
      () => {
        if (remoteOwnerCleanupByOwner.get(ownerId) === cleanup) {
          remoteOwnerCleanupByOwner.delete(ownerId)
        }
      },
      (error: unknown) => {
        if (remoteOwnerCleanupByOwner.get(ownerId) === cleanup) {
          remoteOwnerCleanupByOwner.delete(ownerId)
        }
        taintBackend(
          error instanceof Error
            ? error
            : new Error("Remote owner process cleanup failed", {
                cause: error,
              }),
          "remote_session_process_cleanup"
        )
      }
    )
    return cleanup
  }
  const unsubscribeRemoteOwnerCleanup =
    remoteAccess.subscribeToSessionRevocations((sessionIds) => {
      return Promise.all(
        sessionIds.map((sessionId) => scheduleRemoteOwnerCleanup(sessionId))
      ).then(() => undefined)
    })
  startupCleanup.push({
    name: "remote session process cleanup listener",
    run: unsubscribeRemoteOwnerCleanup,
  })
  startupCleanup.push({
    name: "remote access expiration scheduler",
    run: () => remoteAccess.close(),
  })
  const transcriptRecoveryStore = new AssistantTranscriptRecoveryStore(
    path.join(config.dataDir, "recovery", "provider-transcripts"),
    { logger }
  )
  const transcriptRecoveryTarget = {
    upsertMessage: (request: Parameters<typeof threads.upsertMessage>[0]) =>
      threads.upsertRecoveredAssistantMessage(request),
  }
  const startupTranscriptReplay = transcriptRecoveryStore.replay(
    transcriptRecoveryTarget
  )
  if (
    startupTranscriptReplay.replayed > 0 ||
    startupTranscriptReplay.discarded > 0 ||
    startupTranscriptReplay.quarantined > 0 ||
    startupTranscriptReplay.pending > 0
  ) {
    logger.info(
      { ...startupTranscriptReplay },
      "assistant transcript recovery startup replay completed"
    )
  }
  if (startupTranscriptReplay.pending > 0) {
    throw new Error(
      `Assistant transcript recovery could not commit ${startupTranscriptReplay.pending} pending record(s) during startup.`
    )
  }
  options.signal?.throwIfAborted()

  // ── Retired OAuth credential store ───────────────────────────────────
  // Nothing reads provider credentials from auth.json any more (API keys
  // live in settings, CLI providers use their own login). Drop the stale
  // ChatGPT tokens an earlier build may have left there.
  removeLegacyCredentialStore(config.authPath)
  return {
    settings,
    remoteAccess,
    tailscale,
    remoteProviderTurns,
    unsubscribeRemoteOwnerCleanup,
    transcriptRecoveryStore,
    transcriptRecoveryTarget,
  }
}

/**
 * Re-applies the Tailscale Serve mapping to the port the listener really
 * bound. Runs once the port is known, after the HTTP phase, because the port
 * can change between launches while the setting survives.
 */
export function reconcileTailscaleServeForPort(
  settingsCtx: SettingsContext,
  localPort: number
): void {
  void reconcileTailscaleServe(settingsCtx.tailscale, {
    enabled: settingsCtx.settings.get().remote_access_tailscale_serve === true,
    remoteAccessEnabled: settingsCtx.remoteAccess.enabled(),
    localPort,
  })
}
