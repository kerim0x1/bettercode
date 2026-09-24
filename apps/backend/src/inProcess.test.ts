import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { checkpointRefForThreadTurn } from "@betterc0de/schema"
import { CheckpointTurnSlotStore } from "./checkpointing/CheckpointTurnSlotStore"
import { CheckpointRefCleanupStore } from "./checkpointing/CheckpointRefCleanupStore"
import { openDatabase } from "./persistence/db"
import { runMigrations } from "./persistence/migrations"
import * as lifecycle from "./bootstrap/lifecycle"
import {
  bindAgentPermissionRuntimeContext,
  currentAgentPermissionRuntimeContext,
  listConfiguredAgentPermissionGrants,
  runWithAgentPermissionRuntimeContext,
} from "./provider/agent-permission-runtime"
import {
  captureCheckpoint,
  hasCheckpointRef,
  resumeGitProcessAdmissions,
} from "./services/git"
import {
  __observeStartupCleanupForTests,
  startNodeBackend,
  type StartedBackend,
} from "./inProcess"

/**
 * Black-box boot of the whole backend in this worker: every service layer is
 * constructed for real against a throwaway data directory, the listener is
 * bound on an OS-assigned port, and `stop()` has to leave nothing behind.
 *
 * The backend is stopped only through the handle it returned — never by PID
 * or by name — and the data directory is a fresh temp dir. `os.homedir()` and
 * `APPDATA` are pointed at that same temp dir so the legacy-data migration
 * cannot find (let alone copy) the real installation on this machine.
 */

const PROVIDER_SLOTS = [
  "codex",
  "claude",
  "cursor",
  "betterc0de",
  "claude-terminal",
  "openai",
  "anthropic",
  "google",
  "grok",
  "grok-cli",
  "openrouter",
  "deepseek",
  "lmstudio",
] as const

/**
 * `startupCleanup` push order after a successful boot. The unwind runs these
 * steps reversed, so a reordering silently changes what is torn down first
 * on a failed start. Update this list deliberately, never to make it pass.
 */
const EXPECTED_STARTUP_CLEANUP_ORDER = [
  "startup abort listener",
  "SQLite database",
  "Git processes",
  "image generation processes",
  "native text-generation resources",
  "workspace formatter/config processes",
  "agent permission runtime",
  "remote session process cleanup listener",
  "remote access expiration scheduler",
  "code search harness",
  // The harness depends on the service; reverse unwind closes it first.
  "orchestrator service",
  "orchestrator harness",
  "provider event log 1",
  "provider event log 2",
  "provider hub",
  "provider hub event subscription",
  "settings change listener",
  "WebSocket hub",
  // Paired devices' terminals over the hub: unwound before it closes, so no
  // terminal frame reaches a closing hub. Their processes end with the
  // terminal service's own shutdown.
  "remote terminals",
  // Unwound before the hub closes, so no protocol update reaches a closing hub.
  "protocol updates for paired devices",
  "provider runtime ingestion",
  "checkpoint reactor",
  "thread goals",
  "checkpoint ref cleanup scheduler",
  "thread retention scheduler",
  "tool output archive stores",
  "transcript recovery timer",
  "provider session reaper",
  "vacuum timer",
]

const TRACKED_HANDLE_TYPES = [
  "Timeout",
  "TCPServerWrap",
  "TCPSocketWrap",
  "FSReqCallback",
] as const

let tempRoot = ""
let fakeHome = ""

function makeDataDir(label: string): string {
  const dir = path.join(tempRoot, label)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(
        PROVIDER_SLOTS.map((slot) => [slot, { enabled: false }])
      ),
    })
  )
  return dir
}

type HandleCensus = Record<(typeof TRACKED_HANDLE_TYPES)[number], number>

function countHandles(): HandleCensus {
  const counts = Object.fromEntries(
    TRACKED_HANDLE_TYPES.map((type) => [type, 0])
  ) as HandleCensus
  for (const type of process.getActiveResourcesInfo()) {
    if (type in counts) {
      counts[type as (typeof TRACKED_HANDLE_TYPES)[number]] += 1
    }
  }
  return counts
}

/**
 * `process.getActiveResourcesInfo()` lists only ref'd handles, and every
 * backend scheduler `unref()`s its interval so an idle backend does not keep
 * the process alive — which makes a leaked interval invisible to the census
 * above. So the timers created while a backend boots are recorded here, and
 * after `stop()` each one must have been cleared. Node marks a cleared timer
 * with `_destroyed`; that internal flag has been stable since v10 and is the
 * only cheap, synchronous way to ask "was this handle released".
 */
