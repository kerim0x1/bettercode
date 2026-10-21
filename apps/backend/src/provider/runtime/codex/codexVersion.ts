import { asRecord, readTrimmed } from "@betterc0de/schema"
import { cliVersionAtLeast, compareCliVersions } from "../../../cli/versions"

/**
 * Oldest Codex CLI whose `app-server` speaks the v2 thread/turn protocol this
 * adapter is built on (`thread/start`, `turn/start`, item notifications,
 * `experimentalApi`). Older builds fail mid-turn with opaque "method not
 * found" errors, so the status probe names the version instead. The check
 * only warns, and an unparseable or newer version is never flagged: newer
 * builds keep the v2 contract. An alpha build of the minimum release counts
 * as that release.
 */
export const MINIMUM_CODEX_APP_SERVER_VERSION = "0.50.0"

/** Version from the `initialize` response's `userAgent` ("codex_cli_rs/0.x.y …"). */
export function parseCodexInitializeVersion(response: unknown): string | null {
  const userAgent = readTrimmed(asRecord(response), "userAgent")
  return userAgent?.match(/\/([^\s]+)/)?.[1] ?? null
}

/** A user-facing upgrade hint, or null when the version is fine or unknown. */
export function codexVersionAdvisory(version: string | null): string | null {
  if (!version) return null
  if (compareCliVersions(version, MINIMUM_CODEX_APP_SERVER_VERSION) === null) {
    return null
  }
  if (
    cliVersionAtLeast(version, MINIMUM_CODEX_APP_SERVER_VERSION, {
      prereleaseMeetsRelease: true,
    })
  ) {
    return null
  }
  return (
    `Codex CLI ${version} is older than the oldest supported version ` +
    `(${MINIMUM_CODEX_APP_SERVER_VERSION}) and may fail mid-turn. ` +
    "Update it with `npm i -g @openai/codex`."
  )
}
