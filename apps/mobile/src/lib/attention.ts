import type { PendingRequest } from "@/types/remote"

/** What a chat waits for from the user, like the desktop's attention badge. */
export interface ThreadAttention {
  approvals: number
  questions: number
  plans: number
  total: number
}

export function threadAttention(
  requests: readonly PendingRequest[] | undefined
): ThreadAttention | null {
  if (!requests?.length) return null
  const count = (kind: PendingRequest["kind"]) =>
    requests.filter((request) => request.kind === kind).length
  return {
    approvals: count("approval"),
    questions: count("user-input"),
    plans: count("plan"),
    total: requests.length,
  }
}

/** "1 approval", "2 questions and a plan review". */
export function attentionSummary(attention: ThreadAttention): string {
  const parts = [
    plural(attention.approvals, "approval"),
    plural(attention.questions, "question"),
    attention.plans > 0 ? "a plan review" : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
    : (parts[0] ?? "")
}

function plural(count: number, noun: string): string | null {
  if (count === 0) return null
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
