/**
 * Centralized tunables for the Electron shell. Every magic number that used
 * to live inline in `main.cjs` / `onboarding-ipc.cjs` / `claude-provider.cjs`
 * now has a name here so a future maintainer changing a timeout or dimension
 * doesn't have to grep the codebase for `8000` and guess which one is which.
 *
 * CJS so main-process modules can require it without a build step.
 * Sandboxed preloads cannot require local modules; their constants stay inline.
 */

module.exports = Object.freeze({
  // ── Window defaults ──────────────────────────────────────────────────
  /** Initial window width on first launch (user's persisted bounds win after that). */
  DEFAULT_WINDOW_WIDTH: 1400,
  /** Initial window height on first launch. */
  DEFAULT_WINDOW_HEIGHT: 900,
  /** Debounce window before persisting window-state.json during drag-resize. */
  WINDOW_STATE_SAVE_DEBOUNCE_MS: 500,
  /**
   * Safety net: if `ready-to-show` never fires (silent renderer failure, GPU
   * stall, missing asset), force the window visible after this many ms so
   * devtools are reachable and the failure becomes diagnosable.
   */
  WINDOW_READY_TO_SHOW_FALLBACK_MS: 8000,

  // ── Backend lifecycle ────────────────────────────────────────────────
  /**
   * Maximum silence between backend startup heartbeats. Crash recovery can
   * legitimately outlive this window, but a wedged child cannot.
   */
  BACKEND_STARTUP_TIMEOUT_MS: 30_000,
  /**
   * Time to the first heartbeat in a spawned backend. Cold module loading is
   * synchronous and can exceed the idle budget on a busy Windows machine.
   * Once the first heartbeat arrives, BACKEND_STARTUP_TIMEOUT_MS takes over.
   */
  BACKEND_STARTUP_INITIAL_TIMEOUT_MS: 120_000,
  /**
   * Absolute backend startup bound, including crash-recovery work. This must
   * exceed the backend's bounded 120-second checkpoint Git operation while
   * remaining finite even if a child keeps emitting heartbeats.
   */
  BACKEND_STARTUP_HARD_TIMEOUT_MS: 5 * 60_000,
  /**
   * Total time allotted for graceful backend shutdown before SIGKILL. The
   * backend's own hard deadline (SHUTDOWN_HARD_TIMEOUT_MS in
   * apps/backend/src/constants.ts) is 10 s and starts only when the shutdown
   * message arrives; the extra 5 s lets its final steps (event-log flush,
   * transcript replay, db.close) finish instead of being killed mid-way.
   */
  BACKEND_SHUTDOWN_TIMEOUT_MS: 15_000,
  /** Time to wait for IPC delivery confirmation before falling back to SIGTERM. */
  BACKEND_IPC_SHUTDOWN_ACK_MS: 1500,
  /** Time to confirm that the backend actually exited after a forced tree kill. */
  BACKEND_FORCE_KILL_EXIT_TIMEOUT_MS: 3000,
  /** Max attempts at the `/health` probe before giving up on a spawned backend. */
  BACKEND_HEALTH_PROBE_MAX_ATTEMPTS: 15,
  /** Interval between `/health` probe attempts. */
  BACKEND_HEALTH_PROBE_INTERVAL_MS: 200,
  /** Per-request timeout for the `/health` probe. */
  BACKEND_HEALTH_PROBE_REQUEST_TIMEOUT_MS: 2000,
  /** Time to list a forcibly stopped backend's descendants with `ps` (POSIX). */
  BACKEND_PROCESS_TREE_SNAPSHOT_TIMEOUT_MS: 2000,
  /**
   * Upper bound for the whole shutdown sequence after a fatal main-process
   * error: CLI and plugin shutdown (parallel, ≤10 s), backend (≤15 s, plus
   * 2 s taskkill and 3 s exit confirmation) and the crash-report flush (5 s).
   */
  FATAL_SHUTDOWN_DEADLINE_MS: 45_000,

  // ── Backend supervision (after a successful start) ────────────────────
  /** Unexpected exits within the window below that count as a crash loop. */
  BACKEND_CRASH_LOOP_MAX_CRASHES: 5,
  /** Sliding window for crash-loop detection. */
  BACKEND_CRASH_LOOP_WINDOW_MS: 2 * 60_000,
  /** First automatic restart delay; doubles per crash in the window. */
  BACKEND_RESTART_BASE_DELAY_MS: 1_000,
  /** Longest automatic restart delay. */
  BACKEND_RESTART_MAX_DELAY_MS: 30_000,
  /** Interval between liveness `/health` checks while the backend is up. */
  BACKEND_LIVENESS_INTERVAL_MS: 20_000,
  /** Per-check timeout; a wedged event loop never answers. */
  BACKEND_LIVENESS_TIMEOUT_MS: 10_000,
  /** Consecutive failed checks before the backend is restarted. */
  BACKEND_LIVENESS_MAX_MISSES: 3,
  /** Grace period after system resume before the first liveness check. */
  BACKEND_LIVENESS_RESUME_GRACE_MS: 5_000,

  // ── Renderer recovery ─────────────────────────────────────────────────
  /** A second renderer crash within this window asks before reloading. */
  RENDERER_CRASH_WINDOW_MS: 60_000,

  // ── Updates ───────────────────────────────────────────────────────────
  /** Interval between release-feed checks in a long-running session. */
  UPDATE_CHECK_INTERVAL_MS: 6 * 60 * 60_000,

  // ── Dev server ───────────────────────────────────────────────────────
  /** Fallback Vite dev-server port used when VITE_DEV_PORT env var is unset. */
  VITE_DEV_PORT_FALLBACK: 49123,

  // ── DNS / network ────────────────────────────────────────────────────
  /** Hard cap on `dns.lookup` calls that guard URL-import handlers. */
  DNS_LOOKUP_TIMEOUT_MS: 3000,

  // ── Claude Agent SDK ─────────────────────────────────────────────────
  /**
   * UI thinking-mode → fixed `thinking.budgetTokens` values. Adaptive
   * Claude models use `thinking: { type: "adaptive" }` plus named effort.
   */
  THINKING_BUDGET: Object.freeze({
    LOW: 4000,
    MEDIUM: 8000,
    HIGH: 16000,
    XHIGH: 24000,
    ULTRA: 32000,
  }),
  /** Messages to include from renderer history when SDK has no session to resume. */
  HISTORY_PREFIX_MAX_TURNS: 12,
  /** Per-message char cap in the history prefix — keeps long threads manageable. */
  HISTORY_PREFIX_MAX_CHARS: 4000,

  // ── MCP probe ────────────────────────────────────────────────────────
  /** Probe timeout — after this we mark the spawn "ok" and stop the subprocess. */
  MCP_PROBE_TIMEOUT_MS: 2000,
  /** Stdout/stderr buffer cap during probe (per stream). */
  MCP_OUTPUT_MAX_CHARS: 4000,
  /** `argsPreview.slice(0, N)` when rendering the confirm dialog. */
  MCP_ARGS_PREVIEW_COUNT: 8,

  // ── Skill URL import ─────────────────────────────────────────────────
  /** Max skill markdown size (bytes) — rejects payload floods. */
  SKILL_IMPORT_MAX_BYTES: 1_000_000,
  /** HTTPS request timeout for skill URL imports. */
  SKILL_IMPORT_REQUEST_TIMEOUT_MS: 15_000,

  // ── Slugification ────────────────────────────────────────────────────
  /** Max length for slugified names (skills, subagents, MCPs). */
  SLUG_MAX_LENGTH: 120,
})
