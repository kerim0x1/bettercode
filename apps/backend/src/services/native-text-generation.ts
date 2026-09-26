import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type {
  ModelSelection,
  ProviderInstanceConfig,
  Settings,
} from "@betterc0de/schema"
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@betterc0de/schema"
import { expandHomePath } from "../pathExpansion"
import { deriveProviderInstanceConfigs } from "../provider/runtime/ProviderInstanceManager"
import { resolveCodexHomeLayout } from "../provider/runtime/codex/CodexHomeLayout"
import {
  codexBinaryPath,
  codexProcessEnvironment,
} from "../provider/runtime/codex/CodexBinaryPath"
import {
  createGrokAcpRuntime,
  type GrokAcpRuntimeOptions,
} from "../provider/runtime/grok-cli/GrokAcpRuntime"
import { resolveGrokBinaryAsync } from "../provider/runtime/grok-cli/GrokBinaryResolution"
import {
  CURSOR_BINARY_NAME,
  resolveCursorBinaryAsync,
} from "../provider/runtime/cursor/CursorBinaryResolution"
import {
  createCursorAcpRuntime,
  type CursorAcpRuntime,
  type CursorAcpRuntimeOptions,
} from "../provider/runtime/cursor/CursorAcpRuntime"
import {
  resolveCursorAcpAdvertisedModelId,
  resolveCursorAcpConfigUpdates,
} from "../provider/runtime/cursor/CursorAcpSupport"
import { createBetterC0deCompatHttpClient } from "../provider/runtime/BetterC0deCompatHttpClient"
import { parseBetterC0deModelSlug } from "../provider/runtime/betterc0deCompat/BetterC0deCompatRuntimeSupport"
import {
  BETTERC0DE_COMPAT_PROFILE,
  OPENCODE_CLI_PROFILE,
  type OpenCodeCompatProfile,
} from "../provider/runtime/betterc0deCompat/OpenCodeCompatProfile"
import { extractJsonObject } from "./text-generation"
import { logger } from "../observability/logger"
import {
  isNoSuchProcessError,
  runWindowsTaskkillDetailed,
} from "./process-termination"
import { sanitizedChildEnvironment } from "../security/childEnvironment"

import { buildWindowsCmdArgs } from "../security/windowsCommandLine"
export type NativeTextGenerationSchemaName =
  | "commitMessage"
  | "commitMessageWithBranch"
  | "prContent"
  | "branchName"
  | "threadTitle"
  | "threadContextSummary"
  | "skillContent"

export interface NativeTextGenerationInput {
  readonly settings: Settings
  readonly modelSelection?: ModelSelection | null
  readonly prompt: string
  readonly schemaName: NativeTextGenerationSchemaName
  readonly cwd?: string | null
  readonly timeoutMs?: number
}

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

export interface NativeTextGenerationRunner {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd: string
      readonly env: NodeJS.ProcessEnv
      readonly stdin: string
      readonly timeoutMs: number
      readonly signal?: AbortSignal
    }
  ) => Promise<CommandResult>
  readonly connectBetterC0deServer?: (
    input: BetterC0deServerConnectorInput
  ) => Promise<BetterC0deServerConnection>
  readonly createBetterC0deClient?: (
    input: BetterC0deClientFactoryInput
  ) => Promise<BetterC0deTextClient> | BetterC0deTextClient
  readonly createCursorRuntime?: (
    input: CursorAcpRuntimeOptions
  ) => CursorAcpRuntime
  readonly createGrokRuntime?: (
    input: GrokAcpRuntimeOptions
  ) => CursorAcpRuntime
}

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_BETTERC0DE_SERVER_TIMEOUT_MS = 5_000
const DEFAULT_BETTERC0DE_HOSTNAME = "127.0.0.1"
const BETTERC0DE_TEXT_GENERATION_IDLE_TTL_MS = 30_000
const NATIVE_PROCESS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const NATIVE_PROCESS_TERMINATE_GRACE_MS = 1_000
const NATIVE_PROCESS_FINALIZE_GRACE_MS = 2_000
const BETTERC0DE_EMPTY_CONFIG_CONTENT = "{}"
const CODEX_GIT_TEXT_GENERATION_REASONING_EFFORT = "low"
/**
 * Values `codex exec --config model_reasoning_effort=...` accepts. The value
 * is interpolated into a TOML fragment, so it must be whitelisted rather than
 * escaped. Mirrors the CodexEffort ladder in
 * provider/runtime/codex/CodexAdapter.ts; `packages/schema` deliberately
 * types `reasoning_effort` as a free string on the wire.
 */
const CODEX_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
])

function assertCodexReasoningEffort(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!CODEX_REASONING_EFFORTS.has(normalized)) {
    throw Object.assign(
      new Error(
        `Unsupported Codex reasoning effort "${value}". Expected one of: ${[...CODEX_REASONING_EFFORTS].join(", ")}.`
      ),
      { code: "NATIVE_TEXT_GENERATION_INVALID_EFFORT", statusCode: 400 }
    )
  }
  return normalized
}
const NATIVE_TEXT_GENERATION_SHUTDOWN_TIMEOUT_MS = 10_000
const DEFAULT_NATIVE_TEXT_GENERATION_MAX_CONCURRENT = 4
const DEFAULT_NATIVE_TEXT_GENERATION_MAX_QUEUED = 32
const DEFAULT_NATIVE_TEXT_GENERATION_MAX_PENDING_SESSION_CLEANUPS = 64
const MAX_CONFIGURED_NATIVE_TEXT_GENERATION_CONCURRENT = 64
const MAX_CONFIGURED_NATIVE_TEXT_GENERATION_QUEUED = 1_024
const MAX_CONFIGURED_NATIVE_TEXT_GENERATION_PENDING_SESSION_CLEANUPS = 1_024
const NATIVE_TEXT_GENERATION_MAX_CONCURRENT_ENV =
  "BETTERC0DE_NATIVE_TEXT_GENERATION_MAX_CONCURRENT"
const NATIVE_TEXT_GENERATION_MAX_QUEUED_ENV =
  "BETTERC0DE_NATIVE_TEXT_GENERATION_MAX_QUEUED"
const NATIVE_TEXT_GENERATION_MAX_PENDING_SESSION_CLEANUPS_ENV =
  "BETTERC0DE_NATIVE_TEXT_GENERATION_MAX_PENDING_SESSION_CLEANUPS"

interface SharedBetterC0deTextServer {
  readonly fingerprint: string
  readonly server: BetterC0deServerConnection
  activeRequests: number
  idleCloseTimer: ReturnType<typeof setTimeout> | null
  closePromise: Promise<void> | null
  closeFailure: unknown
}

interface ActiveNativeTextGeneration {
  readonly id: string
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
  slotAcquired: boolean
}

interface QueuedNativeTextGeneration {
  readonly operation: ActiveNativeTextGeneration
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  settled: boolean
}

interface PendingBetterC0deSessionCleanup {
  readonly id: string
  readonly sessionId: string
  readonly deleteSession: (signal: AbortSignal) => Promise<unknown>
  cleanupPromise: Promise<void> | null
  lastFailure: unknown
}

const sharedBetterC0deTextServers = new Map<
  string,
  SharedBetterC0deTextServer
>()
const activeNativeTextGenerations = new Map<
  string,
  ActiveNativeTextGeneration
>()
const activeNativeTextChildren = new Set<ChildProcess>()
const nativeTextChildStops = new Map<ChildProcess, Promise<void>>()
const unconfirmedNativeTextChildren = new WeakSet<ChildProcess>()
const nativeTextCleanupQuarantines = new Map<
  string,
  {
    readonly stop: () => Promise<void>
    pending: Promise<void> | null
  }
>()
const nativeTextGenerationQueue: QueuedNativeTextGeneration[] = []
const pendingBetterC0deSessionCleanups = new Map<
  string,
  PendingBetterC0deSessionCleanup
>()
let sharedBetterC0deAcquireTail: Promise<void> = Promise.resolve()
let nativeTextGenerationAdmissionsOpen = true
let activeNativeTextGenerationSlots = 0
let pendingBetterC0deSessionCleanupReservations = 0

export function resumeNativeTextGenerationAdmissions(): void {
  if (
    activeNativeTextGenerations.size > 0 ||
    activeNativeTextChildren.size > 0 ||
    nativeTextCleanupQuarantines.size > 0 ||
    sharedBetterC0deTextServers.size > 0 ||
    pendingBetterC0deSessionCleanups.size > 0 ||
    pendingBetterC0deSessionCleanupReservations > 0 ||
    nativeTextGenerationQueue.length > 0 ||
    activeNativeTextGenerationSlots > 0
  ) {
    throw new Error(
      "Cannot reopen native text generation while previous resources remain active."
    )
  }
  nativeTextGenerationAdmissionsOpen = true
}

