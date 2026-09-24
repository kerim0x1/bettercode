import { asRecord, readString } from "@betterc0de/schema"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/lib/chat-store"
import {
  describeRequestResponseFailure,
  failedRequestResponseActivity,
} from "@/lib/pending-provider-requests"
import { toast } from "@/lib/toast"
import { respondToApproval } from "@/services/backend"
import type { PendingApproval } from "@/lib/pending-approvals"
import type { PermissionUpdate } from "@betterc0de/schema"

export interface ApprovalInputView {
  command?: string
  commandDescription?: string
  cwd?: string
  filePath?: string
  oldText?: string
  newText?: string
  rawJson?: string
}

/** Fields already rendered on their own; the rest still get shown as JSON. */
const RENDERED_INPUT_KEYS = new Set([
  "command",
  "description",
  "cwd",
  "file_path",
  "filePath",
  "path",
  "old_string",
  "oldString",
  "new_string",
  "newString",
  "content",
])

function remainingInputJson(
  input: Record<string, unknown>
): string | undefined {
  const rest = Object.fromEntries(
    Object.entries(input).filter(([key]) => !RENDERED_INPUT_KEYS.has(key))
  )
  if (Object.keys(rest).length === 0) return undefined
  try {
    return JSON.stringify(rest, null, 2)
  } catch {
    return String(rest)
  }
}

export function approvalInputView(
  approval: PendingApproval
): ApprovalInputView {
  const input = asRecord(approval.input)
  const cwd = readString(input, "cwd")
  const command = readString(input, "command")
  // Previously this returned early on `command`, dropping every other field —
  // so a Bash approval never told the user which directory it would run in.
  if (command) {
    return {
      command,
      commandDescription: readString(input, "description"),
      cwd,
      rawJson: remainingInputJson(input),
    }
  }
  const filePath = readString(input, "file_path", "filePath", "path")
  const oldText = readString(input, "old_string", "oldString")
  const newText = readString(input, "new_string", "newString", "content")
  if (filePath && (oldText !== undefined || newText !== undefined)) {
    return {
      filePath,
      oldText,
      newText,
      cwd,
      rawJson: remainingInputJson(input),
    }
  }
  if (filePath) return { filePath, cwd, rawJson: remainingInputJson(input) }
  let rawJson: string | undefined
  try {
    rawJson = JSON.stringify(approval.input ?? {}, null, 2)
  } catch {
    rawJson = String(approval.input)
  }
  return { rawJson, cwd }
}

/**
 * Height at which a block starts scrolling. Nothing is truncated: the user is
 * authorizing the whole string, so the whole string has to be reachable. The
 * old 2,000-character clamp meant a padded command could hide its payload past
 * a bare "…" and still be approved.
 */
const SCROLL_AFTER_CHARS = 2_000

/**
 * Make characters that can misrepresent a command visible: bidi overrides can
 * render text in an order that differs from what will execute, and C0 controls
 * are invisible entirely.
 */
function visualizeControlChars(text: string): string {
  let out = ""
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const isTabOrNewline = code === 0x09 || code === 0x0a || code === 0x0d
    const isC0 = code < 0x20 && !isTabOrNewline
    const isDelete = code === 0x7f
    const isZeroWidthOrBidi =
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    out +=
      isC0 || isDelete || isZeroWidthOrBidi
        ? `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`
        : char
  }
  return out
}

