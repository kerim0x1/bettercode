import { BetterC0deCompatAdapter } from "../betterc0deCompat/BetterC0deCompatAdapter"
import { OPENCODE_CLI_PROFILE } from "../betterc0deCompat/OpenCodeCompatProfile"

/**
 * OpenCode CLI adapter.
 *
 * The upstream `opencode` binary exposes the same agent-facing HTTP/SSE
 * surface as BetterC0de's own compatibility CLI (v1: `/session`,
 * `/event`, `/permission/{id}/reply`, `/question/{id}/reply`; v2:
 * `/api/model`, `/api/provider`, `/api/session/*`). This adapter is the
 * shared protocol implementation pinned to the OpenCode profile, so the
 * permission/question plumbing, tool/part lifecycle, token usage and diff
 * extraction are byte-for-byte the ones verified for the compatibility
 * adapter — only branding, the `opencode` provider kind, the v2 inventory
 * envelopes, and the absence of a version/config-override gate differ.
 *
 * Both v1 and v2 HTTP surfaces are supported: the v1 endpoints drive turns
 * and streaming, while the v2 endpoints (when present) supply richer
 * provider/model inventory. Older OpenCode builds that only implement v1
 * still work because every v2 call degrades to an empty result and the
 * v1 provider list remains authoritative.
 */
export class OpenCodeAdapter extends BetterC0deCompatAdapter {
  constructor(options: ConstructorParameters<typeof BetterC0deCompatAdapter>[0] = {}) {
    super({ ...options, profile: OPENCODE_CLI_PROFILE })
  }
}