export function beginNativeTextGenerationShutdown(): void {
  nativeTextGenerationAdmissionsOpen = false
  const shutdownError = nativeTextGenerationShutdownError()
  for (const operation of activeNativeTextGenerations.values()) {
    operation.controller.abort(shutdownError)
  }
  while (nativeTextGenerationQueue.length > 0) {
    const queued = nativeTextGenerationQueue.shift()!
    settleQueuedNativeTextGeneration(queued, shutdownError)
  }
  for (const entry of sharedBetterC0deTextServers.values()) {
    cancelSharedBetterC0deIdleClose(entry)
  }
}

export function activeNativeTextGenerationResourceCount(): number {
  return (
    activeNativeTextGenerations.size +
    activeNativeTextChildren.size +
    nativeTextCleanupQuarantines.size +
    sharedBetterC0deTextServers.size +
    pendingBetterC0deSessionCleanups.size
  )
}

export async function shutdownAllNativeTextGenerationResources(
  timeoutMs = NATIVE_TEXT_GENERATION_SHUTDOWN_TIMEOUT_MS
): Promise<number> {
  const initialResourceCount = activeNativeTextGenerationResourceCount()
  const operations = [...activeNativeTextGenerations.values()]
  beginNativeTextGenerationShutdown()
  const attemptedServers = new Set<SharedBetterC0deTextServer>()
  const attemptedSessionCleanups = new Set<PendingBetterC0deSessionCleanup>()
  const failures: unknown[] = []

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () =>
        reject(
          Object.assign(
            new Error(
              `${activeNativeTextGenerationResourceCount()} native text-generation resource(s) did not settle during shutdown.`
            ),
            {
              code: "NATIVE_TEXT_GENERATION_SHUTDOWN_INCOMPLETE",
              activeOperations: activeNativeTextGenerations.size,
              activeChildren: activeNativeTextChildren.size,
              activeSharedServers: sharedBetterC0deTextServers.size,
              pendingSessionCleanups: pendingBetterC0deSessionCleanups.size,
            }
          )
        ),
      Math.max(1, timeoutMs)
    )
    timeoutHandle.unref?.()
  })

  const shutdown = (async () => {
    const resourceDrain = (async () => {
      const serverDrain = withSharedBetterC0deAcquireLock(async () => {
        const entries = [...sharedBetterC0deTextServers.values()]
        for (const entry of entries) attemptedServers.add(entry)
        return await Promise.allSettled(
          entries.map((entry) => closeSharedBetterC0deTextServer(entry))
        )
      })
      const childDrain = Promise.allSettled(
        [...activeNativeTextChildren].map((child) =>
          stopTrackedNativeTextChild(child)
        )
      )
      const sessionCleanupEntries = [
        ...pendingBetterC0deSessionCleanups.values(),
      ]
      for (const entry of sessionCleanupEntries) {
        attemptedSessionCleanups.add(entry)
      }
      const sessionCleanupDrain = Promise.allSettled(
        sessionCleanupEntries.map((entry) =>
          cleanupPendingBetterC0deSession(entry)
        )
      )
      const [serverResults, childResults, sessionCleanupResults] =
        await Promise.all([serverDrain, childDrain, sessionCleanupDrain])
      for (const result of serverResults) {
        if (result.status === "rejected") failures.push(result.reason)
      }
      for (const result of childResults) {
        if (result.status === "rejected") failures.push(result.reason)
      }
      for (const result of sessionCleanupResults) {
        if (result.status === "rejected") failures.push(result.reason)
      }
    })()

    await Promise.all([
      resourceDrain,
      Promise.all(operations.map((operation) => operation.settled)),
    ])

    await withSharedBetterC0deAcquireLock(async () => {
      const lateEntries = [...sharedBetterC0deTextServers.values()].filter(
        (entry) => !attemptedServers.has(entry)
      )
      const results = await Promise.allSettled(
        lateEntries.map((entry) => closeSharedBetterC0deTextServer(entry))
      )
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason)
      }
      for (const entry of sharedBetterC0deTextServers.values()) {
        cancelSharedBetterC0deIdleClose(entry)
      }
    })

    const lateChildResults = await Promise.allSettled(
      [...activeNativeTextChildren].map((child) =>
        stopTrackedNativeTextChild(child)
      )
    )
    for (const result of lateChildResults) {
      if (result.status === "rejected") failures.push(result.reason)
    }

    const lateSessionCleanupEntries = [
      ...pendingBetterC0deSessionCleanups.values(),
    ].filter((entry) => !attemptedSessionCleanups.has(entry))
    const lateSessionCleanupResults = await Promise.allSettled(
      lateSessionCleanupEntries.map((entry) =>
        cleanupPendingBetterC0deSession(entry)
      )
    )
    for (const result of lateSessionCleanupResults) {
      if (result.status === "rejected") failures.push(result.reason)
    }
    const quarantineResults = await Promise.allSettled(
      [...nativeTextCleanupQuarantines.keys()].map(cleanupNativeTextQuarantine)
    )
    for (const result of quarantineResults) {
      if (result.status === "rejected") failures.push(result.reason)
    }
  })()

  try {
    await Promise.race([shutdown, timeout])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }

  const remaining = activeNativeTextGenerationResourceCount()
  if (remaining > 0) {
    failures.push(
      Object.assign(
        new Error(
          `${remaining} native text-generation resource(s) remain after shutdown.`
        ),
        {
          code: "NATIVE_TEXT_GENERATION_RESOURCES_REMAIN",
          activeOperations: activeNativeTextGenerations.size,
          activeChildren: activeNativeTextChildren.size,
          activeSharedServers: sharedBetterC0deTextServers.size,
          pendingSessionCleanups: pendingBetterC0deSessionCleanups.size,
        }
      )
    )
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Native text-generation resource shutdown failed"
    )
  }
  return initialResourceCount
}

export async function runNativeTextGeneration(
  input: NativeTextGenerationInput,
  runner: NativeTextGenerationRunner = { run: runProcess }
): Promise<string | null> {
  if (!nativeTextGenerationAdmissionsOpen) {
    throw Object.assign(
      new Error("Native text generation is not accepting new work."),
      { code: "NATIVE_TEXT_GENERATION_ADMISSION_CLOSED" }
    )
  }
  let resolveSettled!: () => void
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  const operation: ActiveNativeTextGeneration = {
    id: randomUUID(),
    controller: new AbortController(),
    settled,
    resolveSettled,
    slotAcquired: false,
  }
  activeNativeTextGenerations.set(operation.id, operation)

  try {
    await acquireNativeTextGenerationSlot(operation)
    throwIfNativeTextGenerationUnavailable(operation.controller.signal)
    const modelSelection = input.modelSelection
    if (!modelSelection) return null

    const providerConfig = resolveProviderConfig(input.settings, modelSelection)
    if (!providerConfig || providerConfig.enabled === false) return null

    const driver = normalizeNativeDriver(providerConfig.driver)
    if (driver === "codex") {
      return await runCodexTextGeneration(
        input,
        providerConfig,
        modelSelection,
        runner,
        operation.controller.signal
      )
    }
    if (driver === "claude") {
      return await runClaudeTextGeneration(
        input,
        providerConfig,
        modelSelection,
        runner,
        operation.controller.signal
      )
    }
    if (driver === "betterc0de") {
      return await runBetterC0deTextGeneration(
        input,
        providerConfig,
        modelSelection,
        runner,
        operation.controller.signal
      )
    }
    if (driver === "cursor" || driver === "grok") {
      return await runAcpTextGeneration(
        input,
        providerConfig,
        modelSelection,
        runner,
        operation.controller.signal,
        driver
      )
    }
    return null
  } finally {
    releaseNativeTextGenerationSlot(operation)
    if (activeNativeTextGenerations.get(operation.id) === operation) {
      activeNativeTextGenerations.delete(operation.id)
    }
    operation.resolveSettled()
  }
}

async function acquireNativeTextGenerationSlot(
  operation: ActiveNativeTextGeneration
): Promise<void> {
  throwIfNativeTextGenerationUnavailable(operation.controller.signal)
  drainNativeTextGenerationQueue()
  if (
    nativeTextGenerationQueue.length === 0 &&
    activeNativeTextGenerationSlots < nativeTextGenerationMaxConcurrent()
  ) {
    activeNativeTextGenerationSlots += 1
    operation.slotAcquired = true
    return
  }
  if (nativeTextGenerationQueue.length >= nativeTextGenerationMaxQueued()) {
    throw Object.assign(new Error("Native text-generation queue is full."), {
      code: "NATIVE_TEXT_GENERATION_QUEUE_FULL",
      statusCode: 503,
    })
  }

  await new Promise<void>((resolve, reject) => {
    const queued: QueuedNativeTextGeneration = {
      operation,
      resolve,
      reject,
      settled: false,
    }
    nativeTextGenerationQueue.push(queued)
    if (operation.controller.signal.aborted) {
      const index = nativeTextGenerationQueue.indexOf(queued)
      if (index >= 0) nativeTextGenerationQueue.splice(index, 1)
      settleQueuedNativeTextGeneration(
        queued,
        operation.controller.signal.reason ??
          nativeTextGenerationShutdownError()
      )
    }
  })
}