export function ApprovalRequestContext({
  approval,
  compact = false,
}: {
  approval: PendingApproval
  compact?: boolean
}) {
  const view = approvalInputView(approval)
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", compact && "gap-1.5")}>
      {approval.title ? (
        <p className="text-xs font-medium text-foreground">{approval.title}</p>
      ) : null}
      {view.commandDescription ? (
        <p className="text-[11px] text-muted-foreground">
          {view.commandDescription}
        </p>
      ) : null}
      {view.command ? (
        <>
          <pre
            className={cn(
              "overflow-x-auto rounded-lg border border-border/50 bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
              compact ? "max-h-28 overflow-y-auto" : "max-h-64 overflow-y-auto"
            )}
          >
            {visualizeControlChars(view.command)}
          </pre>
          {view.command.length > SCROLL_AFTER_CHARS ? (
            <p className="text-[11px] text-muted-foreground">
              {view.command.length.toLocaleString()} characters — scroll to
              review the whole command before approving.
            </p>
          ) : null}
        </>
      ) : null}
      {view.cwd ? (
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          Working directory: {visualizeControlChars(view.cwd)}
        </p>
      ) : null}
      {view.filePath ? (
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {visualizeControlChars(view.filePath)}
        </p>
      ) : null}
      {view.oldText !== undefined || view.newText !== undefined ? (
        <div
          className={cn(
            "flex flex-col gap-1 overflow-y-auto",
            compact ? "max-h-32" : "max-h-64"
          )}
        >
          {view.oldText ? (
            <pre className="overflow-x-auto rounded-lg border border-destructive/25 bg-destructive/8 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-destructive">
              {view.oldText}
            </pre>
          ) : null}
          {view.newText ? (
            <pre className="overflow-x-auto rounded-lg border border-success/25 bg-success/8 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-success">
              {view.newText}
            </pre>
          ) : null}
        </div>
      ) : null}
      {view.rawJson && view.rawJson !== "{}" ? (
        <ScrollArea className={cn(compact ? "max-h-28" : "max-h-64")}>
          <pre className="overflow-x-auto rounded-lg border border-border/50 bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {view.rawJson}
          </pre>
        </ScrollArea>
      ) : null}
      {approval.decisionReason ? (
        <p className="text-[11px] text-muted-foreground">
          {approval.decisionReason}
        </p>
      ) : null}
      {approval.blockedPath ? (
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          Blocked path: {approval.blockedPath}
        </p>
      ) : null}
    </div>
  )
}

// "Always allow" is shared with the phone app's approval card, so neither
// can offer a broader grant than the other.
export {
  ALWAYS_ALLOW_DESTINATIONS,
  alwaysAllowRuleContent,
  alwaysAllowRules,
  buildAlwaysAllowUpdate,
  describeAlwaysAllowRules,
  type AlwaysAllowDestination,
} from "@betterc0de/schema/always-allow"

/**
 * Records a refused or undeliverable request response locally and tells the
 * user. The backend answers a provider-side refusal with a non-2xx (502 for
 * an upstream failure) and broadcasts its own failed activity; this local
 * twin covers the window before that frame lands and the case where the
 * request never reached the backend at all.
 */
export function recordRequestResponseFailure(input: {
  readonly threadId: string
  readonly requestId: string
  readonly providerKind: string
  readonly providerInstanceId?: string | null
  readonly requestKind: "approval" | "plan-approval"
  readonly error: unknown
}): void {
  const fallback =
    input.requestKind === "plan-approval"
      ? "Provider plan-approval response failed"
      : "Provider approval response failed"
  const detail = describeRequestResponseFailure(input.error, fallback)
  useChatStore
    .getState()
    .upsertThreadActivity(
      input.threadId,
      failedRequestResponseActivity({ ...input, detail })
    )
  toast.error(fallback, {
    description: detail,
    id: `request-response-failed:${input.threadId}:${input.requestId}`,
  })
}

/**
 * Shared submit path for approval decisions (row + modal). Posts the
 * decision, records the resolved/failed activity so `derivePendingApprovals`
 * clears the request everywhere. Never throws: a failure is recorded as an
 * activity and a toast, and `false` is returned, so callers in event
 * handlers cannot leak an unhandled rejection.
 */
export async function submitApprovalDecision(
  threadId: string,
  approval: PendingApproval,
  decision: "approve" | "deny",
  options?: { message?: string; updatedPermissions?: PermissionUpdate[] }
): Promise<boolean> {
  try {
    if (approval.pluginId && window.electronAPI?.pluginSend) {
      await window.electronAPI.pluginSend(
        approval.pluginId,
        "respondToolApproval",
        { requestId: approval.requestId, approved: decision === "approve" }
      )
    } else {
      const response = await respondToApproval(
        threadId,
        approval.providerKind,
        approval.requestId,
        decision,
        approval.providerInstanceId ?? null,
        options
      )
      if (response.status === "failed") {
        throw new Error(response.error || "Provider approval response failed")
      }
    }
  } catch (error) {
    recordRequestResponseFailure({
      threadId,
      requestId: approval.requestId,
      providerKind: approval.providerKind,
      providerInstanceId: approval.providerInstanceId,
      requestKind: "approval",
      error,
    })
    return false
  }
  useChatStore.getState().upsertThreadActivity(threadId, {
    id: `${threadId}::approval.resolved::${approval.requestId}`,
    threadId,
    kind: "approval.resolved",
    tone: decision === "deny" ? "error" : "info",
    summary: decision === "deny" ? "Approval denied" : "Approval approved",
    payload: {
      requestId: approval.requestId,
      providerKind: approval.providerKind,
      providerInstanceId: approval.providerInstanceId,
      decision,
    },
    sequence: Date.now() * 1000,
    createdAt: new Date().toISOString(),
  })
  return true
}