type TimerHandle = NodeJS.Timeout & { _destroyed?: boolean }

function recordTimersDuring<T>(run: () => Promise<T>): Promise<{
  result: T
  timers: TimerHandle[]
}> {
  const timers: TimerHandle[] = []
  const originalSetInterval = globalThis.setInterval
  const originalSetTimeout = globalThis.setTimeout
  const track = <F extends typeof setInterval | typeof setTimeout>(
    original: F
  ): F =>
    ((...args: Parameters<F>) => {
      const handle = (original as (...a: unknown[]) => unknown)(
        ...(args as unknown[])
      ) as TimerHandle
      // Only long-lived timers matter for the leak question; sub-second
      // one-shots fire and free themselves during the test's own awaits.
      const delay = typeof args[1] === "number" ? args[1] : 0
      if (original === originalSetInterval || delay >= 1_000)
        timers.push(handle)
      return handle
    }) as unknown as F
  globalThis.setInterval = track(originalSetInterval)
  globalThis.setTimeout = track(originalSetTimeout)
  return run()
    .then((result) => ({ result, timers }))
    .finally(() => {
      globalThis.setInterval = originalSetInterval
      globalThis.setTimeout = originalSetTimeout
    })
}

function liveTimers(timers: TimerHandle[]): number {
  return timers.filter((timer) => timer._destroyed !== true).length
}

function handlesWithin(census: HandleCensus, baseline: HandleCensus): boolean {
  return TRACKED_HANDLE_TYPES.every((type) => census[type] <= baseline[type])
}

/**
 * `stop()` resolves on the server's `close` event, but libuv releases the
 * underlying handle in the close-callbacks phase of a later loop iteration,
 * so the census right after `await stop()` can still list it. Yield to the
 * event loop until the census drops to the baseline (bounded — a real leak
 * still fails the assertion that follows).
 */
async function settledHandleCensus(
  baseline: HandleCensus,
  maxTurns = 20
): Promise<HandleCensus> {
  let census = countHandles()
  for (
    let turn = 0;
    turn < maxTurns && !handlesWithin(census, baseline);
    turn++
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    census = countHandles()
  }
  return census
}

/**
 * Plain `node:http` with `agent: false`: the socket is closed as soon as the
 * body is consumed, so the handle census after `stop()` is deterministic
 * (global `fetch` keeps pooled sockets alive for a few seconds).
 */
function requestJson(
  port: number,
  pathname: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        agent: false,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let body: unknown = text
          try {
            body = JSON.parse(text)
          } catch {
            // Non-JSON bodies are surfaced verbatim in the assertion.
          }
          resolve({ status: response.statusCode ?? 0, body })
        })
        response.on("error", reject)
      }
    )
    request.on("error", reject)
    request.end()
  })
}

const startedBackends: StartedBackend[] = []

async function boot(
  options: Parameters<typeof startNodeBackend>[0]
): Promise<StartedBackend> {
  const started = await startNodeBackend(options)
  startedBackends.push(started)
  return started
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-inprocess-"))
  fakeHome = path.join(tempRoot, "home")
  fs.mkdirSync(fakeHome, { recursive: true })
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome)
  vi.stubEnv("APPDATA", path.join(fakeHome, "AppData", "Roaming"))
  vi.stubEnv("BETTERC0DE_PROVIDER_SESSION_REAPER", "0")
  vi.stubEnv("BETTERC0DE_VACUUM_INTERVAL_MS", "")
  vi.stubEnv("BETTERC0DE_WEB_ROOT", "")
})

afterEach(async () => {
  __observeStartupCleanupForTests(null)
  // Belt and braces: a failing assertion must not leave a bound listener or
  // an open SQLite file behind for the next test in this worker.
  while (startedBackends.length > 0) {
    const started = startedBackends.pop()!
    if (started.httpServer.listening || started.state.db.open) {
      await started.stop()
    }
  }
})