function releaseNativeTextGenerationSlot(
  operation: ActiveNativeTextGeneration
): void {
  if (!operation.slotAcquired) return
  operation.slotAcquired = false
  activeNativeTextGenerationSlots = Math.max(
    0,
    activeNativeTextGenerationSlots - 1
  )
  drainNativeTextGenerationQueue()
}

function drainNativeTextGenerationQueue(): void {
  if (!nativeTextGenerationAdmissionsOpen) return
  const maxConcurrent = nativeTextGenerationMaxConcurrent()
  while (
    activeNativeTextGenerationSlots < maxConcurrent &&
    nativeTextGenerationQueue.length > 0
  ) {
    const queued = nativeTextGenerationQueue.shift()!
    const operation = queued.operation
    if (
      activeNativeTextGenerations.get(operation.id) !== operation ||
      operation.controller.signal.aborted
    ) {
      settleQueuedNativeTextGeneration(
        queued,
        operation.controller.signal.reason ??
          nativeTextGenerationShutdownError()
      )
      continue
    }
    activeNativeTextGenerationSlots += 1
    operation.slotAcquired = true
    settleQueuedNativeTextGeneration(queued)
  }
}

function settleQueuedNativeTextGeneration(
  queued: QueuedNativeTextGeneration,
  error?: unknown
): void {
  if (queued.settled) return
  queued.settled = true
  if (error !== undefined) queued.reject(error)
  else queued.resolve()
}

function nativeTextGenerationMaxConcurrent(): number {
  return configuredNativeTextGenerationLimit(
    NATIVE_TEXT_GENERATION_MAX_CONCURRENT_ENV,
    DEFAULT_NATIVE_TEXT_GENERATION_MAX_CONCURRENT,
    1,
    MAX_CONFIGURED_NATIVE_TEXT_GENERATION_CONCURRENT
  )
}

function nativeTextGenerationMaxQueued(): number {
  return configuredNativeTextGenerationLimit(
    NATIVE_TEXT_GENERATION_MAX_QUEUED_ENV,
    DEFAULT_NATIVE_TEXT_GENERATION_MAX_QUEUED,
    0,
    MAX_CONFIGURED_NATIVE_TEXT_GENERATION_QUEUED
  )
}

function nativeTextGenerationMaxPendingSessionCleanups(): number {
  return configuredNativeTextGenerationLimit(
    NATIVE_TEXT_GENERATION_MAX_PENDING_SESSION_CLEANUPS_ENV,
    DEFAULT_NATIVE_TEXT_GENERATION_MAX_PENDING_SESSION_CLEANUPS,
    1,
    MAX_CONFIGURED_NATIVE_TEXT_GENERATION_PENDING_SESSION_CLEANUPS
  )
}

function reserveBetterC0deSessionCleanupCapacity(): void {
  if (
    pendingBetterC0deSessionCleanups.size +
      pendingBetterC0deSessionCleanupReservations >=
    nativeTextGenerationMaxPendingSessionCleanups()
  ) {
    throw Object.assign(
      new Error(
        "Native text generation is refusing BetterC0de work because unresolved session cleanup reached its configured limit."
      ),
      {
        code: "NATIVE_TEXT_GENERATION_CLEANUP_BACKLOG_FULL",
        statusCode: 503,
      }
    )
  }
  pendingBetterC0deSessionCleanupReservations += 1
}

function releaseBetterC0deSessionCleanupCapacity(): void {
  pendingBetterC0deSessionCleanupReservations = Math.max(
    0,
    pendingBetterC0deSessionCleanupReservations - 1
  )
}

