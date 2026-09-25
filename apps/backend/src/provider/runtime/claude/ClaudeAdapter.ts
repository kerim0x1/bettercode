import { toolNameCategory } from "../tool-name-category"
import { describeClaudeAccount } from "./account-label"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import { CODE_SEARCH_SERVER } from "../../../services/code-search/contracts"
import os from "node:os"
import path from "node:path"
import {
  type ApprovalRequestId,
  type PermissionUpdate,
  type ProviderAdapterShape,
  type ProviderApprovalDecision,
  type ProviderCapabilities,
  applyClaudePromptEffortPrefix,
  permissionUpdateSchema,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  getModelSelectionStringOptionValue,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderModel,
  type ProviderOptionDescriptor,
  type ProviderSkill,
  type ProviderSlashCommand,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderThreadSnapshot,
  type HistoryMessage,
  resolvePromptInjectedEffort,
  type ThreadId,
  type TurnId,
} from "../contracts"
import {
  anthropicContextLabel,
  anthropicModelDisplayName,
  anthropicModelTier,
  anthropicRequiresExplicitThinkingDisplay,
  anthropicSupportsAdaptiveThinking,
  anthropicSupportsExtendedEffort,
  anthropicSupportsFastMode,
  anthropicSupportsOneMillionContext,
  parseAnthropicModelId,
  asRecord,
  readNumber,
  readString,
} from "@betterc0de/schema"
import {
  resolveTurnBooleanOption,
  resolveTurnModelId,
  resolveTurnStringOption,
} from "../providerTurnOptions"
import { buildUnsupportedAttachmentNotice } from "../../attachments"
import {
  pendingRequestKindFromDecisionKind,
  StalePendingProviderRequestError,
} from "../pendingRequestErrors"
import { expandHomePath } from "../../../pathExpansion"
import { sanitizedChildEnvironment } from "../../../security/childEnvironment"
import { terminateProviderChildProcessTree } from "../ChildProcessTermination"
import {
  appendBoundedProcessOutput,
  createBoundedProcessOutput,
  processOutputLimitError,
} from "../BoundedProcessOutput"
import {
  AGENT_TOOLS,
  PLAN_TOOLS,
  NO_TOOLS,
  IMAGEGEN_TOOL_NAME,
  getToolsForMode,
  isImagegenAutoAllowed,
  classifyToolPermission,
  getMaxTurnsForMode,
  createClaudePreToolUseApprovalHook,
  ASK_MODE_DENY_MESSAGE,
  PLAN_MODE_DENY_MESSAGE,
} from "../../shared/chat-mode-tools"
import { listClaudePluginSkills, readClaudeSkill } from "./claudePluginSkills"
import {
  buildImagegenMcpServer,
  IMAGEGEN_MCP_SERVER_NAME,
  IMAGEGEN_SYSTEM_HINT,
  type SdkMcpCapableModule,
} from "./imagegenMcpServer"
import {
  evaluateBetterC0deProjectToolPermission,
  filterToolsForBetterC0deProjectPolicy,
  type ProjectToolFlag,
} from "../../project-tool-policy"
import type { ProjectPermissionRule } from "../../project-permission-rules"
import { permissionUpdatesForClaudeSdk } from "../../agent-permission-updates"
import {
  evaluateSessionRules,
  recordSessionPermissionUpdates,
  clearSessionRules,
} from "../../session-permission-rules"
import {
  listProjectPermissions,
  listProjectTools,
} from "../../../services/workspace"
import type { EventNdjsonLogger } from "../EventNdjsonLogger"
import { prependProviderHistoryForFreshSession } from "../ProviderHistoryPrompt"
import { withDispatchTurnId } from "../dispatchTurnId"
import { claudeSettingSourcesForCwd } from "../../agent-permission-runtime"
import { logger } from "../../../observability/logger"
import {
  classifyTool,
  normalizeGatePermissionLevel,
  type GatePermissionLevel,
} from "../../permissions"

import { buildWindowsCmdArgs } from "../../../security/windowsCommandLine"
import { CliModelSnapshot, cliAccountIdentity } from "../CliModelSnapshot"
interface SdkQuery {
  [Symbol.asyncIterator](): AsyncIterator<unknown>
  initializationResult?: () => Promise<SdkInitializationResult>
  interrupt?: () => Promise<void> | void
  close?: () => Promise<void> | void
  /** Mid-stream permission-mode switch (control request over CLI stdin). */
  setPermissionMode?: (mode: SdkPermissionMode) => Promise<void> | void
}

interface SdkInitializationResult {
  commands?: ReadonlyArray<ClaudeSlashCommand>
  models?: ReadonlyArray<{
    readonly value?: unknown
    readonly displayName?: unknown
    readonly supportsEffort?: unknown
    readonly supportedEffortLevels?: unknown
    readonly supportsAdaptiveThinking?: unknown
    readonly supportsFastMode?: unknown
  }>
  account?: {
    readonly email?: unknown
    readonly subscriptionType?: unknown
    readonly tokenSource?: unknown
  }
}

interface ClaudeSlashCommand {
  name?: unknown
  description?: unknown
  argumentHint?: unknown
}

// Skill-file candidates + reader now live in ./claudePluginSkills (shared
// with the plugin-bundled skill enumeration).

type SdkPermissionResult = {
  behavior: "allow" | "deny"
  input?: unknown
  updatedInput?: unknown
  updatedPermissions?: unknown[]
  reason?: string
  message?: string
}

type SdkSettings = {
  alwaysThinkingEnabled?: boolean
  fastMode?: boolean
}

type SdkThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | {
      type: "enabled"
      budgetTokens?: number
      display?: "summarized" | "omitted"
    }
  | { type: "disabled" }

type SdkPermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"

type SdkSystemPrompt =
  | string
  | {
      type: "preset"
      preset: "claude_code"
      append?: string
    }

interface SdkModule extends SdkMcpCapableModule {
  query(args: {
    prompt: string | AsyncIterable<unknown>
    options?: {
      model?: string
      cwd?: string
      additionalDirectories?: string[]
      mcpServers?: Record<string, unknown>
      env?: NodeJS.ProcessEnv
      abortController?: AbortController
      maxTurns?: number
      tools?: string[]
      disallowedTools?: string[]
      betas?: string[]
      enableFileCheckpointing?: boolean
      effort?: string
      thinking?: SdkThinkingConfig
      permissionMode?: SdkPermissionMode
      settings?: SdkSettings
      settingSources?: ReadonlyArray<"user" | "project" | "local">
      systemPrompt?: SdkSystemPrompt
      persistSession?: boolean
      includePartialMessages?: boolean
      pathToClaudeCodeExecutable?: string
      spawnClaudeCodeProcess?: (options: {
        command: string
        args: string[]
        cwd?: string
        env: NodeJS.ProcessEnv
        signal: AbortSignal
      }) => ChildProcess
      resume?: string
      resumeSessionAt?: string
      sessionId?: string
      stderr?: () => void
      canUseTool?: (
        toolName: string,
        toolInput: unknown,
        opts?: {
          toolUseID?: string
          title?: string
          description?: string
          displayName?: string
          decisionReason?: string
          blockedPath?: string
          suggestions?: unknown[]
          signal?: AbortSignal
        }
      ) => Promise<SdkPermissionResult>
      hooks?: Partial<
        Record<
          string,
          Array<{
            matcher?: string
            hooks: Array<
              (
                input: unknown,
                toolUseID: string | undefined,
                options: { signal: AbortSignal }
              ) => Promise<unknown>
            >
            timeout?: number
          }>
        >
      >
    }
  }): SdkQuery
}

export interface ClaudeAdapterOptions {
  readonly modelCacheDir?: string
  readonly resolveOrchestratorServer?: import("../../../services/orchestrator/mcp").OrchestratorServerResolver
  readonly resolveCodeSearchServer?: import("../../../services/code-search/contracts").CodeSearchServerResolver
  readonly providerInstanceId?: string
  readonly continuationKey?: string
  readonly binaryPath?: string | null
  readonly homePath?: string | null
  readonly environment?: ReadonlyArray<{
    readonly name: string
    readonly value: string
  }>
  readonly customModels?: ReadonlyArray<string>
  readonly nativeEventLogger?: EventNdjsonLogger | null
  readonly getStoredProviderThreadId?: (threadId: string) => string | null
  readonly getStoredProviderResumeCursor?: (threadId: string) => unknown | null
  readonly persistProviderThreadId?: (
    threadId: string,
    providerThreadId: string | null,
    resumeCursor?: unknown | null
  ) => void
}

interface ToolApprovalResolution {
  decision: "approve" | "deny"
  message?: string
  updatedPermissions?: unknown[]
}

interface PlanApprovalResolution {
  decision: "approve" | "deny"
  permissionMode?: "acceptEdits" | "default"
  message?: string
}

/**
 * Mutable per-session permission view. `canUseTool` reads THIS (not closure
 * constants) so a mid-turn `setPermissionMode` affects our own gate too.
 */
interface SessionPermissionState {
  chatMode: string | null
  permissionLevel: string | null
  sdkMode: SdkPermissionMode | null
}

interface SessionContext {
  query: SdkQuery | null
  /** Cancels the current read loop, not the resumable conversation. */
  abort: AbortController
  pendingApprovals: Map<string, (resolution: ToolApprovalResolution) => void>
  pendingUserInputs: Map<string, (answers: Record<string, unknown>) => void>
  pendingPlanApprovals: Map<
    string,
    (resolution: PlanApprovalResolution) => void
  >
  permissionState: SessionPermissionState
  /** Mode requested while no turn was live; consumed by the next sendTurn. */
  queuedPermissionMode: SdkPermissionMode | null
  session: ProviderSession
  baseResumeSessionAts: Array<string | null>
  turns: ClaudeTurnSnapshot[]
  activeTurn: ActiveClaudeTurn | null
  lastAssistantUuid: string | null
  resumeCursorPersistenceError: string | null
  /** Last plan text seen this session — fallback when ExitPlanMode's tool
   *  input carries no plan payload (newer CLI builds sometimes send an
   *  empty input; without this the approval UI shows an empty preview). */
  lastProposedPlanText: string | null
  /**
   * Set by `stopSession` once the session is torn down. An interrupt ladder
   * still running from an earlier `interruptTurn` must not end the turn
   * after that: the hub has already settled it and emitted `session.exited`.
   */
  sessionExited: boolean
  /** CLI process for the live query. Force-completed turns tree-kill it. */
  claudeChild: ChildProcess | null
}

interface ActiveClaudeTurn {
  id: string
  /** Handed to the SDK query; aborting it is what actually kills the CLI. */
  abort: AbortController
  dispatchTurnId: string | null
  /** Settles when the turn's SDK read loop has fully unwound (its finally). */
  settled: Promise<void>
  settle: () => void
  /**
   * Set when `interruptTurn` gave up waiting for the read loop and ended the
   * turn itself; the loop's finally must then not emit a second terminal.
   */
  forceCompleted: boolean
  items: unknown[]
  assistantResumeUuid: string | null
  toolsByBlockIndex: Map<number, ActiveClaudeTool>
  toolsById: Map<string, ActiveClaudeTool>
  capturedProposedPlanKeys: Set<string>
}

interface ActiveClaudeTool {
  id: string
  name: string
  input: Record<string, unknown>
  partialInputJson: string
  started: boolean
}

interface ClaudeTurnSnapshot {
  id: string
  items: unknown[]
  resumeSessionAt: string | null
}

interface ClaudeResumeCursor {
  threadId?: string
  resume?: string
  sessionId?: string
  resumeSessionAt?: string
  turnCount?: number
  turnResumeSessionAts?: Array<string | null>
}

interface ClaudeProviderStatusProbe {
  readonly configured: boolean
  readonly installed: boolean
  readonly version: string | null
  readonly status: "ready" | "warning" | "error"
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated" | "unknown"
    readonly type?: string
    readonly label?: string
    readonly email?: string
  }
  readonly message?: string
}

interface ClaudeCapabilitiesProbe {
  readonly email?: string
  readonly subscriptionType?: string
  readonly tokenSource?: string
  readonly slashCommands: ReadonlyArray<ProviderSlashCommand>
  readonly models: ReadonlyArray<ProviderModel>
}

interface ClaudeCommandProbeResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

const CAPABILITIES: ProviderCapabilities = {
  supportsStreaming: true,
  supportsTools: true,
  supportsApprovals: true,
  supportsResume: true,
  managesOwnLifecycle: true,
}

// Upper bound on turns whose full raw SDK messages (which include complete tool
// outputs — file contents, command output) are retained in memory per session.
// Beyond this the oldest turns' items are dropped, but their resume point is
// preserved by folding it into the base cursor prefix, so continuation is
// unaffected. High enough that no realistic interactive session reaches it; it
// only bounds pathological / long autonomous-loop sessions.
const MAX_RETAINED_TURN_ITEMS = 500

const PROVIDER_METADATA_CACHE_TTL_MS = 30_000
const CLAUDE_MODEL_CACHE_TTL_MS = 15 * 60_000
const CLAUDE_COMMAND_PROBE_TIMEOUT_MS = 8_000
const CLAUDE_PENDING_REQUEST_TIMEOUT_MS = 5 * 60_000
const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111"

const CLAUDE_LOW_TO_HIGH_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High", isDefault: true },
] as const

const CLAUDE_OPUS_47_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High", isDefault: true },
  { id: "max", label: "Max" },
  { id: "ultracode", label: "Ultracode" },
] as const

const CLAUDE_OPUS_OPTIONS = [
  ...CLAUDE_LOW_TO_HIGH_OPTIONS,
  { id: "max", label: "Max" },
  { id: "ultracode", label: "Ultracode" },
] as const

const CLAUDE_SONNET_OPTIONS = [
  ...CLAUDE_LOW_TO_HIGH_OPTIONS,
  { id: "ultracode", label: "Ultracode" },
] as const

function claudeCapabilities(
  input: {
    readonly effortOptions?: ReadonlyArray<{
      readonly id: string
      readonly label: string
      readonly isDefault?: boolean
    }>
    readonly supportsFastMode?: boolean
    readonly supportsThinking?: boolean
    readonly supportsContextWindow?: boolean
  } = {}
): ModelCapabilities {
  const optionDescriptors: ProviderOptionDescriptor[] = []
  if (input.effortOptions && input.effortOptions.length > 0) {
    const defaultEffort = input.effortOptions.find(
      (option) => option.isDefault
    )?.id
    const effortDescriptor: ProviderOptionDescriptor = {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [...input.effortOptions],
      ...(defaultEffort ? { currentValue: defaultEffort } : {}),
      // Not a real API effort level: "ultracode" is the keyword Claude Code
      // reads out of the prompt text to arm multi-agent workflow
      // orchestration. The composer injects the word and the API-side effort
      // falls back to the ladder's default.
      ...(input.effortOptions.some((option) => option.id === "ultracode")
        ? { promptInjectedValues: ["ultracode"] }
        : {}),
    }
    optionDescriptors.push(effortDescriptor)
  }
  if (input.supportsFastMode) {
    optionDescriptors.push({
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    })
  }
  if (input.supportsContextWindow) {
    optionDescriptors.push({
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k", isDefault: true },
        { id: "1m", label: "1M" },
      ],
      currentValue: "200k",
    })
  }
  if (input.supportsThinking) {
    optionDescriptors.push({
      id: "thinking",
      label: "Thinking",
      type: "boolean",
    })
  }
  return { optionDescriptors }
}

function claudeEffortOptionsFor(slug: string): ReadonlyArray<{
  readonly id: string
  readonly label: string
  readonly isDefault?: boolean
}> | null {
  const identity = parseAnthropicModelId(slug)
  if (slug === "claude-opus-5-5")
    return CLAUDE_OPUS_47_OPTIONS.filter(
      (option) => option.id !== "ultracode"
    ).map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.id === "medium" ? { isDefault: true } : {}),
    }))
  // Haiku exposes a thinking toggle rather than an effort ladder.
  if (!identity || identity.family === "haiku") return null
  if (anthropicSupportsExtendedEffort(slug)) return CLAUDE_OPUS_47_OPTIONS
  if (identity.family === "sonnet") {
    return anthropicSupportsAdaptiveThinking(slug)
      ? CLAUDE_SONNET_OPTIONS
      : CLAUDE_LOW_TO_HIGH_OPTIONS
  }
  if (anthropicSupportsAdaptiveThinking(slug)) return CLAUDE_OPUS_OPTIONS
  if (identity.version !== null && identity.version >= 4.5) {
    return [...CLAUDE_LOW_TO_HIGH_OPTIONS, { id: "max", label: "Max" }]
  }
  return CLAUDE_LOW_TO_HIGH_OPTIONS
}

export function buildClaudeProviderModel(
  slug: string,
  displayName?: string | null
): ProviderModel {
  const effortOptions = claudeEffortOptionsFor(slug)
  const knownFamily = Boolean(parseAnthropicModelId(slug))
  return {
    slug,
    name: displayName?.trim() || anthropicModelDisplayName(slug) || slug,
    context: knownFamily ? anthropicContextLabel(slug) : "runtime",
    tier: anthropicModelTier(slug) ?? "Runtime",
    isCustom: false,
    capabilities: claudeCapabilities({
      ...(effortOptions ? { effortOptions } : { supportsThinking: true }),
      supportsFastMode: anthropicSupportsFastMode(slug),
      supportsContextWindow: anthropicSupportsOneMillionContext(slug),
    }),
  }
}

