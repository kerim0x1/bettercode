import { z } from "zod"
import {
  endpoint,
  ignoredBody,
  noBody,
  type RecordSchema,
} from "./http-endpoint"

/**
 * The backend's own runtime routes (`apps/backend/src/http/routes/runtime.ts`
 * and the two small ones in `settings.ts`). `GET /health` stays outside the
 * contracts: it is the unauthenticated probe mounted beside `/api/v1`, not
 * part of the versioned API clients call.
 */

const text = z.string()
const num = z.number()
const bool = z.boolean()

/** `ok` with a 200, `error` with a 503 while SQLite does not answer. */
const runtimeHealthSchema = z
  .object({ status: z.enum(["ok", "error"]), db: z.enum(["ok", "error"]) })
  .passthrough()

/**
 * One in-memory metric series (`observability/metrics.ts`): a counter has a
 * `value`, a timer `count`, `sumMs`, `minMs` and `maxMs`.
 */
export interface RuntimeMetricSample {
  type: "counter" | "timer"
  name: string
}

const runtimeMetricSchema: RecordSchema<RuntimeMetricSample> = z
  .object({ type: z.enum(["counter", "timer"]), name: text })
  .passthrough()

/** `process.memoryUsage()` of the backend, in bytes. */
const processMemorySchema = z.record(text, num)

/** Where the BetterC0de-compatible runtime keeps its files, and why. */
export interface RuntimeCompatDebugInfo {
  configDir: string
  configDirSource: "default" | "BETTERC0DE_CONFIG_DIR" | "legacy"
  dataDir: string
  stateDir: string
  cacheDir: string
  binDir: string
  logDir: string
  reposDir: string
  dbPath: string
  dbPathSource: "default" | "BETTERC0DE_DB" | "legacy"
  authPath: string
  mcpAuthPath: string
  pluginMetaPath: string
  pureMode?: boolean
  defaultPluginsDisabled?: boolean
  externalPlugins?: "enabled" | "disabled-by-pure"
  defaultPlugins?: "enabled" | "disabled-by-env"
}

/**
 * `GET /runtime/debug-info` (desktop only). Host-identifying values read
 * `[redacted]` for any caller but the desktop owner.
 */
export interface RuntimeDebugInfo {
  app: {
    name: string
    version: string
    backend: string
    startedAt: number
    uptimeSeconds: number
  }
  system: {
    platform: string
    arch: string
    release: string
    type: string
    hostname: string
  }
  process: {
    pid: number
    node: string
    memory?: Record<string, number>
    versions: {
      node: string
      v8?: string
      uv?: string
      modules?: string
    }
    cwd: string
  }
  terminal: {
    term: string | null
    program: string | null
    shell: string | null
  }
  envOverrides: {
    betterc0deHome: "set" | "unset"
    betterc0deDataDir: "set" | "unset"
  }
  paths: {
    dataDir: string
    dbPath: string
    settingsPath: string
    authPath: string
    logsDir: string
    providerLogsDir: string
    providerEventLogPath: string
  }
  database: {
    path: string
  }
  metrics?: RuntimeMetricSample[]
  betterc0de?: RuntimeCompatDebugInfo
}

const setOrUnset = z.enum(["set", "unset"])

const runtimeCompatDebugInfoSchema: RecordSchema<RuntimeCompatDebugInfo> = z
  .object({
    configDir: text,
    configDirSource: z.enum(["default", "BETTERC0DE_CONFIG_DIR", "legacy"]),
    dataDir: text,
    stateDir: text,
    cacheDir: text,
    binDir: text,
    logDir: text,
    reposDir: text,
    dbPath: text,
    dbPathSource: z.enum(["default", "BETTERC0DE_DB", "legacy"]),
    authPath: text,
    mcpAuthPath: text,
    pluginMetaPath: text,
    pureMode: bool.optional(),
    defaultPluginsDisabled: bool.optional(),
    externalPlugins: z.enum(["enabled", "disabled-by-pure"]).optional(),
    defaultPlugins: z.enum(["enabled", "disabled-by-env"]).optional(),
  })
  .passthrough()

const runtimeDebugInfoSchema: RecordSchema<RuntimeDebugInfo> = z
  .object({
    app: z
      .object({
        name: text,
        version: text,
        backend: text,
        startedAt: num,
        uptimeSeconds: num,
      })
      .passthrough(),
    system: z
      .object({
        platform: text,
        arch: text,
        release: text,
        type: text,
        hostname: text,
      })
      .passthrough(),
    process: z
      .object({
        pid: num,
        node: text,
        memory: processMemorySchema.optional(),
        versions: z
          .object({
            node: text,
            v8: text.optional(),
            uv: text.optional(),
            modules: text.optional(),
          })
          .passthrough(),
        cwd: text,
      })
      .passthrough(),
    terminal: z
      .object({
        term: text.nullable(),
        program: text.nullable(),
        shell: text.nullable(),
      })
      .passthrough(),
    envOverrides: z
      .object({ betterc0deHome: setOrUnset, betterc0deDataDir: setOrUnset })
      .passthrough(),
    paths: z
      .object({
        dataDir: text,
        dbPath: text,
        settingsPath: text,
        authPath: text,
        logsDir: text,
        providerLogsDir: text,
        providerEventLogPath: text,
      })
      .passthrough(),
    database: z.object({ path: text }).passthrough(),
    metrics: z.array(runtimeMetricSchema).optional(),
    betterc0de: runtimeCompatDebugInfoSchema.optional(),
  })
  .passthrough()

/** A V8 heap snapshot written to the logs directory. */
export interface RuntimeHeapSnapshotResult {
  path: string
  bytes: number
}

const runtimeHeapSnapshotResultSchema: RecordSchema<RuntimeHeapSnapshotResult> =
  z.object({ path: text, bytes: num }).passthrough()

/** A short-lived Deepgram token, so the key never reaches the renderer. */
export interface DeepgramAccessToken {
  accessToken: string
  /** Seconds. */
  expiresIn: number
}

const deepgramAccessTokenSchema: RecordSchema<DeepgramAccessToken> = z
  .object({ accessToken: text, expiresIn: num })
  .passthrough()

export const runtimeHttpContracts = {
  runtimeHealth: endpoint(
    "GET",
    "/runtime/health",
    noBody,
    runtimeHealthSchema
  ),
  runtimeCapabilities: endpoint(
    "GET",
    "/runtime/capabilities",
    noBody,
    z.object({ capabilities: z.array(text), backend: text }).passthrough()
  ),
  // Desktop only, like the two below.
  runtimeDebugInfo: endpoint(
    "GET",
    "/runtime/debug-info",
    noBody,
    runtimeDebugInfoSchema
  ),
  runtimeMetrics: endpoint(
    "GET",
    "/runtime/metrics",
    noBody,
    z
      .object({
        collectedAt: text,
        uptimeSeconds: num,
        memory: processMemorySchema,
        metrics: z.array(runtimeMetricSchema),
      })
      .passthrough()
  ),
  // Only with `runtimeHeapSnapshotsEnabled`, at most once per five minutes.
  runtimeHeapSnapshot: endpoint(
    "POST",
    "/runtime/heap-snapshot",
    ignoredBody,
    runtimeHeapSnapshotResultSchema
  ),
  deepgramToken: endpoint(
    "POST",
    "/settings/deepgram-token",
    ignoredBody,
    deepgramAccessTokenSchema
  ),
  // The port the backend's WebSocket listens on.
  wsPort: endpoint("GET", "/ws-port", noBody, num),
} as const