function configuredNativeTextGenerationLimit(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

function nativeTextGenerationShutdownError(): Error {
  return Object.assign(new Error("Native text generation is shutting down."), {
    code: "NATIVE_TEXT_GENERATION_SHUTDOWN",
  })
}

class NativeTextProcessCleanupError extends Error {
  declare readonly child: ChildProcess

  constructor(child: ChildProcess, cause: unknown) {
    super(
      "Native text-generation process-tree cleanup could not be confirmed.",
      { cause }
    )
    Object.defineProperty(this, "child", { value: child })
  }
}

function quarantineNativeTextCleanup(
  directory: string,
  stop: () => Promise<void>
): void {
  nativeTextCleanupQuarantines.set(directory, { stop, pending: null })
  beginNativeTextGenerationShutdown()
}

async function cleanupNativeTextQuarantine(directory: string): Promise<void> {
  const entry = nativeTextCleanupQuarantines.get(directory)
  if (!entry) return
  if (entry.pending) return await entry.pending
  entry.pending = (async () => {
    await entry.stop()
    await fs.rm(directory, { recursive: true, force: true })
    nativeTextCleanupQuarantines.delete(directory)
  })()
  try {
    await entry.pending
  } finally {
    entry.pending = null
  }
}

function retainFailedNativeTextProcess(
  directory: string,
  error: unknown
): boolean {
  if (!(error instanceof NativeTextProcessCleanupError)) return false
  unconfirmedNativeTextChildren.add(error.child)
  quarantineNativeTextCleanup(directory, async () => {
    if (!activeNativeTextChildren.has(error.child)) return
    await stopTrackedNativeTextChild(error.child)
  })
  return true
}

function resolveProviderConfig(
  settings: Settings,
  modelSelection: ModelSelection
): ProviderInstanceConfig | null {
  return (
    deriveProviderInstanceConfigs(settings).find(
      (config) => config.instanceId === modelSelection.instanceId
    ) ?? null
  )
}

async function runCodexTextGeneration(
  input: NativeTextGenerationInput,
  config: ProviderInstanceConfig,
  modelSelection: ModelSelection,
  runner: NativeTextGenerationRunner,
  lifecycleSignal: AbortSignal
): Promise<string> {
  throwIfNativeTextGenerationUnavailable(lifecycleSignal)
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "betterc0de-codex-text-generation-")
  )
  const schemaPath = path.join(tempDir, "schema.json")
  const outputPath = path.join(tempDir, "output.json")
  let cleanupSafe = true
  try {
    throwIfNativeTextGenerationUnavailable(lifecycleSignal)
    await fs.writeFile(
      schemaPath,
      JSON.stringify(jsonSchemaFor(input.schemaName)),
      "utf8"
    )
    throwIfNativeTextGenerationUnavailable(lifecycleSignal)
    await fs.writeFile(outputPath, "", "utf8")
    throwIfNativeTextGenerationUnavailable(lifecycleSignal)

    const binaryPath = codexBinaryPath(
      configString(config.config, "binaryPath")
    )
    const effort = assertCodexReasoningEffort(
      getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        getModelSelectionStringOptionValue(modelSelection, "effort") ??
        CODEX_GIT_TEXT_GENERATION_REASONING_EFFORT
    )
    const fastMode =
      getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true

    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "--model",
      modelSelection.model,
      "--config",
      `model_reasoning_effort='${effort}'`,
      ...(fastMode ? ["--config", "service_tier='fast'"] : []),
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ]

    const result = await runner.run(binaryPath, args, {
      // Without a workspace, run inside the private temp dir rather than
      // `process.cwd()` — that is the app's own install directory.
      cwd: resolveCwd(input.cwd, tempDir),
      env: codexProcessEnvironment(binaryPath, codexEnvironment(config)),
      stdin: input.prompt,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: lifecycleSignal,
    })
    if (result.exitCode !== 0) {
      throw new Error(
        commandFailureMessage(
          "Codex CLI",
          result.exitCode,
          result.stderr,
          result.stdout
        )
      )
    }
    const output = (
      await readUtf8FileBounded(
        outputPath,
        NATIVE_PROCESS_MAX_OUTPUT_BYTES,
        "Codex CLI output"
      )
    ).trim()
    return output || result.stdout.trim()
  } catch (error) {
    cleanupSafe = !retainFailedNativeTextProcess(tempDir, error)
    throw error
  } finally {
    if (cleanupSafe)
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function runClaudeTextGeneration(
  input: NativeTextGenerationInput,
  config: ProviderInstanceConfig,
  modelSelection: ModelSelection,
  runner: NativeTextGenerationRunner,
  lifecycleSignal: AbortSignal
): Promise<string> {
  // Text-generation prompts can contain repository and conversation content.
  // Run Claude without tools in an isolated directory so prompt injection
  // cannot inherit write/execute access to the user's workspace.
  throwIfNativeTextGenerationUnavailable(lifecycleSignal)
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "betterc0de-claude-text-generation-")
  )
  let cleanupSafe = true
  try {
    throwIfNativeTextGenerationUnavailable(lifecycleSignal)
    // The Finder-launched macOS app does not inherit the user's shell PATH.
    // The shell process already resolved the installed Claude binary for SDK
    // turns; handoff and compaction must use that same executable.
    const binaryPath =
      configString(config.config, "binaryPath") ??
      (process.env.BETTERC0DE_CLAUDE_CODE_PATH?.trim() || "claude")
    const effort = normalizeClaudeCliEffort(
      getModelSelectionStringOptionValue(modelSelection, "effort") ??
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")
    )
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(jsonSchemaFor(input.schemaName)),
      "--model",
      modelSelection.model,
      ...(effort ? ["--effort", effort] : []),
      "--tools",
      "",
      "--disallowedTools",
      "Bash,Edit,Write,NotebookEdit,Agent,Task,WebFetch,WebSearch",
    ]

    const result = await runner.run(binaryPath, args, {
      cwd: tempDir,
      env: claudeEnvironment(config),
      stdin: input.prompt,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: lifecycleSignal,
    })
    if (result.exitCode !== 0) {
      throw new Error(
        commandFailureMessage(
          "Claude CLI",
          result.exitCode,
          result.stderr,
          result.stdout
        )
      )
    }

    return extractClaudeStructuredOutput(result.stdout)
  } catch (error) {
    cleanupSafe = !retainFailedNativeTextProcess(tempDir, error)
    throw error
  } finally {
    if (cleanupSafe)
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function runBetterC0deTextGeneration(
  input: NativeTextGenerationInput,
  config: ProviderInstanceConfig,
  modelSelection: ModelSelection,
  runner: NativeTextGenerationRunner,
  lifecycleSignal: AbortSignal
): Promise<string> {
  const profile = profileForTextDriver(config.driver)
  const parsedModel = parseBetterC0deModelSlug(modelSelection.model)
  if (!parsedModel) {
    throw new Error(
      "BetterC0de model selection must use the 'provider/model' format."
    )
  }

  const binaryPath =
    configString(config.config, "binaryPath") ?? profile.defaultBinaryPath
  const serverUrl = configString(config.config, "serverUrl")
  const serverUsername =
    configString(config.config, "serverUsername") ??
    firstDefinedEnv(profile.serverUsernameEnvVars)
  const serverPassword = configString(config.config, "serverPassword")
  const serverConnector =
    runner.connectBetterC0deServer ?? connectBetterC0deServer
  const createClient =
    runner.createBetterC0deClient ?? defaultBetterC0deClientFactory
  reserveBetterC0deSessionCleanupCapacity()
  let cleanupReservationHeld = true
  let serverLease: BetterC0deTextServerLease
  try {
    serverLease = await acquireBetterC0deTextServer({
      binaryPath,
      serverUrl,
      env: providerEnvironment(config),
      serverConnector,
      signal: lifecycleSignal,
      profile,
    })
  } catch (error) {
    releaseBetterC0deSessionCleanupCapacity()
    throw error
  }
  const requestAbort = new AbortController()
  const onLifecycleAbort = () => {
    requestAbort.abort(
      lifecycleSignal.reason ??
        new Error("Native text generation is shutting down.")
    )
  }
  if (lifecycleSignal.aborted) onLifecycleAbort()
  else {
    lifecycleSignal.addEventListener("abort", onLifecycleAbort, { once: true })
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeout = setTimeout(() => {
    requestAbort.abort(
      new Error(`BetterC0de request timed out after ${timeoutMs}ms`)
    )
  }, timeoutMs)
  timeout.unref?.()
  let client: BetterC0deTextClient | null = null
  let sessionId: string | null = null
  let output: string | undefined
  let failure: unknown
  let scratchDirectory: string | null = null
  try {
    const server = serverLease.server
    // Same rule as the CLI paths: no workspace means a private temp dir,
    // never the app directory. Created after the request timeout is armed so
    // the deadline also covers this I/O.
    if (!input.cwd?.trim()) {
      scratchDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "betterc0de-compat-text-generation-")
      )
    }
    client = await createClient({
      baseUrl: server.url,
      directory: resolveCwd(input.cwd, scratchDirectory ?? ""),
      ...(server.external && serverPassword
        ? { serverUsername, serverPassword }
        : {}),
    }, profile)
    if (server.external && !client.session.delete) {
      throw Object.assign(
        new Error(
          "External BetterC0de compatibility server does not support required session cleanup."
        ),
        { code: "BETTERC0DE_SESSION_CLEANUP_UNSUPPORTED" }
      )
    }
    const created = await waitForAbort(
      client.session.create(
        {
          title: `BetterC0de ${input.schemaName}`,
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        },
        { signal: requestAbort.signal }
      ),
      requestAbort.signal,
      "BetterC0de session creation timed out."
    )
    sessionId = created.data?.id ?? null
    if (!sessionId)
      throw new Error("BetterC0de session.create returned no session payload.")

    const selectedAgent = getModelSelectionStringOptionValue(
      modelSelection,
      "agent"
    )
    const selectedVariant = getModelSelectionStringOptionValue(
      modelSelection,
      "variant"
    )
    const result = await waitForAbort(
      client.session.prompt(
        {
          sessionID: sessionId,
          model: parsedModel,
          ...(selectedAgent ? { agent: selectedAgent } : {}),
          ...(selectedVariant ? { variant: selectedVariant } : {}),
          parts: [{ type: "text", text: input.prompt }],
        },
        { signal: requestAbort.signal }
      ),
      requestAbort.signal,
      "BetterC0de prompt timed out."
    )
    const errorMessage = betterC0dePromptErrorMessage(result.data?.info?.error)
    if (errorMessage) throw new Error(errorMessage)

    const rawText = betterC0deTextResponse(result.data?.parts)
    if (!rawText)
      throw new Error("BetterC0de compatibility returned empty output.")
    output = extractJsonObject(rawText)
  } catch (error) {
    failure = error
  } finally {
    clearTimeout(timeout)
    lifecycleSignal.removeEventListener("abort", onLifecycleAbort)
    requestAbort.abort()
    if (client?.session.delete && sessionId) {
      const sessionClient = client.session
      const cleanup = registerPendingBetterC0deSessionCleanup({
        sessionId,
        deleteSession: (signal) =>
          sessionClient.delete!({ sessionID: sessionId }, { signal }),
      })
      releaseBetterC0deSessionCleanupCapacity()
      cleanupReservationHeld = false
      try {
        await cleanupPendingBetterC0deSession(cleanup)
      } catch (error) {
        failure = failure
          ? new AggregateError(
              [failure, error],
              "BetterC0de request and session cleanup both failed."
            )
          : error
      }
    }
    if (scratchDirectory) {
      await fs
        .rm(scratchDirectory, { recursive: true, force: true })
        .catch(() => {})
    }
    try {
      await serverLease.release()
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            "BetterC0de request and server cleanup both failed."
          )
        : error
    }
    if (cleanupReservationHeld) {
      releaseBetterC0deSessionCleanupCapacity()
      cleanupReservationHeld = false
    }
  }
  if (failure) throw failure
  return output!
}

function registerPendingBetterC0deSessionCleanup(input: {
  readonly sessionId: string
  readonly deleteSession: (signal: AbortSignal) => Promise<unknown>
}): PendingBetterC0deSessionCleanup {
  const entry: PendingBetterC0deSessionCleanup = {
    id: randomUUID(),
    sessionId: input.sessionId,
    deleteSession: input.deleteSession,
    cleanupPromise: null,
    lastFailure: null,
  }
  pendingBetterC0deSessionCleanups.set(entry.id, entry)
  return entry
}

async function cleanupPendingBetterC0deSession(
  entry: PendingBetterC0deSessionCleanup
): Promise<void> {
  if (entry.cleanupPromise) return await entry.cleanupPromise
  const cleanupPromise = (async () => {
    const cleanupAbort = new AbortController()
    const cleanupTimer = setTimeout(() => {
      cleanupAbort.abort(
        Object.assign(
          new Error(
            `Timed out deleting BetterC0de compatibility session ${entry.sessionId}.`
          ),
          { code: "BETTERC0DE_SESSION_CLEANUP_TIMEOUT" }
        )
      )
    }, DEFAULT_BETTERC0DE_SERVER_TIMEOUT_MS)
    cleanupTimer.unref?.()
    try {
      await waitForAbort(
        entry.deleteSession(cleanupAbort.signal),
        cleanupAbort.signal,
        `Timed out deleting BetterC0de compatibility session ${entry.sessionId}.`
      )
      entry.lastFailure = null
      if (pendingBetterC0deSessionCleanups.get(entry.id) === entry) {
        pendingBetterC0deSessionCleanups.delete(entry.id)
      }
    } finally {
      clearTimeout(cleanupTimer)
    }
  })()
  entry.cleanupPromise = cleanupPromise
  try {
    await cleanupPromise
  } catch (error) {
    entry.lastFailure = error
    throw error
  } finally {
    if (entry.cleanupPromise === cleanupPromise) {
      entry.cleanupPromise = null
    }
  }
}

