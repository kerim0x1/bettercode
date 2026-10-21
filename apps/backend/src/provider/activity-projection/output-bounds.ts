/**
 * Bounds for the tool output a thread activity carries (RAM-04).
 *
 * The implementation is shared with the renderer, which bounds the tool
 * activities it projects from provider plugin events the same way:
 * `@betterc0de/schema/output-bounds` (`packages/schema/src/output-bounds.ts`).
 * This module keeps the backend's import path; `boundThreadActivity` and
 * `boundToolActivity` take the stored `ThreadActivityProjection` row as is.
 */
export {
  boundApprovalRequestPayload,
  boundThreadActivity,
  boundToolActivity,
  boundToolActivityPayload,
  formatByteSize,
  primaryToolActivityOutput,
  TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS,
  TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES,
  toolOutputByteSize,
  truncateInlineText,
  truncateTextMiddle,
} from "@betterc0de/schema/output-bounds"
export type {
  MiddleTruncation,
  PrimaryToolOutput,
  TruncationLabel,
} from "@betterc0de/schema/output-bounds"
