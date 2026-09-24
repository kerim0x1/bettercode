import type { ThreadDiffs } from "@/types/remote"

/** One entry of a chat's Changes: a turn's diff or a checkpoint's. */
export interface ChangeItem {
  id: string
  title: string
  subtitle: string
  diff: string
  additions: number | null
  deletions: number | null
  files: number | null
  createdAt: string
}

/**
 * A chat's turn and checkpoint diffs, newest first. The ids stay the same
 * between loads, so a screen can open one entry by its id.
 */
export function changeItems(diffs: ThreadDiffs | null): ChangeItem[] {
  if (!diffs) return []
  return [
    ...diffs.turnDiffs.map((diff) => ({
      id: `turn-${diff.turnIndex}-${diff.createdAt}`,
      title: `Turn ${diff.turnIndex}`,
      subtitle: "Working tree changes",
      diff: diff.diffText,
      additions: diff.insertions,
      deletions: diff.deletions,
      files: diff.filesChanged,
      createdAt: diff.createdAt,
    })),
    ...diffs.checkpointDiffs.map((diff) => ({
      id: diff.id,
      title: "Checkpoint",
      subtitle: diff.checkpointRef,
      diff: diff.diffContent,
      additions: null,
      deletions: null,
      files: null,
      createdAt: diff.createdAt,
    })),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}