async function runAcpTextGeneration(
  input: NativeTextGenerationInput,
  config: ProviderInstanceConfig,
  modelSelection: ModelSelection,
  runner: NativeTextGenerationRunner,
  lifecycleSignal: AbortSignal,
  driver: "cursor" | "grok"
): Promise<string> {
  // Native text-generation prompts already contain the required repository
  // context. Do not give the external ACP agent the repository as its cwd:
  // prompt injection must not turn a metadata helper into a workspace editor.
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `betterc0de-${driver}-text-generation-`)
  )
  const createRuntime =
    driver === "grok"
      ? (runner.createGrokRuntime ?? createGrokAcpRuntime)
      : (runner.createCursorRuntime ?? createCursorAcpRuntime)
  const label = driver === "grok" ? "Grok" : "Cursor Agent"
  let runtime: CursorAcpRuntime | null = null
  let unsubscribe = () => {}
  const output = new BoundedOutputBuffer(NATIVE_PROCESS_MAX_OUTPUT_BYTES)
  let outputExceeded = false
  let cancellationRequested = false
  let onLifecycleAbort: (() => void) | null = null
  let result: string | undefined
  let failure: unknown
  let cleanupSafe = true
  try {
    let binaryPath =
      configString(config.config, "binaryPath") ??
      (driver === "grok" ? "grok" : CURSOR_BINARY_NAME)
    if (driver === "grok" && !runner.createGrokRuntime) {
      const resolved = await resolveGrokBinaryAsync(binaryPath)
      if (!resolved)
        throw new Error("xAI Grok CLI is unavailable for the provider handoff.")
      binaryPath = resolved.binaryPath
    }
    if (driver === "cursor" && !runner.createCursorRuntime) {
      const resolved = await resolveCursorBinaryAsync(binaryPath)
      if (!resolved)
        throw new Error(
          "Cursor Agent CLI is unavailable for the provider handoff."
        )
      binaryPath = resolved.binaryPath
    }
    throwIfNativeTextGenerationUnavailable(lifecycleSignal)
    runtime = createRuntime({
      settings: {
        binaryPath,
        apiEndpoint: configString(config.config, "apiEndpoint") ?? undefined,
      },
      cwd: tempDir,
      env: providerEnvironment(config),
      clientInfo: {
        name: "betterc0de-text-generation",
        title: "BetterC0de",
        version: "0.0.0",
      },
    })
    onLifecycleAbort = () => {
      if (cancellationRequested) return
      cancellationRequested = true
      void runtime?.cancel().catch(() => {
        // close() in the finalizer remains the authoritative lifecycle check.
      })
    }
    if (lifecycleSignal.aborted) onLifecycleAbort()
    else {
      lifecycleSignal.addEventListener("abort", onLifecycleAbort, {
        once: true,
      })
    }
    runtime.onPermissionRequest(async () => ({
      outcome: { outcome: "cancelled" },
    }))
    unsubscribe = runtime.onEvent((event) => {
      if (event.type !== "content.delta" || outputExceeded) return
      if (!output.append(event.text)) return
      outputExceeded = true
      if (!cancellationRequested) {
        cancellationRequested = true
        void runtime?.cancel().catch(() => {
          // The size violation remains the primary error. close() below is the
          // authoritative process-lifecycle check and is never swallowed.
        })
      }
    })

    result = await waitForAbort(
      withTimeout(
        (async () => {
          await runtime!.start()
          const modeState = runtime!.getModeState()
          // Grok has no session modes. Its permission requests are all denied
          // by the handler above; it also gets no filesystem/terminal APIs.
          if (driver === "cursor") {
            if (
              !modeState ||
              !modeState.availableModes.some((mode) => mode.id === "ask")
            ) {
              throw new Error(
                "Cursor Agent did not advertise the required ask permission mode."
              )
            }
            await runtime!.setMode("ask")
            if (runtime!.getModeState()?.currentModeId !== "ask") {
              throw new Error(
                "Cursor Agent did not confirm the required ask permission mode."
              )
            }
          }
          await runtime!.setModel(
            resolveCursorAcpAdvertisedModelId(
              modelSelection.model,
              runtime!.getConfigOptions()
            )
          )
          const updates = resolveCursorAcpConfigUpdates(
            runtime!.getConfigOptions(),
            modelSelection.options
          )
          for (const update of updates) {
            await runtime!.setConfigOption(update.configId, update.value)
          }
          let promptResult: Record<string, unknown>
          try {
            promptResult = await runtime!.prompt({
              prompt: [{ type: "text", text: input.prompt }],
            })
          } catch (error) {
            if (outputExceeded) {
              throw new Error(
                `${label} output exceeded ${NATIVE_PROCESS_MAX_OUTPUT_BYTES} bytes.`,
                { cause: error }
              )
            }
            throw error
          }
          if (outputExceeded) {
            throw new Error(
              `${label} output exceeded ${NATIVE_PROCESS_MAX_OUTPUT_BYTES} bytes.`
            )
          }
          const rawText = output.text.trim()
          if (!rawText) {
            const stopReason =
              typeof promptResult.stopReason === "string"
                ? promptResult.stopReason
                : null
            throw new Error(
              stopReason === "cancelled"
                ? `${label} request was cancelled.`
                : `${label} returned empty output.`
            )
          }
          return extractJsonObject(rawText)
        })(),
        input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        `${label} request timed out.`
      ),
      lifecycleSignal,
      `${label} request was cancelled during shutdown.`
    )
  } catch (error) {
    failure = error
  } finally {
    if (onLifecycleAbort) {
      lifecycleSignal.removeEventListener("abort", onLifecycleAbort)
    }
    unsubscribe()
    if (runtime) {
      try {
        await runtime.close()
      } catch (error) {
        cleanupSafe = false
        const retainedRuntime = runtime
        quarantineNativeTextCleanup(tempDir, () => retainedRuntime.close())
        failure = failure
          ? new AggregateError(
              [failure, error],
              `${label} request and process cleanup both failed.`
            )
          : error
      }
    }
    if (cleanupSafe)
      await fs.rm(tempDir, { recursive: true, force: true }).catch((error) => {
        failure = failure
          ? new AggregateError(
              [failure, error],
              `${label} request and temporary-directory cleanup both failed.`
            )
          : error
      })
  }
  if (failure) throw failure
  return result!
}

function jsonSchemaFor(schemaName: NativeTextGenerationSchemaName): unknown {
  switch (schemaName) {
    case "commitMessageWithBranch":
      return objectSchema(["subject", "body", "branch"])
    case "commitMessage":
      return objectSchema(["subject", "body"])
    case "prContent":
      return objectSchema(["title", "body"])
    case "branchName":
      return objectSchema(["branch"])
    case "threadTitle":
      return objectSchema(["title"])
    case "threadContextSummary":
      return objectSchema(["summary"])
    case "skillContent":
      return objectSchema(["content"])
  }
}

function objectSchema(required: ReadonlyArray<string>): unknown {
  const properties: Record<string, unknown> = {}
  for (const key of required) properties[key] = { type: "string" }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  }
}

function codexEnvironment(config: ProviderInstanceConfig): NodeJS.ProcessEnv {
  const env = providerEnvironment(config)
  const homePath = configString(config.config, "homePath")
  const shadowHomePath = configString(config.config, "shadowHomePath")
  const layout = resolveCodexHomeLayout({ homePath, shadowHomePath })
  if (layout.runtimeHome) env.CODEX_HOME = layout.runtimeHome
  return env
}

function claudeEnvironment(config: ProviderInstanceConfig): NodeJS.ProcessEnv {
  const env = providerEnvironment(config)
  const homePath = configString(config.config, "homePath")
  if (homePath) env.HOME = normalizeClaudeHome(homePath)
  return env
}

function providerEnvironment(
  config: ProviderInstanceConfig
): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = {}
  for (const item of config.environment ?? []) {
    if (!item.name) continue
    overrides[item.name] = item.value
  }
  return sanitizedChildEnvironment(overrides)
}

function normalizeNativeDriver(
  driver: string
): "codex" | "claude" | "betterc0de" | "cursor" | string {
  const key = driver.trim().toLowerCase().replace(/[_-]+/g, "")
  if (key === "codex" || key === "codexcli") return "codex"
  if (key === "grok" || key === "grokcli" || key === "grokacp") return "grok"
  if (
    key === "betterc0de" ||
    key === "bettercode" ||
    key === "betterc0decli" ||
    key === "bettercodecli" ||
    key === "opencode" ||
    key === "opencodecli"
  ) {
    return "betterc0de"
  }
  if (key === "cursor" || key === "cursoragent" || key === "cursoracp") {
    return "cursor"
  }
  if (
    key === "claude" ||
    key === "claudeagent" ||
    key === "anthropiccli" ||
    key === "claudecli" ||
    key === "claudeterminal" ||
    key === "claudepty" ||
    key === "claudeptywrapper"
  ) {
    return "claude"
  }
  return driver
}

