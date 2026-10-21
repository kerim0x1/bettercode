import type {
  ConversationImportList,
  ConversationImportProvider,
} from "@betterc0de/schema"
import type { ConversationImportRunResult } from "@betterc0de/schema/http-contracts"
import { invokeContract } from "./contracts"

// Importing earlier Claude Code and Codex conversations (desktop-only),
// through the shared `conversationImport*` contracts.

export type { ConversationImportRunResult }

/**
 * The sessions the CLIs keep on this computer, newest first. The first
 * scan of a large history reads for a few seconds; later ones reuse what
 * did not change unless `refresh` is set.
 */
export function listConversationImports(
  options: {
    provider?: ConversationImportProvider
    project?: string
    refresh?: boolean
  } = {}
): Promise<ConversationImportList> {
  const params = new URLSearchParams()
  if (options.provider) params.set("provider", options.provider)
  if (options.project?.trim()) params.set("project", options.project.trim())
  if (options.refresh) params.set("refresh", "1")
  const query = params.toString()
  return invokeContract("conversationImportList", {
    query: query ? `?${query}` : "",
    timeoutMs: 60_000,
  })
}

/** Imports up to `CONVERSATION_IMPORT_MAX_BATCH` sessions; one result each, in order. */
export function importConversations(
  items: ReadonlyArray<{
    provider: ConversationImportProvider
    sessionId: string
  }>
): Promise<ConversationImportRunResult> {
  return invokeContract("conversationImportRun", {
    body: {
      items: items.map(({ provider, sessionId }) => ({ provider, sessionId })),
    },
    // A session file can be tens of megabytes.
    timeoutMs: 180_000,
  })
}
