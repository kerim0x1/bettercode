import type { ThreadSettingsPatch } from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import {
  isBypassPermissionLevel,
  normalizeLevel,
  peekSessionPermission,
  type PermissionLevel,
} from "../../provider/permissions"
import { remoteBypassRefusal, type RemotePermissionAccess } from "./requests"

/**
 * A chat's own settings (projection_threads.settings_json, PATCH
 * /threads/:id) as the turn path reads them: the permission level kept with
 * the chat stands in where a request names none, and after a restart where
 * this process has not seen a turn of the chat yet.
 */

type ThreadSettingsState = {
  readonly threads: Pick<AppState["threads"], "getThreadSettings">
}

/** The permission level kept with the chat, or `null` when it has none. */
export function storedThreadPermissionLevel(
  state: ThreadSettingsState,
  threadId: string
): string | null {
  return state.threads.getThreadSettings(threadId)?.permissionLevel ?? null
}

/**
 * A turn that names no permission level runs at the chat's own, not at
 * whatever the provider session last had. Apply it before the remote cap
 * (`capRemoteChatPermissions`): a paired device without the terminal grant
 * still never gets bypass, whatever the chat keeps.
 */
export function withThreadPermissionLevel<
  T extends {
    readonly thread_id: string
    readonly permission_level: string | null
  },
>(state: ThreadSettingsState, body: T): T {
  if (body.permission_level?.trim()) return body
  const stored = storedThreadPermissionLevel(state, body.thread_id)
  return stored ? { ...body, permission_level: stored } : body
}

/**
 * The thread's current level: the latest a turn or a live change set in
 * this process, else the level kept with the chat, else ask-on-edit.
 */
export function currentThreadPermissionLevel(
  state: ThreadSettingsState,
  threadId: string
): PermissionLevel {
  return (
    peekSessionPermission(threadId) ??
    normalizeLevel(storedThreadPermissionLevel(state, threadId))
  )
}

/**
 * What a paired device may not keep with a chat: bypass without the
 * terminal grant (as for `/chat/permission-mode`), orchestration, which
 * only the desktop host configures (as for `/chat/send`), and pull request
 * wake-ups switched on.
 */
export function assertThreadSettingsPatchAllowed(
  patch: ThreadSettingsPatch,
  access: RemotePermissionAccess
): void {
  if (!access.remote) return
  if (
    !access.mayBypass &&
    typeof patch.permissionLevel === "string" &&
    isBypassPermissionLevel(patch.permissionLevel)
  ) {
    throw remoteBypassRefusal()
  }
  if (patch.orchestration?.enabled) {
    throw new HttpError(
      403,
      "Only the desktop host can configure orchestration."
    )
  }
  // Wake-ups start turns from the desktop window at the chat's own level.
  if (patch.pullRequestWake === true) {
    throw new HttpError(
      403,
      "Only the desktop host can turn on pull request wake-ups."
    )
  }
}