export function buildClaudeModelsFromInitialization(
  models: SdkInitializationResult["models"]
): ProviderModel[] {
  const bySlug = new Map<string, ProviderModel>()
  for (const info of models ?? []) {
    const slug = nonEmptyString(info.value)
    if (!slug || bySlug.has(slug)) continue
    const model = buildClaudeProviderModel(
      slug,
      nonEmptyString(info.displayName)
    )
    const levels = Array.isArray(info.supportedEffortLevels)
      ? info.supportedEffortLevels.filter(
          (level): level is string =>
            typeof level === "string" &&
            ["low", "medium", "high", "xhigh", "max"].includes(level)
        )
      : null
    const hasSdkCapabilities =
      levels !== null ||
      typeof info.supportsEffort === "boolean" ||
      typeof info.supportsAdaptiveThinking === "boolean" ||
      typeof info.supportsFastMode === "boolean"
    const effortOptions =
      levels !== null
        ? levels.map((id) => ({
            id,
            label:
              id === "xhigh" ? "Extra High" : id[0].toUpperCase() + id.slice(1),
            ...(id === "medium" && slug === "claude-opus-5-5"
              ? { isDefault: true }
              : {}),
          }))
        : info.supportsEffort === false
          ? []
          : claudeEffortOptionsFor(slug)
    const capabilities = hasSdkCapabilities
      ? claudeCapabilities({
          ...(effortOptions ? { effortOptions } : {}),
          supportsThinking:
            info.supportsAdaptiveThinking === true &&
            (effortOptions?.length ?? 0) === 0,
          supportsFastMode:
            typeof info.supportsFastMode === "boolean"
              ? info.supportsFastMode
              : anthropicSupportsFastMode(slug),
          supportsContextWindow: anthropicSupportsOneMillionContext(slug),
        })
      : model.capabilities
    bySlug.set(slug, { ...model, capabilities })
  }
  return [...bySlug.values()]
}

function supportsClaudeOpus47(version: string | null | undefined): boolean {
  return version
    ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_7_VERSION) >= 0
    : false
}

function formatClaudeOpus47UpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version"
  return `Claude Code ${versionLabel} is too old for Claude Opus 4.7. Upgrade to v${MINIMUM_CLAUDE_OPUS_4_7_VERSION} or newer to access it.`
}

export function claudeModelSupportsBooleanOption(
  modelId: string,
  optionId: string
): boolean {
  const model = buildClaudeProviderModel(
    normalizeClaudeCapabilityModelId(modelId)
  )
  return Boolean(
    model?.capabilities?.optionDescriptors?.some(
      (descriptor) =>
        descriptor.type === "boolean" && descriptor.id === optionId
    )
  )
}

function normalizeClaudeCapabilityModelId(modelId: string): string {
  return modelId.replace(/\[(?:1m|200k)\]$/i, "").replace(/-(?:1m|200k)$/i, "")
}

const ADAPTIVE_EFFORT_DEFAULT = "high"

function supportsAdaptiveThinking(modelId: string): boolean {
  return anthropicSupportsAdaptiveThinking(modelId)
}

// Mode-based tool selection now lives at `../../shared/chat-mode-tools` so
// the legacy ClaudeAgentAdapter shares one source of truth with this runtime
// adapter. AGENT_TOOLS / PLAN_TOOLS / NO_TOOLS / getToolsForMode /
// classifyToolPermission are imported above.
//
// Suppress unused-import warnings: AGENT_TOOLS / PLAN_TOOLS / NO_TOOLS are
// re-exported indirectly via getToolsForMode but referenced in the codebase
// for legibility in adjacent docs.
void AGENT_TOOLS
void PLAN_TOOLS
void NO_TOOLS

// Trigger Anthropic's 1M-context beta header for Opus/Sonnet variants where
// the user did not explicitly request the 200K profile. Mirrors the plugin's
// `wants1m` heuristic.
export function resolveClaudeRuntimeModelId(modelId: string): string {
  return normalizeClaudeCapabilityModelId(modelId)
}

export function resolveClaudeContextWindow(
  input: ProviderSendTurnInput,
  modelId: string
): "200k" | "1m" | null {
  const selected = getModelSelectionStringOptionValue(
    input.modelSelection,
    "contextWindow"
  )
  if (selected === "200k" || selected === "1m") return selected
  const id = modelId.toLowerCase()
  if (id.endsWith("[200k]") || id.endsWith("-200k")) return "200k"
  if (id.endsWith("[1m]") || id.endsWith("-1m")) return "1m"
  return null
}

function getClaudeModelCapabilities(
  modelId: string,
  discoveredModels: ReadonlyArray<ProviderModel> | null
): ModelCapabilities {
  const normalized = normalizeClaudeCapabilityModelId(modelId)
  return (
    discoveredModels?.find((candidate) => candidate.slug === normalized)
      ?.capabilities ??
    buildClaudeProviderModel(normalized).capabilities ?? {
      optionDescriptors: [],
    }
  )
}

function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  })
  const effortDescriptor = descriptors.find(
    (descriptor) => descriptor.id === "effort"
  )
  const value = getProviderOptionCurrentValue(effortDescriptor)
  return typeof value === "string" ? value : undefined
}

function wantsOneMillionContext(
  modelId: string,
  contextWindow: "200k" | "1m" | null
): boolean {
  if (contextWindow === "200k") return false
  if (contextWindow === "1m") return isOneMillionContextModel(modelId)
  return isOneMillionContextModel(modelId)
}

function isOneMillionContextModel(modelId: string): boolean {
  return anthropicSupportsOneMillionContext(modelId)
}

function readClaudeResumeCursor(cursor: unknown): ClaudeResumeCursor | null {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor))
    return null
  const record = cursor as Record<string, unknown>
  const out: ClaudeResumeCursor = {}
  if (typeof record.threadId === "string" && record.threadId) {
    out.threadId = record.threadId
  }
  if (typeof record.resume === "string" && record.resume) {
    out.resume = record.resume
  }
  if (typeof record.sessionId === "string" && record.sessionId) {
    out.sessionId = record.sessionId
  }
  if (typeof record.resumeSessionAt === "string" && record.resumeSessionAt) {
    out.resumeSessionAt = record.resumeSessionAt
  }
  if (
    typeof record.turnCount === "number" &&
    Number.isInteger(record.turnCount) &&
    record.turnCount >= 0
  ) {
    out.turnCount = record.turnCount
  }
  if (Array.isArray(record.turnResumeSessionAts)) {
    out.turnResumeSessionAts = record.turnResumeSessionAts.map((value) =>
      typeof value === "string" && value ? value : null
    )
  }
  return out
}

function makeClaudeResumeCursor(
  threadId: string,
  providerThreadId: string | null,
  turnCount: number,
  resumeSessionAt: string | null,
  turnResumeSessionAts?: ReadonlyArray<string | null>
): ClaudeResumeCursor {
  const resumeStack = normalizeClaudeResumeStack(
    turnResumeSessionAts,
    turnCount,
    resumeSessionAt
  )
  const lastResumeSessionAt = lastClaudeResumeSessionAt(resumeStack)
  return {
    threadId,
    ...(providerThreadId
      ? { resume: providerThreadId, sessionId: providerThreadId }
      : {}),
    ...(lastResumeSessionAt ? { resumeSessionAt: lastResumeSessionAt } : {}),
    turnCount: resumeStack.length,
    turnResumeSessionAts: resumeStack,
  }
}

function normalizeClaudeResumeStack(
  stack: ReadonlyArray<string | null> | undefined,
  turnCount: number,
  resumeSessionAt: string | null
): Array<string | null> {
  if (stack) {
    return stack.map((value) =>
      typeof value === "string" && value ? value : null
    )
  }
  const safeTurnCount =
    Number.isInteger(turnCount) && turnCount > 0 ? turnCount : 0
  if (safeTurnCount === 0) return []
  const values = Array<string | null>(safeTurnCount).fill(null)
  values[safeTurnCount - 1] = resumeSessionAt
  return values
}

function lastClaudeResumeSessionAt(
  stack: ReadonlyArray<string | null>
): string | null {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const value = stack[index]
    if (value) return value
  }
  return null
}

function buildSystemPromptOption(
  systemInstruction: string | null | undefined
): SdkSystemPrompt | undefined {
  const append = systemInstruction?.trim()
  if (!append) return undefined
  return {
    type: "preset",
    preset: "claude_code",
    append,
  }
}

function buildPlanModePrompt(message: string): string {
  return [
    "<betterc0de_plan_mode_request>",
    "The BetterC0de Plan toggle is active for this turn.",
    "",
    "Hard requirements:",
    "- Do not implement the request.",
    "- Do not create, edit, delete, move, or write files.",
    "- Do not output implementation code blocks as the answer.",
    "- If clarification is needed, use AskUserQuestion.",
    "- When a plan is ready, return only the plan for the BetterC0de plan UI.",
    "- Prefer streaming the plan as a single <proposed_plan>...</proposed_plan> block.",
    "- If ExitPlanMode is available and appropriate, use it with the final plan markdown and stop.",
    "",
    "User request:",
    message,
    "</betterc0de_plan_mode_request>",
  ].join("\n")
}

function resolveClaudePermissionMode(
  chatMode: string | null,
  permissionLevel: string | null
): SdkPermissionMode | null {
  if (chatMode === "plan") return "plan"
  if (chatMode === "ask" || chatMode === "security") return null
  const level = normalizeGatePermissionLevel(permissionLevel)
  switch (level) {
    case "allow-edits":
      return "acceptEdits"
    case "bypass":
      // Keep the SDK in default mode so every tool still crosses the
      // BetterC0de PreToolUse/canUseTool boundary. Full access is represented
      // by our own permission state, not by an SDK escape hatch.
      return "default"
    case "default":
      // Claude-native mode: the CLI's own permission engine decides; every
      // canUseTool callback goes straight to the user approval gate.
      return "default"
    default:
      return null
  }
}

/**
 * Validate the SDK's `suggestions` (PermissionUpdate[]) before forwarding to
 * the renderer; invalid entries are dropped rather than failing the request.
 */
function parsePermissionSuggestions(
  raw: unknown
): PermissionUpdate[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const parsed: PermissionUpdate[] = []
  for (const entry of raw) {
    const result = permissionUpdateSchema.safeParse(entry)
    if (result.success) parsed.push(result.data)
  }
  return parsed.length > 0 ? parsed : undefined
}

/** Inverse mapping used when a raw SDK mode arrives via setPermissionMode. */
function permissionLevelFromSdkMode(mode: SdkPermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return "allow-edits"
    case "bypassPermissions":
      return "bypass"
    case "plan":
      return "plan"
    default:
      return "default"
  }
}

function extractProposedPlanBlock(text: string): string | null {
  const match = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i)
  const plan = match?.[1]?.trim()
  return plan || null
}

function isHaiku(modelId: string): boolean {
  return /haiku/i.test(modelId)
}

/**
 * Claude Opus 4.7 / Sonnet 4.7 (and any future 4.7+ release) changed the
 * `thinking.display` default from "summarized" to "omitted". Without an
 * explicit opt-in to "summarized", the API returns no thinking blocks at
 * all — the wire shape is identical to a non-thinking turn. 4.6 and earlier
 * are unaffected and intentionally NOT matched here so we don't change
 * their observed thinking format.
 */
function requiresExplicitDisplaySummarized(modelId: string): boolean {
  return anthropicRequiresExplicitThinkingDisplay(modelId)
}

type ResolvedOptions = {
  effort?: string
  thinking?: SdkThinkingConfig
  settings?: SdkSettings
}

/**
 * Mirrors the verified reference adapter's Claude option mapping. Pass only
 * the fields needed for the common case:
 *   - Adaptive-thinking models (Opus/Sonnet 4.6+) → `effort` only. The SDK
 *     derives thinking from that.
 *   - Haiku 4.5 → `settings.alwaysThinkingEnabled: true` (Haiku exposes the
 *     boolean toggle, no adaptive mode).
 *
 * 4.7-specific opt-in: Anthropic flipped `thinking.display` default to
 * "omitted" on Opus/Sonnet 4.7. Override to "summarized" so reasoning
 * blocks come back at all. 4.6 and earlier intentionally stay with the
 * minimal shape — no behavior change there.
 */
function resolveOptions(
  effort: string | null | undefined,
  modelId: string,
  fastMode?: boolean | null
): ResolvedOptions {
  const out: ResolvedOptions = {}
  if (supportsAdaptiveThinking(modelId)) {
    out.effort =
      mapAdaptiveEffort(effort, modelId) ??
      (modelId === "claude-opus-5-5" ? "medium" : ADAPTIVE_EFFORT_DEFAULT)
    if (requiresExplicitDisplaySummarized(modelId)) {
      out.thinking = { type: "adaptive", display: "summarized" }
    }
  }
  if (isHaiku(modelId)) {
    out.settings = { alwaysThinkingEnabled: true }
  }
  // Claude CLI Fast Mode — wires `settings.fastMode: true` into the
  // ClaudeQueryOptions block. This matches the verified reference behavior.
  // Anthropic's
  // SDK type does not formally expose this field but the underlying CLI
  // accepts it; compatible Claude binaries
  // route the turn through priority compute.
  if (fastMode === true) {
    out.settings = { ...(out.settings ?? {}), fastMode: true }
  }
  return out
}

function mapAdaptiveEffort(
  raw: string | null | undefined,
  modelId: string
): string | undefined {
  if (!raw) return undefined
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "")
  if (key === "low" || key === "medium" || key === "high") return key
  // Normalize Claude's Opus 4.7 `xhigh` capability to the SDK/CLI
  // `max` effort. `ultrathink` is still handled as a prompt-injected mode.
  if (key === "xhigh" || key === "extrahigh")
    return modelId === "claude-opus-5-5" ? "xhigh" : "max"
  if (key === "max" || key === "ultra" || key === "ultrathink") {
    return "max"
  }
  return undefined
}

/**
 * Wall-clock budget for the whole interrupt ladder when the caller passes
 * none. It matches the hub's default settlement timeout: the hub gives up on
 * an interrupt after that long and hard-stops the session, so a ladder that
 * ran longer only produced a late `turn.aborted` behind `session.exited`.
 */
const CLAUDE_INTERRUPT_BUDGET_MS = 5_000
/**
 * Cumulative share of the budget by which each rung must have ended:
 * `interrupt()` plus the wait for the read loop, then `close()`, then abort.
 * The remaining fifth is headroom for force-completion and the hub's own
 * bookkeeping, so the whole ladder settles inside the budget.
 */
const CLAUDE_INTERRUPT_RUNG_DEADLINES = {
  interrupt: 0.4,
  close: 0.6,
  abort: 0.8,
} as const

export interface ClaudeInterruptOptions {
  /** Total time the ladder may take before the turn is force-completed. */
  readonly interruptBudgetMs?: number
}

function boundedInterruptBudget(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0
    ? Math.floor(value as number)
    : CLAUDE_INTERRUPT_BUDGET_MS
}

/** A failed probe is retried after this, not pinned for the success TTL. */
const PROVIDER_METADATA_ERROR_TTL_MS = 10_000

function isClaudeMetadataCacheFresh(
  cache: { readonly checkedAt: number; readonly error?: true },
  now = Date.now()
): boolean {
  return (
    now - cache.checkedAt <
    (cache.error
      ? PROVIDER_METADATA_ERROR_TTL_MS
      : PROVIDER_METADATA_CACHE_TTL_MS)
  )
}

/**
 * Await `operation()` but never longer than `timeoutMs`. Resolves true when the
 * operation settled in time, false on timeout or failure — the caller escalates
 * rather than propagating, because an interrupt that throws is still an
 * interrupt the user asked for.
 */
async function withInterruptDeadline(
  operation: () => Promise<void> | void | undefined,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      Promise.resolve(operation()).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      }),
    ])
    return result
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** True when `settled` resolved within `timeoutMs`; false on the deadline. */
async function settledWithin(
  settled: Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function eventBase(threadId: string) {
  return {
    threadId,
    providerKind: "claude" as const,
    eventId: randomUUID(),
    at: Date.now(),
  }
}

function makeClaudeToolStartedEvent(
  threadId: string,
  turnId: string,
  tool: ActiveClaudeTool
): ProviderRuntimeEvent {
  return {
    ...eventBase(threadId),
    type: "tool.started",
    toolId: tool.id,
    toolName: tool.name,
    turnId,
    input: tool.input,
    title: claudeToolTitle(tool.name),
  }
}

function makeClaudeToolUpdatedEvent(
  threadId: string,
  turnId: string,
  tool: ActiveClaudeTool
): ProviderRuntimeEvent {
  const detail = summarizeClaudeToolInput(tool.name, tool.input)
  return {
    ...eventBase(threadId),
    type: "item.updated",
    itemId: tool.id,
    kind: `tool:${tool.name}`,
    turnId,
    payload: {
      itemType: claudeToolItemType(tool.name),
      status: "inProgress",
      title: claudeToolTitle(tool.name),
      input: tool.input,
      ...(detail ? { detail } : {}),
      data: {
        toolName: tool.name,
        input: tool.input,
      },
    },
  }
}

function readClaudeToolResult(block: Record<string, unknown>): unknown {
  const content = block.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") return entry
        if (entry && typeof entry === "object") {
          const text = (entry as Record<string, unknown>).text
          if (typeof text === "string") return text
        }
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return block
}

function readClaudeToolError(block: Record<string, unknown>): string | null {
  const isError = block.is_error ?? block.isError
  if (isError === true) {
    const text = readClaudeToolResult(block)
    return typeof text === "string" && text ? text : "Tool failed"
  }
  const error = block.error
  if (typeof error === "string" && error) return error
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message
    if (typeof message === "string" && message) return message
  }
  return null
}

