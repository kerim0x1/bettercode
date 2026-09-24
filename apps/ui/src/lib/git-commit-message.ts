import { generateWorkspaceCommitMessage as generateFromSources } from "@betterc0de/schema/git-commit-message"
import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import {
  generateCommitMessage,
  gitDiff,
  gitDiffStaged,
  gitStatus,
  readFile,
} from "@/services/backend"

/**
 * Generate for exactly the scope that smart commit will commit, without
 * staging anything (@betterc0de/schema/git-commit-message, shared with the
 * phone app).
 */
export function generateWorkspaceCommitMessage(cwd: string): Promise<string> {
  return generateFromSources(cwd, {
    status: () => gitStatus(cwd),
    diff: async () => {
      const patch = await gitDiff(cwd)
      return { diffText: patch.diff_text, truncated: patch.truncated }
    },
    stagedDiff: async () => {
      const patch = await gitDiffStaged(cwd)
      return { diffText: patch.diff_text, truncated: patch.truncated }
    },
    readUntracked: async (file) =>
      (await readFile(resolveWorkspaceFilePath(cwd, file))).content,
    generate: (request) => generateCommitMessage(request),
  })
}