function normalizeClaudeCliEffort(
  raw: string | null | undefined
): string | null {
  if (!raw) return null
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  if (key === "low" || key === "medium" || key === "high") return key
  if (
    key === "xhigh" ||
    key === "extrahigh" ||
    key === "max" ||
    key === "ultra" ||
    key === "ultrathink"
  ) {
    return "max"
  }
  return null
}

function extractClaudeStructuredOutput(stdout: string): string {
  const trimmed = stdout.trim()
  if (!trimmed) return ""
  try {
    const parsed = JSON.parse(trimmed) as { structured_output?: unknown }
    if (parsed && typeof parsed === "object" && "structured_output" in parsed) {
      return JSON.stringify(parsed.structured_output ?? {})
    }
  } catch {
    // Some CLI versions return the structured object directly; pass it through.
  }
  return trimmed
}

interface BetterC0deServerConnectorInput {
  readonly binaryPath: string
  readonly serverUrl?: string | null
  readonly env: NodeJS.ProcessEnv
  readonly profile?: OpenCodeCompatProfile
}

interface BetterC0deServerConnection {
  readonly url: string
  readonly external: boolean
  readonly close: () => Promise<void>
}

interface BetterC0deTextServerLease {
  readonly server: BetterC0deServerConnection
  readonly release: () => Promise<void>
}

interface BetterC0deClientFactoryInput {
  readonly baseUrl: string
  readonly directory: string
  readonly serverUsername?: string
  readonly serverPassword?: string
}

interface BetterC0deTextClient {
  readonly session: {
    create(
      input: Record<string, unknown>,
      options?: { readonly signal?: AbortSignal }
    ): Promise<{ readonly data?: { readonly id: string } }>
    prompt(
      input: Record<string, unknown>,
      options?: { readonly signal?: AbortSignal }
    ): Promise<{
      readonly data?: {
        readonly info?: { readonly error?: unknown }
        readonly parts?: ReadonlyArray<unknown>
      }
    }>
    delete?(
      input: Record<string, unknown>,
      options?: { readonly signal?: AbortSignal }
    ): Promise<unknown>
  }
}

async function defaultBetterC0deClientFactory(
  input: BetterC0deClientFactoryInput,
  profile: OpenCodeCompatProfile = BETTERC0DE_COMPAT_PROFILE
): Promise<BetterC0deTextClient> {
  return createBetterC0deCompatHttpClient<BetterC0deTextClient>({
    baseUrl: input.baseUrl,
    directory: input.directory,
    serverUsername: input.serverUsername,
    serverPassword: input.serverPassword,
    v2Envelope: profile.v2Envelope,
  })
}

async function connectBetterC0deServer(
  input: BetterC0deServerConnectorInput
): Promise<BetterC0deServerConnection> {
  const serverUrl = input.serverUrl?.trim()
  if (serverUrl) {
    return {
      url: serverUrl,
      external: true,
      close: async () => {},
    }
  }
  return startBetterC0deServerProcess(input)
}

/**
 * Which OpenCode-family CLI a native text-generation request drives. The
 * `opencode` binary speaks the same protocol as BetterC0de's compatibility
 * CLI but wraps v2 inventory payloads, so the v2 envelope flag differs.
 */
function profileForTextDriver(driver: string | undefined): OpenCodeCompatProfile {
  const key = (driver ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "")
  // `opencode-cli` is the upstream `opencode` binary's driver; bare
  // `opencode` and `open-code` stay aliases of the BetterC0de compat driver
  // (see normalizeDriverForCompat) and must keep its profile.
  if (key === "opencodecli") return OPENCODE_CLI_PROFILE
  return BETTERC0DE_COMPAT_PROFILE
}

function firstDefinedEnv(names: ReadonlyArray<string>): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

async function acquireBetterC0deTextServer(input: {
  readonly binaryPath: string
  readonly serverUrl?: string | null
  readonly env: NodeJS.ProcessEnv
  readonly signal: AbortSignal
  readonly profile: OpenCodeCompatProfile
  readonly serverConnector: (
    input: BetterC0deServerConnectorInput
  ) => Promise<BetterC0deServerConnection>
}): Promise<BetterC0deTextServerLease> {
  const serverUrl = input.serverUrl?.trim()
  if (serverUrl) {
    throwIfNativeTextGenerationUnavailable(input.signal)
    const server = await input.serverConnector({
      binaryPath: input.binaryPath,
      serverUrl,
      env: input.env,
      profile: input.profile,
    })
    if (!nativeTextGenerationAdmissionsOpen || input.signal.aborted) {
      const admissionFailure =
        input.signal.reason ??
        Object.assign(
          new Error(
            "Native text generation stopped during server acquisition."
          ),
          { code: "NATIVE_TEXT_GENERATION_SHUTDOWN" }
        )
      try {
        await server.close()
      } catch (closeFailure) {
        throw new AggregateError(
          [admissionFailure, closeFailure],
          "Native text-generation server acquisition and cleanup both failed"
        )
      }
      throw admissionFailure
    }
    return { server, release: server.close }
  }

  const entry = await acquireSharedBetterC0deTextServer({
    binaryPath: input.binaryPath,
    env: input.env,
    serverConnector: input.serverConnector,
    signal: input.signal,
    profile: input.profile,
  })
  return {
    server: entry.server,
    release: async () => {
      releaseSharedBetterC0deTextServer(entry)
    },
  }
}

async function acquireSharedBetterC0deTextServer(input: {
  readonly binaryPath: string
  readonly env: NodeJS.ProcessEnv
  readonly signal: AbortSignal
  readonly profile: OpenCodeCompatProfile
  readonly serverConnector: (
    input: BetterC0deServerConnectorInput
  ) => Promise<BetterC0deServerConnection>
}): Promise<SharedBetterC0deTextServer> {
  const fingerprint = betterC0deTextServerFingerprint(
    input.binaryPath,
    input.env
  )
  return await withSharedBetterC0deAcquireLock(async () => {
    throwIfNativeTextGenerationUnavailable(input.signal)

    const existing = sharedBetterC0deTextServers.get(fingerprint)
    if (existing) {
      cancelSharedBetterC0deIdleClose(existing)
      if (existing.closeFailure) {
        await closeSharedBetterC0deTextServer(existing)
      } else {
        existing.activeRequests += 1
        return existing
      }
    }

    const server = await input.serverConnector({
      binaryPath: input.binaryPath,
      env: input.env,
      profile: input.profile,
    })
    const entry: SharedBetterC0deTextServer = {
      fingerprint,
      server,
      activeRequests: 1,
      idleCloseTimer: null,
      closePromise: null,
      closeFailure: null,
    }
    sharedBetterC0deTextServers.set(fingerprint, entry)
    if (!nativeTextGenerationAdmissionsOpen || input.signal.aborted) {
      const admissionFailure =
        input.signal.reason ??
        Object.assign(
          new Error(
            "Native text generation stopped during server acquisition."
          ),
          { code: "NATIVE_TEXT_GENERATION_SHUTDOWN" }
        )
      try {
        await closeSharedBetterC0deTextServer(entry)
      } catch (closeFailure) {
        throw new AggregateError(
          [admissionFailure, closeFailure],
          "Shared native text-generation server acquisition and cleanup both failed"
        )
      }
      throw admissionFailure
    }
    return entry
  })
}

async function withSharedBetterC0deAcquireLock<T>(
  operation: () => Promise<T>
): Promise<T> {
  const previous = sharedBetterC0deAcquireTail
  let releaseLock!: () => void
  sharedBetterC0deAcquireTail = new Promise<void>((resolve) => {
    releaseLock = resolve
  })
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    releaseLock()
  }
}

function releaseSharedBetterC0deTextServer(
  entry: SharedBetterC0deTextServer
): void {
  if (sharedBetterC0deTextServers.get(entry.fingerprint) !== entry) return
  entry.activeRequests = Math.max(0, entry.activeRequests - 1)
  if (entry.activeRequests > 0) return
  cancelSharedBetterC0deIdleClose(entry)
  entry.idleCloseTimer = setTimeout(() => {
    void withSharedBetterC0deAcquireLock(async () => {
      if (
        sharedBetterC0deTextServers.get(entry.fingerprint) === entry &&
        entry.activeRequests === 0
      ) {
        await closeSharedBetterC0deTextServer(entry)
      }
    }).catch((error) => {
      entry.closeFailure = error
    })
  }, BETTERC0DE_TEXT_GENERATION_IDLE_TTL_MS)
  entry.idleCloseTimer.unref?.()
}

function cancelSharedBetterC0deIdleClose(
  entry: SharedBetterC0deTextServer
): void {
  if (!entry.idleCloseTimer) return
  clearTimeout(entry.idleCloseTimer)
  entry.idleCloseTimer = null
}

