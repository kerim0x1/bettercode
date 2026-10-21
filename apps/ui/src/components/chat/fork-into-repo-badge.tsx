import { useState } from "react"
import { GitBranchIcon, LoaderCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { useChatStore } from "@/lib/chat-store"
import { pickFolder } from "@/services/backend/runtime"
import { adoptScratchWorkspace } from "@/services/backend/workspaceApi"
import { handleError } from "@/lib/errors"

/** What `/workspace/scratch/adopt` reports back about the file migration. */
export interface ScratchMigrationSummary {
  readonly copied: number
  readonly skipped: ReadonlyArray<string>
  /**
   * The backend stops copying at 5,000 files or 256 MB and leaves the rest
   * in the scratch workspace. Optional only because older backends did not
   * report it.
   */
  readonly truncated?: boolean
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/**
 * The toast body after a fork. Pure so the wording — especially the
 * truncation notice, which is the only signal the user gets that files were
 * left behind — can be tested without a DOM.
 */
export function forkMigrationDescription(
  migrated: ScratchMigrationSummary | null
): string {
  const copied = migrated?.copied ?? 0
  const skipped = migrated?.skipped.length ?? 0
  const parts: string[] = []
  if (copied > 0) {
    parts.push(
      `Brought ${plural(copied, "file")} along${
        skipped ? `, kept ${plural(skipped, "existing file")}` : ""
      }.`
    )
  }
  // Truncation is checked regardless of the count: a copy that stopped
  // before its first file (one oversized file, or the byte budget already
  // spent) still left everything behind, and the user has to hear that
  // rather than "still available without a folder".
  if (migrated?.truncated) {
    parts.push(
      copied > 0
        ? `The copy was cut short at ${plural(copied, "file")} (limit 5,000 files / 256 MB); the rest was left in the scratch workspace.`
        : "The copy was cut short before any file was brought along (limit 5,000 files / 256 MB); everything was left in the scratch workspace."
    )
  }
  if (parts.length === 0) {
    return "The original chat is still available without a folder."
  }
  return parts.join(" ")
}

/**
 * Turns a folder-less chat into a repository-scoped one.
 *
 * A chat started without a project runs in its own scratch workspace, so the
 * conversation and anything the agent built there are real and worth keeping.
 * Forking branches that chat into the chosen repository — the original stays
 * put, so the same idea can be forked into several repos.
 */
export function ForkIntoRepoBadge({ threadId }: { threadId: string }) {
  const [busy, setBusy] = useState(false)

  const forkIntoRepo = async () => {
    if (busy) return
    const folder = await pickFolder()
    if (!folder) return
    setBusy(true)
    try {
      const projectName = folder.split(/[/\\]/).pop() || "Project"
      const forkedId = await useChatStore
        .getState()
        .forkThread(threadId, { projectPath: folder, projectName })
      if (!forkedId) {
        toast.error("Could not fork this chat into the repository.")
        return
      }

      // The fork is persisted first so the folder counts as a registered
      // workspace by the time the backend is asked to copy into it.
      let migrated: ScratchMigrationSummary | null = null
      try {
        migrated = await adoptScratchWorkspace(threadId, folder)
      } catch (err) {
        // The chat itself forked fine; only the file migration failed, so say
        // so rather than implying the whole action did not happen.
        handleError(err, { source: "fork-into-repo" })
      }

      useChatStore.getState().setActiveThread(forkedId)
      window.dispatchEvent(
        new CustomEvent("betterc0de:open-thread", {
          detail: { threadId: forkedId, label: projectName },
        })
      )

      const description = forkMigrationDescription(migrated)
      // A cut-short copy is a warning the user has to act on, not a success.
      if (migrated?.truncated) {
        toast.warning(`Forked into ${projectName}`, { description })
      } else {
        toast.success(`Forked into ${projectName}`, { description })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Badge
      variant="outline"
      className="shrink-0 cursor-pointer gap-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      onClick={() => void forkIntoRepo()}
      title="Continue this chat in a repository, keeping the original"
    >
      {busy ? (
        <LoaderCircleIcon className="size-3.5 animate-spin" />
      ) : (
        <GitBranchIcon className="size-3.5" />
      )}
      Fork into repo
    </Badge>
  )
}
