import path from "node:path"
import os from "node:os"
import { logger } from "../observability/logger"
import { openDatabase } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { migrateLegacyDbIfNeeded } from "../persistence/migrateLegacyDb"
import { EventStore } from "../persistence/eventStore"
import { CommandReceiptStore } from "../persistence/commandReceipts"
import {
  CheckpointDiffProjectionQuery,
  MessageProjectionQuery,
  ProjectProjectionQuery,
  ThreadActivityProjectionQuery,
  ThreadProjectionQuery,
  TurnProjectionQuery,
  WorktreeRegistryQuery,
} from "../persistence/projections"
import type { SettingsService } from "../settings/service"
import { AgentPermissionPolicy } from "../provider/agent-permission-policy"
import {
  releaseAgentPermissionRuntime,
  setDefaultAgentPermissionRuntime,
} from "../provider/agent-permission-runtime"
import {
  ProviderSessionBindingStore,
  ProviderRuntimeJournalRecoveryStore,
  ProviderRuntimeProjectionReceiptStore,
} from "../provider/runtime"
import { ThreadService } from "../services/threads"
import { ChatDispatchStore } from "../services/chat-dispatch-store"
import type { BootRoot, PersistenceContext } from "./context"

/**
 * Phase 1: open and migrate the database, build every store and projection
 * query on top of it, and install the agent permission policy. The resource
 * shutdown cleanup steps are registered here, right after the database step,
 * so the unwind terminates child processes before it closes the file.
 */
export function openPersistence(root: BootRoot): PersistenceContext {
  const { options, config, startupCleanup } = root
  const {
    git: requestGitProcessShutdown,
    imageGeneration: requestImageGenerationShutdown,
    nativeTextGeneration: requestNativeTextGenerationShutdown,
    workspace: requestWorkspaceProcessShutdown,
  } = root.resourceShutdowns
  // ── Persistence ────────────────────────────────────────────────────────
  // One-shot migration from legacy per-OS data dirs (Roaming AppData,
  // Library/Application Support, XDG config, or the flat ~/.betterc0de)
  // into the current ~/.betterc0de[-dev]/userdata/ layout. Explicit custom
  // profiles must not inherit the normal profile's credentials or history.
  const canonicalPathKey = (value: string) => {
    const resolved = path.resolve(value)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  const targetKey = canonicalPathKey(config.dbPath)
  if (
    [".betterc0de", ".betterc0de-dev"].some(
      (base) =>
        canonicalPathKey(
          path.join(os.homedir(), base, "userdata", "betterc0de.db")
        ) === targetKey
    )
  ) {
    migrateLegacyDbIfNeeded(config.dbPath)
  }
  const db = openDatabase(config.dbPath)
  startupCleanup.push({
    name: "SQLite database",
    run: () => {
      if (db.open) db.close()
    },
  })
  startupCleanup.push({
    name: "Git processes",
    run: async () => {
      await requestGitProcessShutdown()
    },
  })
  startupCleanup.push({
    name: "image generation processes",
    run: () => requestImageGenerationShutdown().then(() => undefined),
  })
  startupCleanup.push({
    name: "native text-generation resources",
    run: () => requestNativeTextGenerationShutdown().then(() => undefined),
  })
  startupCleanup.push({
    name: "workspace formatter/config processes",
    run: () => requestWorkspaceProcessShutdown().then(() => undefined),
  })
  runMigrations(db)
  options.signal?.throwIfAborted()
  const eventStore = new EventStore(db)
  const receiptStore = new CommandReceiptStore(db)
  const threadProjections = new ThreadProjectionQuery(db)
  const messageProjections = new MessageProjectionQuery(db)
  const checkpointDiffs = new CheckpointDiffProjectionQuery(db)
  const turnProjections = new TurnProjectionQuery(db)
  const threadActivities = new ThreadActivityProjectionQuery(db)
  const providerSessionBindings = new ProviderSessionBindingStore(db)
  const providerRuntimeProjectionReceipts =
    new ProviderRuntimeProjectionReceiptStore(db)
  const providerRuntimeJournalRecoveryStore =
    new ProviderRuntimeJournalRecoveryStore(
      path.join(config.dataDir, "recovery", "provider-runtime-journal"),
      { logger }
    )
  const projectProjections = new ProjectProjectionQuery(db)
  const worktreeRegistry = new WorktreeRegistryQuery(db)
  const threads = new ThreadService(db)
  const chatDispatches = new ChatDispatchStore(db)
  // Settings are constructed by the next phase, so the policy reads them
  // through a holder bound via `bindSettingsForTrust`. Until then auto-trust
  // stays off (fail closed).
  let settingsForTrust: SettingsService | null = null
  const agentPermissions = new AgentPermissionPolicy(db, {
    autoTrustWorkspaces: () =>
      settingsForTrust?.get().auto_trust_workspaces === true,
  })
  // Provider callbacks consult this backend's runtime (its notices go to
  // `root.eventBus`) through the installed default.
  const { agentPermissionRuntime } = root
  agentPermissionRuntime.setPolicy(agentPermissions)
  setDefaultAgentPermissionRuntime(agentPermissionRuntime)
  startupCleanup.push({
    name: "agent permission runtime",
    run: () => releaseAgentPermissionRuntime(agentPermissionRuntime),
  })
  return {
    db,
    eventStore,
    receiptStore,
    threadProjections,
    messageProjections,
    checkpointDiffs,
    turnProjections,
    threadActivities,
    providerSessionBindings,
    providerRuntimeProjectionReceipts,
    providerRuntimeJournalRecoveryStore,
    projectProjections,
    worktreeRegistry,
    threads,
    chatDispatches,
    agentPermissions,
    bindSettingsForTrust: (service: SettingsService) => {
      settingsForTrust = service
    },
  }
}