async function closeSharedBetterC0deTextServer(
  entry: SharedBetterC0deTextServer
): Promise<void> {
  cancelSharedBetterC0deIdleClose(entry)
  if (entry.closePromise) return await entry.closePromise
  const closePromise = (async () => {
    await entry.server.close()
    entry.closeFailure = null
    if (sharedBetterC0deTextServers.get(entry.fingerprint) === entry) {
      sharedBetterC0deTextServers.delete(entry.fingerprint)
    }
  })()
  entry.closePromise = closePromise
  try {
    await closePromise
  } catch (error) {
    entry.closeFailure = error
    throw error
  } finally {
    entry.closePromise = null
  }
}

function betterC0deTextServerFingerprint(
  binaryPath: string,
  env: NodeJS.ProcessEnv
): string {
  const hash = createHash("sha256")
  const updateField = (value: string) => {
    const bytes = Buffer.from(value, "utf8")
    hash.update(String(bytes.byteLength))
    hash.update(":")
    hash.update(bytes)
  }
  updateField(binaryPath)
  for (const key of Object.keys(env).sort()) {
    updateField(key)
    const value = env[key]
    updateField(value === undefined ? "undefined:" : `string:${value}`)
  }
  return hash.digest("hex")
}

function throwIfNativeTextGenerationUnavailable(signal: AbortSignal): void {
  if (signal.aborted) {
    throw (
      signal.reason ??
      Object.assign(new Error("Native text generation was cancelled."), {
        code: "NATIVE_TEXT_GENERATION_SHUTDOWN",
      })
    )
  }
  if (!nativeTextGenerationAdmissionsOpen) {
    throw Object.assign(
      new Error("Native text generation is not accepting new work."),
      { code: "NATIVE_TEXT_GENERATION_ADMISSION_CLOSED" }
    )
  }
}

async function startBetterC0deServerProcess(input: {
  readonly binaryPath: string
  readonly env: NodeJS.ProcessEnv
  readonly profile?: OpenCodeCompatProfile
}): Promise<BetterC0deServerConnection> {
  const profile = input.profile ?? BETTERC0DE_COMPAT_PROFILE
  const port = await findAvailablePort()
  const spawnInput = nativeProcessSpawnInput(input.binaryPath, [
    ...profile.serveArgs(port, DEFAULT_BETTERC0DE_HOSTNAME),
  ])
  const configEnv: NodeJS.ProcessEnv = {}
  for (const name of profile.configContentEnv) {
    configEnv[name] = BETTERC0DE_EMPTY_CONFIG_CONTENT
  }
  const child = spawn(spawnInput.command, [...spawnInput.args], {
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: spawnInput.windowsVerbatimArguments,
    env: {
      ...input.env,
      ...configEnv,
    },
  })
  activeNativeTextChildren.add(child)
  keepChildErrorObserved(child, "compatibility server")
  return new Promise((resolve, reject) => {
    const stdout = new BoundedOutputBuffer(NATIVE_PROCESS_MAX_OUTPUT_BYTES)
    const stderr = new BoundedOutputBuffer(NATIVE_PROCESS_MAX_OUTPUT_BYTES)
    let settled = false
    const timer = setTimeout(() => {
      failStartup(
        new Error("Timed out waiting for compatibility server to start.")
      )
    }, DEFAULT_BETTERC0DE_SERVER_TIMEOUT_MS)
    timer.unref?.()

    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off("data", onStdout)
      child.stderr?.off("data", onStderr)
      child.off("error", onError)
      child.off("exit", onExit)
    }
    const failStartup = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      void (async () => {
        try {
          await stopTrackedNativeTextChild(child)
          reject(error)
        } catch (cleanupError) {
          reject(
            new AggregateError(
              [error, cleanupError],
              "Compatibility server startup and process cleanup both failed"
            )
          )
        }
      })()
    }
    const close = () => stopTrackedNativeTextChild(child)
    const onStdout = (chunk: Buffer | string) => {
      if (stdout.append(chunk) && !settled) {
        failStartup(
          new Error("Compatibility server startup output exceeded limit.")
        )
        return
      }
      if (
        settled ||
        !profile.serverReadyPrefixes.some((prefix) =>
          stdout.text.toLowerCase().includes(prefix)
        )
      )
        return
      settled = true
      cleanup()
      child.once("close", () => {
        void confirmTrackedNativeTextChildExit(child).catch(() => {
          // Keep the child registered so global shutdown can retry cleanup.
        })
      })
      resolve({
        url: `http://${DEFAULT_BETTERC0DE_HOSTNAME}:${port}`,
        external: false,
        close,
      })
    }
    const onStderr = (chunk: Buffer | string) => {
      if (stderr.append(chunk) && !settled) {
        failStartup(
          new Error("Compatibility server startup output exceeded limit.")
        )
      }
    }
    const onError = (error: Error) => {
      failStartup(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      failStartup(
        new Error(
          `compatibility server exited before ready (code ${code ?? "unknown"}, signal ${signal ?? "none"}): ${
            stderr.text.trim() || stdout.text.trim() || "no output"
          }`
        )
      )
    }

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", onStderr)
    child.once("error", onError)
    child.once("exit", onExit)
  })
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, DEFAULT_BETTERC0DE_HOSTNAME, () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error("Failed to allocate compatibility server port."))
      })
    })
  })
}

function betterC0dePromptErrorMessage(error: unknown): string | null {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined
  const source = record(error)
  const candidates = [record(source?.data)?.message, source?.name]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim()
  }
  return null
}

function betterC0deTextResponse(
  parts: ReadonlyArray<unknown> | undefined
): string {
  const output = new BoundedOutputBuffer(NATIVE_PROCESS_MAX_OUTPUT_BYTES)
  for (const part of parts ?? []) {
    if (!part || typeof part !== "object") continue
    const record = part as Record<string, unknown>
    if (record.type !== "text" || typeof record.text !== "string") continue
    if (output.append(record.text)) {
      throw new Error(
        `BetterC0de compatibility output exceeded ${NATIVE_PROCESS_MAX_OUTPUT_BYTES} bytes.`
      )
    }
  }
  return output.text.trim()
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)
    if (timer.unref) timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  message: string
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error(message))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () =>
      finish(() => reject(signal.reason ?? new Error(message)))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

function configString(config: unknown, key: string): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return null
  const value = (config as Record<string, unknown>)[key]
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeClaudeHome(homePath: string): string {
  const normalized = path.normalize(path.resolve(expandHomePath(homePath)))
  if (path.basename(normalized) === ".claude") return path.dirname(normalized)
  return normalized
}

/**
 * Resolve the working directory for a native run. `fallback` must be a
 * private directory owned by the caller; `process.cwd()` is deliberately not
 * an option because it is BetterC0de's own installation directory (see
 * services/scratchWorkspace.ts for the same hazard on the chat side).
 */
function resolveCwd(cwd: string | null | undefined, fallback: string): string {
  const trimmed = cwd?.trim()
  if (trimmed) return path.resolve(expandHomePath(trimmed))
  if (fallback.trim()) return fallback
  throw Object.assign(
    new Error("Native text generation requires a working directory."),
    { code: "NATIVE_TEXT_GENERATION_CWD_REQUIRED" }
  )
}

function commandFailureMessage(
  label: string,
  exitCode: number | null,
  stderr: string,
  stdout: string
): string {
  const detail = stderr.trim() || stdout.trim()
  return detail
    ? `${label} command failed: ${redactSensitiveText(detail)}`
    : `${label} command failed with code ${exitCode ?? "unknown"}.`
}

function runProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly stdin: string
    readonly timeoutMs: number
    readonly signal?: AbortSignal
  }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(
        options.signal.reason instanceof Error
          ? options.signal.reason
          : nativeTextGenerationShutdownError()
      )
      return
    }
    const spawnInput = nativeProcessSpawnInput(command, args)
    const child = spawn(spawnInput.command, [...spawnInput.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: spawnInput.windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"],
    })
    activeNativeTextChildren.add(child)
    keepChildErrorObserved(child, path.basename(command))
    const stdout = new BoundedOutputBuffer(NATIVE_PROCESS_MAX_OUTPUT_BYTES)
    const stderr = new BoundedOutputBuffer(NATIVE_PROCESS_MAX_OUTPUT_BYTES)
    let settled = false
    let terminalError: Error | null = null
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.removeAllListeners("data")
      child.stderr?.removeAllListeners("data")
      child.removeListener("error", onError)
      child.removeListener("close", onClose)
      child.stdin?.removeListener("error", onStdinError)
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort)
      }
    }
    const settleRejected = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const terminate = (error: Error) => {
      if (settled || terminalError) return
      terminalError = error
      child.stdin?.destroy()
      void stopTrackedNativeTextChild(child).then(
        () => settleRejected(error),
        (cleanupError) =>
          settleRejected(
            new NativeTextProcessCleanupError(
              child,
              new AggregateError(
                [error, cleanupError],
                `${error.message}; process-tree cleanup also failed`
              )
            )
          )
      )
    }
    const timer = setTimeout(() => {
      terminate(
        new Error(
          `${path.basename(command)} timed out after ${options.timeoutMs}ms`
        )
      )
    }, options.timeoutMs)
    timer.unref?.()

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      if (stdout.append(chunk)) {
        terminate(
          new Error(
            `${path.basename(command)} stdout exceeded ${NATIVE_PROCESS_MAX_OUTPUT_BYTES} bytes`
          )
        )
      }
    })
    child.stderr?.on("data", (chunk) => {
      if (stderr.append(chunk)) {
        terminate(
          new Error(
            `${path.basename(command)} stderr exceeded ${NATIVE_PROCESS_MAX_OUTPUT_BYTES} bytes`
          )
        )
      }
    })
    const onError = (error: Error) => {
      if (terminalError) return
      terminate(error)
    }
    const onClose = async (
      exitCode: number | null,
      signal: NodeJS.Signals | null
    ) => {
      if (settled) return
      if (terminalError) return
      settled = true
      clearTimeout(timer)
      if (process.platform !== "win32" && child.pid != null) {
        try {
          await confirmTrackedNativeTextChildExit(child)
        } catch (error) {
          cleanup()
          reject(new NativeTextProcessCleanupError(child, error))
          return
        }
      } else {
        activeNativeTextChildren.delete(child)
      }
      cleanup()
      resolve({ stdout: stdout.text, stderr: stderr.text, exitCode, signal })
    }
    const onStdinError = (error: Error) => {
      terminate(
        new Error(
          `${path.basename(command)} stdin failed: ${redactSensitiveText(error.message)}`
        )
      )
    }
    const onAbort = () => {
      terminate(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : nativeTextGenerationShutdownError()
      )
    }
    child.once("error", onError)
    child.once("close", onClose)
    child.stdin?.once("error", onStdinError)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    child.stdin?.end(options.stdin)
  })
}