afterAll(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe("startNodeBackend", () => {
  it("boots on a free port, answers /health, stops cleanly and leaves no live handles", async () => {
    const dataDir = makeDataDir("boot")
    const baseline = countHandles()

    const { result: started, timers } = await recordTimersDuring(() =>
      boot({ dataDir, preferredPort: 0 })
    )
    // Sanity: the backend does schedule long-lived timers (retention,
    // reaper, transcript recovery...), so the assertion below is not vacuous.
    expect(liveTimers(timers)).toBeGreaterThan(0)

    expect(started.port).toBeGreaterThan(0)
    expect(started.httpServer.listening).toBe(true)
    expect(started.state.db.open).toBe(true)
    expect(started.config.dataDir).toBe(dataDir)
    // The settings file written above was accepted (defaults would be `true`).
    expect(started.state.settings.get().providers.codex.enabled).toBe(false)

    const health = await requestJson(started.port, "/health")
    expect(health.status).toBe(200)
    expect(health.body).toEqual({ status: "ok", db: "ok" })

    const metrics = await requestJson(started.port, "/api/v1/runtime/metrics", {
      Authorization: `Bearer ${started.token}`,
    })
    expect(metrics.status).toBe(200)
    expect(metrics.body).toEqual(
      expect.objectContaining({
        memory: expect.objectContaining({ rss: expect.any(Number) }),
      })
    )

    bindAgentPermissionRuntimeContext({
      threadId: "leftover-context",
      workspacePath: dataDir,
    })
    const firstStop = started.stop()
    // A second call shares the in-flight promise instead of tearing down twice.
    expect(started.stop()).toBe(firstStop)
    await firstStop

    expect(started.httpServer.listening).toBe(false)
    expect(started.state.db.open).toBe(false)
    expect(currentAgentPermissionRuntimeContext("leftover-context")).toBeNull()
    expect(
      runWithAgentPermissionRuntimeContext(
        { threadId: "post-stop", workspacePath: dataDir },
        () => listConfiguredAgentPermissionGrants()
      )
    ).toEqual([])
    await expect(started.stop()).resolves.toBeUndefined()

    const after = await settledHandleCensus(baseline)
    for (const type of TRACKED_HANDLE_TYPES) {
      expect(after[type], `${type} handles after stop`).toBeLessThanOrEqual(
        baseline[type]
      )
    }
    // Every long-lived timer the boot created has been cleared, unref'd or
    // not — a scheduler that outlives `stop()` would fire against a closed
    // database and is exactly the leak the census cannot see.
    expect(liveTimers(timers), "long-lived timers still armed after stop").toBe(
      0
    )
  })

  it("recovers a failed large-diff checkpoint on startup and preserves it across another restart", async () => {
    const dataDir = makeDataDir("large-checkpoint-recovery")
    const cwd = path.join(tempRoot, "large-checkpoint-repo")
    fs.mkdirSync(cwd)
    execFileSync("git", ["init", cwd], { windowsHide: true, stdio: "pipe" })
    execFileSync("git", ["config", "core.autocrlf", "false"], {
      cwd,
      windowsHide: true,
    })
    const filePath = path.join(cwd, "large.txt")
    fs.writeFileSync(filePath, "before\n")
    const threadId = "thread-large-checkpoint"
    const baseCheckpointRef = checkpointRefForThreadTurn(threadId, 0)
    const checkpointRef = checkpointRefForThreadTurn(threadId, 1)
    resumeGitProcessAdmissions()
    await captureCheckpoint({ cwd, checkpointRef: baseCheckpointRef })
    // Between the journal's 1 MiB limit and Git's 2 MiB output limit.
    const content = `${"x".repeat(128)}\n`.repeat(10_000)
    fs.writeFileSync(filePath, content)
    await captureCheckpoint({ cwd, checkpointRef })

    const db = openDatabase(path.join(dataDir, "betterc0de.db"))
    try {
      runMigrations(db)
      const now = new Date().toISOString()
      db.prepare(
        `
        INSERT INTO projection_threads (thread_id, project_id, created_at, updated_at)
        VALUES (?, 'project-recovery', ?, ?)
      `
      ).run(threadId, now, now)
      const slots = new CheckpointTurnSlotStore(db)
      const allocation = slots.allocate(threadId)
      slots.recordAdmission({
        threadId,
        turnKey: "turn:dispatch-large",
        turnId: "native-large",
        dispatchTurnId: "dispatch-large",
        turnCount: allocation.turnCount,
        cwd,
        baseCheckpointRef,
        checkpointRef,
      })
      slots.markAdmissionFailed(
        threadId,
        "turn:dispatch-large",
        new Error(
          `Checkpoint turn 1 for thread '${threadId}' was not durably projected.`
        )
      )
      new CheckpointRefCleanupStore(db).retainBaseline({
        threadId,
        cwd,
        checkpointRef: baseCheckpointRef,
      })
    } finally {
      db.close()
    }

    // Recovery must journal and project the bounded event before retiring the
    // failed admission. Merely swallowing the startup error cannot pass this.
    for (let restart = 0; restart < 2; restart += 1) {
      const started = await boot({ dataDir, preferredPort: 0 })
      expect(await requestJson(started.port, "/health")).toEqual({
        status: 200,
        body: { status: "ok", db: "ok" },
      })
      expect(started.state.checkpointTurnSlots?.listAdmissions()).toEqual([])
      expect(
        started.state.checkpointDiffs.listTurnDiffsByThread(threadId)
      ).toEqual([
        expect.objectContaining({
          turn_index: 1,
          files_changed: 1,
          insertions: 10_000,
          deletions: 1,
        }),
      ])
      const journals = started.state.db
        .prepare(
          `
        SELECT payload_json FROM orchestration_events
        WHERE stream_id = ? AND event_type = 'ProviderRuntime:turn.diff.updated'
      `
        )
        .all(threadId) as Array<{ payload_json: string }>
      const diffEvent = journals
        .map((row) => JSON.parse(row.payload_json))
        .find((event) => event.event_type === "turn.diff.updated")
      expect(diffEvent?.payload).toMatchObject({
        diffTruncated: true,
        diffTruncationReason: "journal_limit",
        checkpointRef,
        baseCheckpointRef,
      })
      expect(diffEvent.payload.unifiedDiff).toBeUndefined()
      expect(journals).toHaveLength(1)
      expect(fs.readFileSync(filePath, "utf8")).toBe(content)
      expect(
        await hasCheckpointRef({ cwd, checkpointRef: baseCheckpointRef })
      ).toBe(true)
      expect(await hasCheckpointRef({ cwd, checkpointRef })).toBe(true)
      await started.stop()
    }
  }, 30_000)

  it("registers startup cleanup steps in the pinned order", async () => {
    const dataDir = makeDataDir("cleanup-order")
    let observed: string[] | null = null
    __observeStartupCleanupForTests((steps) => {
      observed = steps.map((step) => step.name)
    })

    const started = await boot({ dataDir, preferredPort: 0 })
    await started.stop()

    expect(observed).toEqual(EXPECTED_STARTUP_CLEANUP_ORDER)
  })

  it("rejects before touching anything when the startup signal is already aborted", async () => {
    const dataDir = makeDataDir("pre-aborted")
    const controller = new AbortController()
    controller.abort(new Error("cancelled before start"))

    await expect(
      startNodeBackend({ dataDir, preferredPort: 0, signal: controller.signal })
    ).rejects.toThrow("cancelled before start")

    expect(fs.existsSync(path.join(dataDir, "betterc0de.db"))).toBe(false)
  })

  it("clears the startup heartbeat when reopening resource admission fails", async () => {
    const failure = vi
      .spyOn(lifecycle, "reopenResourceAdmissions")
      .mockImplementationOnce(() => {
        throw new Error("retained resources")
      })
    try {
      const { timers } = await recordTimersDuring(async () => {
        await expect(
          startNodeBackend({
            dataDir: makeDataDir("admission-refused"),
            preferredPort: 0,
            onStartupHeartbeat: vi.fn(),
          })
        ).rejects.toThrow("retained resources")
      })
      expect(timers.length).toBeGreaterThan(0)
      expect(liveTimers(timers)).toBe(0)
    } finally {
      failure.mockRestore()
    }
  })

  it("unwinds a partially started backend on abort and can boot again in the same worker", async () => {
    const dataDir = makeDataDir("abort-midway")
    const controller = new AbortController()
    let heartbeats = 0

    // The first heartbeat fires synchronously before resource admissions are
    // reopened; the abort is then observed at the first `throwIfAborted()`
    // after the database has been opened and migrated, so the startup unwind
    // (SQLite close, resource-manager shutdown) runs for real.
    await expect(
      startNodeBackend({
        dataDir,
        preferredPort: 0,
        signal: controller.signal,
        onStartupHeartbeat: () => {
          heartbeats += 1
          if (heartbeats === 1)
            controller.abort(new Error("cancelled mid-start"))
        },
      })
    ).rejects.toThrow("cancelled mid-start")
    expect(heartbeats).toBe(1)

    // Admission gates must have been rebalanced by the unwind: a second boot
    // on the same data directory has to reopen them and succeed.
    const started = await boot({ dataDir, preferredPort: 0 })
    const health = await requestJson(started.port, "/health")
    expect(health.status).toBe(200)
    expect(health.body).toEqual({ status: "ok", db: "ok" })
    await started.stop()
    expect(started.state.db.open).toBe(false)
  })
})
