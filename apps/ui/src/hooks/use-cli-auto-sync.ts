import { useEffect } from "react"
import {
  resolveCliScanContext,
  type CliScanContext,
  type CliScanProjectScope,
} from "@/lib/cli-scan-context"
import { getElectronApi } from "@/services/ipc-facade"

/** What a CLI sync imports (`cli:auto-sync` in apps/shell/onboarding-ipc.cjs). */
export type CliSyncKind = "mcpServers" | "skills" | "agents"

export type CliSyncCounts = Record<CliSyncKind, number>

/**
 * A `cli:auto-sync` request: the scan context plus, for a manual "Sync from
 * CLI", which kinds to import and whether to bring back items the user
 * removed. An older desktop process ignores the extra fields.
 */
export interface CliSyncRequest extends Partial<CliScanContext> {
  kinds?: CliSyncKind[]
  includeDismissed?: boolean
}

/** A user-level MCP server the desktop could not import as it is. */
export interface CliSkippedMcpServer {
  id: string
  name: string
  source: string
  reason: string
}

export interface CliSyncResult {
  ok: boolean
  error?: string
  imported: CliSyncCounts
  /** User-level entries found; project-scoped ones are not included. */
  total: CliSyncCounts
  /**
   * Items the user removed or hid earlier, which an automatic sync leaves
   * out. Absent from an older desktop process.
   */
  dismissed?: CliSyncCounts
  /** Absent from an older desktop process. */
  skippedMcpServers?: CliSkippedMcpServer[]
  /** Whether each CLI's configuration exists. Absent from an older desktop. */
  found?: { claude: boolean; codex: boolean }
  skippedWorkspaceAssets?: number
  projectScope?: CliScanProjectScope
}

/**
 * Run a CLI sync in the desktop process, or `null` outside the desktop app.
 * The bridge is typed for the plain scan context; the extra request fields
 * and result fields are added here.
 */
export async function runCliSync(
  request: CliSyncRequest | undefined
): Promise<CliSyncResult | null> {
  const api = getElectronApi()
  if (!api?.cliAutoSync) return null
  const sync = api.cliAutoSync as unknown as (
    request?: CliSyncRequest
  ) => Promise<CliSyncResult | undefined>
  return (await sync(request)) ?? null
}

/**
 * Runs on mount and when the selected project changes to import NEW MCP
 * servers, skills, and agents from the user's own Claude/Codex CLI
 * configuration. Everything imported is global — it applies in every
 * workspace — so a repository's own entries (`.mcp.json`,
 * `.claude/settings*.json`, project skills and agents) are never imported:
 * the desktop process skips them, and the project is only scanned at all
 * once the backend records an explicit trust decision for it.
 *
 * Removals stick: the desktop process remembers what it imported
 * (`cli-imports.json`), and an item the user removed or hid in Settings is
 * not imported again here. Settings → "Sync from CLI" brings it back.
 *
 * Best-effort / non-blocking: failures are silently swallowed so the
 * app startup is never delayed or interrupted.
 */
export function useCliAutoSync(activeProjectPath?: string | null) {
  useEffect(() => {
    if (!getElectronApi()?.cliAutoSync) return
    let cancelled = false

    resolveCliScanContext(activeProjectPath)
      .then((scanContext) => runCliSync(scanContext))
      .then((result) => {
        if (cancelled) return
        if (!result?.ok) return
        const { imported, total, projectScope } = result
        const projectStatus = projectScope?.status ?? "not-selected"
        const skipped = result.skippedWorkspaceAssets ?? 0
        const skippedNote =
          skipped > 0
            ? [
                `(skipped ${skipped} project-scoped item(s); they stay with their project)`,
              ]
            : []
        const dismissed = result.dismissed
          ? result.dismissed.mcpServers +
            result.dismissed.skills +
            result.dismissed.agents
          : 0
        const dismissedNote =
          dismissed > 0
            ? [`(left out ${dismissed} item(s) removed in Settings)`]
            : []
        const any =
          imported.mcpServers > 0 || imported.skills > 0 || imported.agents > 0
        if (any) {
          console.info(
            "[cli-auto-sync] Imported from CLI configs:",
            `${imported.mcpServers} MCP server(s),`,
            `${imported.skills} skill(s),`,
            `${imported.agents} agent(s)`,
            `(scanned ${total.mcpServers} server(s), ${total.skills} skill(s), ${total.agents} agent(s) total)`,
            `(project scope: ${projectStatus})`,
            ...skippedNote,
            ...dismissedNote
          )
        } else {
          console.info(
            "[cli-auto-sync] No new items to import",
            `(scanned ${total.mcpServers} server(s), ${total.skills} skill(s), ${total.agents} agent(s))`,
            `(project scope: ${projectStatus})`,
            ...skippedNote,
            ...dismissedNote
          )
        }
      })
      .catch(() => {
        // Silent — auto-sync is best-effort and must never block startup.
      })
    return () => {
      cancelled = true
    }
  }, [activeProjectPath])
}
