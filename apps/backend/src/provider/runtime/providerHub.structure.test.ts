import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Guards the shape of the ProviderHub split, not its behaviour. Each
 * assertion pins a decision that would otherwise erode silently: one event
 * lane, extracted modules that sit *below* the hub, a stable export surface
 * for `index.ts` and the routes, and a line count that only goes down.
 */

const runtimeDir = __dirname

function readSource(name: string): string {
  return fs.readFileSync(path.join(runtimeDir, name), "utf8")
}

/** One entry per `import ... from "<module>"` statement, in file order. */
function importStatements(
  source: string
): ReadonlyArray<{ readonly statement: string; readonly module: string }> {
  const statements: Array<{ statement: string; module: string }> = []
  const pattern = /^import[\s\S]*?from\s+"([^"]+)"/gm
  for (const match of source.matchAll(pattern)) {
    statements.push({ statement: match[0], module: match[1]! })
  }
  return statements
}

// Runtime (value) exports of `./ProviderHub`. Types are erased and do not
// appear here. Adding an export is a deliberate API change: update this list
// in the same commit and say why in the commit body.
const PROVIDER_HUB_EXPORTS = [
  "ProviderBackendQuarantinedError",
  "ProviderHub",
  "ProviderInstanceUnavailableError",
  "ProviderMetadataCapacityError",
  "ProviderMetadataInputError",
  "ProviderSessionAdmissionCapacityError",
  "ProviderSessionCapacityError",
  "ProviderSessionInspectionError",
  "ProviderStaleSessionCleanupError",
  "ProviderTurnCapacityError",
  "ProviderTurnConflictError",
  "ProviderUpdateError",
  "toApprovalRequestId",
  "toThreadId",
] as const

// Ratchet: lower it when you extract more, never raise it to fit new code.
// Split plan baseline: 4 674 lines before the split; 4 040 after (f)–(d);
// 3 975 after moving binding recovery and runtime-mode resolution out;
// 2 644 after moving status, sessions, capacity, approval routing, the
// public types and the errors into their own modules (MOD-08).
const PROVIDER_HUB_MAX_LINES = 2_650

const EXTRACTED_MODULES = [
  "HubAuditLog.ts",
  "HubApprovalRequests.ts",
  "HubApprovalRouter.ts",
  "ProviderCatalogs.ts",
  "ProviderHubErrors.ts",
  "ProviderHubTypes.ts",
  "ProviderMaintenanceCoordinator.ts",
  "ProviderMetadataCache.ts",
  "ProviderSessionRecovery.ts",
  "ProviderSessionRegistry.ts",
  "ProviderStatusService.ts",
  "ProviderTurnCapacity.ts",
  "providerTurnOptions.ts",
] as const