function isClaudeToolBlockType(type: string | undefined): boolean {
  return (
    type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use"
  )
}

function readClaudeToolInput(value: unknown): Record<string, unknown> {
  return asRecord(value)
}

function tryParseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return asRecord(parsed)
  } catch {
    return null
  }
}

function claudeToolItemType(toolName: string): string {
  return toolNameCategory(toolName, "claude")
}

function claudeToolTitle(toolName: string): string {
  switch (claudeToolItemType(toolName)) {
    case "collab_agent_tool_call":
      return "Subagent task"
    case "command_execution":
      return "Command run"
    case "file_change":
      return "File change"
    case "mcp_tool_call":
      return "MCP tool call"
    case "web_search":
      return "Search"
    default:
      return "Tool call"
  }
}

function summarizeClaudeToolInput(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  const command = readString(input, "command", "cmd")
  if (command) return `${toolName}: ${command.slice(0, 400)}`

  if (claudeToolItemType(toolName) === "collab_agent_tool_call") {
    const description = readString(input, "description")
    const prompt = readString(input, "prompt")
    const subagentType = readString(input, "subagent_type", "subagentType")
    const label = description ?? (prompt ? prompt.slice(0, 200) : undefined)
    if (label) return subagentType ? `${subagentType}: ${label}` : label
  }

  const path = readString(input, "path", "file_path", "filePath")
  if (path) return `${toolName}: ${path}`
  return undefined
}

function claudeNativeMessageType(value: unknown): string | undefined {
  return readString(asRecord(value), "type")
}

function claudeNativeMethod(message: unknown): string {
  const messageType = claudeNativeMessageType(message) ?? "unknown"
  const record = asRecord(message)
  const subtype = readString(record, "subtype")
  if (subtype) return `claude/${messageType}/${subtype}`

  if (messageType === "stream_event") {
    const event = asRecord(record.event)
    const streamType = claudeNativeMessageType(event)
    if (streamType) {
      if (streamType === "content_block_delta") {
        const deltaType = claudeNativeMessageType(asRecord(event.delta))
        if (deltaType) {
          return `claude/${messageType}/${streamType}/${deltaType}`
        }
      }
      return `claude/${messageType}/${streamType}`
    }
  }

  return `claude/${messageType}`
}

function claudeNativeItemId(message: unknown): string | undefined {
  const record = asRecord(message)
  const type = claudeNativeMessageType(record)
  if (type === "assistant") {
    return readString(asRecord(record.message), "id")
  }
  if (type === "stream_event") {
    const event = asRecord(record.event)
    if (claudeNativeMessageType(event) !== "content_block_start") {
      return undefined
    }
    return readString(asRecord(event.content_block), "id")
  }
  return undefined
}

function normalizeHookOutcome(
  value: unknown
): "success" | "error" | "cancelled" {
  return value === "error" || value === "cancelled" ? value : "success"
}

function normalizeTaskStatus(
  value: unknown
): "completed" | "failed" | "stopped" {
  if (value === "failed" || value === "stopped") return value
  if (value === "error") return "failed"
  if (value === "cancelled" || value === "canceled" || value === "interrupted")
    return "stopped"
  return "completed"
}

function isTodoTool(toolName: string | undefined): boolean {
  return (toolName ?? "").toLowerCase() === "todowrite"
}

function extractPlanStepsFromTodoInput(
  input: unknown
): Array<{ step: string; status: string }> {
  const todos = asRecord(input).todos
  if (!Array.isArray(todos)) return []
  return todos
    .map((todo) => {
      const record = asRecord(todo)
      const step =
        readString(record, "content", "text", "task") ??
        readString(record, "description")
      if (!step) return null
      const status = readString(record, "status") ?? "pending"
      return {
        step,
        status:
          status === "in_progress" || status === "inProgress"
            ? "in_progress"
            : status === "completed"
              ? "completed"
              : "pending",
      }
    })
    .filter(
      (entry): entry is { step: string; status: string } => entry !== null
    )
}

function translateClaudeSystemMessage(
  threadId: string,
  msg: Record<string, unknown>,
  turnId: string
): ProviderRuntimeEvent[] {
  const subtype = readString(msg, "subtype") ?? ""
  const base = { ...eventBase(threadId), turnId }
  switch (subtype) {
    case "hook_started":
      return [
        {
          ...base,
          type: "hook.started",
          payload: {
            hookId: readString(msg, "hook_id", "hookId") ?? randomUUID(),
            hookName: readString(msg, "hook_name", "hookName") ?? "hook",
            hookEvent: readString(msg, "hook_event", "hookEvent") ?? "unknown",
          },
        },
      ]
    case "hook_progress":
      return [
        {
          ...base,
          type: "hook.progress",
          payload: {
            hookId: readString(msg, "hook_id", "hookId") ?? randomUUID(),
            ...(readString(msg, "output")
              ? { output: readString(msg, "output") }
              : {}),
            ...(readString(msg, "stdout")
              ? { stdout: readString(msg, "stdout") }
              : {}),
            ...(readString(msg, "stderr")
              ? { stderr: readString(msg, "stderr") }
              : {}),
          },
        },
      ]
    case "hook_response":
      return [
        {
          ...base,
          type: "hook.completed",
          payload: {
            hookId: readString(msg, "hook_id", "hookId") ?? randomUUID(),
            outcome: normalizeHookOutcome(msg.outcome),
            ...(readString(msg, "output")
              ? { output: readString(msg, "output") }
              : {}),
            ...(readString(msg, "stdout")
              ? { stdout: readString(msg, "stdout") }
              : {}),
            ...(readString(msg, "stderr")
              ? { stderr: readString(msg, "stderr") }
              : {}),
            ...(readNumber(msg, "exit_code", "exitCode") !== undefined
              ? { exitCode: readNumber(msg, "exit_code", "exitCode") }
              : {}),
          },
        },
      ]
    case "task_started":
      return [
        {
          ...base,
          type: "task.started",
          payload: {
            taskId: readString(msg, "task_id", "taskId") ?? randomUUID(),
            ...(readString(msg, "description")
              ? { description: readString(msg, "description") }
              : {}),
            ...(readString(msg, "task_type", "taskType")
              ? { taskType: readString(msg, "task_type", "taskType") }
              : {}),
          },
        },
      ]
    case "task_progress": {
      const description =
        readString(msg, "description") ??
        readString(msg, "summary") ??
        "Working"
      return [
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId: readString(msg, "task_id", "taskId") ?? randomUUID(),
            description,
            ...(readString(msg, "summary")
              ? { summary: readString(msg, "summary") }
              : {}),
            ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
            ...(readString(msg, "last_tool_name", "lastToolName")
              ? {
                  lastToolName: readString(
                    msg,
                    "last_tool_name",
                    "lastToolName"
                  ),
                }
              : {}),
          },
        },
      ]
    }
    case "task_notification":
      return [
        {
          ...base,
          type: "task.completed",
          payload: {
            taskId: readString(msg, "task_id", "taskId") ?? randomUUID(),
            status: normalizeTaskStatus(msg.status),
            ...(readString(msg, "summary")
              ? { summary: readString(msg, "summary") }
              : {}),
            ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
          },
        },
      ]
    case "files_persisted": {
      const files = Array.isArray(msg.files)
        ? msg.files
            .map((entry) => {
              const file = asRecord(entry)
              const filename = readString(file, "filename")
              const fileId = readString(file, "file_id", "fileId")
              return filename && fileId ? { filename, fileId } : null
            })
            .filter(
              (entry): entry is { filename: string; fileId: string } =>
                entry !== null
            )
        : []
      const failed = Array.isArray(msg.failed)
        ? msg.failed
            .map((entry) => {
              const failure = asRecord(entry)
              const filename = readString(failure, "filename")
              const error = readString(failure, "error")
              return filename && error ? { filename, error } : null
            })
            .filter(
              (entry): entry is { filename: string; error: string } =>
                entry !== null
            )
        : []
      return [
        {
          ...base,
          type: "files.persisted",
          payload: {
            files,
            ...(failed.length > 0 ? { failed } : {}),
          },
        },
      ]
    }
    default:
      return []
  }
}

function normalizeClaudeUserInputQuestions(input: unknown): Array<{
  id: string
  header: string
  question: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}> {
  const rawQuestions = asRecord(input).questions
  if (!Array.isArray(rawQuestions)) return []
  return rawQuestions.map((entry, index) => {
    const record = asRecord(entry)
    const question =
      typeof record.question === "string"
        ? record.question
        : typeof record.text === "string"
          ? record.text
          : ""
    const header =
      typeof record.header === "string" && record.header.length > 0
        ? record.header
        : question || `Question ${index + 1}`
    const id =
      typeof record.id === "string" && record.id.length > 0
        ? record.id
        : question || header
    const options = Array.isArray(record.options)
      ? record.options
          .map((option) => {
            if (typeof option === "string") return { label: option }
            const opt = asRecord(option)
            const label = typeof opt.label === "string" ? opt.label : ""
            if (!label) return null
            const description =
              typeof opt.description === "string" ? opt.description : undefined
            return description ? { label, description } : { label }
          })
          .filter(
            (option): option is { label: string; description?: string } =>
              option !== null
          )
      : []
    return {
      id,
      header,
      question,
      options,
      ...(typeof record.multiSelect === "boolean"
        ? { multiSelect: record.multiSelect }
        : {}),
    }
  })
}

function extractExitPlanModePlan(input: unknown): string | null {
  const record = asRecord(input)
  for (const key of ["plan", "markdown", "content", "text"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    // Newer CLI builds occasionally nest the plan ({ plan: { markdown } })
    // or send it as a list of steps — flatten both instead of dropping
    // the plan on the floor (which surfaced as an empty approval preview).
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = extractExitPlanModePlan(value)
      if (nested) return nested
    }
    if (Array.isArray(value)) {
      const joined = value
        .map((entry) =>
          typeof entry === "string"
            ? entry
            : (extractExitPlanModePlan(entry) ?? "")
        )
        .filter((line) => line.trim().length > 0)
        .join("\n")
      if (joined.trim()) return joined.trim()
    }
  }
  return null
}

