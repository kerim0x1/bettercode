import { useChatStore } from "@/lib/chat-store"
import { formatProviderActivityLabel } from "@/lib/provider-label"
import { type RuntimeSubagent } from "@/lib/runtime-config"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { respondToApproval } from "@/services/backend/chatApi"
import type { WorkspaceProjectPermissionRule } from "@/services/backend/workspaceApi"
import {
  loadProjectBetterC0deConfigForChat,
  writeProjectBetterC0deConfigForChat,
} from "./mcp-commands"
import {
  escapeMarkdownTableCell,
  type ActiveThreadRef,
} from "./provider-config"
import {
  approvalRecord,
  approvalStringFrom,
  deriveChatPendingApprovals,
  shortApprovalId,
  type ChatPendingApproval,
  type ChatPendingUserInput,
  type ChatPendingUserInputQuestion,
} from "./session-commands"
import { getElectronApi } from "@/services/ipc-facade"

export function buildProjectPermissionsOutput(
  rules: ReadonlyArray<WorkspaceProjectPermissionRule>,
  activeThread: ActiveThreadRef,
  activePermissionLevel: string,
  subagents: ReadonlyArray<RuntimeSubagent> = []
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const agentRows = agentPermissionRows(subagents)
  if (!runtimePath) {
    return "# Project Permissions\n\n> No workspace folder is open."
  }
  if (rules.length === 0 && agentRows.length === 0) {
    return [
      "# Project Permissions\n",
      "> No BetterC0de `permission` config found.",
      "",
      `Active BetterC0de permission preset: \`${activePermissionLevel}\`.`,
    ].join("\n")
  }

  const sections = [
    "# Project Permissions\n",
    `${rules.length} global rule${rules.length === 1 ? "" : "s"} and ${agentRows.length} agent-scoped rule${agentRows.length === 1 ? "" : "s"} configured in \`${runtimePath}\`.\n`,
    `Active BetterC0de permission preset: \`${activePermissionLevel}\`.\n`,
  ]

  if (rules.length > 0) {
    sections.push(
      "## Global Project Rules",
      "",
      "| Permission | Pattern | Action | Source |",
      "|:-----------|:--------|:-------|:-------|",
      ...rules.map(
        (rule) =>
          `| \`${escapeMarkdownTableCell(rule.permission)}\` | \`${escapeMarkdownTableCell(rule.pattern)}\` | **${rule.action}** | \`${escapeMarkdownTableCell(rule.sourcePath)}\` |`
      ),
      ""
    )
  } else {
    sections.push(
      "## Global Project Rules",
      "",
      "> No top-level BetterC0de `permission` config found.",
      ""
    )
  }

  if (agentRows.length > 0) {
    sections.push(
      "## Agent-Scoped Rules",
      "",
      "| Agent | Permission | Pattern | Action | Source |",
      "|:------|:-----------|:--------|:-------|:-------|",
      ...agentRows.map(
        ({ agent, rule }) =>
          `| \`${escapeMarkdownTableCell(agent)}\` | \`${escapeMarkdownTableCell(rule.permission)}\` | \`${escapeMarkdownTableCell(rule.pattern)}\` | **${rule.action}** | \`${escapeMarkdownTableCell(rule.sourcePath)}\` |`
      ),
      "",
      "> Agent-scoped rules come from BetterC0de compatibility project agents and only apply when that agent is selected or injected.",
      ""
    )
  }

  sections.push(
    "> BetterC0de does not let project config silently weaken the active permission preset. Use the composer permission menu or `/autoaccept` for the runtime policy."
  )

  return sections.join("\n")
}

