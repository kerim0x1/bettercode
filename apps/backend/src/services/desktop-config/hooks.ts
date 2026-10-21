import { RUNTIME_HOOK_LIMITS } from "@betterc0de/schema/runtime-records"
import { logger } from "../../observability/logger"
import type { DesktopConfigStore } from "./store"

/** How a hook run ended, as Settings → Hooks shows it. */
export interface HookRunOutcome {
  readonly status: "success" | "error"
  readonly exitCode: number | null
  /** The failure text; `null` for a successful run. */
  readonly error: string | null
}

const MAX_ATTEMPTS = 3

function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === "desktop_config_conflict" || code === "desktop_config_busy"
}

/**
 * Record a hook's last run in `hooks.json` (`lastRunAt`, `lastStatus`,
 * `lastExitCode`, `lastError`), the fields the desktop's `hook:update-run`
 * kept and Settings → Hooks shows. The backend runs message hooks for every
 * client now, so it records them; the write goes through the store, against
 * the revision it read, so a hook the user edits at the same time is never
 * overwritten. Never throws: a record that cannot be written is logged and
 * the turn goes on.
 */
export function recordHookRun(
  store: DesktopConfigStore,
  id: string,
  outcome: HookRunOutcome,
  now: () => Date = () => new Date()
): boolean {
  if (!id) return false
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const document = store.readHooks()
      if (document.problem) return false
      const index = document.entries.findIndex((entry) => entry.id === id)
      if (index < 0) return false
      const at = now().toISOString()
      const entries = [...document.entries]
      entries[index] = {
        ...entries[index]!,
        lastRunAt: at,
        lastStatus: outcome.status,
        lastExitCode: outcome.exitCode,
        lastError:
          outcome.error === null
            ? null
            : outcome.error.slice(0, RUNTIME_HOOK_LIMITS.maxErrorChars),
        updatedAt: at,
      }
      store.writeHooks(entries, document.revision)
      return true
    } catch (error) {
      if (isRetryable(error) && attempt < MAX_ATTEMPTS) continue
      logger.warn(
        { err: error, hookId: id },
        "could not record a hook's last run in hooks.json"
      )
      return false
    }
  }
  return false
}