function proposedPlanCaptureKey(input: {
  readonly toolUseId?: string | null
  readonly planMarkdown: string
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`
}

function markProposedPlanCaptured(
  ctx: SessionContext | undefined,
  input: {
    readonly toolUseId?: string | null
    readonly planMarkdown: string
  }
): boolean {
  const activeTurn = ctx?.activeTurn
  if (!activeTurn) return true
  const key = proposedPlanCaptureKey(input)
  if (activeTurn.capturedProposedPlanKeys.has(key)) return false
  activeTurn.capturedProposedPlanKeys.add(key)
  return true
}

/** One SDK message on its way through `translateSdkMessage`. */
interface SdkMessageTranslation {
  readonly threadId: string
  /** The raw message, for readers that re-parse it. */
  readonly msg: unknown
  readonly m: {
    type?: string
    message?: {
      content?: Array<Record<string, unknown>>
      usage?: Record<string, number>
    }
    result?: Record<string, unknown>
    subtype?: string
    event?: Record<string, unknown>
  }
  readonly turnId: string
  readonly isPlanMode: boolean
  readonly ctx?: SessionContext
  /** Events accumulate here in arrival order. */
  readonly out: ProviderRuntimeEvent[]
}

export class ClaudeAdapter implements ProviderAdapterShape {
  readonly provider = "claude" as const
  readonly displayName = "Claude"
  readonly capabilities = CAPABILITIES

  private readonly sessions = new Map<string, SessionContext>()
  private readonly bus = new EventEmitter()
  private sdkCache: SdkModule | null = null
  private sdkLoadError: string | null = null
  private metadataStopping = false
  private readonly metadataWork = new Set<Promise<unknown>>()
  private readonly metadataQueries = new Set<SdkQuery>()
  private readonly failedMetadataQueries = new Set<SdkQuery>()
  private readonly metadataQueryCleanup = new Map<SdkQuery, Promise<void>>()
  private readonly metadataChildren = new Set<ChildProcess>()
  private readonly metadataChildCleanup = new Map<ChildProcess, Promise<void>>()
  private readonly claudeChildCleanup = new Map<ChildProcess, Promise<void>>()
  private readonly skillsCache = new Map<
    string,
    {
      readonly checkedAt: number
      readonly skills: ReadonlyArray<ProviderSkill>
    }
  >()
  private readonly slashCommandsCache = new Map<
    string,
    {
      readonly checkedAt: number
      readonly commands: ReadonlyArray<ProviderSlashCommand>
      /** Recorded after a probe error; retried after the short TTL. */
      readonly error?: true
    }
  >()
  private modelsCache: {
    readonly checkedAt: number
    readonly models: ReadonlyArray<ProviderModel>
  } | null = null
  private modelsInFlight: Promise<ReadonlyArray<ProviderModel>> | null = null
  private readonly modelSnapshot: CliModelSnapshot
  private lastKnownModels: ReadonlyArray<ProviderModel> | null = null
  private lastKnownAccount: string | null = null
  private statusCache: {
    readonly checkedAt: number
    readonly status: ClaudeProviderStatusProbe
    /** Recorded after a probe error; retried after the short TTL. */
    readonly error?: true
  } | null = null

  constructor(private readonly options: ClaudeAdapterOptions = {}) {
    this.modelSnapshot = new CliModelSnapshot(options.modelCacheDir)
  }

  isConfigured(): boolean {
    // Installation and authentication are verified by the bounded async
    // capability probe. Turn admission must not touch disk or spawn helpers.
    return isClaudeBinaryRunnable(this.claudeBinaryPath())
  }

  probeStatus(
    input: { readonly cwd?: string | null } = {}
  ): Promise<ClaudeProviderStatusProbe> {
    return this.runMetadataWork(() => this.probeStatusUnderAdmission(input))
  }

  private async probeStatusUnderAdmission(input: {
    readonly cwd?: string | null
  }): Promise<ClaudeProviderStatusProbe> {
    if (this.statusCache && isClaudeMetadataCacheFresh(this.statusCache)) {
      return this.statusCache.status
    }

    const binaryPath = this.claudeBinaryPath()
    if (!(await isClaudeBinaryRunnableAsync(binaryPath))) {
      return this.cacheStatus({
        configured: false,
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI (`claude`) is not installed or not on PATH.",
      })
    }
    try {
      const versionProbe = await runClaudeCommandProbe({
        binaryPath,
        args: ["--version"],
        cwd: normalizeCwd(input.cwd),
        env: this.makeEnvironment(),
        timeoutMs: CLAUDE_COMMAND_PROBE_TIMEOUT_MS,
        retainFailedCleanup: (child) => {
          this.metadataChildren.add(child)
        },
      })
      const version = parseClaudeCliVersion(
        `${versionProbe.stdout}\n${versionProbe.stderr}`
      )

      if (versionProbe.code !== 0) {
        return this.cacheStatus({
          configured: false,
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Claude Agent CLI is installed but failed to run.",
        })
      }

      const capabilities = await this.probeCapabilities(normalizeCwd(input.cwd))
      const upgradeMessage = supportsClaudeOpus47(version)
        ? undefined
        : formatClaudeOpus47UpgradeMessage(version)
      if (!capabilities) {
        // A missing SDK is a stable fact and gets the normal TTL; only a
        // probe that spawned but timed out or failed is worth retrying soon.
        return this.cacheStatus(
          {
            configured: true,
            installed: true,
            version,
            status: "warning",
            auth: { status: "unknown" },
            message:
              "Could not verify Claude authentication status from initialization result.",
          },
          { transient: this.sdkCache !== null }
        )
      }

      const authMetadata = describeClaudeAccount({
        subscriptionType: capabilities.subscriptionType,
        authMethod: capabilities.tokenSource,
      })
      return this.cacheStatus({
        configured: true,
        installed: true,
        version,
        status: "ready",
        auth: {
          status: "authenticated",
          ...(capabilities.email ? { email: capabilities.email } : {}),
          ...(authMetadata ? authMetadata : {}),
        },
        ...(upgradeMessage ? { message: upgradeMessage } : {}),
      })
    } catch (error) {
      logger.warn({ err: error }, "claude provider status probe failed")
      const missing = isCommandMissingError(error)
      // "Not installed" is stable: re-probing it every 10 s only spawns
      // helpers for nothing. A timeout or spawn error is what is transient.
      return this.cacheStatus(
        {
          configured: false,
          installed: !missing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: missing
            ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
            : "Failed to execute Claude Agent CLI health check.",
        },
        { transient: !missing }
      )
    }
  }

  async availableModels(): Promise<ReadonlyArray<ProviderModel>> {
    const account = this.modelAccountIdentity()
    if (this.lastKnownAccount !== account) {
      this.lastKnownAccount = account
      this.lastKnownModels = this.modelSnapshot.read(
        "claude",
        this.options.providerInstanceId ?? "claude",
        account
      )
      this.modelsCache = null
      this.modelsInFlight = null
    }
    if (
      this.modelsCache &&
      Date.now() - this.modelsCache.checkedAt < CLAUDE_MODEL_CACHE_TTL_MS
    )
      return mergeCustomModels(
        this.modelsCache.models,
        this.options.customModels ?? []
      )
    if (this.modelsInFlight) return this.modelsInFlight
    const probe = this.runMetadataWork(async () => {
      const capabilities = await this.probeCapabilities(normalizeCwd(null))
      if (capabilities) return capabilities.models
      return this.lastKnownModels ?? []
    })
      .then((models) =>
        mergeCustomModels(models, this.options.customModels ?? [])
      )
      .finally(() => {
        this.modelsInFlight = null
      })
    this.modelsInFlight = probe
    return probe
  }

  invalidateMetadata(input: { readonly cwd?: string | null } = {}): void {
    this.modelsCache = null
    if (input.cwd === undefined) {
      this.skillsCache.clear()
      this.slashCommandsCache.clear()
      return
    }
    const cwd = normalizeCwd(input.cwd)
    this.skillsCache.delete(cwd)
    this.slashCommandsCache.delete(cwd)
  }

  async availableSkills(
    input: { readonly cwd?: string | null; readonly force?: boolean } = {}
  ): Promise<ReadonlyArray<ProviderSkill>> {
    if (!this.isConfigured()) return []
    const cwd = normalizeCwd(input.cwd)
    const cached = this.skillsCache.get(cwd)
    if (
      !input.force &&
      cached &&
      Date.now() - cached.checkedAt < PROVIDER_METADATA_CACHE_TTL_MS
    ) {
      return cached.skills
    }
    const skills = await this.fetchSkills()
    this.skillsCache.set(cwd, { checkedAt: Date.now(), skills })
    return skills
  }

  availableSlashCommands(
    input: { readonly cwd?: string | null; readonly force?: boolean } = {}
  ): Promise<ReadonlyArray<ProviderSlashCommand>> {
    return this.runMetadataWork(() =>
      this.availableSlashCommandsUnderAdmission(input)
    )
  }

  private async availableSlashCommandsUnderAdmission(input: {
    readonly cwd?: string | null
    readonly force?: boolean
  }): Promise<ReadonlyArray<ProviderSlashCommand>> {
    if (!this.isConfigured()) return []
    const cwd = normalizeCwd(input.cwd)
    const cached = this.slashCommandsCache.get(cwd)
    if (!input.force && cached && isClaudeMetadataCacheFresh(cached)) {
      return cached.commands
    }
    const commands = await this.fetchSlashCommands(cwd)
    this.slashCommandsCache.set(cwd, {
      checkedAt: Date.now(),
      commands: commands ?? [],
      ...(commands === null ? { error: true as const } : {}),
    })
    return commands ?? []
  }

  private runMetadataWork<T>(work: () => Promise<T>): Promise<T> {
    if (this.metadataStopping)
      return Promise.reject(new Error("Claude metadata is stopping"))
    const pending = (async () => {
      await this.retryMetadataCleanup()
      if (this.metadataStopping) throw new Error("Claude metadata is stopping")
      return work()
    })()
    this.metadataWork.add(pending)
    void pending.then(
      () => this.metadataWork.delete(pending),
      () => this.metadataWork.delete(pending)
    )
    return pending
  }

  private async closeMetadataQuery(query: SdkQuery): Promise<void> {
    let pending = this.metadataQueryCleanup.get(query)
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        if (query.close) await query.close()
        else if (query.interrupt) await query.interrupt()
        else throw new Error("Claude metadata query has no cleanup operation")
        this.metadataQueries.delete(query)
        this.failedMetadataQueries.delete(query)
      })
      this.metadataQueryCleanup.set(query, pending)
      void pending.then(
        () => this.metadataQueryCleanup.delete(query),
        () => this.metadataQueryCleanup.delete(query)
      )
    }
    await withTimeout(pending, CLAUDE_COMMAND_PROBE_TIMEOUT_MS)
  }

  private async finishMetadataQuery(query: SdkQuery): Promise<void> {
    try {
      await this.closeMetadataQuery(query)
    } catch (error) {
      this.failedMetadataQueries.add(query)
      throw error
    }
  }

  private async closeMetadataChild(child: ChildProcess): Promise<void> {
    let pending = this.metadataChildCleanup.get(child)
    if (!pending) {
      if (
        process.platform === "win32" &&
        (child.exitCode != null || child.signalCode != null)
      ) {
        // The exited root can no longer safely identify descendants from the
        // failed attempt. Keep the resource quarantined instead of treating
        // the generic helper's already-exited fast path as confirmed cleanup.
        throw new Error(
          "Claude metadata descendant cleanup remains unconfirmed after the Windows root exited"
        )
      }
      pending = terminateProviderChildProcessTree(child).then(() => {
        this.metadataChildren.delete(child)
      })
      this.metadataChildCleanup.set(child, pending)
      void pending.then(
        () => this.metadataChildCleanup.delete(child),
        () => this.metadataChildCleanup.delete(child)
      )
    }
    await pending
  }

  private async retryMetadataCleanup(): Promise<void> {
    // Only failed or timed-out cleanup remains after a probe settles. Active
    // queries are owned by their still-running probe and must not be closed here.
    const results = await Promise.allSettled([
      ...Array.from(this.metadataQueries)
        .filter((query) => this.failedMetadataQueries.has(query))
        .map((query) => this.closeMetadataQuery(query)),
      ...Array.from(this.metadataChildren).map((child) =>
        this.closeMetadataChild(child)
      ),
    ])
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length === 1) throw failures[0]
    if (failures.length > 0)
      throw new AggregateError(failures, "Claude metadata cleanup failed")
  }

  private cacheStatus(
    status: ClaudeProviderStatusProbe,
    options: { readonly transient?: boolean } = {}
  ): ClaudeProviderStatusProbe {
    this.statusCache = {
      checkedAt: Date.now(),
      status,
      ...(options.transient ? { error: true as const } : {}),
    }
    return status
  }

  private async probeCapabilities(
    cwd: string
  ): Promise<ClaudeCapabilitiesProbe | null> {
    const sdk = await this.loadSdk()
    if (!sdk) return null

    const abort = new AbortController()
    const accountAtStart = this.modelAccountIdentity()
    const claudeCodeBinaryPath = this.claudeBinaryPath()
    let query: SdkQuery | null = null
    try {
      query = sdk.query({
        prompt: waitForAbortPrompt(abort.signal),
        options: {
          cwd,
          additionalDirectories: [cwd],
          env: this.makeEnvironment(),
          settingSources: [...claudeSettingSourcesForCwd(cwd)],
          tools: [],
          persistSession: false,
          abortController: abort,
          stderr: () => {},
          ...(claudeCodeBinaryPath
            ? { pathToClaudeCodeExecutable: claudeCodeBinaryPath }
            : {}),
        },
      })
      this.metadataQueries.add(query)
      if (!query.initializationResult) return null
      const init = await withTimeout(
        query.initializationResult(),
        CLAUDE_COMMAND_PROBE_TIMEOUT_MS
      )
      const account = init.account ?? {}
      const email = nonEmptyString(account.email)
      const subscriptionType = nonEmptyString(account.subscriptionType)
      const tokenSource = nonEmptyString(account.tokenSource)
      const slashCommands = parseClaudeInitializationCommands(init.commands)
      const models = buildClaudeModelsFromInitialization(init.models)
      if (accountAtStart && this.modelAccountIdentity() !== accountAtStart)
        return null
      this.modelsCache = { checkedAt: Date.now(), models }
      const accountIdentity = this.modelAccountIdentity(
        nonEmptyString(init.account?.email)
      )
      this.lastKnownAccount = accountIdentity
      this.lastKnownModels = models
      this.modelSnapshot.write(
        "claude",
        this.options.providerInstanceId ?? "claude",
        accountIdentity,
        models
      )
      this.slashCommandsCache.set(cwd, {
        checkedAt: Date.now(),
        commands: slashCommands,
      })
      return {
        ...(email ? { email } : {}),
        ...(subscriptionType ? { subscriptionType } : {}),
        ...(tokenSource ? { tokenSource } : {}),
        slashCommands,
        models,
      }
    } catch (error) {
      logger.warn({ err: error, cwd }, "claude capability probe failed")
      return null
    } finally {
      abort.abort()
      if (query) await this.finishMetadataQuery(query)
    }
  }

  private modelAccountIdentity(email?: string): string | null {
    return cliAccountIdentity(
      "claude",
      this.claudeConfigDir(),
      email ?? this.statusCache?.status.auth.email
    )
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId as string)
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.bus.on("event", listener)
    return () => {
      this.bus.off("event", listener)
    }
  }

  async startSession(input: {
    threadId: ThreadId
    cwd?: string | null
    modelSelection?: ModelSelection | null
    resumeCursor?: unknown | null
    runtimeMode?: string | null
  }): Promise<ProviderSession> {
    const key = input.threadId as string
    const existing = this.sessions.get(key)
    if (existing) return existing.session
    const now = Date.now()
    const inputResumeCursor = readClaudeResumeCursor(input.resumeCursor)
    const storedResumeCursor =
      inputResumeCursor ??
      readClaudeResumeCursor(this.options.getStoredProviderResumeCursor?.(key))
    const providerThreadId =
      inputResumeCursor?.resume ??
      inputResumeCursor?.sessionId ??
      this.options.getStoredProviderThreadId?.(key) ??
      storedResumeCursor?.resume ??
      storedResumeCursor?.sessionId ??
      null
    const baseResumeSessionAts = normalizeClaudeResumeStack(
      storedResumeCursor?.turnResumeSessionAts,
      storedResumeCursor?.turnCount ?? 0,
      storedResumeCursor?.resumeSessionAt ?? null
    )
    const resumeCursor = providerThreadId
      ? makeClaudeResumeCursor(
          key,
          providerThreadId,
          baseResumeSessionAts.length,
          lastClaudeResumeSessionAt(baseResumeSessionAts),
          baseResumeSessionAts
        )
      : null
    const session: ProviderSession = {
      threadId: key,
      providerInstanceId: this.options.providerInstanceId ?? null,
      providerThreadId,
      resumeCursor,
      continuationKey: this.options.continuationKey ?? null,
      status: "ready",
      cwd: input.cwd ?? null,
      runtimeMode: input.runtimeMode ?? null,
      activeTurnId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(key, {
      query: null,
      abort: new AbortController(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      pendingPlanApprovals: new Map(),
      permissionState: { chatMode: null, permissionLevel: null, sdkMode: null },
      queuedPermissionMode: null,
      session,
      baseResumeSessionAts,
      turns: [],
      activeTurn: null,
      lastAssistantUuid: resumeCursor?.resumeSessionAt ?? null,
      resumeCursorPersistenceError: null,
      lastProposedPlanText: null,
      sessionExited: false,
      claudeChild: null,
    })
    return session
  }

  async listSessions(): Promise<ReadonlyArray<ProviderSession>> {
    return Array.from(this.sessions.entries()).map(([threadId, ctx]) => ({
      ...ctx.session,
      threadId,
      activeTurnId: ctx.activeTurn?.id ?? null,
      status: ctx.activeTurn ? "running" : ctx.session.status,
      updatedAt: Date.now(),
    }))
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const key = input.threadId
    let ctx = this.sessions.get(key)
    if (!ctx) {
      await this.startSession({
        threadId: key as ThreadId,
        cwd: input.projectPath,
      })
      ctx = this.sessions.get(key)!
    }

    // Stop cancels one query. Keep its signal local so a late SDK iterator
    // cannot resume publishing when a subsequent turn gets a fresh signal.
    const loopAbort = new AbortController()
    ctx.abort = loopAbort

    const sdk = await this.loadSdk()
    if (
      loopAbort.signal.aborted ||
      ctx.sessionExited ||
      this.sessions.get(key) !== ctx
    )
      return
    if (!sdk) {
      // The prefix is what callers and tests key on; the real reason follows
      // it so a broken install reads as such instead of "not installed".
      throw new Error(
        `Claude SDK is not installed or could not be loaded${
          this.sdkLoadError ? `: ${this.sdkLoadError}` : ""
        }. Install @anthropic-ai/claude-agent-sdk.`
      )
    }

    const turnId = randomUUID()

    const rawModelId = resolveTurnModelId(input)
    const modelId = resolveClaudeRuntimeModelId(rawModelId)
    const contextWindow = resolveClaudeContextWindow(input, rawModelId)
    const reasoningEffort = resolveTurnStringOption(
      input,
      ["effort", "reasoningEffort"],
      input.reasoningEffort
    )
    const modelCapabilities = getClaudeModelCapabilities(
      modelId,
      this.modelsCache?.models ?? this.lastKnownModels
    )
    const resolvedEffort = resolveClaudeEffort(
      modelCapabilities,
      reasoningEffort
    )
    const fastMode = modelCapabilities.optionDescriptors?.some(
      (descriptor) =>
        descriptor.id === "fastMode" && descriptor.type === "boolean"
    )
      ? resolveTurnBooleanOption(input, "fastMode", input.fastMode)
      : undefined
    const opts = resolveOptions(resolvedEffort, modelId, fastMode)
    const promptInjectedEffort = resolvePromptInjectedEffort(
      modelCapabilities,
      reasoningEffort
    )
    const providerMessage = applyClaudePromptEffortPrefix(
      input.message +
        (buildUnsupportedAttachmentNotice(input.attachments) ?? ""),
      promptInjectedEffort
    )
    const cwd = input.projectPath ?? undefined
    const chatMode = (input as { chatMode?: string | null }).chatMode ?? null
    const permissionLevel =
      (input as { permissionLevel?: string | null }).permissionLevel ?? null
    const history = (input as { history?: ReadonlyArray<HistoryMessage> })
      .history
    const isPlanMode = chatMode === "plan"
    // "interactive" (default): ExitPlanMode waits for the user's plan
    // decision. "capture": legacy capture-and-deny — pipeline-driven turns
    // use their own stop points as the human gate.
    const planApprovalMode =
      (input as { planApprovalMode?: "interactive" | "capture" | null })
        .planApprovalMode ?? "interactive"
    const interactivePlan = isPlanMode && planApprovalMode === "interactive"
    const projectToolPolicy = await loadBetterC0deProjectToolPolicy(cwd)
    // SDK tool lists are fixed for the lifetime of query(). Interactive plans
    // continue in that same query after approval, so keep implementation tools
    // registered and enforce the current mode in PreToolUse/canUseTool.
    const tools = filterToolsForBetterC0deProjectPolicy(
      getToolsForMode(interactivePlan ? "agent" : chatMode),
      {
        toolFlags: projectToolPolicy.toolFlags,
        permissionRules: projectToolPolicy.permissionRules,
      }
    )
    // A mode queued via setPermissionMode() while idle applies only when the
    // incoming send didn't specify a level itself (the composer usually does).
    const queuedMode = ctx.queuedPermissionMode
    ctx.queuedPermissionMode = null
    const effectivePermissionLevel =
      permissionLevel ??
      (queuedMode ? permissionLevelFromSdkMode(queuedMode) : null)
    const permissionMode = resolveClaudePermissionMode(
      chatMode,
      effectivePermissionLevel
    )
    // Canonical level for every turn-setup decision below. `resolveClaudePermissionMode`
    // keeps taking the raw value because it maps SDK-native spellings itself.
    const effectiveGateLevel = normalizeGatePermissionLevel(
      effectivePermissionLevel
    )
    ctx.permissionState = {
      chatMode,
      permissionLevel: effectivePermissionLevel,
      sdkMode: permissionMode,
    }
    // Imagegen: the MCP server registers whenever a workspace exists (so a
    // plan→implement rollover can still reach it via the approval gate), but
    // auto-allow + the system-prompt nudge apply only to agentish,
    // non-read-only turns.
    const codeSearchServer = cwd
      ? await this.options.resolveCodeSearchServer?.(cwd)
      : null
    const orchestratorServer = cwd
      ? await this.options.resolveOrchestratorServer?.(cwd, key)
      : null
    if (
      loopAbort.signal.aborted ||
      ctx.sessionExited ||
      this.sessions.get(key) !== ctx
    )
      return
    const imagegenAdvertised =
      Boolean(cwd) &&
      effectiveGateLevel !== "read-only" &&
      chatMode !== "plan" &&
      chatMode !== "ask"
    const systemPrompt = buildSystemPromptOption(
      [
        input.systemInstruction,
        imagegenAdvertised ? IMAGEGEN_SYSTEM_HINT : null,
      ]
        .filter((part): part is string => Boolean(part?.trim()))
        .join("\n\n")
    )

    const canUseTool = async (
      toolName: string,
      toolInput: unknown,
      opts?: {
        toolUseID?: string
        title?: string
        description?: string
        displayName?: string
        decisionReason?: string
        blockedPath?: string
        suggestions?: unknown[]
        signal?: AbortSignal
      }
    ) => {
      const cancelled = () =>
        loopAbort.signal.aborted ||
        ctx!.sessionExited ||
        ctx!.abort !== loopAbort
      const interrupted = { behavior: "deny" as const, message: "Interrupted" }
      if (cancelled()) return interrupted
      if (toolName === "AskUserQuestion") {
        const requestId = randomUUID()
        const questions = normalizeClaudeUserInputQuestions(toolInput)
        const answers = await awaitPendingClaudeRequest(
          ctx!.pendingUserInputs,
          requestId,
          loopAbort.signal,
          {},
          () =>
            this.emitEvent({
              ...eventBase(key),
              type: "request.opened",
              requestId,
              kind: "user_input",
              questions,
              turnId,
            })
        )
        if (cancelled()) return interrupted
        this.emitEvent({
          ...eventBase(key),
          type: "request.resolved",
          requestId,
          decision: "answer",
        })
        return {
          behavior: "allow" as const,
          input: { ...asRecord(toolInput), answers },
          updatedInput: { ...asRecord(toolInput), answers },
        }
      }

      if (toolName === "ExitPlanMode") {
        const planMarkdown = extractExitPlanModePlan(toolInput)
        if (planMarkdown) ctx!.lastProposedPlanText = planMarkdown
        if (
          planMarkdown &&
          markProposedPlanCaptured(ctx, {
            planMarkdown,
            toolUseId: opts?.toolUseID,
          })
        ) {
          this.emitEvent({
            ...eventBase(key),
            type: "turn.proposed.completed",
            turnId,
            payload: { planMarkdown },
          })
        }
        if (planApprovalMode === "capture") {
          return {
            behavior: "deny" as const,
            message:
              "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          }
        }
        // Interactive plan approval: block until the user approves the plan
        // (optionally switching to acceptEdits for same-turn implementation)
        // or sends it back with feedback.
        const requestId = randomUUID()
        const resolution =
          await awaitPendingClaudeRequest<PlanApprovalResolution>(
            ctx!.pendingPlanApprovals,
            requestId,
            loopAbort.signal,
            { decision: "deny", message: "Interrupted or timed out" },
            () =>
              this.emitEvent({
                ...eventBase(key),
                type: "request.opened",
                requestId,
                kind: "plan_approval",
                // Fall back to the plan text streamed earlier this session when
                // the tool input arrived without a plan payload — the approval
                // UI must never show an empty preview for a real plan.
                planMarkdown: planMarkdown ?? ctx!.lastProposedPlanText ?? "",
                turnId,
              })
          )
        if (cancelled()) return interrupted
        this.emitEvent({
          ...eventBase(key),
          type: "request.resolved",
          requestId,
          decision: resolution.decision,
          requestKind: "plan_approval",
          ...(resolution.permissionMode
            ? { permissionMode: resolution.permissionMode }
            : {}),
          ...(resolution.message ? { message: resolution.message } : {}),
        })
        if (resolution.decision === "approve") {
          const approvedMode = resolution.permissionMode ?? "default"
          // ALWAYS leave the SDK's plan mode — for "default" (manual
          // approvals) too. Before this, only acceptEdits switched modes,
          // so a manual-approval approve left the CLI itself in plan mode
          // and every Edit/Write call failed with "Edit exists but is not
          // enabled in this context" even though our own gate allowed it.
          try {
            await ctx!.query?.setPermissionMode?.(
              approvedMode === "acceptEdits" ? "acceptEdits" : "default"
            )
          } catch {
            // Non-fatal: the CLI keeps its current mode; our own gate
            // below still honors the approved level.
          }
          // Leave plan mode in our own gate for the rest of the turn so the
          // read-only restriction stops firing while Claude implements.
          ctx!.permissionState = {
            chatMode: "agent",
            permissionLevel:
              approvedMode === "acceptEdits" ? "allow-edits" : "default",
            sdkMode: approvedMode,
          }
          return { behavior: "allow" as const, input: toolInput }
        }
        const feedback = resolution.message?.trim()
        return {
          behavior: "deny" as const,
          message: feedback
            ? `The user wants to keep planning. Their feedback: ${feedback}`
            : "The user wants to keep planning. Revise the plan based on the conversation so far and present an updated plan.",
        }
      }

      // Read the MUTABLE permission state (not closure constants) so
      // mid-turn setPermissionMode / plan approval affect this gate too.
      const perm = ctx!.permissionState
      // Canonicalize ONCE. Every comparison below reads `level`, never the raw
      // `perm.permissionLevel`. Comparing the raw string meant an alias such as
      // `"read"` — which `normalizeLevel` maps to `read-only`, and which
      // `/shell/run` denies — matched none of the branches here and fell
      // through to the approval prompt instead of being denied outright.
      const level: GatePermissionLevel = normalizeGatePermissionLevel(
        perm.permissionLevel
      )
      const permissionClass = classifyToolPermission(toolName)
      const policyClass = classifyTool(toolName, toolInput)
      const imagegenMayAutoAllow =
        toolName === IMAGEGEN_TOOL_NAME &&
        isImagegenAutoAllowed(perm.chatMode, level)
      const imagegenRequiresApproval =
        toolName === IMAGEGEN_TOOL_NAME && !imagegenMayAutoAllow
      // Network egress (WebFetch/WebSearch) stays "read" for the *mode* gate —
      // Plan and Ask are research modes and would be useless without it — but
      // it is not auto-allowed like a local read. It is the one always-available
      // tool that can carry workspace contents off the machine, so outside
      // bypass it goes to the approval gate where the user sees the URL.
      const egressRequiresApproval =
        policyClass === "egress" && level !== "bypass"

      // Plan mode: only read-only tools. Mutate / unknown are denied with a
      // structured message the SDK surfaces back to the model.
      if (perm.chatMode === "plan" && permissionClass !== "read") {
        return { behavior: "deny" as const, message: PLAN_MODE_DENY_MESSAGE }
      }
      if (perm.chatMode === "ask" && permissionClass !== "read") {
        return { behavior: "deny" as const, message: ASK_MODE_DENY_MESSAGE }
      }
      // Read-only permission level: same restriction applied independent of mode.
      if (level === "read-only" && permissionClass !== "read") {
        return {
          behavior: "deny" as const,
          message: "Read-only mode — only read tools are allowed.",
        }
      }
      // Session-scoped "always deny" rules (mirrored PermissionUpdates —
      // deny wins over everything below except the hard mode restrictions).
      const sessionRule = evaluateSessionRules(key, toolName, toolInput)
      if (sessionRule === "deny") {
        return {
          behavior: "deny" as const,
          message: "Denied by a session permission rule.",
        }
      }
      const projectRule = evaluateBetterC0deProjectToolPermission(
        projectToolPolicy.permissionRules,
        { toolName, toolInput }
      )
      if (projectRule?.action === "deny") {
        return {
          behavior: "deny" as const,
          message: `BetterC0de project permission denied ${projectRule.permission}:${projectRule.pattern}.`,
        }
      }
      const projectRuleRequiresApproval =
        projectRule?.action === "ask" || sessionRule === "ask"

      // ── Turn ceiling ────────────────────────────────────────────────────
      // What the permission level alone auto-approves, before any session or
      // project rule is consulted. Security mode never auto-approves beyond
      // proven reads — `gateToolCall` forces security to ask-on-edit for every
      // other provider, `isImagegenAutoAllowed` refuses under security, and
      // `resolveClaudePermissionMode` returns null for it. This used to be
      // computed twice with different guards: `sessionCeilingAutoAllows` had
      // the security check and the standalone block below did not, so a
      // Security-mode turn at `bypass` skipped straight past it and
      // auto-approved. One definition now, applied everywhere.
      const levelAutoAllows =
        perm.chatMode !== "security" &&
        (level === "bypass" ||
          (level === "allow-edits" &&
            (policyClass === "read" || policyClass === "write")))
      // Proven-read tools auto-allow unless the CLI's own engine owns the
      // decision (`default`) or the call can carry data off the machine.
      const readAutoAllows =
        permissionClass === "read" &&
        !egressRequiresApproval &&
        (level !== "default" || perm.chatMode === "security")
      const sessionCeilingAutoAllows = readAutoAllows || levelAutoAllows

      if (imagegenMayAutoAllow && !projectRuleRequiresApproval) {
        return { behavior: "allow" as const, input: toolInput }
      }
      if (
        projectRule?.action === "allow" &&
        !imagegenRequiresApproval &&
        sessionCeilingAutoAllows
      ) {
        return { behavior: "allow" as const, input: toolInput }
      }
      // Session and project rules may narrow the immutable turn ceiling, but
      // never widen it (for example, Security mode still asks for execution).
      if (
        !projectRuleRequiresApproval &&
        !imagegenRequiresApproval &&
        evaluateSessionRules(key, toolName, toolInput) === "allow" &&
        sessionCeilingAutoAllows
      ) {
        return { behavior: "allow" as const, input: toolInput }
      }

      if (
        !projectRuleRequiresApproval &&
        !imagegenRequiresApproval &&
        levelAutoAllows
      ) {
        return { behavior: "allow" as const, input: toolInput }
      }

      // Plan/Ask already denied everything that is not classified read above.
      // Auto-allow only that proven-read set: a tool whose class is `unknown`
      // (every MCP tool, anything the builtin registry does not name) must
      // still reach the approval gate rather than inherit a blanket pass.
      if (
        (perm.chatMode === "plan" || perm.chatMode === "ask") &&
        permissionClass === "read" &&
        !egressRequiresApproval &&
        !projectRuleRequiresApproval
      ) {
        return { behavior: "allow" as const, input: toolInput }
      }
      // Ask-on-edit: read tools auto-allow, anything else hits the approval
      // gate. The "default" level deliberately skips this ladder — the CLI's
      // own engine already decided this call needs asking (single gate).
      if (
        (level === "ask-on-edit" || perm.chatMode === "security") &&
        permissionClass === "read" &&
        !egressRequiresApproval &&
        !projectRuleRequiresApproval
      ) {
        return { behavior: "allow" as const, input: toolInput }
      }

      const requestId = randomUUID()
      const suggestions = parsePermissionSuggestions(opts?.suggestions)
      const resolution =
        await awaitPendingClaudeRequest<ToolApprovalResolution>(
          ctx!.pendingApprovals,
          requestId,
          loopAbort.signal,
          { decision: "deny", message: "Interrupted or timed out" },
          () =>
            this.emitEvent({
              ...eventBase(key),
              type: "request.opened",
              requestId,
              kind: "tool_approval",
              tool: toolName,
              input: toolInput,
              turnId,
              ...(opts?.title ? { title: opts.title } : {}),
              ...(opts?.description ? { description: opts.description } : {}),
              ...(opts?.decisionReason
                ? { decisionReason: opts.decisionReason }
                : {}),
              ...(opts?.blockedPath ? { blockedPath: opts.blockedPath } : {}),
              ...(suggestions ? { suggestions } : {}),
            })
        )
      if (cancelled()) return interrupted
      this.emitEvent({
        ...eventBase(key),
        type: "request.resolved",
        requestId,
        decision: resolution.decision,
        requestKind: "tool_approval",
      })
      if (resolution.decision === "approve") {
        const updatedPermissions = resolution.updatedPermissions
        if (updatedPermissions && updatedPermissions.length > 0) {
          // `session`-destination rules die with the per-turn CLI process —
          // mirror them so later turns keep auto-allowing. File destinations
          // are written by the CLI itself via updatedPermissions below.
          recordSessionPermissionUpdates(key, updatedPermissions)
        }
        return {
          behavior: "allow" as const,
          input: toolInput,
          ...(updatedPermissions && updatedPermissions.length > 0
            ? { updatedPermissions }
            : {}),
        }
      }
      const denyMessage = resolution.message?.trim()
      return {
        behavior: "deny" as const,
        message: denyMessage || "User denied the action",
      }
    }

    // History prefix is concatenated into the prompt itself — the Agent SDK
    // doesn't take a separate `history` option. The plugin used the same
    // approach.
    const resumeSessionId = ctx.session.providerThreadId
    const resumeCursor = readClaudeResumeCursor(ctx.session.resumeCursor)
    const resumeSessionAt = resumeSessionId
      ? resumeCursor?.resumeSessionAt
      : undefined
    const fullPrompt = prependProviderHistoryForFreshSession({
      history,
      currentPrompt: isPlanMode
        ? buildPlanModePrompt(providerMessage)
        : providerMessage,
      resumed: Boolean(resumeSessionId),
    })

    // Path forwarded from the shell process — see
    // `apps/shell/shared/claude-binary-path.cjs` for the resolution rationale.
    const claudeCodeBinaryPath = this.claudeBinaryPath()
    // Per-turn controller passed to the SDK. `ctx.abort` only stops our loop;
    // without this the interrupt path had no way to end a wedged child.
    const turnAbort = new AbortController()
    const query = sdk.query({
      prompt: fullPrompt,
      options: {
        ...(cwd ? { cwd } : {}),
        model: modelId,
        abortController: turnAbort,
        settingSources: [...claudeSettingSourcesForCwd(cwd)],
        env: {
          ...this.makeEnvironment(),
          // Imagegen MCP calls run minutes, not seconds — without this the
          // SDK closes the tool stream at its 60s default.
          ...(cwd ? { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "420000" } : {}),
        },
        ...(claudeCodeBinaryPath
          ? { pathToClaudeCodeExecutable: claudeCodeBinaryPath }
          : {}),
        spawnClaudeCodeProcess: (spawnOptions) =>
          this.spawnClaudeCodeProcess(ctx, spawnOptions),
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(resumeSessionAt ? { resumeSessionAt } : {}),
        ...(cwd ? { additionalDirectories: [cwd] } : {}),
        // In-process MCP server: real PNG assets via the local Codex CLI,
        // always pinned to gpt-5.5 @ xhigh (see imagegenMcpServer.ts).
        ...(cwd
          ? {
              mcpServers: {
                ...(codeSearchServer
                  ? { [CODE_SEARCH_SERVER]: codeSearchServer }
                  : {}),
                ...(orchestratorServer
                  ? { betterc0de_orchestrator: orchestratorServer }
                  : {}),
                [IMAGEGEN_MCP_SERVER_NAME]: buildImagegenMcpServer(sdk, {
                  workspaceDir: cwd,
                }),
              },
            }
          : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.thinking ? { thinking: opts.thinking } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(opts.settings ? { settings: opts.settings } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(wantsOneMillionContext(modelId, contextWindow)
          ? { betas: ["context-1m-2025-08-07"] }
          : {}),
        tools,
        // Read-only must hold even against persisted allow-rules in the
        // user's ~/.claude settings (those make the CLI skip canUseTool).
        // Interactive plans instead use the always-ask PreToolUse hook and
        // mutable gate, since approval must enable tools in this same query.
        ...(effectiveGateLevel === "read-only" && !interactivePlan
          ? {
              disallowedTools: [
                "Write",
                "Edit",
                "MultiEdit",
                "NotebookEdit",
                "Bash",
                "Agent",
                "Task",
                IMAGEGEN_TOOL_NAME,
              ],
            }
          : (chatMode === "plan" && !interactivePlan) || chatMode === "ask"
            ? { disallowedTools: [IMAGEGEN_TOOL_NAME] }
            : {}),
        // Interactive plan mode can roll straight into implementation after
        // approval — keep checkpointing on and budget implementation turns.
        enableFileCheckpointing:
          !isPlanMode || planApprovalMode === "interactive",
        maxTurns:
          isPlanMode && planApprovalMode === "interactive"
            ? 50
            : getMaxTurnsForMode(chatMode),
        includePartialMessages: true,
        canUseTool,
        hooks: {
          PreToolUse: [{ hooks: [createClaudePreToolUseApprovalHook()] }],
        },
      },
    })
    ctx.query = query
    let settleTurn!: () => void
    const turnSettled = new Promise<void>((resolve) => {
      settleTurn = resolve
    })
    const activeTurn: ActiveClaudeTurn = {
      id: turnId,
      abort: turnAbort,
      dispatchTurnId: input.dispatchTurnId ?? null,
      settled: turnSettled,
      settle: settleTurn,
      forceCompleted: false,
      items: [{ type: "user", text: input.message }],
      assistantResumeUuid: null,
      toolsByBlockIndex: new Map(),
      toolsById: new Map(),
      capturedProposedPlanKeys: new Set(),
    }
    ctx.activeTurn = activeTurn
    this.emitEvent({
      ...eventBase(key),
      type: "turn.started",
      turnId,
      payload: {
        ...(input.dispatchTurnId
          ? { dispatchTurnId: input.dispatchTurnId }
          : {}),
      },
    })

    let terminalObserved = false
    try {
      for await (const msg of query) {
        if (loopAbort.signal.aborted) break
        this.writeNativeSdkMessage(key, msg, turnId, ctx)
        const events = this.translateSdkMessage(
          key,
          msg,
          turnId,
          { chatMode },
          ctx
        ).map((event) =>
          withDispatchTurnId(event, input.dispatchTurnId ?? null)
        )
        this.recordTurnMessage(ctx, msg)
        for (const ev of events) {
          this.emitEvent(ev)
        }
        // Persist provider-native continuation metadata only after translating
        // and publishing the received SDK message. A local metadata write must
        // never hide model output that Claude already delivered.
        this.persistSessionIdFromMessage(ctx, key, msg)
        const terminal = events.find((ev) => ev.type === "turn.completed")
        if (terminal?.type === "turn.completed") {
          terminalObserved = true
          if (terminal.status === "completed") {
            this.completeActiveTurn(ctx, key, turnId)
          } else if (ctx.activeTurn?.id === turnId) {
            ctx.activeTurn = null
          }
          break
        } else if (events.some((ev) => ev.type === "runtime.error")) {
          if (ctx.activeTurn?.id === turnId) ctx.activeTurn = null
        }
      }
    } catch (error) {
      if (!terminalObserved && !loopAbort.signal.aborted) {
        if (ctx.activeTurn?.id === turnId) ctx.activeTurn = null
        // The public message stays generic; the real reason goes to the log
        // and rides along as `detail` so it is not lost on the way to the UI.
        const detail = error instanceof Error ? error.message : String(error)
        logger.error(
          { err: error, thread: key, turn: turnId },
          "claude sdk query failed"
        )
        const publicMessage = "Claude provider failed."
        this.emitEvent({
          ...eventBase(key),
          type: "runtime.error",
          message: publicMessage,
          class: "provider_error",
          detail,
        })
        this.emitEvent({
          ...eventBase(key),
          type: "turn.completed",
          turnId,
          status: "failed",
          error: publicMessage,
          payload: {
            state: "failed",
            errorMessage: publicMessage,
            ...(input.dispatchTurnId
              ? { dispatchTurnId: input.dispatchTurnId }
              : {}),
          },
        })
      }
    } finally {
      // `interruptTurn` may already have ended this turn on the user's behalf
      // when the loop would not unwind; it then owns the terminal event.
      if (
        !terminalObserved &&
        loopAbort.signal.aborted &&
        !activeTurn.forceCompleted
      ) {
        terminalObserved = true
        this.emitEvent({
          ...eventBase(key),
          type: "turn.aborted",
          turnId,
          payload: {
            reason: "Interrupted by user.",
            ...(input.dispatchTurnId
              ? { dispatchTurnId: input.dispatchTurnId }
              : {}),
          },
        })
      }
      if (ctx.activeTurn?.id === turnId) {
        ctx.activeTurn = null
      }
      if (ctx.query === query) ctx.query = null
      activeTurn.settle()
    }
  }

  private writeNativeSdkMessage(
    threadId: string,
    message: unknown,
    turnId: string,
    ctx: SessionContext
  ): void {
    const nativeEventLogger = this.options.nativeEventLogger
    if (!nativeEventLogger) return

    const record = asRecord(message)
    const observedAt = new Date().toISOString()
    const providerThreadId = readString(record, "session_id", "sessionId")
    const itemId = claudeNativeItemId(message)
    try {
      nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: readString(record, "uuid", "id") ?? randomUUID(),
            kind: "notification",
            provider: "claudeAgent",
            providerKind: "claude",
            providerInstanceId: this.options.providerInstanceId ?? "claude",
            threadId,
            createdAt: observedAt,
            method: claudeNativeMethod(message),
            ...(providerThreadId ? { providerThreadId } : {}),
            turnId,
            ...(ctx.session.providerThreadId
              ? { boundProviderThreadId: ctx.session.providerThreadId }
              : {}),
            ...(itemId ? { itemId } : {}),
            payload: message,
          },
        },
        threadId
      )
    } catch {
      // Native observability must never interrupt provider delivery.
    }
  }

  async interruptTurn(
    threadId: ThreadId,
    options: ClaudeInterruptOptions = {}
  ): Promise<void> {
    const ctx = this.sessions.get(threadId as string)
    if (!ctx) return
    // Drain pending plan approvals BEFORE interrupting so the awaited
    // canUseTool promise settles and the SDK can unwind cleanly.
    for (const [id, resolver] of ctx.pendingPlanApprovals) {
      resolver({ decision: "deny", message: "Interrupted" })
      ctx.pendingPlanApprovals.delete(id)
    }
    ctx.abort.abort()
    for (const [id, resolver] of ctx.pendingApprovals) {
      resolver({ decision: "deny" })
      ctx.pendingApprovals.delete(id)
    }
    for (const [id, resolver] of ctx.pendingUserInputs) {
      resolver({})
      ctx.pendingUserInputs.delete(id)
    }
    // Escalation ladder. Every rung is bounded because `/chat/interrupt` runs
    // inside `withChatRecoveryMutation`: an unbounded await holds the thread's
    // recovery lease and the Stop button appears to do nothing. The rungs
    // share one wall-clock budget — the hub's own interrupt timeout, passed
    // in by the hub — so the ladder settles before the hub gives up and
    // hard-stops the session; a ladder that outlived that used to emit a
    // stray `turn.aborted` after the hub's `session.exited`.
    //
    // What ends a turn is not the control request's ack but the turn's read
    // loop unwinding — that is what clears `ctx.activeTurn` and emits the
    // terminal event. So after each rung we wait on the loop, not the ack:
    // an acked `interrupt()` whose stream never ends used to leave the turn
    // active forever, and `close()` is synchronous in the SDK, so a deadline
    // on it never fired and the abort below was unreachable. If nothing
    // unwinds the loop, the turn is force-completed here so Stop always ends
    // the turn; the loop's finally then skips its own terminal event.
    const budgetMs = boundedInterruptBudget(options.interruptBudgetMs)
    const startedAt = Date.now()
    const deadlineAt = (share: number) =>
      startedAt + Math.max(1, Math.floor(budgetMs * share))
    const remainingUntil = (deadline: number) =>
      Math.max(1, deadline - Date.now())
    const query = ctx.query
    const activeTurn = ctx.activeTurn
    const interruptDeadline = deadlineAt(
      CLAUDE_INTERRUPT_RUNG_DEADLINES.interrupt
    )
    if (query?.interrupt) {
      await withInterruptDeadline(
        () => query.interrupt?.(),
        remainingUntil(interruptDeadline)
      )
    }
    if (!activeTurn) {
      // No read loop to wait on (the turn already settled, or none ran);
      // closing is the only cleanup left.
      if (query?.close) {
        await withInterruptDeadline(
          () => query.close?.(),
          remainingUntil(interruptDeadline)
        )
      }
      return
    }
    if (
      await settledWithin(activeTurn.settled, remainingUntil(interruptDeadline))
    ) {
      return
    }
    const closeDeadline = deadlineAt(CLAUDE_INTERRUPT_RUNG_DEADLINES.close)
    if (query?.close) {
      await withInterruptDeadline(
        () => query.close?.(),
        remainingUntil(closeDeadline)
      )
      if (
        await settledWithin(activeTurn.settled, remainingUntil(closeDeadline))
      ) {
        return
      }
    }
    // The SDK honours this controller by terminating its child process.
    const abortDeadline = deadlineAt(CLAUDE_INTERRUPT_RUNG_DEADLINES.abort)
    if (!activeTurn.abort.signal.aborted) activeTurn.abort.abort()
    if (
      await settledWithin(activeTurn.settled, remainingUntil(abortDeadline))
    ) {
      return
    }
    this.forceCompleteInterruptedTurn(
      ctx,
      threadId as string,
      activeTurn,
      query
    )
  }

  /**
   * Ends a turn whose SDK read loop would not unwind after interrupt, close
   * and abort. The loop keeps running in the background and settles its own
   * bookkeeping when the iterator finally gives up; `forceCompleted` stops it
   * from emitting a second terminal event.
   */
  /**
   * The SDK's abort only signals the root. A child that ignores it, and any
   * grandchild still holding the pipes, is killed here. One cleanup promise
   * per process so interrupt and stopSession do not taskkill the same PID twice.
   */
  private killClaudeChild(child: ChildProcess | null): Promise<void> {
    if (!child) return Promise.resolve()
    let pending = this.claudeChildCleanup.get(child)
    if (!pending) {
      pending = terminateProviderChildProcessTree(child).then(
        () => undefined,
        (error: unknown) => {
          logger.warn(
            { err: error, pid: child.pid },
            "claude process tree survived shutdown"
          )
        }
      )
      this.claudeChildCleanup.set(child, pending)
      void pending.finally(() => {
        if (this.claudeChildCleanup.get(child) === pending) {
          this.claudeChildCleanup.delete(child)
        }
      })
    }
    return pending
  }

  private spawnClaudeCodeProcess(
    ctx: SessionContext,
    options: {
      command: string
      args: string[]
      cwd?: string
      env: NodeJS.ProcessEnv
      signal: AbortSignal
    }
  ): ChildProcess {
    const previous = ctx.claudeChild
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // POSIX tree-kill signals the process group, which requires the child
      // to be the group leader. Windows addresses the tree by PID.
      detached: process.platform !== "win32",
      signal: options.signal,
    })
    child.stderr?.resume()
    ctx.claudeChild = child
    child.once("exit", () => {
      if (ctx.claudeChild === child) ctx.claudeChild = null
    })
    if (
      previous &&
      previous !== child &&
      previous.exitCode == null &&
      previous.signalCode == null
    ) {
      void this.killClaudeChild(previous)
    }
    return child
  }

  private forceCompleteInterruptedTurn(
    ctx: SessionContext,
    threadId: string,
    activeTurn: ActiveClaudeTurn,
    query: SdkQuery | null
  ): void {
    if (activeTurn.forceCompleted) return
    if (ctx.sessionExited || this.sessions.get(threadId) !== ctx) {
      // The hub already settled this turn and tore the session down
      // (`stopSession` after a timed-out interrupt). A terminal event now
      // would trail its `session.exited`; the loop's finally is silenced too.
      activeTurn.forceCompleted = true
      if (ctx.activeTurn === activeTurn) ctx.activeTurn = null
      if (query && ctx.query === query) ctx.query = null
      void this.killClaudeChild(ctx.claudeChild)
      logger.debug(
        { thread: threadId, turn: activeTurn.id },
        "claude interrupt ladder ended after the session was already stopped; no terminal event emitted"
      )
      return
    }
    activeTurn.forceCompleted = true
    logger.warn(
      { thread: threadId, turn: activeTurn.id },
      "claude turn did not unwind after interrupt, close and abort; force-completing it"
    )
    if (ctx.activeTurn === activeTurn) ctx.activeTurn = null
    if (query && ctx.query === query) ctx.query = null
    void this.killClaudeChild(ctx.claudeChild)
    this.emitEvent({
      ...eventBase(threadId),
      type: "turn.aborted",
      turnId: activeTurn.id,
      payload: {
        reason: "Interrupted by user.",
        ...(activeTurn.dispatchTurnId
          ? { dispatchTurnId: activeTurn.dispatchTurnId }
          : {}),
      },
    })
  }

  async readThread(threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    const ctx = this.sessions.get(threadId as string)
    if (!ctx) {
      return { threadId, turns: [] }
    }
    return this.snapshotThread(ctx)
  }

  async rollbackThread(
    threadId: ThreadId,
    numTurns: number
  ): Promise<ProviderThreadSnapshot> {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1")
    }
    const key = threadId as string
    let ctx = this.sessions.get(key)
    if (!ctx) {
      await this.startSession({ threadId })
      ctx = this.sessions.get(key)
      if (!ctx) return { threadId, turns: [] }
    }

    const nextLength = Math.max(0, ctx.turns.length - numTurns)
    const removedTurns = ctx.turns.length - nextLength
    const remainingTurnsToRemove = Math.max(0, numTurns - removedTurns)
    ctx.turns.splice(nextLength)
    if (remainingTurnsToRemove > 0) {
      const nextBaseLength = Math.max(
        0,
        ctx.baseResumeSessionAts.length - remainingTurnsToRemove
      )
      ctx.baseResumeSessionAts.splice(nextBaseLength)
    }
    ctx.activeTurn = null

    const lastTurn = ctx.turns.at(-1)
    ctx.lastAssistantUuid =
      lastTurn?.resumeSessionAt ??
      lastClaudeResumeSessionAt(ctx.baseResumeSessionAts)

    if (
      removedTurns + remainingTurnsToRemove > 0 &&
      ctx.baseResumeSessionAts.length + ctx.turns.length === 0
    ) {
      ctx.session = {
        ...ctx.session,
        providerThreadId: null,
        resumeCursor: makeClaudeResumeCursor(key, null, 0, null, []),
        updatedAt: Date.now(),
      }
      this.options.persistProviderThreadId?.(key, null)
    } else {
      this.updateResumeCursor(ctx, key)
    }

    return this.snapshotThread(ctx)
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision
  ): Promise<void> {
    const ctx = this.sessions.get(threadId as string)
    if (!ctx) {
      throw new StalePendingProviderRequestError(
        pendingRequestKindFromDecisionKind(decision.kind),
        requestId
      )
    }
    if (
      decision.kind === "user_input" ||
      decision.kind === "user_input_reject"
    ) {
      const resolver = ctx.pendingUserInputs.get(requestId as string)
      if (!resolver) {
        throw new StalePendingProviderRequestError("user-input", requestId)
      }
      ctx.pendingUserInputs.delete(requestId as string)
      resolver(decision.kind === "user_input" ? decision.answers : {})
      return
    }
    if (decision.kind === "plan_approval") {
      const resolver = ctx.pendingPlanApprovals.get(requestId as string)
      if (!resolver) {
        throw new StalePendingProviderRequestError("plan-approval", requestId)
      }
      ctx.pendingPlanApprovals.delete(requestId as string)
      resolver({
        decision: decision.decision,
        ...(decision.permissionMode
          ? { permissionMode: decision.permissionMode }
          : {}),
        ...(decision.message ? { message: decision.message } : {}),
      })
      return
    }
    const resolver = ctx.pendingApprovals.get(requestId as string)
    if (!resolver) {
      throw new StalePendingProviderRequestError("approval", requestId)
    }
    ctx.pendingApprovals.delete(requestId as string)
    const sdkPermissionUpdates = decision.updatedPermissions?.length
      ? permissionUpdatesForClaudeSdk(decision.updatedPermissions)
      : []
    resolver({
      decision: decision.decision,
      ...(decision.message ? { message: decision.message } : {}),
      ...(sdkPermissionUpdates.length > 0
        ? { updatedPermissions: sdkPermissionUpdates }
        : {}),
    })
  }

  /**
   * Switch the permission mode. Applies live via the SDK control request
   * when a turn is running (stdin stays open until the first result);
   * otherwise queued for the next sendTurn.
   */
  async setPermissionMode(
    threadId: ThreadId,
    mode: SdkPermissionMode
  ): Promise<{ applied: "live" | "queued" }> {
    const ctx = this.sessions.get(threadId as string)
    if (!ctx) {
      // No session yet — nothing to update; the next sendTurn derives its
      // mode from the request's permissionLevel anyway.
      return { applied: "queued" }
    }
    // Plan is a CHAT MODE, not a permission level. `permissionLevelFromSdkMode`
    // returns the string "plan", and writing that into `permissionLevel` left
    // the gate with a value it does not recognise: it matched none of the
    // level branches and fell through to "ask for everything" while
    // `chatMode` stayed on whatever it was. Switching to Plan mid-turn
    // therefore stopped enforcing Plan in our own gate and relied entirely on
    // the SDK's plan mode — and did nothing at all for adapters without one.
    // Map it onto the field that actually gates mutations.
    ctx.permissionState =
      mode === "plan"
        ? {
            ...ctx.permissionState,
            chatMode: "plan",
            permissionLevel: "read-only",
            sdkMode: mode,
          }
        : {
            ...ctx.permissionState,
            // Leaving plan mode returns the gate to ordinary agent semantics;
            // staying on "plan" would keep denying every mutating tool.
            chatMode:
              ctx.permissionState.chatMode === "plan"
                ? "agent"
                : ctx.permissionState.chatMode,
            permissionLevel: permissionLevelFromSdkMode(mode),
            // bypassPermissions would stop the SDK from calling canUseTool.
            // Keep that callback, and let our gate treat level "bypass" as
            // full access after the deny checks. sendTurn already does this.
            sdkMode: mode === "bypassPermissions" ? "default" : mode,
          }
    const query = ctx.query
    if (query?.setPermissionMode && ctx.activeTurn) {
      try {
        await query.setPermissionMode(
          mode === "bypassPermissions" ? "default" : mode
        )
        return { applied: "live" }
      } catch {
        // Control request failed (e.g. stdin already closed after the
        // result message) — fall back to queueing for the next turn.
      }
    }
    ctx.queuedPermissionMode = mode
    return { applied: "queued" }
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    await this.interruptTurn(threadId)
    clearSessionRules(threadId as string)
    const ctx = this.sessions.get(threadId as string)
    if (ctx) {
      ctx.sessionExited = true
      await this.killClaudeChild(ctx.claudeChild)
    }
    this.sessions.delete(threadId as string)
  }

  async stopAll(): Promise<void> {
    this.metadataStopping = true
    await Promise.allSettled([...this.metadataWork])
    const keys = Array.from(this.sessions.keys())
    const results = await Promise.allSettled([
      ...keys.map((k) => this.stopSession(k as ThreadId)),
      this.retryMetadataCleanup(),
    ])
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to stop all Claude sessions")
    }
  }

  private snapshotThread(ctx: SessionContext): ProviderThreadSnapshot {
    return {
      threadId: ctx.session.threadId as ThreadId,
      turns: ctx.turns.map((turn) => ({
        id: turn.id as TurnId,
        items: [...turn.items],
      })),
    }
  }

  private updateResumeCursor(ctx: SessionContext, threadId: string): void {
    const turnResumeSessionAts = [
      ...ctx.baseResumeSessionAts,
      ...ctx.turns.map((turn) => turn.resumeSessionAt),
    ]
    const resumeCursor = makeClaudeResumeCursor(
      threadId,
      ctx.session.providerThreadId,
      turnResumeSessionAts.length,
      ctx.lastAssistantUuid,
      turnResumeSessionAts
    )
    ctx.session = {
      ...ctx.session,
      resumeCursor,
      updatedAt: Date.now(),
    }
    try {
      this.options.persistProviderThreadId?.(
        threadId,
        ctx.session.providerThreadId,
        resumeCursor
      )
      ctx.resumeCursorPersistenceError = null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (ctx.resumeCursorPersistenceError === message) return
      ctx.resumeCursorPersistenceError = message
      this.emitEvent({
        ...eventBase(threadId),
        type: "config.warning",
        payload: {
          summary: "Claude session continuation could not be saved",
          details:
            "The current response remains available; BetterC0de will retry when the session state changes again.",
        },
      })
    }
  }

  private recordTurnMessage(ctx: SessionContext, msg: unknown): void {
    const active = ctx.activeTurn
    if (!active) return
    active.items.push(msg)
    const assistantUuid = sdkAssistantUuid(msg)
    if (assistantUuid) {
      active.assistantResumeUuid = assistantUuid
    }
  }

  private completeActiveTurn(
    ctx: SessionContext,
    threadId: string,
    turnId: string
  ): void {
    const active = ctx.activeTurn
    if (!active || active.id !== turnId) return
    ctx.turns.push({
      id: active.id,
      items: [...active.items],
      resumeSessionAt: active.assistantResumeUuid,
    })
    // Bound retained raw-message memory. Fold each evicted turn's resume point
    // onto the end of the base prefix so `[...base, ...turns.map(resumeSessionAt)]`
    // — the exact resume-cursor sequence — is byte-for-byte unchanged.
    while (ctx.turns.length > MAX_RETAINED_TURN_ITEMS) {
      const evicted = ctx.turns.shift()
      if (!evicted) break
      ctx.baseResumeSessionAts.push(evicted.resumeSessionAt)
    }
    ctx.activeTurn = null
    ctx.lastAssistantUuid = active.assistantResumeUuid
    this.updateResumeCursor(ctx, threadId)
  }

  private emitEvent(event: ProviderRuntimeEvent): void {
    this.bus.emit("event", event)
  }

  private persistSessionIdFromMessage(
    ctx: SessionContext,
    threadId: string,
    msg: unknown
  ): void {
    const sessionId = sdkSessionId(msg)
    if (!sessionId || sessionId === ctx.session.providerThreadId) return
    ctx.session = {
      ...ctx.session,
      providerThreadId: sessionId,
      updatedAt: Date.now(),
    }
    this.updateResumeCursor(ctx, threadId)
  }

  private claudeBinaryPath(): string | null {
    const configured =
      typeof this.options.binaryPath === "string"
        ? this.options.binaryPath.trim()
        : ""
    if (configured) return configured
    const fromEnv = process.env.BETTERC0DE_CLAUDE_CODE_PATH?.trim()
    return fromEnv || "claude"
  }

  private homePath(): string | null {
    const configured =
      typeof this.options.homePath === "string"
        ? this.options.homePath.trim()
        : ""
    return configured || null
  }

  private claudeConfigDir(): string {
    const home = this.homePath()
    if (home) return claudeConfigDir(home)
    const configured =
      [...(this.options.environment ?? [])]
        .reverse()
        .find((item) => item.name === "CLAUDE_CONFIG_DIR")
        ?.value.trim() ?? process.env.CLAUDE_CONFIG_DIR?.trim()
    return configured
      ? normalizeExactClaudeConfigDir(configured)
      : claudeConfigDir(os.homedir())
  }

  private makeEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = sanitizedChildEnvironment()
    const home = this.homePath()
    if (home) env.HOME = normalizeClaudeHome(home)
    for (const item of this.options.environment ?? []) {
      if (!item.name) continue
      env[item.name] = item.value
    }
    if (
      home ||
      env.CLAUDE_CONFIG_DIR?.trim() ||
      process.env.CLAUDE_CONFIG_DIR?.trim()
    ) {
      env.CLAUDE_CONFIG_DIR = this.claudeConfigDir()
    }
    return env
  }

  private async loadSdk(): Promise<SdkModule | null> {
    if (this.sdkCache) return this.sdkCache
    try {
      const mod = (await import(
        "@anthropic-ai/claude-agent-sdk" as string
      )) as SdkModule
      this.sdkCache = mod
      this.sdkLoadError = null
      return mod
    } catch (error) {
      // "Not installed" is only one reason an import fails; a broken native
      // dependency or a syntax error inside the package are others. Keep the
      // real reason so the surfaced error says so instead of guessing.
      this.sdkLoadError = error instanceof Error ? error.message : String(error)
      logger.error(
        { err: error },
        "failed to load @anthropic-ai/claude-agent-sdk"
      )
      return null
    }
  }

  private async fetchSkills(): Promise<ReadonlyArray<ProviderSkill>> {
    const configDir = this.claudeConfigDir()
    const skillsDir = path.join(configDir, "skills")
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
    } catch {
      // No user skills dir — plugin-bundled skills may still exist.
    }

    const userSkills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => readClaudeSkill(skillsDir, entry.name))
    )
    // Plugin-bundled skills are appended AFTER user skills so a same-named
    // user skill wins the dedupe. They are metadata for the `$`-picker only;
    // the claude binary loads enabled plugins natively via settingSources.
    const pluginSkills = await listClaudePluginSkills(configDir)
    return dedupeProviderSkills([
      ...userSkills.filter((skill): skill is ProviderSkill => Boolean(skill)),
      ...pluginSkills,
    ])
  }

  /** Null (not an empty list) when the probe failed, so callers cache it briefly. */
  private async fetchSlashCommands(
    cwd: string
  ): Promise<ReadonlyArray<ProviderSlashCommand> | null> {
    const sdk = await this.loadSdk()
    if (!sdk) return null

    const abort = new AbortController()
    const claudeCodeBinaryPath = this.claudeBinaryPath()
    let query: SdkQuery | null = null
    try {
      query = sdk.query({
        prompt: waitForAbortPrompt(abort.signal),
        options: {
          cwd,
          additionalDirectories: [cwd],
          env: this.makeEnvironment(),
          settingSources: [...claudeSettingSourcesForCwd(cwd)],
          tools: [],
          persistSession: false,
          abortController: abort,
          stderr: () => {},
          ...(claudeCodeBinaryPath
            ? { pathToClaudeCodeExecutable: claudeCodeBinaryPath }
            : {}),
        },
      })
      this.metadataQueries.add(query)
      if (!query.initializationResult) return []
      const init = await withTimeout(
        query.initializationResult(),
        CLAUDE_COMMAND_PROBE_TIMEOUT_MS
      )
      return parseClaudeInitializationCommands(init.commands)
    } catch (error) {
      logger.warn({ err: error, cwd }, "claude slash command probe failed")
      return null
    } finally {
      abort.abort()
      if (query) await this.finishMetadataQuery(query)
    }
  }

  private translateSdkMessage(
    threadId: string,
    msg: unknown,
    turnId: string,
    options: { chatMode?: string | null } = {},
    ctx?: SessionContext
  ): ProviderRuntimeEvent[] {
    if (!msg || typeof msg !== "object") return []
    const m = msg as {
      type?: string
      message?: {
        content?: Array<Record<string, unknown>>
        usage?: Record<string, number>
      }
      result?: Record<string, unknown>
      subtype?: string
      event?: Record<string, unknown>
    }
    const out: ProviderRuntimeEvent[] = []
    const isPlanMode = options.chatMode === "plan"

    const translation: SdkMessageTranslation = {
      threadId,
      msg,
      m,
      turnId,
      isPlanMode,
      ctx,
      out,
    }
    switch (m.type) {
      case "assistant":
        this.translateAssistantMessage(translation)
        break
      case "stream_event":
        this.translateStreamEvent(translation)
        break
      case "user":
        this.translateUserMessage(translation)
        break
      case "system":
        out.push(
          ...translateClaudeSystemMessage(threadId, asRecord(msg), turnId)
        )
        break
      case "tool_progress":
        this.translateToolProgress(translation)
        break
      case "tool_use_summary":
        this.translateToolUseSummary(translation)
        break
      case "auth_status":
        this.translateAuthStatus(translation)
        break
      case "result":
        this.translateResultMessage(translation)
        break
      default:
        break
    }
    return out
  }

  /**
   * A complete assistant message: text, thinking and tool-use blocks. With
   * partial messages enabled most of this already streamed; the blocks
   * still settle tool ids and plan steps.
   */
  private translateAssistantMessage(t: SdkMessageTranslation): void {
    const { threadId, m, turnId, isPlanMode, ctx, out } = t
    const blocks = m.message?.content ?? []
    for (const block of blocks) {
      const t = (block as { type?: string }).type
      if (t === "text") {
        const text = (block as { text?: string }).text ?? ""
        // Only a real <proposed_plan> block is a plan. Preliminary
        // narration in plan mode ("let me read the UI first…") has no
        // wrapper and must stay a normal assistant message — otherwise it
        // renders as a premature plan card while the agent is still
        // working. (Previously `normalizePlanMarkdown` fell back to the
        // whole text, promoting any plan-turn text to a proposal.)
        const planBlock = isPlanMode ? extractProposedPlanBlock(text) : null
        if (planBlock) {
          if (ctx) ctx.lastProposedPlanText = planBlock
          out.push({
            ...eventBase(threadId),
            type: "turn.proposed.completed",
            turnId,
            payload: { planMarkdown: planBlock },
          })
        } else if (text) {
          out.push({
            ...eventBase(threadId),
            type: "content.replace",
            streamKind: "assistant_text",
            text,
          })
        }
      } else if (t === "thinking") {
        const text = (block as { thinking?: string }).thinking ?? ""
        if (text)
          out.push({
            ...eventBase(threadId),
            type: "reasoning.replace",
            streamKind: "reasoning_text",
            text,
          })
      } else if (isClaudeToolBlockType(t)) {
        const tb = block as { id?: string; name?: string; input?: unknown }
        const toolId = tb.id ?? randomUUID()
        const toolName = tb.name ?? "unknown"
        const input = readClaudeToolInput(tb.input)
        if (toolName === "ExitPlanMode") {
          const planMarkdown = extractExitPlanModePlan(input)
          if (planMarkdown && ctx) ctx.lastProposedPlanText = planMarkdown
          if (
            planMarkdown &&
            markProposedPlanCaptured(ctx, {
              planMarkdown,
              toolUseId: toolId,
            })
          ) {
            out.push({
              ...eventBase(threadId),
              type: "turn.proposed.completed",
              turnId,
              payload: { planMarkdown },
            })
          }
        }
        const knownTool = ctx?.activeTurn?.toolsById.get(toolId)
        const tool: ActiveClaudeTool = knownTool
          ? { ...knownTool, input }
          : {
              id: toolId,
              name: toolName,
              input,
              partialInputJson: "",
              started: false,
            }
        if (ctx?.activeTurn) {
          ctx.activeTurn.toolsById.set(toolId, tool)
        }
        if (!knownTool?.started) {
          tool.started = true
          out.push(makeClaudeToolStartedEvent(threadId, turnId, tool))
        } else if (Object.keys(input).length > 0) {
          out.push(makeClaudeToolUpdatedEvent(threadId, turnId, tool))
        }
        const plan = isTodoTool(toolName)
          ? extractPlanStepsFromTodoInput(input)
          : []
        if (plan.length > 0) {
          out.push({
            ...eventBase(threadId),
            type: "turn.plan.updated",
            turnId,
            payload: { plan },
          })
        }
      } else if (t === "tool_result") {
        const tb = block as { tool_use_id?: string; name?: string }
        const toolId = tb.tool_use_id ?? randomUUID()
        const error = readClaudeToolError(block)
        if (error) {
          out.push({
            ...eventBase(threadId),
            type: "tool.failed",
            toolId,
            toolName: tb.name ?? "unknown",
            turnId,
            error,
            output: readClaudeToolResult(block),
          })
        } else {
          out.push({
            ...eventBase(threadId),
            type: "tool.completed",
            toolId,
            toolName: tb.name ?? "unknown",
            turnId,
            output: readClaudeToolResult(block),
          })
        }
      }
    }
  }

  /**
   * Raw Anthropic stream events: tool block starts, text/thinking/input
   * deltas.
   */
  private translateStreamEvent(t: SdkMessageTranslation): void {
    const { threadId, m, turnId, ctx, out } = t
    const ev = asRecord(m.event)
    const eventType = readString(ev, "type")
    if (eventType === "content_block_start") {
      const blockIndex = readNumber(ev, "index")
      const block = asRecord(ev.content_block)
      const blockType = readString(block, "type")
      if (!isClaudeToolBlockType(blockType)) return

      const tool: ActiveClaudeTool = {
        id: readString(block, "id") ?? randomUUID(),
        name: readString(block, "name") ?? "unknown",
        input: readClaudeToolInput(block.input),
        partialInputJson: "",
        started: true,
      }
      if (ctx?.activeTurn) {
        if (blockIndex !== undefined) {
          ctx.activeTurn.toolsByBlockIndex.set(blockIndex, tool)
        }
        ctx.activeTurn.toolsById.set(tool.id, tool)
      }
      out.push(makeClaudeToolStartedEvent(threadId, turnId, tool))

      const plan = isTodoTool(tool.name)
        ? extractPlanStepsFromTodoInput(tool.input)
        : []
      if (plan.length > 0) {
        out.push({
          ...eventBase(threadId),
          type: "turn.plan.updated",
          turnId,
          payload: { plan },
        })
      }
      return
    }

    if (eventType === "content_block_stop") {
      return
    }

    if (eventType !== "content_block_delta") return
    const delta = asRecord(ev.delta)
    if (
      delta.type === "text_delta" &&
      typeof delta.text === "string" &&
      delta.text
    ) {
      // Stream plan-mode text as normal assistant content (same path as
      // any other turn). The frontend's `proposedPlanPrefixState` boundary
      // detector routes a block that actually starts with <proposed_plan>
      // into plan streaming; preliminary narration stays normal text.
      // Previously plan mode blanket-emitted `turn.proposed.delta`, which
      // set `isPlanStreaming` for narration and produced a premature plan
      // card while the agent was still working.
      out.push({
        ...eventBase(threadId),
        type: "content.delta",
        streamKind: "assistant_text",
        delta: delta.text as string,
        turnId,
      })
    } else if (
      delta.type === "thinking_delta" &&
      typeof delta.thinking === "string" &&
      delta.thinking
    ) {
      out.push({
        ...eventBase(threadId),
        type: "reasoning.delta",
        streamKind: "reasoning_text",
        delta: delta.thinking as string,
        turnId,
      })
    } else if (
      delta.type === "input_json_delta" &&
      typeof delta.partial_json === "string" &&
      delta.partial_json
    ) {
      const blockIndex = readNumber(ev, "index")
      const tool =
        blockIndex !== undefined
          ? ctx?.activeTurn?.toolsByBlockIndex.get(blockIndex)
          : undefined
      if (!tool) return

      tool.partialInputJson += delta.partial_json
      const parsedInput = tryParseJsonRecord(tool.partialInputJson)
      if (!parsedInput) return

      tool.input = parsedInput
      out.push(makeClaudeToolUpdatedEvent(threadId, turnId, tool))

      const plan = isTodoTool(tool.name)
        ? extractPlanStepsFromTodoInput(parsedInput)
        : []
      if (plan.length > 0) {
        out.push({
          ...eventBase(threadId),
          type: "turn.plan.updated",
          turnId,
          payload: { plan },
        })
      }
    }
  }

  /**
   * The SDK echoes tool results back as user messages; they complete the
   * pending tool call.
   */
  private translateUserMessage(t: SdkMessageTranslation): void {
    const { threadId, m, turnId, ctx, out } = t
    const blocks = m.message?.content ?? []
    for (const block of blocks) {
      const record = asRecord(block)
      if (readString(record, "type") !== "tool_result") continue
      const toolId =
        readString(record, "tool_use_id", "toolUseId") ?? randomUUID()
      const knownTool = ctx?.activeTurn?.toolsById.get(toolId)
      const toolName =
        readString(record, "name", "tool_name", "toolName") ??
        knownTool?.name ??
        "unknown"
      const error = readClaudeToolError(record)
      if (error) {
        out.push({
          ...eventBase(threadId),
          type: "tool.failed",
          toolId,
          toolName,
          turnId,
          error,
          output: readClaudeToolResult(record),
        })
      } else {
        out.push({
          ...eventBase(threadId),
          type: "tool.completed",
          toolId,
          toolName,
          turnId,
          output: readClaudeToolResult(record),
        })
      }
    }
  }

  /**
   * Progress heartbeats for a long-running tool.
   */
  private translateToolProgress(t: SdkMessageTranslation): void {
    const { threadId, msg, turnId, out } = t
    const record = asRecord(msg)
    out.push({
      ...eventBase(threadId),
      type: "tool.progress",
      turnId,
      payload: {
        ...(readString(record, "tool_use_id", "toolUseId")
          ? { toolUseId: readString(record, "tool_use_id", "toolUseId") }
          : {}),
        ...(readString(record, "tool_name", "toolName")
          ? { toolName: readString(record, "tool_name", "toolName") }
          : {}),
        ...(readString(record, "summary", "message")
          ? { summary: readString(record, "summary", "message") }
          : readString(record, "task_id", "taskId")
            ? {
                summary: `task:${readString(record, "task_id", "taskId")}`,
              }
            : {}),
        ...(readNumber(record, "elapsed_time_seconds", "elapsedSeconds") !==
        undefined
          ? {
              elapsedSeconds: readNumber(
                record,
                "elapsed_time_seconds",
                "elapsedSeconds"
              ),
            }
          : {}),
      },
    })
  }

  /**
   * Summaries the SDK attaches to a finished tool run.
   */
  private translateToolUseSummary(t: SdkMessageTranslation): void {
    const { threadId, msg, turnId, out } = t
    const record = asRecord(msg)
    const summary = readString(record, "summary")
    if (summary) {
      const rawIds = record.preceding_tool_use_ids ?? record.precedingToolUseIds
      const precedingToolUseIds = Array.isArray(rawIds)
        ? rawIds.filter(
            (entry): entry is string =>
              typeof entry === "string" && entry.length > 0
          )
        : []
      out.push({
        ...eventBase(threadId),
        type: "tool.summary",
        turnId,
        payload: {
          summary,
          ...(precedingToolUseIds.length > 0 ? { precedingToolUseIds } : {}),
        },
      })
    }
  }

  /**
   * Login state changes surfaced mid-session.
   */
  private translateAuthStatus(t: SdkMessageTranslation): void {
    const { threadId, msg, turnId, out } = t
    const record = asRecord(msg)
    const output = Array.isArray(record.output)
      ? record.output.filter(
          (entry): entry is string => typeof entry === "string"
        )
      : undefined
    out.push({
      ...eventBase(threadId),
      type: "auth.status",
      turnId,
      payload: {
        ...(typeof record.is_authenticating === "boolean"
          ? { isAuthenticating: record.is_authenticating }
          : {}),
        ...(typeof record.isAuthenticating === "boolean"
          ? { isAuthenticating: record.isAuthenticating }
          : {}),
        ...(output && output.length > 0 ? { output } : {}),
        ...(readString(record, "error")
          ? { error: readString(record, "error") }
          : {}),
      },
    })
  }

  /**
   * The turn's terminal message: usage, cost, stop reason and the final
   * text when nothing streamed.
   */
  private translateResultMessage(t: SdkMessageTranslation): void {
    const { threadId, msg, m, turnId, out } = t
    const resultEnvelope = asRecord(msg)
    const envelopeUsage = asRecord(resultEnvelope.usage)
    const resultRecord = asRecord(m.result)
    const messageUsage = asRecord(m.message?.usage)
    const resultUsage = asRecord(resultRecord.usage)
    const usage =
      Object.keys(envelopeUsage).length > 0
        ? envelopeUsage
        : Object.keys(messageUsage).length > 0
          ? messageUsage
          : resultUsage
    const totalCostUsd =
      readNumber(resultEnvelope, "total_cost_usd", "totalCostUsd") ??
      readNumber(resultRecord, "total_cost_usd", "totalCostUsd")
    const durationMs =
      readNumber(resultEnvelope, "duration_ms", "durationMs") ??
      readNumber(resultRecord, "duration_ms", "durationMs")
    let canonicalUsage:
      | {
          inputTokens: number
          outputTokens: number
          totalTokens: number
          cachedInputTokens?: number
          cacheReadTokens?: number
          cacheCreationTokens?: number
          reasoningOutputTokens?: number
          totalCostUsd?: number
          durationMs?: number
        }
      | undefined
    if (Object.keys(usage).length > 0) {
      const input = readNumber(usage, "input_tokens", "inputTokens") ?? 0
      const output = readNumber(usage, "output_tokens", "outputTokens") ?? 0
      const cacheRead =
        readNumber(
          usage,
          "cache_read_input_tokens",
          "cacheReadInputTokens",
          "cache_read_tokens",
          "cacheReadTokens"
        ) ?? 0
      const cacheCreation =
        readNumber(
          usage,
          "cache_creation_input_tokens",
          "cacheCreationInputTokens",
          "cache_creation_tokens",
          "cacheCreationTokens"
        ) ?? 0
      const reasoning =
        readNumber(usage, "reasoning_output_tokens", "reasoningOutputTokens") ??
        0
      canonicalUsage = {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        ...(cacheRead + cacheCreation > 0
          ? {
              cachedInputTokens: cacheRead + cacheCreation,
              cacheReadTokens: cacheRead,
              cacheCreationTokens: cacheCreation,
            }
          : {}),
        ...(reasoning > 0 ? { reasoningOutputTokens: reasoning } : {}),
        ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      }
      out.push({
        ...eventBase(threadId),
        type: "token.usage",
        turnId,
        usage: canonicalUsage,
      })
      if (input + output > 0) {
        out.push({
          ...eventBase(threadId),
          type: "thread.token-usage.updated",
          turnId,
          payload: {
            usage: {
              usedTokens: input + output,
              inputTokens: input,
              outputTokens: output,
              ...(cacheRead + cacheCreation > 0
                ? {
                    cachedInputTokens: cacheRead + cacheCreation,
                    cacheReadTokens: cacheRead,
                    cacheCreationTokens: cacheCreation,
                  }
                : {}),
              ...(reasoning > 0 ? { reasoningOutputTokens: reasoning } : {}),
              ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          },
        })
      }
    }
    const subtype = readString(resultEnvelope, "subtype") ?? ""
    if (
      resultEnvelope.is_error === true ||
      subtype === "error" ||
      subtype === "failure" ||
      subtype.startsWith("error_")
    ) {
      const errors = Array.isArray(resultEnvelope.errors)
        ? resultEnvelope.errors.filter(
            (error): error is string =>
              typeof error === "string" && error.length > 0
          )
        : []
      const errMsg =
        (errors.length > 0 ? errors.join("\n") : undefined) ??
        readString(resultRecord, "error") ??
        "Claude SDK reported a failure"
      out.push({
        ...eventBase(threadId),
        type: "runtime.error",
        message: errMsg,
        class: "provider_error",
      })
      out.push({
        ...eventBase(threadId),
        type: "turn.completed",
        turnId,
        status: "failed",
        error: errMsg,
        payload: {
          state: "failed",
          ...(canonicalUsage ? { usage: canonicalUsage } : {}),
          ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
          errorMessage: errMsg,
        },
      })
    } else {
      out.push({
        ...eventBase(threadId),
        type: "turn.completed",
        turnId,
        status: "completed",
        payload: {
          state: "completed",
          ...(canonicalUsage ? { usage: canonicalUsage } : {}),
          ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
        },
      })
    }
  }
}

async function* waitForAbortPrompt(
  signal: AbortSignal
): AsyncGenerator<unknown> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
  }
  yield* []
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs} ms`)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function dedupeProviderSkills(
  skills: ReadonlyArray<ProviderSkill>
): ReadonlyArray<ProviderSkill> {
  const byName = new Map<string, ProviderSkill>()
  for (const skill of skills) {
    const name = nonEmptyString(skill.name)
    if (!name) continue
    const key = name.toLowerCase()
    if (!byName.has(key)) byName.set(key, { ...skill, name })
  }
  return [...byName.values()]
}

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined
): ReadonlyArray<ProviderSlashCommand> {
  const available: ProviderSlashCommand[] = []
  for (const source of commands ?? []) {
    const name = nonEmptyString(source.name)
    if (!name) continue
    const entry: ProviderSlashCommand = { name }
    const description = nonEmptyString(source.description)
    const hint = nonEmptyString(source.argumentHint)
    if (description) entry.description = description
    if (hint) entry.input = { hint }
    available.push(entry)
  }
  return dedupeSlashCommands(available)
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ProviderSlashCommand>
): ReadonlyArray<ProviderSlashCommand> {
  const byName = new Map<string, ProviderSlashCommand>()
  for (const command of commands) {
    const name = nonEmptyString(command.name)
    if (!name) continue
    const key = name.toLowerCase()
    const existing = byName.get(key)
    if (!existing) {
      byName.set(key, { ...command, name })
      continue
    }
    byName.set(key, {
      ...existing,
      ...(existing.description || !command.description
        ? {}
        : { description: command.description }),
      ...(existing.input?.hint || !command.input?.hint
        ? {}
        : { input: { hint: command.input.hint } }),
    })
  }
  return [...byName.values()]
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function runClaudeCommandProbe(input: {
  readonly binaryPath: string | null
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly retainFailedCleanup: (child: ChildProcess) => void
}): Promise<ClaudeCommandProbeResult> {
  const binaryPath = input.binaryPath?.trim() || "claude"
  const isWindows = process.platform === "win32"
  const directExe =
    isWindows && path.isAbsolute(binaryPath) && /\.exe$/i.test(binaryPath)
  const viaCmd = isWindows && !directExe
  const spawnCommand = viaCmd
    ? process.env.ComSpec?.trim() || "cmd.exe"
    : binaryPath
  const spawnArgs = viaCmd
    ? buildWindowsCmdArgs(binaryPath, input.args)
    : [...input.args]
  return new Promise((resolve, reject) => {
    let settled = false
    let terminating = false
    const output = createBoundedProcessOutput()
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      windowsVerbatimArguments: viaCmd,
      detached: !isWindows,
    })
    const onStdout = (chunk: Buffer | string) => {
      if (appendBoundedProcessOutput(output, "stdout", chunk)) return
      beginTermination(
        processOutputLimitError("Claude command probe", output.byteCap),
        (error) => reject(error)
      )
    }
    const onStderr = (chunk: Buffer | string) => {
      if (appendBoundedProcessOutput(output, "stderr", chunk)) return
      beginTermination(
        processOutputLimitError("Claude command probe", output.byteCap),
        (error) => reject(error)
      )
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off("data", onStdout)
      child.stderr?.off("data", onStderr)
      child.off("error", onError)
      child.off("close", onClose)
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onError = (error: Error) => {
      if (terminating) return
      finish(() => reject(error))
    }
    const onClose = (code: number | null) => {
      if (terminating) return
      finish(() =>
        resolve({
          code,
          stdout: output.stdout,
          stderr: output.stderr,
        })
      )
    }
    const beginTermination = (
      primaryError: Error,
      onCleanupSuccess: (error: Error) => void
    ) => {
      if (settled || terminating) return
      terminating = true
      clearTimeout(timer)
      void terminateProviderChildProcessTree(child).then(
        () => finish(() => onCleanupSuccess(primaryError)),
        (cleanupError) => {
          input.retainFailedCleanup(child)
          finish(() =>
            reject(
              new AggregateError(
                [primaryError, cleanupError],
                `${primaryError.message} Process-tree cleanup also failed.`
              )
            )
          )
        }
      )
    }
    const timer = setTimeout(() => {
      const timeoutError = new Error("Timed out while running Claude command.")
      beginTermination(timeoutError, () =>
        resolve({
          code: null,
          stdout: output.stdout,
          stderr: output.stderr || "Timed out while running command.",
        })
      )
    }, input.timeoutMs)

    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", onStderr)
    child.on("error", onError)
    child.on("close", onClose)
  })
}

