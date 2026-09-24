/**
 * "Always allow" for a tool approval: the rule it would store, and the
 * PermissionUpdate that stores it. The desktop's approval dialog and the
 * phone app's approval card both use these, so neither can offer a
 * broader grant than the other.
 */

import { asRecord, readString } from "./json-read"
import type { PermissionRuleValue, PermissionUpdate } from "./provider-runtime"

export type AlwaysAllowDestination =
  | "session"
  | "localSettings"
  | "userSettings"

export const ALWAYS_ALLOW_DESTINATIONS: ReadonlyArray<{
  id: AlwaysAllowDestination
  label: string
}> = [
  { id: "session", label: "This session" },
  { id: "localSettings", label: "This project" },
  { id: "userSettings", label: "All projects" },
]

/** What "Always allow" needs to know about a tool approval request. */
export interface AlwaysAllowRequest {
  toolName?: string
  input?: unknown
  /** The provider's own suggestion (the Claude Agent SDK's `suggestions`). */
  suggestions?: ReadonlyArray<PermissionUpdate>
}

/**
 * The exact rules an "Always allow" would persist, or `null` when this call
 * cannot be scoped safely.
 *
 * This is the single source of truth: `buildAlwaysAllowUpdate` sends these and
 * `describeAlwaysAllowRules` renders these, so the menu can never advertise a
 * narrower scope than the one that gets written.
 *
 * Every rule must be scoped. An unscoped `{ toolName }` rule matches *every*
 * invocation of the normalized tool family — `edit` also covers Write,
 * MultiEdit, NotebookEdit and apply_patch on every path, and `bash` covers
 * every shell command — so persisting one would grant far more than the dialog
 * showed. The backend refuses them (both `session-permission-rules.ts` and
 * `agent-permission-updates.ts`), so emitting one would silently do nothing.
 * Returning `null` keeps the UI honest by disabling the control instead.
 *
 * The SDK's own suggestion is preferred when it is fully scoped, because it
 * knows more about the call than we do — but it is *validated*, not trusted.
 * Forwarding it unchecked was how an unscoped suggestion became a
 * workspace-wide (or all-workspaces) grant while the menu displayed a narrow
 * synthesized rule that was never sent.
 */
export function alwaysAllowRules(
  request: AlwaysAllowRequest
): PermissionRuleValue[] | null {
  const suggested = request.suggestions?.find(
    (update) =>
      update.type === "addRules" &&
      update.behavior === "allow" &&
      update.rules.length > 0 &&
      update.rules.every(
        (rule) => rule.toolName.trim() && rule.ruleContent?.trim()
      )
  )
  if (suggested && suggested.type === "addRules") return [...suggested.rules]

  const toolName = request.toolName
  if (!toolName) return null
  const ruleContent = alwaysAllowRuleContent(request, toolName)
  if (!ruleContent) return null
  return [{ toolName, ruleContent }]
}

/** Render the rules exactly as they will be persisted, for the menu label. */
export function describeAlwaysAllowRules(
  rules: ReadonlyArray<PermissionRuleValue>
): string {
  return rules
    .map((rule) => `${rule.toolName}(${rule.ruleContent ?? ""})`)
    .join(", ")
}

/**
 * Build the PermissionUpdate to persist for "Always allow" from the same rules
 * the menu displayed.
 */
export function buildAlwaysAllowUpdate(
  request: AlwaysAllowRequest,
  destination: AlwaysAllowDestination
): PermissionUpdate | null {
  const rules = alwaysAllowRules(request)
  if (!rules || rules.length === 0) return null
  return {
    type: "addRules",
    rules,
    behavior: "allow",
    destination,
  }
}

/**
 * The scope an "Always allow" would persist, or `null` when this call cannot be
 * scoped safely. Exported so the menu can render the exact rule and hide the
 * option when there is nothing narrow enough to offer.
 */
export function alwaysAllowRuleContent(
  request: AlwaysAllowRequest,
  toolName = request.toolName
): string | null {
  if (!toolName) return null
  const input = asRecord(request.input)
  // A command wins over a path, as the approval dialog shows it.
  const command = readString(input, "command")

  if (toolName === "Bash") {
    const trimmed = command?.trim()
    if (!trimmed) return null
    // Refuse to derive a rule from a command we cannot bound: substitution can
    // expand to anything, and a chained line is several commands, so a rule
    // named after the first one would authorize the rest too.
    if (/[`]|\$\(/.test(trimmed)) return null
    if (/[;&|\n\r]/.test(trimmed)) return null
    const firstToken = trimmed.split(/\s+/)[0]
    return firstToken ? `${firstToken}:*` : null
  }

  // File tools scope to the exact path that was approved.
  if (command) return null
  const filePath = readString(input, "file_path", "filePath", "path")?.trim()
  return filePath ? filePath : null
}