export async function buildProjectPermissionsConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Project Permissions\n\n> Open a workspace folder before using `--config-only`."
  }

  const request = parseProjectPermissionsConfigArgs(args)
  if (!request.permission) {
    return [
      "# Project Permissions",
      "",
      '> Usage: `/permissions --config-only --permission bash --pattern "npm test" --action ask`',
      "> Shorthand usage: `/permissions --config-only --permission edit --action deny`",
      '> Remove usage: `/permissions --config-only --permission bash --pattern "npm test" --remove`',
    ].join("\n")
  }
  if (!request.remove && !request.action) {
    return "# Project Permissions\n\n> Provide `--action ask|allow|deny` or `--remove`."
  }

  const loaded = await loadProjectBetterC0deConfigForChat(
    runtimePath,
    "Project Permissions"
  )
  if ("output" in loaded) return loaded.output
  const permission =
    loaded.config.permission &&
    typeof loaded.config.permission === "object" &&
    !Array.isArray(loaded.config.permission)
      ? { ...(loaded.config.permission as Record<string, unknown>) }
      : {}

  if (request.remove) {
    if (request.pattern) {
      const existing = permission[request.permission]
      if (
        existing &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        const next = { ...(existing as Record<string, unknown>) }
        delete next[request.pattern]
        permission[request.permission] = next
      }
    } else {
      delete permission[request.permission]
    }
  } else if (request.action) {
    if (request.pattern) {
      const existing = permission[request.permission]
      const next =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>) }
          : {}
      next[request.pattern] = request.action
      permission[request.permission] = next
    } else {
      permission[request.permission] = request.action
    }
  }
  loaded.config.permission = permission

  return writeProjectBetterC0deConfigForChat({
    runtimePath,
    config: loaded.config,
    configPath: loaded.configPath,
    existed: loaded.existed,
    heading: "Project Permissions",
    settings: [
      request.pattern
        ? `permission.${request.permission}.${request.pattern}`
        : `permission.${request.permission}`,
    ],
  })
}

interface ProjectPermissionsConfigRequest {
  permission?: string
  pattern?: string
  action?: "ask" | "allow" | "deny"
  remove: boolean
}

function parseProjectPermissionsConfigArgs(
  args: ReadonlyArray<string>
): ProjectPermissionsConfigRequest {
  const request: ProjectPermissionsConfigRequest = { remove: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue
      index += 1
      return args[index] ?? ""
    }
    switch (key) {
      case "--config-only":
        break
      case "--permission":
      case "--tool":
        request.permission = nextValue().trim()
        break
      case "--pattern":
      case "--match":
        request.pattern = nextValue().trim()
        break
      case "--action": {
        const action = parseBetterC0dePermissionAction(nextValue())
        if (action) request.action = action
        break
      }
      case "--ask":
        request.action = "ask"
        break
      case "--allow":
        request.action = "allow"
        break
      case "--deny":
        request.action = "deny"
        break
      case "--remove":
      case "--delete":
        request.remove = true
        break
      default:
        break
    }
  }
  return request
}

function parseBetterC0dePermissionAction(
  value: string
): ProjectPermissionsConfigRequest["action"] {
  const normalized = value.trim().toLowerCase()
  if (normalized === "ask" || normalized === "allow" || normalized === "deny") {
    return normalized
  }
  return undefined
}