describe("ProviderHub structure", () => {
  const hub = readSource("ProviderHub.ts")

  it("delivers every runtime event through the single audit lane", () => {
    // `emitRuntimeEvent` is the only place that writes the canonical trace,
    // records the metric, fires the bus and calls the host — in that order.
    expect(hub.match(/auditLog\.write\(/g)).toHaveLength(1)
    expect(hub.match(/this\.bus\.emit\(/g)).toHaveLength(1)
    expect(hub.match(/this\.onEvent\?\.\(/g)).toHaveLength(1)
    expect(hub).not.toMatch(/canonicalEventLogger\?\.write/)
    expect(hub).not.toMatch(/backendMetrics\.incrementCounter/)
    expect(hub).not.toMatch(/PROVIDER_RUNTIME_EVENTS_TOTAL/)

    const lane = hub.slice(hub.indexOf("private emitRuntimeEvent("))
    const order = [
      "this.auditLog.write(event)",
      "this.auditLog.recordMetric(event)",
      'this.bus.emit("event", event)',
      "this.onEvent?.(event, hostProviderKind)",
    ].map((needle) => lane.indexOf(needle))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it("no longer owns what the extracted modules own", () => {
    // Approval policy: the hub only applies decisions, it does not compute them.
    expect(hub).not.toMatch(/evaluateConfiguredAgentToolPermission\(/)
    expect(hub).not.toMatch(/classifyToolPermission\(/)
    expect(hub).not.toMatch(/PLAN_MODE_DENY_MESSAGE|ASK_MODE_DENY_MESSAGE/)
    // Metadata cache: no in-flight map, semaphore or TTL constants left behind
    // (`metadataInFlightMaxEntries` is a public option and stays).
    expect(hub).not.toMatch(/this\.metadataInFlight\b|metadataSemaphore/)
    expect(hub).not.toMatch(/METADATA_CACHE_TTL_MS|METADATA_CACHE_MAX_ENTRIES/)
    expect(hub).not.toMatch(/class BoundedAsyncSemaphore/)
    expect(hub).not.toMatch(/function readAdapterMetadata\(/)
    // Catalogs: the hub never reads a workspace policy file itself.
    expect(hub).not.toMatch(/listProjectProviders/)
    expect(hub).not.toMatch(/isRuntimeProviderAllowedByProjectPolicy/)
    // Session recovery: binding selection is pure and lives beside the store.
    expect(hub).not.toMatch(/function selectRecoveryBinding\(/)
    expect(hub).not.toMatch(/function findConflictingProviderBinding\(/)
    expect(hub).not.toMatch(/function isResumableBinding\(/)
    expect(hub).not.toMatch(/function normalizeRuntimeMode\(/)
    // Maintenance: update bookkeeping lives in the coordinator.
    expect(hub).not.toMatch(
      /updateLockTails|runningUpdateTargets|updateStates\b/
    )
    expect(hub).not.toMatch(/withProviderUpdateLock/)
    expect(hub).not.toMatch(/function providerUpdateFailureMessage/)
    expect(hub).not.toMatch(/class ProviderUpdateError/)
    // Status: snapshots, redaction and the coalesced listing live in the
    // status service; the hub only delegates.
    // (`listInstancesInFlightMaxEntries` is a public option and stays.)
    expect(hub).not.toMatch(
      /listInstancesUncoalesced|this\.listInstancesInFlight\b/
    )
    expect(hub).not.toMatch(/function redactProviderConfig\(/)
    expect(hub).not.toMatch(/function readInstanceStatusProbe\(/)
    expect(hub).not.toMatch(/isSensitiveProviderFieldName|getMasterKey/)
    // Sessions: live-session accounting and the admission queue belong to
    // the session registry.
    expect(hub).not.toMatch(/knownLiveSessions|sessionAdmissionWaiters/)
    expect(hub).not.toMatch(/suppressedSessionExitCorrelation/)
    expect(hub).not.toMatch(/recoverSessionForThreadUnderAdmission/)
    expect(hub).not.toMatch(/function readAdapterSessions\(/)
    // Capacity: limits and their hard caps live in ProviderTurnCapacity.
    expect(hub).not.toMatch(/ACTIVE_TURNS_HARD_MAX|LIVE_SESSIONS_HARD_MAX/)
    expect(hub).not.toMatch(/function boundedProviderOperationalLimit\(/)
    // Errors and public types are declared once, outside the hub.
    expect(hub).not.toMatch(/class \w+Error extends Error/)
    expect(hub).not.toMatch(/export interface ProviderRuntimeInstance\b/)

    const modules = importStatements(hub).map((entry) => entry.module)
    for (const gone of [
      "../../services/workspace",
      "./ProviderStatusCache",
      "../../http/errors",
      "../../security/childEnvironment",
      "../permissions",
      "../shared/chat-mode-tools",
    ]) {
      expect(modules, `ProviderHub.ts still imports ${gone}`).not.toContain(
        gone
      )
    }
    for (const module of EXTRACTED_MODULES) {
      expect(modules).toContain(`./${module.replace(/\.ts$/, "")}`)
    }
  })

  it("keeps the extracted modules below the hub", () => {
    for (const name of EXTRACTED_MODULES) {
      const hubImports = importStatements(readSource(name)).filter(
        (entry) => entry.module === "./ProviderHub"
      )
      if (name === "ProviderMaintenanceCoordinator.ts") {
        // The coordinator needs the instance and snapshot *types*; a value
        // import would create a runtime cycle through the hub.
        expect(hubImports.length).toBeGreaterThan(0)
        for (const entry of hubImports) {
          expect(entry.statement, name).toMatch(/^import type\s/)
        }
        continue
      }
      expect(hubImports, `${name} must not import ./ProviderHub`).toEqual([])
    }
  })

  it("keeps the hub's public surface", async () => {
    const keys = Object.keys(await import("./ProviderHub")).sort()
    expect(keys).toEqual([...PROVIDER_HUB_EXPORTS].sort())
  })

  it("re-exports the moved errors with their original identity", async () => {
    const hubModule = await import("./ProviderHub")
    const cache = await import("./ProviderMetadataCache")
    const maintenance = await import("./ProviderMaintenanceCoordinator")
    expect(hubModule.ProviderMetadataCapacityError).toBe(
      cache.ProviderMetadataCapacityError
    )
    expect(hubModule.ProviderMetadataInputError).toBe(
      cache.ProviderMetadataInputError
    )
    expect(hubModule.ProviderUpdateError).toBe(maintenance.ProviderUpdateError)
    const errors = await import("./ProviderHubErrors")
    for (const name of [
      "ProviderBackendQuarantinedError",
      "ProviderInstanceUnavailableError",
      "ProviderSessionAdmissionCapacityError",
      "ProviderSessionCapacityError",
      "ProviderSessionInspectionError",
      "ProviderStaleSessionCleanupError",
      "ProviderTurnCapacityError",
      "ProviderTurnConflictError",
    ] as const) {
      expect(hubModule[name], name).toBe(errors[name])
    }
  })

  it("does not grow back past the ratchet", () => {
    const lines = hub.split("\n").length
    expect(lines).toBeLessThanOrEqual(PROVIDER_HUB_MAX_LINES)
  })
})
