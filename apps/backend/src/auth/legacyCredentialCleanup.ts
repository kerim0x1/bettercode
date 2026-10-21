import fs from "node:fs"
import path from "node:path"
import { logger } from "../observability/logger"

/**
 * Earlier builds stored ChatGPT sign-in tokens (an access token and a
 * long-lived refresh token) in `auth.json` through an OAuth flow whose
 * credentials nothing ever read, refreshed or revoked. That flow and its
 * store are gone; this removes the leftover file, and any temp file an
 * interrupted write left beside it, so a refresh token does not stay on disk
 * without an owner.
 *
 * Runs at every startup but only acts when something is left. Best-effort:
 * a failure is logged and never blocks the backend from starting.
 */
export function removeLegacyCredentialStore(authPath: string): number {
  let removed = 0
  const directory = path.dirname(authPath)
  const base = path.basename(authPath)
  const candidates = [authPath]
  try {
    for (const name of fs.readdirSync(directory)) {
      if (name.startsWith(`${base}.tmp.`)) {
        candidates.push(path.join(directory, name))
      }
    }
  } catch {
    // No data directory yet: nothing was ever stored.
  }
  for (const candidate of candidates) {
    try {
      fs.unlinkSync(candidate)
      removed += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      logger.warn(
        {
          file: path.basename(candidate),
          errorCode: (error as NodeJS.ErrnoException).code,
        },
        "could not remove the retired provider credential store"
      )
    }
  }
  if (removed > 0) {
    logger.info(
      { files: removed },
      "removed the retired provider credential store (auth.json)"
    )
  }
  return removed
}