function parseClaudeCliVersion(output: string): string | null {
  return output.match(/(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)/i)?.[1] ?? null
}

function isCommandMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = (error as { code?: unknown }).code
  const message = errorMessage(error).toLowerCase()
  return code === "ENOENT" || message.includes("enoent")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareSemverVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10))
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0)
    if (delta !== 0) return delta
  }
  return 0
}

async function loadBetterC0deProjectToolPolicy(
  cwd: string | undefined
): Promise<{
  readonly toolFlags: readonly ProjectToolFlag[]
  readonly permissionRules: readonly ProjectPermissionRule[]
}> {
  if (!cwd?.trim()) return { toolFlags: [], permissionRules: [] }
  const [toolFlags, permissionRules] = await Promise.all([
    listProjectTools(cwd),
    listProjectPermissions(cwd),
  ])
  return { toolFlags, permissionRules }
}

function normalizeCwd(cwd: string | null | undefined): string {
  const trimmed = cwd?.trim()
  return trimmed ? path.resolve(expandHomeLikePath(trimmed)) : process.cwd()
}

function expandHomeLikePath(value: string): string {
  if (value === "~") return process.env.HOME ?? value
  if (value.startsWith("~/"))
    return path.join(process.env.HOME ?? "~", value.slice(2))
  return value
}

