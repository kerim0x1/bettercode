import { create } from "zustand"
import { AppError } from "@/lib/errors/types"

/**
 * What trusting a workspace allows. Shared by Settings → Permissions and the
 * inline action on a refused Agent turn, so both confirmations say the same.
 */
export const WORKSPACE_TRUST_DESCRIPTION =
  "Agent Mode and approved workspace mutations will be allowed for this exact project root. Commands the project declares — its MCP servers, formatters and Claude project hooks — may run. Only trust code you know."

/** The backend refused a turn because its workspace is not trusted. */
export function isWorkspaceUntrustedError(error: unknown): boolean {
  return error instanceof AppError && error.code === "workspace_untrusted"
}

export interface WorkspaceTrustPrompt {
  /** The workspace root the refused turn ran in. */
  workspacePath: string
}

/** Old prompts only matter for errors still on screen; keep the map small. */
const MAX_PROMPTS = 50

interface WorkspaceTrustPromptState {
  /** Error message id → the workspace its inline "Trust" action trusts. */
  byMessageId: Readonly<Record<string, WorkspaceTrustPrompt>>
  register: (messageId: string, prompt: WorkspaceTrustPrompt) => void
  /** Drops every prompt for a workspace once it has been trusted. */
  resolveWorkspace: (workspacePath: string) => void
}

/**
 * Inline "Trust this workspace" actions for Agent turns the backend refused
 * with `workspace_untrusted`. Kept in memory only: after a reload the error
 * text still points to Settings → Permissions.
 */
export const useWorkspaceTrustPromptStore = create<WorkspaceTrustPromptState>()(
  (set) => ({
    byMessageId: {},
    register: (messageId, prompt) =>
      set((state) => {
        const entries = Object.entries(state.byMessageId).filter(
          ([id]) => id !== messageId
        )
        entries.push([messageId, prompt])
        return {
          byMessageId: Object.fromEntries(entries.slice(-MAX_PROMPTS)),
        }
      }),
    resolveWorkspace: (workspacePath) =>
      set((state) => {
        const entries = Object.entries(state.byMessageId)
        const remaining = entries.filter(
          ([, prompt]) => prompt.workspacePath !== workspacePath
        )
        return remaining.length === entries.length
          ? state
          : { byMessageId: Object.fromEntries(remaining) }
      }),
  })
)