export function resolvePendingApprovalReference(
  reference: string | undefined,
  approvals: ReadonlyArray<ChatPendingApproval>
): ChatPendingApproval | null {
  const value = reference?.trim()
  if (!value) return approvals.length === 1 ? approvals[0]! : null

  const indexValue = value.replace(/^#/, "")
  const index = Number(indexValue)
  if (Number.isInteger(index) && index >= 1 && index <= approvals.length) {
    return approvals[index - 1]!
  }

  const normalized = value.toLowerCase()
  const exact = approvals.find(
    (approval) => approval.requestId.toLowerCase() === normalized
  )
  if (exact) return exact

  const prefixMatches = approvals.filter((approval) =>
    approval.requestId.toLowerCase().startsWith(normalized)
  )
  return prefixMatches.length === 1 ? prefixMatches[0]! : null
}

export function buildPendingApprovalsOutput(
  approvals: ReadonlyArray<ChatPendingApproval>,
  options: { hasActiveThread?: boolean } = {}
): string {
  if (options.hasActiveThread === false) {
    return "# Pending Approvals\n\n> No active chat is open."
  }
  if (approvals.length === 0) {
    return "# Pending Approvals\n\n> No pending approval requests for this chat."
  }

  return [
    "# Pending Approvals\n",
    `${approvals.length} request${approvals.length === 1 ? "" : "s"} waiting for a decision.\n`,
    "| # | Provider | Tool | Detail | Request ID |",
    "|:--|:---------|:-----|:-------|:-----------|",
    ...approvals.map((approval, index) => {
      const provider = formatProviderActivityLabel(approval, "Provider")
      const tool = approval.toolName ?? approval.requestKind ?? "tool action"
      const detail = approvalDetail(approval)
      return `| ${index + 1} | ${escapeMarkdownTableCell(provider)} | \`${escapeMarkdownTableCell(tool)}\` | ${escapeMarkdownTableCell(detail)} | \`${escapeMarkdownTableCell(shortApprovalId(approval.requestId))}\` |`
    }),
    "",
    "> Reply with `/approve <#|request-id>` or `/deny <#|request-id>`. If only one request is pending, `/approve` and `/deny` are enough.",
  ].join("\n")
}

export async function buildApprovalDecisionOutput(
  threadId: string | null,
  reference: string | undefined,
  decision: "approve" | "deny"
): Promise<string> {
  if (!threadId) {
    return "# Approval\n\n> No active chat is open."
  }

  const approvals = await pendingApprovalsForThread(threadId)
  const approval = resolvePendingApprovalReference(reference, approvals ?? [])
  if (!approval) {
    return [
      `# Approval ${decision === "approve" ? "Approve" : "Deny"}\n`,
      "> Could not resolve a pending approval request.",
      "",
      buildPendingApprovalsOutput(approvals ?? [], { hasActiveThread: true }),
    ].join("\n")
  }

  try {
    const desktopBridge = getElectronApi()
    if (approval.pluginId && desktopBridge?.pluginSend) {
      await desktopBridge.pluginSend(approval.pluginId, "respondToolApproval", {
        requestId: approval.requestId,
        approved: decision === "approve",
      })
    } else {
      const response = await respondToApproval(
        threadId,
        approval.providerKind,
        approval.requestId,
        decision,
        approval.providerInstanceId ?? null
      )
      if (response.status === "failed") {
        upsertApprovalFailureActivity(
          threadId,
          approval,
          response.error ?? "Provider approval response failed"
        )
        return buildApprovalDecisionFailedOutput(
          decision,
          approval,
          response.error
        )
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    upsertApprovalFailureActivity(threadId, approval, detail)
    return buildApprovalDecisionFailedOutput(decision, approval, detail)
  }

  upsertApprovalResolvedActivity(threadId, approval, decision)
  return [
    `# Approval ${decision === "approve" ? "Approved" : "Denied"}\n`,
    `- Provider: ${formatProviderActivityLabel(approval, "Provider")}`,
    `- Request: \`${approval.requestId}\``,
    `- Tool: \`${approval.toolName ?? approval.requestKind ?? "tool action"}\``,
  ].join("\n")
}

export async function pendingApprovalsForThread(
  threadId: string | null
): Promise<ChatPendingApproval[] | null> {
  if (!threadId) return null
  const store = useChatStore.getState()
  if (!store.activitiesLoadedByThread[threadId]) {
    await store.hydrateThreadActivities(threadId).catch(() => undefined)
  }
  return deriveChatPendingApprovals(
    useChatStore.getState().activitiesByThread[threadId] ?? []
  )
}

function upsertApprovalResolvedActivity(
  threadId: string,
  approval: ChatPendingApproval,
  decision: "approve" | "deny"
): void {
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
}

function upsertApprovalFailureActivity(
  threadId: string,
  approval: ChatPendingApproval,
  detail: string
): void {
  useChatStore.getState().upsertThreadActivity(threadId, {
    id: `${threadId}::provider.approval.respond.failed::${approval.requestId}`,
    threadId,
    kind: "provider.approval.respond.failed",
    tone: "error",
    summary: "Provider approval response failed",
    payload: {
      requestId: approval.requestId,
      providerKind: approval.providerKind,
      providerInstanceId: approval.providerInstanceId,
      detail,
    },
    sequence: Date.now() * 1000,
    createdAt: new Date().toISOString(),
  })
}

function buildApprovalDecisionFailedOutput(
  decision: "approve" | "deny",
  approval: ChatPendingApproval,
  detail: string | undefined
): string {
  return [
    `# Approval ${decision === "approve" ? "Approve" : "Deny"}\n`,
    "> Provider did not accept the approval response.",
    "",
    `- Provider: ${formatProviderActivityLabel(approval, "Provider")}`,
    `- Request: \`${approval.requestId}\``,
    `- Error: ${detail ?? "Provider approval response failed"}`,
  ].join("\n")
}

export function buildUserInputAnswerPayload(
  input: ChatPendingUserInput,
  args: ReadonlyArray<string>
):
  | { ok: true; answers: Record<string, unknown> }
  | { ok: false; error: string } {
  const assignments = new Map<string, string>()
  const positional: string[] = []
  for (const arg of args) {
    const equalsIndex = arg.indexOf("=")
    if (equalsIndex > 0) {
      const key = arg.slice(0, equalsIndex).trim()
      const value = arg.slice(equalsIndex + 1).trim()
      if (key) assignments.set(key, value)
      continue
    }
    positional.push(arg)
  }

  if (assignments.size === 0) {
    if (input.questions.length !== 1) {
      return {
        ok: false,
        error:
          "Multiple questions are pending. Use `question-id=value` pairs so each answer is explicit.",
      }
    }
    const answer = positional.join(" ").trim()
    if (!answer) {
      return { ok: false, error: "No answer text was provided." }
    }
    const question = input.questions[0]!
    return {
      ok: true,
      answers: {
        [question.id]: coercePendingUserInputAnswer(question, answer),
      },
    }
  }

  const answers: Record<string, unknown> = {}
  const missing = new Set(input.questions.map((question) => question.id))
  for (const [rawKey, value] of assignments) {
    const question = resolvePendingUserInputQuestion(rawKey, input.questions)
    const key = question?.id ?? rawKey
    if (!value) {
      return {
        ok: false,
        error: `Answer for \`${rawKey}\` is empty.`,
      }
    }
    answers[key] = coercePendingUserInputAnswer(question, value)
    if (question) missing.delete(question.id)
  }

  if (input.questions.length > 1 && missing.size > 0) {
    return {
      ok: false,
      error: `Missing answer for ${[...missing]
        .map((id) => `\`${id}\``)
        .join(", ")}.`,
    }
  }
  return { ok: true, answers }
}

function resolvePendingUserInputQuestion(
  reference: string,
  questions: ReadonlyArray<ChatPendingUserInputQuestion>
): ChatPendingUserInputQuestion | null {
  const index = Number(reference.replace(/^#/, ""))
  if (Number.isInteger(index) && index >= 1 && index <= questions.length) {
    return questions[index - 1]!
  }
  const normalized = reference.trim().toLowerCase()
  if (!normalized) return null
  const exact = questions.find((question) =>
    [question.id, question.header, question.text]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase() === normalized)
  )
  if (exact) return exact
  const prefixMatches = questions.filter((question) =>
    [question.id, question.header, question.text]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().startsWith(normalized))
  )
  return prefixMatches.length === 1 ? prefixMatches[0]! : null
}

function coercePendingUserInputAnswer(
  question: ChatPendingUserInputQuestion | null,
  value: string
): unknown {
  if (!question?.multiSelect) return value
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function approvalDetail(approval: ChatPendingApproval): string {
  const input = approval.input
  if (typeof input === "string" && input.trim()) {
    return truncateApprovalDetail(input.trim())
  }
  const inputRecord = approvalRecord(input)
  const command =
    approvalStringFrom(inputRecord.command) ??
    approvalStringFrom(inputRecord.cmd) ??
    approvalStringFrom(inputRecord.shellCommand)
  if (command) return truncateApprovalDetail(`$ ${command}`)

  const path =
    approvalStringFrom(inputRecord.file_path) ??
    approvalStringFrom(inputRecord.filePath) ??
    approvalStringFrom(inputRecord.path)
  if (path) return truncateApprovalDetail(path)

  const query =
    approvalStringFrom(inputRecord.pattern) ??
    approvalStringFrom(inputRecord.query) ??
    approvalStringFrom(inputRecord.description)
  if (query) return truncateApprovalDetail(query)

  return approval.requestKind ?? approval.toolName ?? "Approval required"
}

function truncateApprovalDetail(value: string): string {
  return value.length > 96 ? `${value.slice(0, 93)}...` : value
}

function agentPermissionRows(subagents: ReadonlyArray<RuntimeSubagent>): Array<{
  agent: string
  rule: NonNullable<RuntimeSubagent["permissions"]>[number]
}> {
  const rows: Array<{
    agent: string
    rule: NonNullable<RuntimeSubagent["permissions"]>[number]
  }> = []
  for (const agent of subagents) {
    for (const rule of agent.permissions ?? []) {
      rows.push({ agent: agent.id || agent.name, rule })
    }
  }
  return rows
}