function sdkSessionId(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null
  const value = (msg as { session_id?: unknown }).session_id
  return typeof value === "string" && value.length > 0 ? value : null
}

function sdkAssistantUuid(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null
  const record = msg as { type?: unknown; uuid?: unknown }
  if (record.type !== "assistant") return null
  return typeof record.uuid === "string" && record.uuid.length > 0
    ? record.uuid
    : null
}

function isClaudeBinaryRunnable(binaryPath: string | null): boolean {
  const trimmed = binaryPath?.trim() ?? ""
  if (!trimmed || trimmed.includes("\0")) return false
  if (
    path.isAbsolute(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    // The asynchronous command probe is authoritative for path existence and
    // executability. This synchronous predicate performs lexical checks only.
    return true
  }
  // Availability is established by the asynchronous status probe. Keep this
  // synchronous configuration predicate free of child-process detection.
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(trimmed)
}

async function isClaudeBinaryRunnableAsync(
  binaryPath: string | null
): Promise<boolean> {
  if (!isClaudeBinaryRunnable(binaryPath)) return false
  const trimmed = binaryPath!.trim()
  if (
    !path.isAbsolute(trimmed) &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  ) {
    return true
  }
  try {
    await fs.promises.access(
      trimmed,
      process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK
    )
    return true
  } catch {
    return false
  }
}

function normalizeClaudeHome(homePath: string): string {
  const normalized = path.normalize(path.resolve(expandHomePath(homePath)))
  return path.basename(normalized) === ".claude"
    ? path.dirname(normalized)
    : normalized
}

function claudeConfigDir(homePath: string): string {
  const normalized = path.normalize(path.resolve(expandHomePath(homePath)))
  return path.basename(normalized) === ".claude"
    ? normalized
    : path.join(normalized, ".claude")
}

function normalizeExactClaudeConfigDir(configDir: string): string {
  return path.normalize(path.resolve(expandHomePath(configDir)))
}

function awaitPendingClaudeRequest<T>(
  pending: Map<string, (value: T) => void>,
  requestId: string,
  signal: AbortSignal,
  fallback: T,
  publish: () => void
): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      if (pending.get(requestId) === resolver) pending.delete(requestId)
      resolve(value)
    }
    const resolver = (value: T) => finish(value)
    const onAbort = () => finish(fallback)
    const timer = setTimeout(
      () => finish(fallback),
      CLAUDE_PENDING_REQUEST_TIMEOUT_MS
    )
    timer.unref?.()
    pending.set(requestId, resolver)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    if (!settled) {
      try {
        publish()
      } catch (error) {
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        if (pending.get(requestId) === resolver) pending.delete(requestId)
        reject(error)
      }
    }
  })
}

function mergeCustomModels(
  base: ReadonlyArray<ProviderModel>,
  customModels: ReadonlyArray<string>
): ReadonlyArray<ProviderModel> {
  const seen = new Set(base.map((model) => model.slug))
  const out = [...base]
  for (const raw of customModels) {
    const slug = raw.trim()
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    out.push({
      slug,
      name: slug,
      context: "custom",
      tier: "Custom",
      isCustom: true,
      capabilities: base.find((model) => model.capabilities)?.capabilities ?? {
        optionDescriptors: [],
      },
    })
  }
  return out
}