function nativeProcessSpawnInput(
  command: string,
  args: ReadonlyArray<string>
): {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly windowsVerbatimArguments: boolean
} {
  if (process.platform !== "win32") {
    return { command, args, windowsVerbatimArguments: false }
  }
  const directExe = path.isAbsolute(command) && /\.exe$/i.test(command)
  if (directExe) return { command, args, windowsVerbatimArguments: false }
  const shell = process.env.ComSpec?.trim() || "cmd.exe"
  return {
    command: shell,
    args: buildWindowsCmdArgs(command, args),
    windowsVerbatimArguments: true,
  }
}

/**
 * Byte-bounded output accumulator that tracks its size incrementally. The
 * previous helper re-measured the whole buffer on every chunk, which is
 * quadratic for a chatty child.
 */
class BoundedOutputBuffer {
  text = ""
  bytes = 0

  constructor(private readonly maxBytes: number) {}

  /** Returns true when the chunk did not fit (the buffer keeps the prefix). */
  append(chunk: Buffer | string): boolean {
    const nextChunk = String(chunk)
    const remaining = Math.max(0, this.maxBytes - this.bytes)
    const chunkBuffer = Buffer.from(nextChunk, "utf8")
    if (chunkBuffer.byteLength <= remaining) {
      this.text += nextChunk
      this.bytes += chunkBuffer.byteLength
      return false
    }
    const kept = chunkBuffer.subarray(0, remaining).toString("utf8")
    this.text += kept
    this.bytes += Buffer.byteLength(kept, "utf8")
    return true
  }
}

/**
 * A ChildProcess with no `error` listener turns a late EPIPE or a failed
 * kill into an uncaught exception that takes the backend down. Per-run
 * handlers are removed once a run settles; this listener stays for the
 * child's whole life so the event is always observed.
 */
function keepChildErrorObserved(child: ChildProcess, label: string): void {
  child.on("error", (error) => {
    logger.warn(
      { err: error.message, pid: child.pid ?? null },
      `native text-generation child (${label}) reported an error`
    )
  })
}

async function readUtf8FileBounded(
  filePath: string,
  maxBytes: number,
  label: string
): Promise<string> {
  const handle = await fs.open(filePath, "r")
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxBytes) {
      throw new Error(`${label} exceeded ${maxBytes} bytes.`)
    }
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

async function signalChildProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals
): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    if (hasChildExited(child)) return
    const killed = await runWindowsTaskkill(child.pid, signal === "SIGKILL")
    if (killed || hasChildExited(child)) return
    if (signal !== "SIGKILL") return
  } else if (child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to the direct handle when the process group is already gone.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Best-effort termination; the final deadline still settles the caller.
  }
}

async function terminateChildProcessTree(
  child: ChildProcess
): Promise<boolean> {
  const pid = child.pid
  // A ChildProcess without a PID never crossed the successful-spawn boundary.
  if (pid == null) return true
  if (process.platform === "win32") {
    if (hasChildExited(child)) return true
    // Windows has no stable process-group identifier in Node. Use taskkill's
    // tree traversal with /F while the root PID is still owned by this child;
    // falling back after the root exits would risk PID-reuse collateral damage.
    const killed = await runWindowsTaskkill(pid, true)
    if (!killed) {
      try {
        child.kill("SIGKILL")
      } catch {
        // The root may have raced with taskkill. Without confirmed tree
        // traversal the caller must treat cleanup as failed.
      }
    }
    const rootExited = await waitForChildProcessExit(
      child,
      NATIVE_PROCESS_FINALIZE_GRACE_MS
    )
    return killed && rootExited
  }

  if (!isNativePosixProcessGroupAlive(pid)) return true
  await signalChildProcessTree(child, "SIGTERM")
  if (
    await waitForNativePosixProcessGroupExit(
      pid,
      NATIVE_PROCESS_TERMINATE_GRACE_MS
    )
  ) {
    return true
  }
  await signalChildProcessTree(child, "SIGKILL")
  return await waitForNativePosixProcessGroupExit(
    pid,
    NATIVE_PROCESS_FINALIZE_GRACE_MS
  )
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  const exited = await terminateChildProcessTree(child)
  if (!exited) {
    throw new Error("Child process tree did not exit after forced termination.")
  }
}

async function stopTrackedNativeTextChild(child: ChildProcess): Promise<void> {
  const existing = nativeTextChildStops.get(child)
  if (existing) return await existing
  const stop = (async () => {
    if (
      unconfirmedNativeTextChildren.has(child) &&
      process.platform === "win32" &&
      child.pid != null &&
      hasChildExited(child)
    ) {
      // Once an unconfirmed root exits, its descendants cannot safely be found
      // using a potentially reused PID. Preserve ownership until restart.
      throw new NativeTextProcessCleanupError(
        child,
        new Error("Unconfirmed Windows process root has exited.")
      )
    }
    await stopChildProcess(child)
    unconfirmedNativeTextChildren.delete(child)
    activeNativeTextChildren.delete(child)
  })()
  nativeTextChildStops.set(child, stop)
  try {
    await stop
  } finally {
    if (nativeTextChildStops.get(child) === stop) {
      nativeTextChildStops.delete(child)
    }
  }
}

async function confirmTrackedNativeTextChildExit(
  child: ChildProcess
): Promise<void> {
  if (process.platform !== "win32" && child.pid != null) {
    await ensureNativePosixProcessGroupTerminated(child.pid)
  }
  activeNativeTextChildren.delete(child)
}

async function runWindowsTaskkill(
  pid: number,
  force: boolean
): Promise<boolean> {
  const result = await runWindowsTaskkillDetailed(pid, force, {
    timeoutMs: NATIVE_PROCESS_FINALIZE_GRACE_MS,
  })
  return result.status === "closed" && result.code === 0
}

function waitForChildProcessExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (hasChildExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.removeListener("exit", onExit)
      child.removeListener("close", onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once("exit", onExit)
    child.once("close", onExit)
    timer = setTimeout(() => finish(hasChildExited(child)), timeoutMs)
    timer.unref?.()
  })
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function ensureNativePosixProcessGroupTerminated(
  pid: number
): Promise<void> {
  if (!isNativePosixProcessGroupAlive(pid)) return
  signalNativePosixProcessGroup(pid, "SIGTERM")
  if (
    await waitForNativePosixProcessGroupExit(
      pid,
      NATIVE_PROCESS_TERMINATE_GRACE_MS
    )
  ) {
    return
  }
  signalNativePosixProcessGroup(pid, "SIGKILL")
  if (
    await waitForNativePosixProcessGroupExit(
      pid,
      NATIVE_PROCESS_FINALIZE_GRACE_MS
    )
  ) {
    return
  }
  throw Object.assign(
    new Error(`Native text-generation process group ${pid} survived SIGKILL.`),
    { code: "NATIVE_PROCESS_GROUP_SURVIVED_SIGKILL", pid }
  )
}

function signalNativePosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals
): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (isNoSuchProcessError(error)) return false
    throw error
  }
}

function isNativePosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (isNoSuchProcessError(error)) return false
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true
    throw error
  }
}

async function waitForNativePosixProcessGroupExit(
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() < deadline) {
    if (!isNativePosixProcessGroupAlive(pid)) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  return !isNativePosixProcessGroupAlive(pid)
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]"
    )
}
