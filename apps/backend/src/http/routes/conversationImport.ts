import type { Hono } from "hono"
import type { AppState } from "../../appState"
import { withCheckpointRecoveryMutation } from "../../services/checkpoint-recovery-fence"
import { ConversationImportService } from "../../services/conversation-import/service"
import { contractResult, handleHttpContract } from "../contracts"

/**
 * Importing earlier Claude Code and Codex conversations
 * (`conversationImportList`, `conversationImportRun` in the shared
 * contracts). Desktop-only (`DESKTOP_ONLY_PATHS` in remote/http.ts): the
 * sessions are read from this computer's home folder.
 */
export function registerConversationImportRoutes(
  api: Hono,
  state: AppState
): void {
  // Built on first use: its statements need the migrated database.
  let service: ConversationImportService | null = null
  const importer = (): ConversationImportService =>
    (service ??= new ConversationImportService({
      db: state.db,
      threads: state.threads,
      bindings: state.providerSessionBindings,
      activities: state.threadActivities,
      continuationKey: (instanceId) => {
        const instance = state.providerHub.getInstance(instanceId)
        return instance?.enabled ? (instance.continuationKey ?? null) : null
      },
      dataDir: state.config.dataDir || null,
      withMutation: (scope, run) =>
        withCheckpointRecoveryMutation(state, scope, run),
    }))

  // `?provider=claude|codex`, `?project=<folder>`; `?refresh=1` reads every file again.
  api.get("/conversation-imports", async (c) => {
    const provider = c.req.query("provider")
    return contractResult(
      c,
      "conversationImportList",
      await importer().list({
        provider:
          provider === "claude" || provider === "codex" ? provider : null,
        project: c.req.query("project") ?? null,
        refresh: c.req.query("refresh") === "1",
      })
    )
  })

  api.post("/conversation-imports", (c) =>
    handleHttpContract(
      c,
      "conversationImportRun",
      (body) => importer().import(body.items),
      { operation: "conversation import" }
    )
  )
}
