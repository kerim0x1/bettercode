import { toolNameCategory } from "../tool-name-category"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import net from "node:net"
import {
  getModelSelectionStringOptionValue,
  type ApprovalRequestId,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderAdapterShape,
  type ProviderApprovalDecision,
  type ProviderAgent,
  type ProviderCapabilities,
  type ProviderCatalogEntry,
  type ProviderKind,
  type ProviderModel,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSkill,
  type ProviderSlashCommand,
  type ProviderTool,
  type ProviderThreadSnapshot,
  type ThreadId,
  type TurnId,
} from "../contracts"
import { sanitizedChildEnvironment } from "../../../security/childEnvironment"
import type { EventNdjsonLogger } from "../EventNdjsonLogger"
import { createBetterC0deCompatHttpClient } from "../BetterC0deCompatHttpClient"
import {
  appendBetterC0deAssistantTextDelta,
  buildBetterC0deSessionPermissionRules,
  mergeBetterC0deAssistantText,
  betterC0deQuestionId,
  parseBetterC0deModelSlug,
  toBetterC0dePermissionReply,
  toBetterC0deQuestionAnswers,
} from "./BetterC0deCompatRuntimeSupport"
import {
  listProjectPermissions,
  listProjectTools,
} from "../../../services/workspace"
import {
  pendingRequestKindFromDecisionKind,
  StalePendingProviderRequestError,
} from "../pendingRequestErrors"
import { attachmentMediaType, attachmentName } from "../../attachments"
import { terminateProviderChildProcessTree } from "../ChildProcessTermination"
import {
  appendBoundedProcessOutput,
  createBoundedProcessOutput,
  processOutputLimitError,
} from "../BoundedProcessOutput"
import { prependProviderHistoryForFreshSession } from "../ProviderHistoryPrompt"
import { withDispatchTurnId } from "../dispatchTurnId"
import {
  newCleanupQuarantineState,
  recordCleanupQuarantineFailure,
  retryCleanupQuarantines,
  type CleanupQuarantineState,
} from "../CleanupQuarantine"
import { buildWindowsCmdArgs } from "../../../security/windowsCommandLine"
import { logger } from "../../../observability/logger"
import {
  BETTERC0DE_COMPAT_PROFILE,
  type OpenCodeCompatProfile,
} from "./OpenCodeCompatProfile"

const DEFAULT_HOSTNAME = "127.0.0.1"
const DEFAULT_SERVER_TIMEOUT_MS = 5_000
const METADATA_CACHE_TTL_MS = 5 * 60 * 1000
const METADATA_ERROR_CACHE_TTL_MS = 10 * 1000
const EMPTY_CONFIG_CONTENT = "{}"

// Covers failures before a server connection exists, including version probes.
const compatProcessCleanups = new Map<ChildProcessWithoutNullStreams, {
  failed: boolean
  promise: Promise<void> | null
}>()

async function closeCompatProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  let record = compatProcessCleanups.get(child)
  if (!record) {
    record = { failed: false, promise: null }
    compatProcessCleanups.set(child, record)
  }
  if (record.promise) return record.promise
  if (record.failed && process.platform === "win32" &&
    (child.exitCode !== null || child.signalCode !== null)) {
    throw new Error("Compatibility process descendants remain unconfirmed after the Windows root exited.")
  }
  const operation = terminateProviderChildProcessTree(child)
  record.promise = operation
  try {
    await operation
    compatProcessCleanups.delete(child)
  } catch (error) {
    record.failed = true
    throw error
  } finally {
    if (record.promise === operation) record.promise = null
  }
}

async function retryCompatProcessCleanup(): Promise<void> {
  const results = await Promise.allSettled([...compatProcessCleanups.keys()].map(closeCompatProcess))
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, "Compatibility process cleanup is still unconfirmed.")
}

const CAPABILITIES: ProviderCapabilities = {
  supportsStreaming: true,
  supportsTools: true,
  supportsApprovals: true,
  supportsResume: false,
  managesOwnLifecycle: true,
}

export interface BetterC0deCompatAdapterOptions {
  /**
   * Which OpenCode-family CLI this adapter drives. Defaults to BetterC0de's
   * own compatibility CLI so existing call sites are unchanged. The OpenCode
   * profile selects opencode branding, the v2 inventory envelopes, and the
   * `opencode` provider kind.
   */
  readonly profile?: OpenCodeCompatProfile
  readonly providerInstanceId?: string
  readonly continuationKey?: string
  readonly binaryPath?: string | null
  readonly serverUrl?: string | null
  readonly serverUsername?: string | null
  readonly serverPassword?: string | null
  readonly environment?: ReadonlyArray<{
    readonly name: string
    readonly value: string
  }>
  readonly customModels?: ReadonlyArray<string>
  readonly nativeEventLogger?: EventNdjsonLogger | null
  readonly clientFactory?: BetterC0deClientFactory
  readonly serverConnector?: BetterC0deServerConnector
}

export interface BetterC0deClientFactoryInput {
  readonly baseUrl: string
  readonly directory: string
  readonly serverUsername?: string
  readonly serverPassword?: string
}

export type BetterC0deClientFactory = (
  input: BetterC0deClientFactoryInput,
  profile: OpenCodeCompatProfile
) => Promise<BetterC0deClient> | BetterC0deClient

export interface BetterC0deServerConnection {
  readonly url: string
  readonly external: boolean
  readonly close: () => Promise<void>
  readonly exitCode?: Promise<number>
}

export type BetterC0deServerConnector = (input: {
  readonly binaryPath: string
  readonly serverUrl?: string | null
  readonly env: NodeJS.ProcessEnv
  readonly profile?: OpenCodeCompatProfile
}) => Promise<BetterC0deServerConnection>

interface SessionContext {
  session: ProviderSession
  readonly client: BetterC0deClient
  readonly server: BetterC0deServerConnection
  readonly directory: string
  readonly betterC0deSessionId: string
  readonly eventAbort: AbortController
  readonly pendingPermissions: Map<string, PermissionRequest>
  readonly pendingQuestions: Map<string, QuestionRequest>
  readonly messageRoleById: Map<string, "user" | "assistant">
  readonly partById: Map<string, Part>
  readonly emittedTextByPartId: Map<string, string>
  readonly completedAssistantPartIds: Set<string>
  readonly nextToolCalls: Map<string, BetterC0deNextToolCallState>
  stopped: boolean
  unexpectedExit: boolean
  stopComplete: boolean
  stopPromise: Promise<void> | null
  activeTurnId: TurnId | null
  activeDispatchTurnId: string | null
  activeAgent: string | null
  activeVariant: string | null
  historySeedPending: boolean
}

interface BetterC0deStartSessionInput {
  threadId: ThreadId
  cwd?: string | null
  modelSelection?: ModelSelection | null
  resumeCursor?: unknown | null
  runtimeMode?: string | null
}

interface ServerCleanupContext extends CleanupQuarantineState {
  readonly server: BetterC0deServerConnection
}

interface BetterC0deResult<T> {
  readonly data?: T
}

function resetTransientTurnState(context: SessionContext): void {
  context.messageRoleById.clear()
  context.partById.clear()
  context.emittedTextByPartId.clear()
  context.completedAssistantPartIds.clear()
  context.nextToolCalls.clear()
}

function clearPendingRequests(context: SessionContext): void {
  context.pendingPermissions.clear()
  context.pendingQuestions.clear()
}

interface BetterC0deClient {
  readonly session: {
    create(
      input: Record<string, unknown>
    ): Promise<BetterC0deResult<{ id: string }>>
    promptAsync(input: Record<string, unknown>): Promise<unknown>
    abort(input: { sessionID: string }): Promise<unknown>
    messages(input: { sessionID: string }): Promise<
      BetterC0deResult<
        Array<{
          info: { id: string; role: string }
          parts: unknown[]
        }>
      >
    >
    revert(input: Record<string, unknown>): Promise<unknown>
  }
  readonly event: {
    subscribe(
      parameters?: unknown,
      options?: { readonly signal?: AbortSignal }
    ): Promise<{ readonly stream: AsyncIterable<BetterC0deSdkEvent> }>
  }
  readonly permission: {
    reply(input: {
      requestID: string
      reply: "once" | "always" | "reject"
    }): Promise<unknown>
  }
  readonly question: {
    reply(input: {
      requestID: string
      answers: ReadonlyArray<ReadonlyArray<string>>
    }): Promise<unknown>
    reject(input: { requestID: string }): Promise<unknown>
  }
  readonly provider: {
    list(): Promise<BetterC0deResult<ProviderListResponse>>
  }
  readonly v2?: {
    readonly model: {
      list(parameters?: {
        readonly location?: {
          readonly directory?: string
          readonly workspace?: string
        }
      }): Promise<BetterC0deResult<BetterC0deModelV2[]>>
    }
    readonly provider: {
      list(parameters?: {
        readonly location?: {
          readonly directory?: string
          readonly workspace?: string
        }
      }): Promise<BetterC0deResult<BetterC0deProviderV2[]>>
    }
  }
  readonly app: {
    agents(): Promise<BetterC0deResult<Agent[]>>
    skills(): Promise<
      BetterC0deResult<
        Array<{
          name: string
          description?: string
          location: string
          content?: string
        }>
      >
    >
  }
  readonly command: {
    list(): Promise<
      BetterC0deResult<
        Array<{
          name: string
          description?: string
          hints: string[]
        }>
      >
    >
  }
  readonly tool?: {
    list(parameters: {
      readonly directory?: string
      readonly workspace?: string
      readonly provider: string
      readonly model: string
    }): Promise<BetterC0deResult<BetterC0deToolListItem[]>>
    ids(parameters?: {
      readonly directory?: string
      readonly workspace?: string
    }): Promise<BetterC0deResult<string[]>>
  }
}

interface Agent {
  readonly name: string
  readonly description?: string
  readonly mode: "subagent" | "primary" | "all"
  readonly hidden?: boolean
}

interface ProviderListResponse {
  readonly all: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly source?: string
    readonly env?: ReadonlyArray<string>
    readonly key?: string
    readonly options?: Record<string, unknown>
    readonly models: Record<string, BetterC0deModel>
  }>
  readonly connected: ReadonlyArray<string>
}

interface BetterC0deProviderV2 {
  readonly id: string
  readonly name: string
  readonly enabled:
    | false
    | {
        readonly via: string
        readonly name?: string
        readonly service?: string
        readonly data?: Record<string, unknown>
      }
  readonly env: ReadonlyArray<string>
  readonly endpoint?: {
    readonly type: string
    readonly url?: string
    readonly package?: string
    readonly websocket?: boolean
  }
  /**
   * Current `opencode` replaces the flat `endpoint` object with a nested
   * `api` descriptor on both providers and models. The legacy compatibility
   * CLI keeps `endpoint`, so both are optional and normalised at read time.
   */
  readonly api?: {
    readonly id?: string
    readonly type?: string
    readonly url?: string
    readonly package?: string
    readonly websocket?: boolean
  }
}

interface BetterC0deModelV2 {
  readonly id: string
  readonly apiID?: string
  readonly providerID: string
  readonly family?: string
  readonly name: string
  readonly endpoint?: {
    readonly type: string
    readonly url?: string
    readonly package?: string
    readonly websocket?: boolean
  }
  readonly api?: {
    readonly id?: string
    readonly type?: string
    readonly url?: string
    readonly package?: string
    readonly websocket?: boolean
  }
  readonly variants: ReadonlyArray<{ readonly id: string }>
  readonly time: {
    readonly released: number | string
  }
  readonly cost: ReadonlyArray<{
    readonly input: number
    readonly output: number
    readonly cache: {
      readonly read: number
      readonly write: number
    }
  }>
  readonly status: "alpha" | "beta" | "deprecated" | "active"
  readonly enabled: boolean
  readonly limit: {
    readonly context: number
    readonly input?: number
    readonly output: number
  }
  readonly capabilities?: BetterC0deModelCapabilities
}

interface BetterC0deToolListItem {
  readonly id: string
  readonly description?: string
  readonly parameters?: unknown
}

type BetterC0deModelModalities = ReadonlyArray<string> | Record<string, unknown>

interface BetterC0deModelCapabilities {
  readonly attachment?: boolean
  readonly input?: BetterC0deModelModalities
  readonly output?: BetterC0deModelModalities
}

interface BetterC0deModel {
  readonly id: string
  readonly name: string
  readonly limit: { readonly context: number }
  readonly status: string
  readonly attachment?: boolean
  readonly capabilities?: BetterC0deModelCapabilities
  readonly variants?: Record<string, unknown>
}

interface PermissionRequest {
  readonly id: string
  readonly sessionID: string
  readonly permission: string
  readonly patterns: string[]
  readonly metadata: Record<string, unknown>
}

interface QuestionOption {
  readonly label: string
  readonly description?: string
}

interface QuestionInfo {
  readonly header: string
  readonly question: string
  readonly options: QuestionOption[]
  readonly multiple?: boolean
}

interface QuestionRequest {
  readonly id: string
  readonly sessionID: string
  readonly questions: QuestionInfo[]
}

interface TextPart {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "text"
  readonly text: string
  readonly time?: { readonly start: number; readonly end?: number }
}

interface ReasoningPart {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "reasoning"
  readonly text: string
  readonly time: { readonly start: number; readonly end?: number }
}

interface ToolPart {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "tool"
  readonly callID: string
  readonly tool: string
  readonly state:
    | {
        readonly status: "pending"
        readonly input: Record<string, unknown>
        readonly raw: string
      }
    | {
        readonly status: "running"
        readonly input: Record<string, unknown>
        readonly title?: string
        readonly metadata?: Record<string, unknown>
        readonly time: { readonly start: number }
      }
    | {
        readonly status: "completed"
        readonly input: Record<string, unknown>
        readonly output: string
        readonly title: string
        readonly metadata: Record<string, unknown>
        readonly time: { readonly start: number; readonly end: number }
      }
    | {
        readonly status: "error"
        readonly input: Record<string, unknown>
        readonly error: string
        readonly metadata?: Record<string, unknown>
        readonly time: { readonly start: number; readonly end: number }
      }
}

type Part = TextPart | ReasoningPart | ToolPart

interface BetterC0deNextModelRef {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

interface BetterC0deNextToolContent {
  readonly type: "text" | "file"
  readonly text?: string
  readonly uri?: string
  readonly mime?: string
  readonly name?: string
}

interface BetterC0deNextToolProviderState {
  readonly executed: boolean
  readonly metadata?: Record<string, unknown>
}

interface BetterC0deNextSessionError {
  readonly type?: string
  readonly message?: string
}

interface BetterC0deSnapshotFileDiff {
  readonly file?: string
  readonly patch?: string
  readonly additions: number
  readonly deletions: number
  readonly status?: "added" | "deleted" | "modified"
}

interface BetterC0deTodo {
  readonly content: string
  readonly status: string
  readonly priority: string
}

interface BetterC0deNextRetryError {
  readonly message: string
  readonly statusCode?: number
  readonly isRetryable: boolean
  readonly responseHeaders?: Record<string, string>
  readonly responseBody?: string
  readonly metadata?: Record<string, string>
}

interface BetterC0dePtyInfo {
  readonly id: string
  readonly title: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly status: "running" | "exited"
  readonly pid: number
}

interface BetterC0deSessionInfo {
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly agent?: string
  readonly model?: BetterC0deNextModelRef
  readonly version?: string
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: {
      readonly read: number
      readonly write: number
    }
  }
  readonly summary?: {
    readonly additions: number
    readonly deletions: number
    readonly files: number
    readonly diffs?: ReadonlyArray<BetterC0deSnapshotFileDiff>
  }
}

interface BetterC0dePrompt {
  readonly text: string
  readonly files?: ReadonlyArray<unknown>
  readonly agents?: ReadonlyArray<unknown>
  readonly references?: ReadonlyArray<unknown>
}

interface BetterC0deNextToolCallState {
  readonly callID: string
  toolName?: string
  rawInput?: string
  input?: Record<string, unknown>
  provider?: BetterC0deNextToolProviderState
  startedAt?: number
}

type BetterC0deSdkEvent =
  | {
      readonly id: string
      readonly type: "tui.prompt.append"
      readonly properties: {
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly type: "tui.command.execute"
      readonly properties: {
        readonly command: string
      }
    }
  | {
      readonly id: string
      readonly type: "tui.toast.show"
      readonly properties: {
        readonly title?: string
        readonly message: string
        readonly variant: "info" | "success" | "warning" | "error"
        readonly duration?: number
      }
    }
  | {
      readonly id: string
      readonly type: "tui.session.select"
      readonly properties: {
        readonly sessionID: string
      }
    }
  | {
      readonly id: string
      readonly type: "server.connected"
      readonly properties: Record<string, unknown>
    }
  | {
      readonly id: string
      readonly type: "global.disposed"
      readonly properties: Record<string, unknown>
    }
  | {
      readonly id: string
      readonly type: "server.instance.disposed"
      readonly properties: {
        readonly directory: string
      }
    }
  | {
      readonly id: string
      readonly type: "file.edited"
      readonly properties: {
        readonly file: string
      }
    }
  | {
      readonly id: string
      readonly type: "lsp.client.diagnostics"
      readonly properties: {
        readonly serverID: string
        readonly path: string
      }
    }
  | {
      readonly id: string
      readonly type: "lsp.updated"
      readonly properties: Record<string, unknown>
    }
  | {
      readonly id: string
      readonly type: "message.updated"
      readonly properties: {
        readonly sessionID: string
        readonly info: {
          readonly id: string
          readonly role: "user" | "assistant"
        }
      }
    }
  | {
      readonly id: string
      readonly type: "message.removed"
      readonly properties: {
        readonly sessionID: string
        readonly messageID: string
      }
    }
  | {
      readonly id: string
      readonly type: "message.part.delta"
      readonly properties: {
        readonly sessionID: string
        readonly messageID: string
        readonly partID: string
        readonly field: string
        readonly delta: string
      }
    }
  | {
      readonly id: string
      readonly type: "message.part.updated"
      readonly properties: {
        readonly sessionID: string
        readonly part: Part
        readonly time: number
      }
    }
  | {
      readonly id: string
      readonly type: "message.part.removed"
      readonly properties: {
        readonly sessionID: string
        readonly messageID: string
        readonly partID: string
      }
    }
  | {
      readonly id: string
      readonly type: "permission.asked"
      readonly properties: PermissionRequest
    }
  | {
      readonly id: string
      readonly type: "permission.replied"
      readonly properties: {
        readonly sessionID: string
        readonly requestID: string
        readonly reply: "once" | "always" | "reject"
      }
    }
  | {
      readonly id: string
      readonly type: "question.asked"
      readonly properties: QuestionRequest
    }
  | {
      readonly id: string
      readonly type: "question.replied"
      readonly properties: {
        readonly sessionID: string
        readonly requestID: string
        readonly answers: ReadonlyArray<ReadonlyArray<string>>
      }
    }
  | {
      readonly id: string
      readonly type: "question.rejected"
      readonly properties: {
        readonly sessionID: string
        readonly requestID: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.status"
      readonly properties: {
        readonly sessionID: string
        readonly status:
          | { readonly type: "idle" }
          | { readonly type: "busy" }
          | { readonly type: "retry"; readonly message: string }
      }
    }
  | {
      readonly id: string
      readonly type: "session.idle"
      readonly properties: {
        readonly sessionID: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.diff"
      readonly properties: {
        readonly sessionID: string
        readonly diff: ReadonlyArray<BetterC0deSnapshotFileDiff>
      }
    }
  | {
      readonly id: string
      readonly type: "session.compacted"
      readonly properties: {
        readonly sessionID: string
      }
    }
  | {
      readonly id: string
      readonly type: "todo.updated"
      readonly properties: {
        readonly sessionID: string
        readonly todos: ReadonlyArray<BetterC0deTodo>
      }
    }
  | {
      readonly id: string
      readonly type: "session.created"
      readonly properties: {
        readonly sessionID: string
        readonly info: BetterC0deSessionInfo
      }
    }
  | {
      readonly id: string
      readonly type: "session.updated"
      readonly properties: {
        readonly sessionID: string
        readonly info: BetterC0deSessionInfo
      }
    }
  | {
      readonly id: string
      readonly type: "session.deleted"
      readonly properties: {
        readonly sessionID: string
        readonly info: BetterC0deSessionInfo
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.agent.switched"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly agent: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.model.switched"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly model: BetterC0deNextModelRef
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.prompted"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly prompt: BetterC0dePrompt
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.synthetic"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.step.started"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly agent: string
        readonly model: BetterC0deNextModelRef
        readonly snapshot?: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.step.ended"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly finish: string
        readonly cost: number
        readonly tokens: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: {
            readonly read: number
            readonly write: number
          }
        }
        readonly snapshot?: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.step.failed"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly error: BetterC0deNextSessionError
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.text.started"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.text.delta"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly delta: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.text.ended"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.reasoning.started"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly reasoningID: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.reasoning.delta"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly reasoningID: string
        readonly delta: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.reasoning.ended"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly reasoningID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.tool.input.started"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly name: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.tool.input.delta"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly delta: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.tool.input.ended"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.tool.called"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly tool: string
        readonly input: Record<string, unknown>
        readonly provider: BetterC0deNextToolProviderState
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.tool.progress"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly structured: Record<string, unknown>
        readonly content: ReadonlyArray<BetterC0deNextToolContent>
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.tool.success"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly structured: Record<string, unknown>
        readonly content: ReadonlyArray<BetterC0deNextToolContent>
        readonly provider: BetterC0deNextToolProviderState
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.tool.failed"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly error: BetterC0deNextSessionError
        readonly provider: BetterC0deNextToolProviderState
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.retried"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly attempt: number
        readonly error: BetterC0deNextRetryError
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.compaction.started"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly reason: "auto" | "manual"
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.compaction.delta"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.compaction.ended"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly text: string
        readonly include?: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.shell.started"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly command: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.next.shell.ended"
      readonly properties: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly output: string
      }
    }
  | {
      readonly id: string
      readonly type: "session.error"
      readonly properties: {
        readonly sessionID?: string
        readonly error?: unknown
      }
    }
  | {
      readonly id: string
      readonly type: "file.watcher.updated"
      readonly properties: {
        readonly file: string
        readonly event: "add" | "change" | "unlink"
      }
    }
  | {
      readonly id: string
      readonly type: "project.updated"
      readonly properties: {
        readonly id?: string
        readonly worktree?: string
        readonly commands?: unknown
      }
    }
  | {
      readonly id: string
      readonly type: "catalog.model.updated"
      readonly properties: {
        readonly model: BetterC0deModelV2
      }
    }
  | {
      readonly id: string
      readonly type: "mcp.tools.changed"
      readonly properties: {
        readonly server: string
      }
    }
  | {
      readonly id: string
      readonly type: "mcp.browser.open.failed"
      readonly properties: {
        readonly mcpName: string
        readonly url: string
      }
    }
  | {
      readonly id: string
      readonly type: "command.executed"
      readonly properties: {
        readonly name: string
        readonly sessionID: string
        readonly arguments: string
        readonly messageID: string
      }
    }
  | {
      readonly id: string
      readonly type: "vcs.branch.updated"
      readonly properties: {
        readonly branch?: string
      }
    }
  | {
      readonly id: string
      readonly type: "workspace.ready"
      readonly properties: {
        readonly name: string
      }
    }
  | {
      readonly id: string
      readonly type: "workspace.failed"
      readonly properties: {
        readonly message: string
      }
    }
  | {
      readonly id: string
      readonly type: "workspace.status"
      readonly properties: {
        readonly workspaceID: string
        readonly status: "connected" | "connecting" | "disconnected" | "error"
      }
    }
  | {
      readonly id: string
      readonly type: "worktree.ready"
      readonly properties: {
        readonly name: string
        readonly branch?: string
      }
    }
  | {
      readonly id: string
      readonly type: "worktree.failed"
      readonly properties: {
        readonly message: string
      }
    }
  | {
      readonly id: string
      readonly type: "pty.created"
      readonly properties: {
        readonly info: BetterC0dePtyInfo
      }
    }
  | {
      readonly id: string
      readonly type: "pty.updated"
      readonly properties: {
        readonly info: BetterC0dePtyInfo
      }
    }
  | {
      readonly id: string
      readonly type: "pty.exited"
      readonly properties: {
        readonly id: string
        readonly exitCode: number
      }
    }
  | {
      readonly id: string
      readonly type: "pty.deleted"
      readonly properties: {
        readonly id: string
      }
    }
  | {
      readonly id: string
      readonly type: "installation.updated"
      readonly properties: {
        readonly version: string
      }
    }
  | {
      readonly id: string
      readonly type: "installation.update-available"
      readonly properties: {
        readonly version: string
      }
    }

interface MetadataCache<T> {
  readonly checkedAt: number
  readonly value: T
  /** The value is a fallback recorded after a probe error; expires sooner. */
  readonly error?: true
}

/**
 * A failed probe must not pin its fallback for the full success TTL — a
 * server that was briefly unreachable would show empty catalogs for five
 * minutes. Error results are retried after a short window instead.
 */
function isMetadataCacheFresh(
  cache: { readonly checkedAt: number; readonly error?: true },
  now = Date.now()
): boolean {
  return (
    now - cache.checkedAt <
    (cache.error ? METADATA_ERROR_CACHE_TTL_MS : METADATA_CACHE_TTL_MS)
  )
}

function buildBetterC0dePromptParts(
  input: ProviderSendTurnInput,
  currentPrompt: string
): unknown[] {
  return [
    { type: "text", text: currentPrompt },
    ...(input.attachments ?? []).map((attachment) => ({
      type: "file",
      mime: attachmentMediaType(attachment),
      filename: attachmentName(attachment),
      url: attachment.url,
    })),
  ]
}

export class BetterC0deCompatAdapter implements ProviderAdapterShape {
  readonly provider: ProviderKind
  readonly displayName: string
  readonly capabilities = CAPABILITIES
  private readonly profile: OpenCodeCompatProfile

  private readonly bus = new EventEmitter()
  private readonly sessions = new Map<string, SessionContext>()
  private readonly pendingSessionStarts = new Map<string, {
    controller: AbortController
    promise: Promise<ProviderSession>
  }>()
  private stopAllPromise: Promise<void> | null = null
  private readonly metadataOperations = new Set<Promise<unknown>>()
  private readonly serverCleanupQuarantines = new Map<
    BetterC0deServerConnection,
    ServerCleanupContext
  >()
  private metadataGeneration = 0
  private modelsCache: MetadataCache<ReadonlyArray<ProviderModel>> | null = null
  private skillsCache = new Map<
    string,
    MetadataCache<ReadonlyArray<ProviderSkill>>
  >()
  private commandsCache = new Map<
    string,
    MetadataCache<ReadonlyArray<ProviderSlashCommand>>
  >()
  private agentsCache = new Map<
    string,
    MetadataCache<ReadonlyArray<ProviderAgent>>
  >()
  private providerCatalogCache = new Map<
    string,
    MetadataCache<ReadonlyArray<ProviderCatalogEntry>>
  >()
  private toolsCache = new Map<
    string,
    MetadataCache<ReadonlyArray<ProviderTool>>
  >()

  constructor(private readonly options: BetterC0deCompatAdapterOptions = {}) {
    this.profile = options.profile ?? BETTERC0DE_COMPAT_PROFILE
    this.provider = this.profile.providerKind
    this.displayName = this.profile.displayName
  }

  isConfigured(): boolean {
    // Reachability is verified asynchronously by probeStatus. This predicate
    // only reports whether the instance has a configured transport. An
    // explicitly empty binaryPath means "cleared by the user" and does not
    // fall back to the profile's default binary.
    const explicitBinaryPath =
      this.options.binaryPath === undefined
        ? this.profile.defaultBinaryPath
        : (this.options.binaryPath ?? "").trim()
    return Boolean(this.serverUrl() || explicitBinaryPath)
  }

  probeStatus(input: { readonly cwd?: string | null } = {}) {
    return this.trackMetadataOperation(() => this.probeStatusInternal(input))
  }

  private async probeStatusInternal(input: { readonly cwd?: string | null } = {}): Promise<{
    readonly configured: boolean
    readonly installed: boolean
    readonly version: string | null
    readonly status: "ready" | "warning" | "error"
    readonly auth: {
      readonly status: "authenticated" | "unauthenticated" | "unknown"
      readonly type?: string
    }
    readonly message?: string
  }> {
    const cwd = normalizeCwd(input.cwd)
    const isExternalServer = Boolean(this.serverUrl())
    let version: string | null = null

    if (!isExternalServer) {
      const versionResult = await runBetterC0deCommand(
        this.binaryPath(),
        this.profile.versionArgs,
        this.makeEnvironment(),
        this.brand()
      ).catch((error: unknown) => ({ error }))
      if ("error" in versionResult) {
        const failure = formatBetterC0deProbeError({
          cause: versionResult.error,
          isExternalServer,
          brand: this.brand(),
        })
        return {
          configured: false,
          installed: failure.installed,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: failure.message,
        }
      }

      version = parseGenericCliVersion(
        `${versionResult.stdout}\n${versionResult.stderr}`
      )
      const minimumVersion = this.profile.minimumVersion
      if (!version && minimumVersion) {
        return {
          configured: false,
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: `Unable to determine ${this.brand()} version from \`${this.binaryPath()} --version\` output. ${this.brand()} requires v${minimumVersion} or newer.`,
        }
      }
      if (
        minimumVersion &&
        version &&
        compareSemverVersions(version, minimumVersion) < 0
      ) {
        return {
          configured: false,
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: `${this.brand()} v${version} is too old. Upgrade to v${minimumVersion} or newer.`,
        }
      }
    }

    try {
      const inventory = await this.loadInventory(cwd)
      const connectedCount = inventory.providerList.connected.length
      const source = isExternalServer
        ? "the configured compatibility server"
        : `${this.brand()} Compat`
      return {
        configured: connectedCount > 0,
        installed: true,
        version,
        status: connectedCount > 0 ? "ready" : "warning",
        auth: {
          status: connectedCount > 0 ? "authenticated" : "unknown",
          type: "betterc0de",
        },
        message:
          connectedCount > 0
            ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${source}.`
            : isExternalServer
              ? "Connected to the configured compatibility server, but it did not report any connected upstream providers."
              : `${this.brand()} compatibility is available, but it did not report any connected upstream providers.`,
      }
    } catch (error) {
      const failure = formatBetterC0deProbeError({
        cause: error,
        isExternalServer,
        brand: this.brand(),
      })
      return {
        configured: false,
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      }
    }
  }

  availableModels(input: { readonly force?: boolean } = {}) {
    return this.trackMetadataOperation(() => this.availableModelsInternal(input))
  }

  private async availableModelsInternal(
    input: { readonly force?: boolean } = {}
  ): Promise<ReadonlyArray<ProviderModel>> {
    const generation = this.metadataGeneration
    const now = Date.now()
    if (
      !input.force &&
      this.modelsCache &&
      isMetadataCacheFresh(this.modelsCache, now)
    ) {
      return this.modelsCache.value
    }

    const fallback = mergeCustomModels(
      defaultBetterC0deModels(),
      this.options.customModels ?? []
    )
    if (!this.isConfigured()) {
      // "Not configured" changes the moment the user fills in a server URL
      // or binary path; pin the fallback for the short error TTL, not the
      // five-minute success TTL, so the real catalog shows up promptly.
      if (generation === this.metadataGeneration) this.modelsCache = { checkedAt: now, value: fallback, error: true }
      return fallback
    }

    try {
      const inventory = await this.loadInventory(process.cwd())
      const live = flattenBetterC0deModels(inventory)
      const models =
        live.length > 0
          ? mergeCustomModels(live, this.options.customModels ?? [])
          : fallback
      if (generation === this.metadataGeneration) this.modelsCache = { checkedAt: Date.now(), value: models }
      return models
    } catch (error) {
      logger.warn({ err: error }, `${this.brand()} model inventory probe failed`)
      if (generation === this.metadataGeneration) this.modelsCache = { checkedAt: Date.now(), value: fallback, error: true }
      return fallback
    }
  }

  private trackMetadataOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopAllPromise) return Promise.reject(new Error(`${this.brand()} shutdown is in progress.`))
    // Register before yielding so retirement also owns probes awaiting their
    // first native version check or temporary server connection.
    const pending = Promise.resolve().then(operation)
    this.metadataOperations.add(pending)
    return pending.finally(() => { this.metadataOperations.delete(pending) })
  }

  private storeMetadata<T>(
    cache: Map<string, MetadataCache<T>>,
    cwd: string,
    generation: number,
    value: MetadataCache<T>,
  ): void {
    if (generation !== this.metadataGeneration) return
    cache.delete(cwd)
    cache.set(cwd, value)
    while (cache.size > 64) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  invalidateMetadata(input: { readonly cwd?: string | null } = {}): void {
    this.metadataGeneration += 1
    this.modelsCache = null
    if (input.cwd === undefined) {
      this.skillsCache.clear()
      this.commandsCache.clear()
      this.agentsCache.clear()
      this.providerCatalogCache.clear()
      this.toolsCache.clear()
      return
    }
    const cwd = normalizeCwd(input.cwd)
    this.skillsCache.delete(cwd)
    this.commandsCache.delete(cwd)
    this.agentsCache.delete(cwd)
    this.providerCatalogCache.delete(cwd)
    this.toolsCache.delete(cwd)
  }

  availableProviderCatalog(input: { readonly cwd?: string | null; readonly force?: boolean } = {}) {
    return this.trackMetadataOperation(() => this.availableProviderCatalogInternal(input))
  }

  private async availableProviderCatalogInternal(
    input: { readonly cwd?: string | null; readonly force?: boolean } = {}
  ): Promise<ReadonlyArray<ProviderCatalogEntry>> {
    if (!this.isConfigured()) return []
    const generation = this.metadataGeneration
    const cwd = normalizeCwd(input.cwd)
    const cached = this.providerCatalogCache.get(cwd)
    if (
      !input.force &&
      cached &&
      isMetadataCacheFresh(cached)
    ) {
      return cached.value
    }

    try {
      const inventory = await this.loadInventory(cwd)
      const catalog = betterC0deProviderCatalog(inventory)
      this.storeMetadata(this.providerCatalogCache, cwd, generation, {
        checkedAt: Date.now(),
        value: catalog,
      })
      return catalog
    } catch (error) {
      logger.warn({ err: error, cwd }, `${this.brand()} provider catalog probe failed`)
      this.storeMetadata(this.providerCatalogCache, cwd, generation, {
        checkedAt: Date.now(),
        value: [],
        error: true,
      })
      return []
    }
  }

  availableAgents(input: { readonly cwd?: string | null; readonly force?: boolean } = {}) {
    return this.trackMetadataOperation(() => this.availableAgentsInternal(input))
  }

  private async availableAgentsInternal(
    input: { readonly cwd?: string | null; readonly force?: boolean } = {}
  ): Promise<ReadonlyArray<ProviderAgent>> {
    if (!this.isConfigured()) return []
    const generation = this.metadataGeneration
    const cwd = normalizeCwd(input.cwd)
    const cached = this.agentsCache.get(cwd)
    if (
      !input.force &&
      cached &&
      isMetadataCacheFresh(cached)
    ) {
      return cached.value
    }

    try {
      const inventory = await this.loadInventory(cwd)
      const agents = betterC0deProviderAgents(inventory.agents)
      this.storeMetadata(this.agentsCache, cwd, generation, { checkedAt: Date.now(), value: agents })
      return agents
    } catch (error) {
      logger.warn({ err: error, cwd }, `${this.brand()} agents probe failed`)
      this.storeMetadata(this.agentsCache, cwd, generation, { checkedAt: Date.now(), value: [], error: true })
      return []
    }
  }

  availableTools(input: { readonly cwd?: string | null; readonly force?: boolean } = {}) {
    return this.trackMetadataOperation(() => this.availableToolsInternal(input))
  }

  private async availableToolsInternal(
    input: { readonly cwd?: string | null; readonly force?: boolean } = {}
  ): Promise<ReadonlyArray<ProviderTool>> {
    if (!this.isConfigured()) return []
    const generation = this.metadataGeneration
    const cwd = normalizeCwd(input.cwd)
    const cached = this.toolsCache.get(cwd)
    if (
      !input.force &&
      cached &&
      isMetadataCacheFresh(cached)
    ) {
      return cached.value
    }

    try {
      const inventory = await this.loadInventory(cwd)
      const tools = betterC0deProviderTools(inventory)
      this.storeMetadata(this.toolsCache, cwd, generation, { checkedAt: Date.now(), value: tools })
      return tools
    } catch (error) {
      logger.warn({ err: error, cwd }, `${this.brand()} tools probe failed`)
      this.storeMetadata(this.toolsCache, cwd, generation, { checkedAt: Date.now(), value: [], error: true })
      return []
    }
  }

  availableSkills(input: { readonly cwd?: string | null; readonly force?: boolean } = {}) {
    return this.trackMetadataOperation(() => this.availableSkillsInternal(input))
  }

  private async availableSkillsInternal(
    input: { readonly cwd?: string | null; readonly force?: boolean } = {}
  ): Promise<ReadonlyArray<ProviderSkill>> {
    if (!this.isConfigured()) return []
    const generation = this.metadataGeneration
    const cwd = normalizeCwd(input.cwd)
    const cached = this.skillsCache.get(cwd)
    if (
      !input.force &&
      cached &&
      isMetadataCacheFresh(cached)
    ) {
      return cached.value
    }

    try {
      const { client, server } = await this.createTemporaryClient(cwd)
      try {
        const result = await client.app.skills()
        const skills = (
          (result.data ?? []) as Array<{
            name: string
            description?: string
            location: string
          }>
        ).map((skill) => ({
          name: skill.name,
          displayName: skill.name,
          description: skill.description,
          shortDescription: skill.description,
          path: skill.location,
          scope: "betterc0de",
          enabled: true,
        }))
        this.storeMetadata(this.skillsCache, cwd, generation, { checkedAt: Date.now(), value: skills })
        return skills
      } finally {
        await this.closeTrackedServer(server)
      }
    } catch (error) {
      logger.warn({ err: error, cwd }, `${this.brand()} skills probe failed`)
      this.storeMetadata(this.skillsCache, cwd, generation, { checkedAt: Date.now(), value: [], error: true })
      return []
    }
  }

  availableSlashCommands(input: { readonly cwd?: string | null; readonly force?: boolean } = {}) {
    return this.trackMetadataOperation(() => this.availableSlashCommandsInternal(input))
  }

  private async availableSlashCommandsInternal(
    input: { readonly cwd?: string | null; readonly force?: boolean } = {}
  ): Promise<ReadonlyArray<ProviderSlashCommand>> {
    if (!this.isConfigured()) return []
    const generation = this.metadataGeneration
    const cwd = normalizeCwd(input.cwd)
    const cached = this.commandsCache.get(cwd)
    if (
      !input.force &&
      cached &&
      isMetadataCacheFresh(cached)
    ) {
      return cached.value
    }

    try {
      const { client, server } = await this.createTemporaryClient(cwd)
      try {
        const result = await client.command.list()
        const commands = (
          (result.data ?? []) as Array<{
            name: string
            description?: string
            hints?: string[]
          }>
        ).map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.hints?.[0] ? { input: { hint: command.hints[0] } } : {}),
        }))
        this.storeMetadata(this.commandsCache, cwd, generation, { checkedAt: Date.now(), value: commands })
        return commands
      } finally {
        await this.closeTrackedServer(server)
      }
    } catch (error) {
      logger.warn({ err: error, cwd }, `${this.brand()} slash command probe failed`)
      this.storeMetadata(this.commandsCache, cwd, generation, {
        checkedAt: Date.now(),
        value: [],
        error: true,
      })
      return []
    }
  }

  async startSession(input: BetterC0deStartSessionInput): Promise<ProviderSession> {
    const key = input.threadId as string
    if (this.stopAllPromise || this.pendingSessionStarts.has(key)) {
      throw new Error(`${this.brand()} session startup is already pending or shutdown is in progress.`)
    }
    const controller = new AbortController()
    const promise = this.startSessionInternal(input, controller.signal)
    const pending = { controller, promise }
    this.pendingSessionStarts.set(key, pending)
    try {
      return await promise
    } finally {
      if (this.pendingSessionStarts.get(key) === pending) this.pendingSessionStarts.delete(key)
    }
  }

  private async startSessionInternal(
    input: BetterC0deStartSessionInput,
    signal: AbortSignal,
  ): Promise<ProviderSession> {
    const key = input.threadId as string
    const existing = this.sessions.get(key)
    if (existing) {
      await this.stopContext(existing, "Session replaced.", "graceful")
      if (this.sessions.get(key) === existing) this.sessions.delete(key)
    }

    const directory = normalizeCwd(input.cwd)
    const server = await this.connectServer(signal)
    let client: BetterC0deClient | null = null
    try {
      throwIfCompatStartupCancelled(signal)
      client = await this.createClient({
        baseUrl: server.url,
        directory,
        ...(server.external && this.serverPassword()
          ? {
              serverUsername: this.serverUsername(),
              serverPassword: this.serverPassword() ?? undefined,
            }
          : {}),
      })
      throwIfCompatStartupCancelled(signal)
      const [projectToolFlags, projectPermissionRules] =
        await loadBetterC0deProjectPermissionInputs(directory)
      throwIfCompatStartupCancelled(signal)
      const created = await client.session.create({
        title: `${this.brand()} ${key}`,
        permission: buildBetterC0deSessionPermissionRules({
          runtimeMode: input.runtimeMode,
          projectToolFlags,
          projectPermissionRules,
        }) as never,
      })
      throwIfCompatStartupCancelled(signal)
      const betterC0deSession = unwrapData<{ id: string }>(
        created,
        `${this.brand()} session.create returned no session payload.`
      )
      if (!betterC0deSession || typeof betterC0deSession.id !== "string" || !betterC0deSession.id.trim()) {
        throw new Error(`${this.brand()} session.create returned an invalid session ID.`)
      }
      const now = Date.now()
      const runtimeMode = normalizeProviderRuntimeMode(input.runtimeMode)
      const session: ProviderSession = {
        threadId: key,
        providerInstanceId: this.providerInstanceId(),
        providerThreadId: betterC0deSession.id,
        resumeCursor: null,
        continuationKey: this.continuationKey(),
        status: "ready",
        cwd: directory,
        activeTurnId: null,
        runtimeMode,
        createdAt: now,
        updatedAt: now,
      }
      const context: SessionContext = {
        session,
        client,
        server,
        directory,
        betterC0deSessionId: betterC0deSession.id,
        eventAbort: new AbortController(),
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        messageRoleById: new Map(),
        partById: new Map(),
        emittedTextByPartId: new Map(),
        completedAssistantPartIds: new Set(),
        nextToolCalls: new Map(),
        stopped: false,
        unexpectedExit: false,
        stopComplete: false,
        stopPromise: null,
        activeTurnId: null,
        activeDispatchTurnId: null,
        activeAgent: null,
        activeVariant: null,
        historySeedPending: true,
      }
      this.sessions.set(key, context)
      this.startEventPump(context)
      this.emitEvent({
        ...this.eventBase(key),
        type: "session.started",
        payload: { message: `${this.brand()} session started` },
      })
      this.emitEvent({
        ...this.eventBase(key),
        type: "thread.started",
        payload: { providerThreadId: betterC0deSession.id },
      })
      return session
    } catch (err) {
      const published = this.sessions.get(key)
      if (published?.server === server) {
        published.stopped = true
        published.eventAbort.abort()
        this.sessions.delete(key)
      }
      try {
        await this.closeTrackedServer(server)
      } catch (cleanupError) {
        throw new AggregateError(
          [err, cleanupError],
          `${this.brand()} session startup failed and its server cleanup also failed.`
        )
      }
      throw err
    }
  }

  async listSessions(): Promise<ReadonlyArray<ProviderSession>> {
    return Array.from(this.sessions.values()).map((context) => context.session)
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const key = input.threadId as string
    const context = this.ensureContext(key)
    const turnId = `${this.taskId("turn")}-${randomUUID()}` as TurnId
    const modelSelection =
      input.modelSelection ??
      ({
        instanceId: this.providerInstanceId(),
        model: input.modelId,
      } satisfies ModelSelection)
    if (
      modelSelection.instanceId &&
      modelSelection.instanceId !== this.providerInstanceId()
    ) {
      throw new Error(
        `${this.brand()} model selection is bound to instance '${modelSelection.instanceId}', expected '${this.providerInstanceId()}'.`
      )
    }
    const parsedModel = parseBetterC0deModelSlug(modelSelection.model)
    if (!parsedModel) {
      throw new Error(
        `${this.brand()} model selection must use the 'provider/model' format.`
      )
    }

    const text = input.message.trim()
    if (text.length === 0) {
      throw new Error(`${this.brand()} compatibility turns require text input.`)
    }

    context.activeTurnId = turnId
    context.activeDispatchTurnId = input.dispatchTurnId ?? null
    context.activeAgent =
      getModelSelectionStringOptionValue(modelSelection, "agent") ??
      (await this.resolveAgentForChatMode(context.directory, input.chatMode))
    if (context.stopped || this.sessions.get(key) !== context || context.activeTurnId !== turnId) {
      throw new Error(`${this.brand()} turn was stopped or cancelled during agent discovery.`)
    }
    context.activeVariant =
      getModelSelectionStringOptionValue(modelSelection, "variant") ?? null
    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
    })
    this.emitEvent({
      ...this.eventBase(key),
      turnId,
      type: "turn.started",
      payload: {
        model: modelSelection.model,
        ...(context.activeVariant ? { effort: context.activeVariant } : {}),
      },
    })

    try {
      if (context.stopped || this.sessions.get(key) !== context || context.activeTurnId !== turnId) {
        throw new Error(`${this.brand()} turn was stopped or cancelled before prompt dispatch.`)
      }
      const currentPrompt = prependProviderHistoryForFreshSession({
        history: input.history,
        currentPrompt: input.message,
        resumed: !context.historySeedPending,
      })
      await context.client.session.promptAsync({
        sessionID: context.betterC0deSessionId,
        model: parsedModel,
        ...(context.activeAgent ? { agent: context.activeAgent } : {}),
        ...(context.activeVariant ? { variant: context.activeVariant } : {}),
        parts: buildBetterC0dePromptParts(input, currentPrompt),
      })
      context.historySeedPending = false
    } catch (err) {
      if (context.stopped || context.activeTurnId !== turnId) throw err
      const publicMessage = `${this.brand()} compatibility provider turn failed.`
      context.activeTurnId = null
      context.activeAgent = null
      context.activeVariant = null
      clearPendingRequests(context)
      resetTransientTurnState(context)
      this.updateSession(context, {
        status: "ready",
        activeTurnId: null,
      })
      this.emitEvent({
        ...this.eventBase(key),
        turnId,
        type: "turn.aborted",
        payload: { reason: publicMessage },
      })
      throw err
    }
  }

  private async resolveAgentForChatMode(
    cwd: string,
    chatMode: string | null | undefined
  ): Promise<string | null> {
    if (chatMode === "plan") return "plan"
    if (chatMode !== "ask" && chatMode !== "security" && chatMode !== "debug") {
      return null
    }

    const agents = await this.availableAgents({ cwd })
    const modeAgent = agents.find(
      (agent) =>
        agent.name === chatMode &&
        !agent.hidden &&
        (agent.mode === "primary" || agent.mode === "all")
    )
    return modeAgent?.name ?? null
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const context = this.sessions.get(threadId as string)
    if (!context) return
    await context.client.session.abort({
      sessionID: context.betterC0deSessionId,
    })
    const turnId = context.activeTurnId
    context.activeTurnId = null
    context.activeAgent = null
    context.activeVariant = null
    clearPendingRequests(context)
    resetTransientTurnState(context)
    this.updateSession(context, { status: "ready", activeTurnId: null })
    if (turnId) {
      this.emitEvent({
        ...this.eventBase(threadId as string),
        turnId,
        type: "turn.aborted",
        payload: { reason: "Interrupted by user." },
      })
    }
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision
  ): Promise<void> {
    const context = this.ensureContext(threadId as string)
    const key = requestId as string
    if (decision.kind === "tool_approval") {
      if (!context.pendingPermissions.has(key)) {
        throw new StalePendingProviderRequestError("approval", requestId)
      }
      await context.client.permission.reply({
        requestID: key,
        reply: toBetterC0dePermissionReply(decision),
      })
      return
    }

    const request = context.pendingQuestions.get(key)
    if (!request) {
      throw new StalePendingProviderRequestError(
        pendingRequestKindFromDecisionKind(decision.kind),
        requestId
      )
    }
    if (decision.kind === "user_input_reject") {
      await context.client.question.reject({
        requestID: key,
      })
      return
    }
    if (decision.kind !== "user_input") {
      // plan_approval is Claude-runtime-only; this adapter never opens one.
      throw new StalePendingProviderRequestError(
        pendingRequestKindFromDecisionKind(decision.kind),
        requestId
      )
    }
    await context.client.question.reply({
      requestID: key,
      answers: toBetterC0deQuestionAnswers(request, decision.answers) as never,
    })
  }

  async readThread(threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    const context = this.ensureContext(threadId as string)
    const messages = await context.client.session.messages({
      sessionID: context.betterC0deSessionId,
    })
    const data = (messages.data ?? []) as Array<{
      info: { id: string; role: string }
      parts: unknown[]
    }>
    return {
      threadId,
      turns: data
        .filter((entry) => entry.info.role === "assistant")
        .map((entry) => ({
          id: entry.info.id as TurnId,
          items: [entry.info, ...entry.parts],
        })),
    }
  }

  async rollbackThread(
    threadId: ThreadId,
    numTurns: number
  ): Promise<ProviderThreadSnapshot> {
    const context = this.ensureContext(threadId as string)
    const messages = await context.client.session.messages({
      sessionID: context.betterC0deSessionId,
    })
    const assistantMessages = (
      (messages.data ?? []) as Array<{
        info: { id: string; role: string }
      }>
    ).filter((entry) => entry.info.role === "assistant")
    const targetIndex = assistantMessages.length - numTurns - 1
    const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null
    await context.client.session.revert({
      sessionID: context.betterC0deSessionId,
      ...(target ? { messageID: target.info.id } : {}),
    })
    return this.readThread(threadId)
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const key = threadId as string
    const pending = this.pendingSessionStarts.get(key)
    if (pending) {
      pending.controller.abort()
      await pending.promise.catch((error) => {
        if (this.serverCleanupQuarantines.size > 0 || compatProcessCleanups.size > 0) throw error
      })
    }
    const context = this.sessions.get(key)
    if (!context) return
    await this.stopContext(context, "Session stopped.", "graceful")
    if (this.sessions.get(key) === context) {
      this.sessions.delete(key)
    }
  }

  hasSession(threadId: ThreadId): boolean {
    const context = this.sessions.get(threadId as string)
    return Boolean(context && !context.unexpectedExit)
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.bus.on("event", listener)
    return () => this.bus.off("event", listener)
  }

  stopAll(): Promise<void> {
    if (this.stopAllPromise) return this.stopAllPromise
    const operation = Promise.resolve().then(() => this.stopAllInternal())
    this.stopAllPromise = operation
    return operation.finally(() => {
      if (this.stopAllPromise === operation) this.stopAllPromise = null
    })
  }

  private async stopAllInternal(): Promise<void> {
    const pending = [...this.pendingSessionStarts.values()]
    for (const entry of pending) entry.controller.abort()
    await Promise.allSettled([
      ...pending.map((entry) => entry.promise),
      ...this.metadataOperations,
    ])
    const keys = Array.from(this.sessions.keys())
    const quarantines = Array.from(this.serverCleanupQuarantines.values())
    const results = await Promise.allSettled(
      keys.map((key) => this.stopSession(key as ThreadId))
    )
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    const cleanupResults = await Promise.allSettled(
      quarantines
        .filter(
          (context) =>
            this.serverCleanupQuarantines.get(context.server) === context
        )
        .map((context) => this.closeTrackedServer(context.server))
    )
    failures.push(
      ...cleanupResults.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      )
    )
    try {
      await retryCompatProcessCleanup()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to stop all ${this.brand()} compatibility sessions`
      )
    }
  }

  private async loadInventory(cwd: string): Promise<BetterC0deInventory> {
    const { client, server } = await this.createTemporaryClient(cwd)
    try {
      const [providerList, agents, providerV2List, modelV2List, toolIDs] =
        await Promise.all([
          client.provider
            .list()
            .then((result: BetterC0deResult<ProviderListResponse>) =>
              unwrapData<ProviderListResponse>(
                result,
                `${this.brand()} provider.list returned no payload.`
              )
            ),
          client.app
            .agents()
            .then((result: BetterC0deResult<Agent[]>) => result.data ?? []),
          client.v2?.provider
            .list({ location: { directory: cwd } })
            .then(
              (result: BetterC0deResult<BetterC0deProviderV2[]>) =>
                result.data ?? []
            )
            .catch(() => Promise.resolve([])) ?? Promise.resolve([]),
          client.v2?.model
            .list({ location: { directory: cwd } })
            .then(
              (result: BetterC0deResult<BetterC0deModelV2[]>) =>
                result.data ?? []
            )
            .catch(() => Promise.resolve([])) ?? Promise.resolve([]),
          client.tool
            ?.ids({ directory: cwd })
            .then((result: BetterC0deResult<string[]>) => result.data ?? [])
            .catch(() => Promise.resolve([])) ?? Promise.resolve([]),
        ])
      const tools =
        (await this.loadToolList(client, cwd, providerList, modelV2List)) ?? []
      return {
        providerList,
        agents,
        providerV2List,
        modelV2List,
        toolIDs,
        tools,
      }
    } finally {
      await this.closeTrackedServer(server)
    }
  }

  private async loadToolList(
    client: BetterC0deClient,
    cwd: string,
    providerList: ProviderListResponse,
    modelV2List: ReadonlyArray<BetterC0deModelV2>
  ): Promise<ReadonlyArray<BetterC0deToolListItem>> {
    if (!client.tool?.list) return []
    const target = selectBetterC0deToolCatalogTarget(providerList, modelV2List)
    if (!target) return []
    try {
      const result = await client.tool.list({
        directory: cwd,
        provider: target.providerID,
        model: target.modelID,
      })
      return result.data ?? []
    } catch {
      return []
    }
  }

  private async createTemporaryClient(cwd: string): Promise<{
    readonly client: BetterC0deClient
    readonly server: BetterC0deServerConnection
  }> {
    const server = await this.connectServer()
    try {
      const client = await this.createClient({
        baseUrl: server.url,
        directory: cwd,
        ...(server.external && this.serverPassword()
          ? {
              serverUsername: this.serverUsername(),
              serverPassword: this.serverPassword() ?? undefined,
            }
          : {}),
      })
      return { client, server }
    } catch (err) {
      try {
        await this.closeTrackedServer(server)
      } catch (cleanupError) {
        throw new AggregateError(
          [err, cleanupError],
          `${this.brand()} temporary client creation failed and its server cleanup also failed.`
        )
      }
      throw err
    }
  }

  private async connectServer(signal?: AbortSignal): Promise<BetterC0deServerConnection> {
    try {
      await this.closeAllServerCleanupQuarantines()
    } catch (error) {
      throw Object.assign(
        new Error(
          `${this.brand()} server admission is quarantined until prior cleanup succeeds.`,
          { cause: error }
        ),
        {
          code: "BETTERC0DE_SERVER_CLEANUP_QUARANTINED",
          statusCode: 503,
        }
      )
    }
    if (signal) throwIfCompatStartupCancelled(signal)
    const connector = this.options.serverConnector ?? connectBetterC0deServer
    return connector({
      binaryPath: this.binaryPath(),
      serverUrl: this.serverUrl(),
      env: this.makeEnvironment(),
      profile: this.profile,
    })
  }

  private async createClient(
    input: BetterC0deClientFactoryInput
  ): Promise<BetterC0deClient> {
    const factory = this.options.clientFactory ?? defaultBetterC0deClientFactory
    return factory(input, this.profile)
  }

  private startEventPump(context: SessionContext): void {
    void (async () => {
      try {
        const subscription = await context.client.event.subscribe(undefined, {
          signal: context.eventAbort.signal,
        })
        for await (const event of subscription.stream as AsyncIterable<BetterC0deSdkEvent>) {
          if (context.stopped || context.eventAbort.signal.aborted) break
          this.handleSubscribedEvent(context, event)
        }
        if (!context.stopped && !context.eventAbort.signal.aborted) {
          await this.emitUnexpectedExit(
            context,
            `${this.brand()} compatibility event stream ended unexpectedly.`
          )
        }
      } catch {
        if (context.stopped || context.eventAbort.signal.aborted) return
        await this.emitUnexpectedExit(
          context,
          `${this.brand()} compatibility event stream failed.`
        )
      }
    })()

    if (!context.server.external && context.server.exitCode) {
      void context.server.exitCode.then(async (code) => {
        if (context.stopped) return
        await this.emitUnexpectedExit(
          context,
          `compatibility server exited unexpectedly (${code}).`
        )
      })
    }
  }

  private handleSubscribedEvent(
    context: SessionContext,
    event: BetterC0deSdkEvent
  ): void {
    this.writeNativeEvent(context, event, context.activeTurnId ?? undefined)
    if (this.handleWorkspaceEvent(context, event)) return

    // Everything below is scoped to the session this context subscribed.
    // The compat CLI and current `opencode` both stamp the session id on
    // the event envelope (`properties.sessionID`), but current `opencode`
    // can also nest it inside `info`/`part` for message events.
    if (
      readEventSessionId(event.properties) !== context.betterC0deSessionId
    ) {
      return
    }

    if (this.handleMessageEvent(context, event)) return
    if (this.handleRequestEvent(context, event)) return
    if (this.handleSessionEvent(context, event)) return
    this.handleNextTurnEvent(context, event)
  }

  /**
   * Events that are not scoped to one session: catalogs, MCP tools, the
   * file watcher, project and workspace state, PTYs, installation and
   * server lifecycle. They arrive on every subscription and are handled
   * before the session filter.
   *
   * Returns whether the event was one of these.
   */
  private handleWorkspaceEvent(
    context: SessionContext,
    event: BetterC0deSdkEvent
  ): boolean {
    const threadId = context.session.threadId
    const turnId = context.activeTurnId ?? undefined
    if (event.type === "catalog.model.updated") {
      this.metadataGeneration += 1
      this.modelsCache = null
      this.providerCatalogCache.clear()
      this.toolsCache.clear()
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "provider.metadata.changed",
        payload: {
          providerKind: this.provider,
          providerInstanceId: this.providerInstanceId(),
          metadataKind: "models",
          summary: `${this.brand()} model catalog changed.`,
          cwd: context.directory,
        },
      })
      return true
    }

    if (event.type === "mcp.tools.changed") {
      this.metadataGeneration += 1
      this.toolsCache.delete(context.directory)
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "provider.metadata.changed",
        payload: {
          providerKind: this.provider,
          providerInstanceId: this.providerInstanceId(),
          metadataKind: "tools",
          summary: `${this.brand()} compatibility MCP tools changed.`,
          details: event.properties.server,
          cwd: context.directory,
        },
      })
      return true
    }

    if (event.type === "file.watcher.updated") {
      const change = betterC0deMetadataChangeFromFile(
        event.properties.file,
        event.properties.event
      )
      if (!change) return true
      this.invalidateMetadata({ cwd: context.directory })
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "provider.metadata.changed",
        payload: {
          providerKind: this.provider,
          providerInstanceId: this.providerInstanceId(),
          metadataKind: change.metadataKind,
          summary: change.summary,
          details: event.properties.file,
          cwd: context.directory,
        },
      })
      return true
    }

    if (event.type === "project.updated") {
      const worktree =
        typeof event.properties.worktree === "string"
          ? event.properties.worktree
          : undefined
      if (worktree && !betterC0dePathsOverlap(worktree, context.directory))
        return true
      this.invalidateMetadata({ cwd: context.directory })
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "provider.metadata.changed",
        payload: {
          providerKind: this.provider,
          providerInstanceId: this.providerInstanceId(),
          metadataKind: "all",
          summary: `${this.brand()} project metadata changed.`,
          ...(worktree ? { details: worktree } : {}),
          cwd: context.directory,
        },
      })
      return true
    }

    if (event.type === "tui.prompt.append") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "task.progress",
        payload: {
          taskId: "betterc0de-tui-prompt",
          description: `${this.brand()} compatibility TUI prompt updated.`,
          summary: betterC0deEventSummary(
            event.properties.text,
            "Prompt updated."
          ),
        },
      })
      return true
    }

    if (event.type === "tui.command.execute") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "task.completed",
        payload: {
          taskId: `${this.taskId("tui-command")}:${event.id}`,
          status: "completed",
          summary: `${this.brand()} compatibility TUI command: ${event.properties.command}`,
        },
      })
      return true
    }

    if (event.type === "tui.toast.show") {
      if (event.properties.variant === "error") {
        this.emitEvent({
          ...this.eventBase(threadId),
          raw: { source: this.rawSource(), payload: event },
          type: "runtime.error",
          payload: {
            message: event.properties.message,
            class: "provider_error",
            detail: event.properties,
          },
        })
        return true
      }
      if (event.properties.variant === "warning") {
        this.emitEvent({
          ...this.eventBase(threadId),
          raw: { source: this.rawSource(), payload: event },
          type: "runtime.warning",
          willRetry: false,
          payload: {
            message: event.properties.message,
            detail: event.properties,
          },
        })
        return true
      }
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "task.completed",
        payload: {
          taskId: `${this.taskId("tui-toast")}:${event.id}`,
          status: "completed",
          summary: event.properties.title
            ? `${event.properties.title}: ${event.properties.message}`
            : event.properties.message,
        },
      })
      return true
    }

    if (event.type === "tui.session.select") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "session.configured",
        payload: {
          config: {
            selectedSession: event.properties.sessionID,
          },
        },
      })
      return true
    }

    if (event.type === "installation.updated") {
      this.invalidateMetadata({ cwd: context.directory })
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "provider.metadata.changed",
        payload: {
          providerKind: this.provider,
          providerInstanceId: this.providerInstanceId(),
          metadataKind: "all",
          summary: `${this.brand()} compatibility installation updated to ${event.properties.version}.`,
          details: event.properties.version,
          cwd: context.directory,
        },
      })
      return true
    }

    if (event.type === "installation.update-available") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "runtime.warning",
        willRetry: false,
        payload: {
          message: `${this.brand()} compatibility ${event.properties.version} is available.`,
          detail: event.properties,
        },
      })
      return true
    }

    if (event.type === "mcp.browser.open.failed") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "runtime.warning",
        willRetry: false,
        payload: {
          message: `${this.brand()} compatibility MCP browser open failed for ${event.properties.mcpName}.`,
          detail: event.properties,
        },
      })
      return true
    }

    if (event.type === "server.connected") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "session.configured",
        payload: {
          config: {
            server: "connected",
            source: "betterc0de",
          },
        },
      })
      return true
    }

    if (event.type === "global.disposed") {
      this.updateSession(context, { status: "stopped", activeTurnId: null })
      this.retireDisposedContext(context)
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "session.exited",
        payload: {
          reason: `${this.brand()} compatibility global runtime disposed.`,
          recoverable: true,
          exitKind: "graceful",
        },
      })
      return true
    }

    if (event.type === "server.instance.disposed") {
      if (
        !betterC0dePathsOverlap(event.properties.directory, context.directory)
      )
        return true
      this.updateSession(context, { status: "stopped", activeTurnId: null })
      this.retireDisposedContext(context)
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "session.exited",
        payload: {
          reason: "compatibility server instance disposed.",
          recoverable: true,
          exitKind: "graceful",
        },
      })
      return true
    }

    if (event.type === "file.edited") {
      this.emitEvent({
        ...this.eventBase(threadId),
        turnId,
        itemId: `${this.taskId("file")}:${event.properties.file}`,
        raw: { source: this.rawSource(), payload: event },
        type: "item.completed",
        payload: {
          itemType: "file_change",
          status: "completed",
          title: "File edited",
          detail: event.properties.file,
          input: { path: event.properties.file },
          output: event.properties.file,
          data: { file: event.properties.file },
        },
      })
      return true
    }

    if (event.type === "vcs.branch.updated") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "session.configured",
        payload: {
          config: {
            vcs: {
              branch: event.properties.branch ?? null,
            },
          },
        },
      })
      return true
    }

    if (event.type === "workspace.status") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "task.progress",
        payload: {
          taskId: `${this.taskId("workspace")}:${event.properties.workspaceID}`,
          description: `${this.brand()} compatibility workspace ${event.properties.status}.`,
          summary: event.properties.status,
        },
      })
      return true
    }

    if (event.type === "workspace.ready") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "task.completed",
        payload: {
          taskId: `${this.taskId("workspace")}:${event.properties.name}`,
          status: "completed",
          summary: `${this.brand()} compatibility workspace ${event.properties.name} is ready.`,
        },
      })
      return true
    }

    if (event.type === "workspace.failed") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "runtime.error",
        payload: {
          message: event.properties.message,
          class: "provider_error",
          detail: event.properties,
        },
      })
      return true
    }

    if (event.type === "worktree.ready") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "task.completed",
        payload: {
          taskId: `${this.taskId("worktree")}:${event.properties.name}`,
          status: "completed",
          summary: event.properties.branch
            ? `${this.brand()} compatibility worktree ${event.properties.name} is ready on ${event.properties.branch}.`
            : `${this.brand()} compatibility worktree ${event.properties.name} is ready.`,
        },
      })
      return true
    }

    if (event.type === "worktree.failed") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "runtime.error",
        payload: {
          message: event.properties.message,
          class: "provider_error",
          detail: event.properties,
        },
      })
      return true
    }

    if (event.type === "pty.created") {
      const pty = event.properties.info
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "task.started",
        payload: {
          taskId: `${this.taskId("pty")}:${pty.id}`,
          taskType: "pty",
          description: betterC0dePtySummary(pty),
        },
      })
      return true
    }

    if (event.type === "pty.updated") {
      const pty = event.properties.info
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "task.progress",
        payload: {
          taskId: `${this.taskId("pty")}:${pty.id}`,
          description: betterC0dePtySummary(pty),
          summary: pty.status,
        },
      })
      return true
    }

    if (event.type === "pty.exited") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "task.completed",
        payload: {
          taskId: `${this.taskId("pty")}:${event.properties.id}`,
          status: event.properties.exitCode === 0 ? "completed" : "failed",
          summary: `${this.brand()} compatibility PTY exited with code ${event.properties.exitCode}.`,
        },
      })
      return true
    }

    if (event.type === "pty.deleted") {
      this.emitEvent({
        ...this.eventBase(threadId),
        raw: { source: this.rawSource(), payload: event },
        type: "task.completed",
        payload: {
          taskId: `${this.taskId("pty")}:${event.properties.id}`,
          status: "stopped",
          summary: `${this.brand()} compatibility PTY deleted.`,
        },
      })
      return true
    }

    return false
  }

  /**
   * Message lifecycle: the assistant message and its parts (text, tool
   * calls, reasoning, file changes).
   *
   * Returns whether the event belonged to this family.
   */
  private handleMessageEvent(
    context: SessionContext,
    event: BetterC0deSdkEvent
  ): boolean {
    const threadId = context.session.threadId
    const turnId = context.activeTurnId ?? undefined
    switch (event.type) {
      case "message.updated": {
        context.messageRoleById.set(
          event.properties.info.id,
          event.properties.info.role
        )
        if (event.properties.info.role === "assistant") {
          for (const part of context.partById.values()) {
            if (part.messageID === event.properties.info.id) {
              this.emitAssistantTextDelta(context, part, turnId, event)
            }
          }
        }
        break
      }
      case "message.removed": {
        context.messageRoleById.delete(event.properties.messageID)
        break
      }
      case "message.part.delta": {
        const existingPart = context.partById.get(event.properties.partID)
        if (
          !existingPart ||
          messageRoleForPart(context, existingPart) !== "assistant"
        ) {
          break
        }
        const delta = event.properties.delta
        if (delta.length === 0) break
        const previousText =
          context.emittedTextByPartId.get(event.properties.partID) ??
          textFromPart(existingPart) ??
          ""
        const { nextText, deltaToEmit } = appendBetterC0deAssistantTextDelta(
          previousText,
          delta
        )
        if (deltaToEmit.length === 0) break
        context.emittedTextByPartId.set(event.properties.partID, nextText)
        if (existingPart.type === "text" || existingPart.type === "reasoning") {
          context.partById.set(event.properties.partID, {
            ...existingPart,
            text: nextText,
          })
        }
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId,
          itemId: event.properties.partID,
          raw: { source: this.rawSource(), payload: event },
          type: "content.delta",
          payload: {
            streamKind: resolveTextStreamKind(existingPart),
            delta: deltaToEmit,
          },
        })
        break
      }
      case "message.part.updated": {
        const part = event.properties.part
        context.partById.set(part.id, part)
        if (messageRoleForPart(context, part) === "assistant") {
          this.emitAssistantTextDelta(context, part, turnId, event)
        }
        if (part.type === "tool") {
          const detail = detailFromToolPart(part)
          const title = titleFromToolPart(part)
          const input = inputFromToolPart(part)
          const output = outputFromToolPart(part)
          const metadata = metadataFromToolPart(part)
          this.emitEvent({
            ...this.eventBase(threadId, toolStateCreatedAt(part)),
            turnId,
            itemId: part.callID,
            raw: { source: this.rawSource(), payload: event },
            type:
              part.state.status === "pending"
                ? "item.started"
                : part.state.status === "completed" ||
                    part.state.status === "error"
                  ? "item.completed"
                  : "item.updated",
            payload: {
              itemType: toToolLifecycleItemType(part.tool),
              status: toToolLifecycleStatus(part.state.status),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              ...(input !== undefined ? { input } : {}),
              ...(output !== undefined ? { output } : {}),
              data: {
                tool: part.tool,
                toolName: part.tool,
                state: part.state,
                ...(input !== undefined ? { input } : {}),
                ...(output !== undefined ? { output } : {}),
                ...(metadata ? { metadata } : {}),
              },
            },
          })
        }
        break
      }
      case "message.part.removed": {
        context.partById.delete(event.properties.partID)
        context.emittedTextByPartId.delete(event.properties.partID)
        context.completedAssistantPartIds.delete(event.properties.partID)
        break
      }
      default:
        return false
    }
    return true
  }

  /**
   * Permission and question requests raised by the agent and their
   * answers.
   *
   * Returns whether the event belonged to this family.
   */
  private handleRequestEvent(
    context: SessionContext,
    event: BetterC0deSdkEvent
  ): boolean {
    const threadId = context.session.threadId
    const turnId = context.activeTurnId ?? undefined
    switch (event.type) {
      case "permission.asked": {
        context.pendingPermissions.set(event.properties.id, event.properties)
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId,
          requestId: event.properties.id,
          raw: { source: this.rawSource(), payload: event },
          type: "request.opened",
          payload: {
            requestType: mapPermissionToRequestType(
              event.properties.permission
            ),
            detail:
              event.properties.patterns.length > 0
                ? event.properties.patterns.join("\n")
                : event.properties.permission,
            args: event.properties.metadata,
          },
        })
        break
      }
      case "permission.replied": {
        context.pendingPermissions.delete(event.properties.requestID)
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId,
          requestId: event.properties.requestID,
          raw: { source: this.rawSource(), payload: event },
          type: "request.resolved",
          payload: {
            requestType: "unknown",
            decision: mapPermissionDecision(event.properties.reply),
          },
        })
        break
      }
      case "question.asked": {
        context.pendingQuestions.set(event.properties.id, event.properties)
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId,
          requestId: event.properties.id,
          raw: { source: this.rawSource(), payload: event },
          type: "user-input.requested",
          payload: {
            questions: normalizeQuestionRequest(event.properties),
          },
        })
        break
      }
      case "question.replied": {
        const request = context.pendingQuestions.get(event.properties.requestID)
        context.pendingQuestions.delete(event.properties.requestID)
        const answers = Object.fromEntries(
          (request?.questions ?? []).map((question, index) => [
            betterC0deQuestionId(index, question),
            event.properties.answers[index]?.join(", ") ?? "",
          ])
        )
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId,
          requestId: event.properties.requestID,
          raw: { source: this.rawSource(), payload: event },
          type: "user-input.resolved",
          payload: { answers },
        })
        break
      }
      case "question.rejected": {
        context.pendingQuestions.delete(event.properties.requestID)
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId,
          requestId: event.properties.requestID,
          raw: { source: this.rawSource(), payload: event },
          type: "user-input.resolved",
          payload: { answers: {} },
        })
        break
      }
      default:
        return false
    }
    return true
  }

  /**
   * Session-level state: status, idle, diffs, compaction, todos, commands
   * and the session's own lifecycle and errors.
   *
   * Returns whether the event belonged to this family.
   */
  private handleSessionEvent(
    context: SessionContext,
    event: BetterC0deSdkEvent
  ): boolean {
    const threadId = context.session.threadId
    const turnId = context.activeTurnId ?? undefined
    switch (event.type) {
      case "command.executed": {
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId,
          itemId: event.properties.messageID,
          raw: { source: this.rawSource(), payload: event },
          type: "item.completed",
          payload: {
            itemType: "dynamic_tool_call",
            status: "completed",
            title: `/${event.properties.name}`,
            ...(event.properties.arguments
              ? { detail: event.properties.arguments }
              : {}),
            input: {
              command: event.properties.name,
              arguments: event.properties.arguments,
            },
            output: event.properties.arguments,
            data: {
              command: event.properties.name,
              arguments: event.properties.arguments,
              messageID: event.properties.messageID,
            },
          },
        })
        break
      }
      case "session.status": {
        if (event.properties.status.type === "busy") {
          this.updateSession(context, {
            status: "running",
            activeTurnId: context.activeTurnId,
          })
        } else if (event.properties.status.type === "retry") {
          this.emitEvent({
            ...this.eventBase(threadId),
            turnId,
            raw: { source: this.rawSource(), payload: event },
            type: "runtime.warning",
            willRetry: true,
            payload: {
              message: event.properties.status.message,
              detail: event.properties.status,
            },
          })
        } else if (
          event.properties.status.type === "idle" &&
          context.activeTurnId
        ) {
          const completedTurnId = context.activeTurnId
          context.activeTurnId = null
          context.activeAgent = null
          context.activeVariant = null
          resetTransientTurnState(context)
          this.updateSession(context, { status: "ready", activeTurnId: null })
          this.emitEvent({
            ...this.eventBase(threadId),
            turnId: completedTurnId,
            raw: { source: this.rawSource(), payload: event },
            type: "turn.completed",
            payload: { state: "completed" },
          })
        }
        break
      }
      case "session.idle": {
        if (!context.activeTurnId) break
        const completedTurnId = context.activeTurnId
        context.activeTurnId = null
        context.activeAgent = null
        context.activeVariant = null
        resetTransientTurnState(context)
        this.updateSession(context, { status: "ready", activeTurnId: null })
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId: completedTurnId,
          raw: { source: this.rawSource(), payload: event },
          type: "turn.completed",
          payload: { state: "completed" },
        })
        break
      }
      case "session.diff": {
        const files = betterC0deDiffFiles(event.properties.diff)
        const unifiedDiff = betterC0deUnifiedDiff(event.properties.diff)
        if (!unifiedDiff && files.length === 0) break
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId,
          itemId: event.id,
          raw: { source: this.rawSource(), payload: event },
          type: "turn.diff.updated",
          payload: {
            unifiedDiff,
            ...(files.length > 0 ? { files } : {}),
          },
        })
        break
      }
      case "session.compacted": {
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "task.completed",
          payload: {
            taskId: `${this.taskId("compaction")}:${context.betterC0deSessionId}`,
            status: "completed",
            summary: `${this.brand()} compatibility compacted the session context.`,
          },
        })
        break
      }
      case "todo.updated": {
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "turn.plan.updated",
          payload: {
            explanation: `${this.brand()} compatibility task list updated.`,
            plan: event.properties.todos.map((todo) => ({
              step: todo.content,
              status: betterC0deTodoStatus(todo.status),
            })),
          },
        })
        break
      }
      case "session.created": {
        this.emitEvent({
          ...this.eventBase(threadId),
          raw: { source: this.rawSource(), payload: event },
          type: "session.state.changed",
          payload: {
            state: "ready",
            reason: `${this.brand()} session created.`,
            detail: betterC0deSessionConfig(event.properties.info),
          },
        })
        this.emitBetterC0deSessionMetadata(context, event)
        break
      }
      case "session.updated": {
        this.emitEvent({
          ...this.eventBase(threadId),
          raw: { source: this.rawSource(), payload: event },
          type: "session.configured",
          payload: {
            config: betterC0deSessionConfig(event.properties.info),
          },
        })
        this.emitBetterC0deSessionMetadata(context, event)
        this.emitBetterC0deSessionUsage(context, event)
        break
      }
      case "session.deleted": {
        this.updateSession(context, { status: "stopped", activeTurnId: null })
        this.retireDisposedContext(context)
        this.emitEvent({
          ...this.eventBase(threadId),
          raw: { source: this.rawSource(), payload: event },
          type: "session.exited",
          payload: {
            reason: `${this.brand()} session deleted.`,
            recoverable: false,
            exitKind: "graceful",
          },
        })
        break
      }
      case "session.error": {
        const message = sessionErrorMessage(event.properties.error, this.brand())
        const activeTurnId = context.activeTurnId
        context.activeTurnId = null
        context.activeAgent = null
        context.activeVariant = null
        clearPendingRequests(context)
        resetTransientTurnState(context)
        this.updateSession(context, { status: "error", activeTurnId: null })
        if (activeTurnId) {
          this.emitEvent({
            ...this.eventBase(threadId),
            turnId: activeTurnId,
            raw: { source: this.rawSource(), payload: event },
            type: "turn.completed",
            payload: { state: "failed", errorMessage: message },
          })
        }
        this.emitEvent({
          ...this.eventBase(threadId),
          raw: { source: this.rawSource(), payload: event },
          type: "runtime.error",
          payload: {
            message,
            class: "provider_error",
            detail: event.properties.error,
          },
        })
        break
      }
      default:
        return false
    }
    return true
  }

  /**
   * The `session.next.*` turn stream: agent and model switches, steps,
   * text and reasoning deltas, tool calls, retries, compaction and shells.
   *
   * Returns whether the event belonged to this family.
   */
  private handleNextTurnEvent(
    context: SessionContext,
    event: BetterC0deSdkEvent
  ): boolean {
    const threadId = context.session.threadId
    const turnId = context.activeTurnId ?? undefined
    switch (event.type) {
      case "session.next.agent.switched": {
        context.activeAgent = event.properties.agent
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "session.configured",
          payload: {
            config: {
              agent: event.properties.agent,
            },
          },
        })
        break
      }
      case "session.next.model.switched": {
        context.activeVariant = event.properties.model.variant ?? null
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "session.configured",
          payload: {
            config: {
              model: event.properties.model,
            },
          },
        })
        break
      }
      case "session.next.prompted": {
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "thread.metadata.updated",
          payload: {
            metadata: {
              [this.metadataNamespace()]: {
                prompt: event.properties.prompt,
              },
            },
          },
        })
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "task.completed",
          payload: {
            taskId: `${this.taskId("prompt")}:${event.id}`,
            status: "completed",
            summary: betterC0deEventSummary(
              event.properties.prompt.text,
              `${this.brand()} compatibility prompt submitted.`
            ),
          },
        })
        break
      }
      case "session.next.synthetic": {
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "task.completed",
          payload: {
            taskId: `${this.taskId("synthetic")}:${event.id}`,
            status: "completed",
            summary: betterC0deEventSummary(
              event.properties.text,
              `${this.brand()} compatibility synthetic prompt injected.`
            ),
          },
        })
        break
      }
      case "session.next.step.started": {
        context.activeAgent = event.properties.agent
        context.activeVariant = event.properties.model.variant ?? null
        this.updateSession(context, {
          status: "running",
          activeTurnId: context.activeTurnId,
        })
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "session.configured",
          payload: {
            config: {
              agent: event.properties.agent,
              model: event.properties.model,
              ...(event.properties.snapshot
                ? { snapshot: event.properties.snapshot }
                : {}),
            },
          },
        })
        break
      }
      case "session.next.step.ended": {
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "token.usage",
          usage: {
            inputTokens: event.properties.tokens.input,
            outputTokens: event.properties.tokens.output,
            totalTokens:
              event.properties.tokens.input +
              event.properties.tokens.output +
              event.properties.tokens.reasoning,
            reasoningOutputTokens: event.properties.tokens.reasoning,
            cachedInputTokens:
              event.properties.tokens.cache.read +
              event.properties.tokens.cache.write,
            cacheReadTokens: event.properties.tokens.cache.read,
            cacheCreationTokens: event.properties.tokens.cache.write,
            totalCostUsd: event.properties.cost,
          },
        })
        break
      }
      case "session.next.step.failed": {
        const message =
          event.properties.error.message ??
          `${this.brand()} compatibility step failed.`
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "runtime.error",
          payload: {
            message,
            class: "provider_error",
            detail: event.properties.error,
          },
        })
        break
      }
      case "session.next.text.delta": {
        if (event.properties.delta.length === 0) break
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          itemId: event.id,
          raw: { source: this.rawSource(), payload: event },
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: event.properties.delta,
          },
        })
        break
      }
      case "session.next.text.ended": {
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          itemId: event.id,
          raw: { source: this.rawSource(), payload: event },
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(event.properties.text ? { detail: event.properties.text } : {}),
          },
        })
        break
      }
      case "session.next.reasoning.delta": {
        if (event.properties.delta.length === 0) break
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          itemId: event.properties.reasoningID,
          raw: { source: this.rawSource(), payload: event },
          type: "reasoning.delta",
          payload: {
            streamKind: "reasoning_text",
            delta: event.properties.delta,
          },
        })
        break
      }
      case "session.next.reasoning.ended": {
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          itemId: event.properties.reasoningID,
          raw: { source: this.rawSource(), payload: event },
          type: "item.completed",
          payload: {
            itemType: "reasoning",
            status: "completed",
            title: "Reasoning",
            ...(event.properties.text ? { detail: event.properties.text } : {}),
          },
        })
        break
      }
      case "session.next.tool.input.started": {
        const state: BetterC0deNextToolCallState = {
          callID: event.properties.callID,
          toolName: event.properties.name,
          rawInput: "",
          startedAt: event.properties.timestamp,
        }
        context.nextToolCalls.set(event.properties.callID, state)
        this.emitNextToolItem(context, event, {
          lifecycle: "item.started",
          status: "pending",
          toolName: event.properties.name,
          detail: event.properties.name,
          data: { rawInput: "" },
        })
        break
      }
      case "session.next.tool.input.delta": {
        const state = this.ensureNextToolCallState(
          context,
          event.properties.callID
        )
        state.rawInput = `${state.rawInput ?? ""}${event.properties.delta}`
        this.emitNextToolItem(context, event, {
          lifecycle: "item.updated",
          status: "pending",
          toolName: state.toolName,
          detail: state.rawInput,
          data: { rawInput: state.rawInput },
        })
        break
      }
      case "session.next.tool.input.ended": {
        const state = this.ensureNextToolCallState(
          context,
          event.properties.callID
        )
        state.rawInput = event.properties.text
        this.emitNextToolItem(context, event, {
          lifecycle: "item.updated",
          status: "pending",
          toolName: state.toolName,
          detail: event.properties.text,
          data: { rawInput: event.properties.text },
        })
        break
      }
      case "session.next.tool.called": {
        const state = this.ensureNextToolCallState(
          context,
          event.properties.callID
        )
        state.toolName = event.properties.tool
        state.input = event.properties.input
        state.provider = event.properties.provider
        this.emitNextToolItem(context, event, {
          lifecycle: "item.updated",
          status: "running",
          toolName: event.properties.tool,
          input: event.properties.input,
          data: {
            provider: event.properties.provider,
          },
        })
        break
      }
      case "session.next.tool.progress": {
        const state = this.ensureNextToolCallState(
          context,
          event.properties.callID
        )
        const detail = betterC0deNextToolContentText(event.properties.content)
        this.emitNextToolItem(context, event, {
          lifecycle: "item.updated",
          status: "running",
          toolName: state.toolName,
          output: detail || event.properties.structured,
          detail,
          data: {
            structured: event.properties.structured,
            content: event.properties.content,
          },
        })
        break
      }
      case "session.next.tool.success": {
        const state = this.ensureNextToolCallState(
          context,
          event.properties.callID
        )
        state.provider = event.properties.provider
        const detail = betterC0deNextToolContentText(event.properties.content)
        this.emitNextToolItem(context, event, {
          lifecycle: "item.completed",
          status: "completed",
          toolName: state.toolName,
          input: state.input,
          output: detail || event.properties.structured,
          detail,
          data: {
            structured: event.properties.structured,
            content: event.properties.content,
            provider: event.properties.provider,
          },
        })
        context.nextToolCalls.delete(event.properties.callID)
        break
      }
      case "session.next.tool.failed": {
        const state = this.ensureNextToolCallState(
          context,
          event.properties.callID
        )
        state.provider = event.properties.provider
        const detail =
          event.properties.error.message ??
          `${this.brand()} compatibility tool failed.`
        this.emitNextToolItem(context, event, {
          lifecycle: "item.completed",
          status: "failed",
          toolName: state.toolName,
          input: state.input,
          output: detail,
          detail,
          data: {
            error: event.properties.error,
            provider: event.properties.provider,
          },
        })
        context.nextToolCalls.delete(event.properties.callID)
        break
      }
      case "session.next.retried": {
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "runtime.warning",
          willRetry: event.properties.error.isRetryable,
          payload: {
            message: event.properties.error.message,
            detail: {
              attempt: event.properties.attempt,
              ...event.properties.error,
            },
          },
        })
        break
      }
      case "session.next.compaction.started": {
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "task.started",
          payload: {
            taskId: `${this.taskId("compaction")}:${context.betterC0deSessionId}`,
            taskType: "context_compaction",
            description: `${this.brand()} compatibility context compaction started (${event.properties.reason}).`,
          },
        })
        break
      }
      case "session.next.compaction.delta": {
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "task.progress",
          payload: {
            taskId: `${this.taskId("compaction")}:${context.betterC0deSessionId}`,
            description:
              `${this.brand()} compatibility context compaction in progress.`,
            summary: event.properties.text,
          },
        })
        break
      }
      case "session.next.compaction.ended": {
        this.emitEvent({
          ...this.eventBase(
            threadId,
            isoFromEpochMs(event.properties.timestamp)
          ),
          turnId,
          raw: { source: this.rawSource(), payload: event },
          type: "task.completed",
          payload: {
            taskId: `${this.taskId("compaction")}:${context.betterC0deSessionId}`,
            status: "completed",
            ...(event.properties.text
              ? { summary: event.properties.text }
              : {}),
          },
        })
        break
      }
      case "session.next.shell.started": {
        const state: BetterC0deNextToolCallState = {
          callID: event.properties.callID,
          toolName: "bash",
          input: { command: event.properties.command },
          startedAt: event.properties.timestamp,
        }
        context.nextToolCalls.set(event.properties.callID, state)
        this.emitNextToolItem(context, event, {
          lifecycle: "item.started",
          status: "running",
          toolName: "bash",
          input: { command: event.properties.command },
          detail: event.properties.command,
        })
        break
      }
      case "session.next.shell.ended": {
        const state = this.ensureNextToolCallState(
          context,
          event.properties.callID
        )
        this.emitNextToolItem(context, event, {
          lifecycle: "item.completed",
          status: "completed",
          toolName: state.toolName ?? "bash",
          input: state.input,
          output: event.properties.output,
          detail: event.properties.output,
        })
        context.nextToolCalls.delete(event.properties.callID)
        break
      }
      default:
        return false
    }
    return true
  }

  private ensureNextToolCallState(
    context: SessionContext,
    callID: string
  ): BetterC0deNextToolCallState {
    const existing = context.nextToolCalls.get(callID)
    if (existing) return existing
    const state: BetterC0deNextToolCallState = { callID }
    context.nextToolCalls.set(callID, state)
    return state
  }

  private emitBetterC0deSessionMetadata(
    context: SessionContext,
    event: Extract<
      BetterC0deSdkEvent,
      { readonly type: "session.created" | "session.updated" }
    >
  ): void {
    const metadata = betterC0deSessionConfig(event.properties.info)
    if (Object.keys(metadata).length === 0 && !event.properties.info.title)
      return
    this.emitEvent({
      ...this.eventBase(context.session.threadId),
      raw: { source: this.rawSource(), payload: event },
      type: "thread.metadata.updated",
      payload: {
        ...(event.properties.info.title
          ? { name: event.properties.info.title }
          : {}),
        metadata: {
          [this.metadataNamespace()]: metadata,
        },
      },
    })
  }

  private emitBetterC0deSessionUsage(
    context: SessionContext,
    event: Extract<BetterC0deSdkEvent, { readonly type: "session.updated" }>
  ): void {
    const tokens = event.properties.info.tokens
    if (!tokens) return
    this.emitEvent({
      ...this.eventBase(context.session.threadId),
      raw: { source: this.rawSource(), payload: event },
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: tokens.input + tokens.output + tokens.reasoning,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          reasoningOutputTokens: tokens.reasoning,
          cachedInputTokens: tokens.cache.read + tokens.cache.write,
        },
      },
    })
  }

  private emitNextToolItem(
    context: SessionContext,
    event: BetterC0deSdkEvent & {
      readonly properties: {
        readonly callID: string
        readonly timestamp: number
      }
    },
    input: {
      readonly lifecycle: "item.started" | "item.updated" | "item.completed"
      readonly status: "pending" | "running" | "completed" | "failed"
      readonly toolName?: string
      readonly detail?: string
      readonly input?: Record<string, unknown>
      readonly output?: unknown
      readonly data?: Record<string, unknown>
    }
  ): void {
    const threadId = context.session.threadId
    const turnId = context.activeTurnId ?? undefined
    const state = this.ensureNextToolCallState(context, event.properties.callID)
    const toolName = input.toolName ?? state.toolName ?? "tool"
    const toolInput = input.input ?? state.input
    const detail =
      input.detail ??
      betterC0deNextToolDetail(
        toolName,
        toolInput,
        input.output,
        state.rawInput
      )
    const payload = {
      itemType: toToolLifecycleItemType(toolName),
      status: input.status,
      title: titleCaseSlug(toolName),
      ...(detail ? { detail } : {}),
      ...(toolInput !== undefined ? { input: toolInput } : {}),
      ...(input.output !== undefined ? { output: input.output } : {}),
      data: {
        tool: toolName,
        toolName,
        callID: event.properties.callID,
        ...(state.rawInput !== undefined ? { rawInput: state.rawInput } : {}),
        ...(toolInput !== undefined ? { input: toolInput } : {}),
        ...(input.output !== undefined ? { output: input.output } : {}),
        ...(state.provider ? { provider: state.provider } : {}),
        ...(input.data ?? {}),
      },
    }

    this.emitEvent({
      ...this.eventBase(threadId, isoFromEpochMs(event.properties.timestamp)),
      turnId,
      itemId: event.properties.callID,
      raw: { source: this.rawSource(), payload: event },
      type: input.lifecycle,
      payload,
    })
  }

  private emitAssistantTextDelta(
    context: SessionContext,
    part: Part,
    turnId: TurnId | undefined,
    rawEvent: BetterC0deSdkEvent
  ): void {
    const text = textFromPart(part)
    if (text === undefined) return
    const previousText = context.emittedTextByPartId.get(part.id)
    const { latestText, deltaToEmit } = mergeBetterC0deAssistantText(
      previousText,
      text
    )
    context.emittedTextByPartId.set(part.id, latestText)
    if (
      latestText !== text &&
      (part.type === "text" || part.type === "reasoning")
    ) {
      context.partById.set(part.id, { ...part, text: latestText })
    }
    if (deltaToEmit.length > 0) {
      this.emitEvent({
        ...this.eventBase(context.session.threadId, textPartStartedAt(part)),
        turnId,
        itemId: part.id,
        raw: { source: this.rawSource(), payload: rawEvent },
        type: "content.delta",
        payload: {
          streamKind: resolveTextStreamKind(part),
          delta: deltaToEmit,
        },
      })
    }
    if (
      part.type === "text" &&
      part.time?.end !== undefined &&
      !context.completedAssistantPartIds.has(part.id)
    ) {
      context.completedAssistantPartIds.add(part.id)
      this.emitEvent({
        ...this.eventBase(
          context.session.threadId,
          isoFromEpochMs(part.time.end)
        ),
        turnId,
        itemId: part.id,
        raw: { source: this.rawSource(), payload: rawEvent },
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(latestText.length > 0 ? { detail: latestText } : {}),
        },
      })
    }
  }

  private async emitUnexpectedExit(
    context: SessionContext,
    message: string
  ): Promise<void> {
    if (context.stopped) return
    context.stopped = true
    context.unexpectedExit = true
    const turnId = context.activeTurnId ?? undefined
    this.emitEvent({
      ...this.eventBase(context.session.threadId),
      turnId,
      type: "runtime.error",
      payload: { message, class: "transport_error" },
    })
    try {
      await this.stopContext(context, message, "error")
      if (this.sessions.get(context.session.threadId) === context) {
        this.sessions.delete(context.session.threadId)
      }
    } catch {
      // The exact context and tracked server remain authoritative quarantine
      // records. stopSession/stopAll/a later connection retries the cleanup.
    }
  }

  private async stopContext(
    context: SessionContext,
    reason: string,
    exitKind: "graceful" | "error"
  ): Promise<void> {
    if (context.stopComplete) return
    if (context.stopPromise) return context.stopPromise
    context.stopped = true
    context.eventAbort.abort()
    const stopPromise = (async () => {
      await context.client.session
        .abort({ sessionID: context.betterC0deSessionId })
        .catch(() => {})
      await this.closeTrackedServer(context.server)
      context.stopComplete = true
      this.emitEvent({
        ...this.eventBase(context.session.threadId),
        type: "session.exited",
        payload: {
          reason,
          recoverable: false,
          exitKind,
        },
      })
    })()
    context.stopPromise = stopPromise
    try {
      await stopPromise
    } finally {
      context.stopPromise = null
    }
  }

  private async closeTrackedServer(
    server: BetterC0deServerConnection
  ): Promise<void> {
    let context = this.serverCleanupQuarantines.get(server)
    if (!context) {
      context = { server, ...newCleanupQuarantineState() }
      this.serverCleanupQuarantines.set(server, context)
    }
    if (context.closePromise) return await context.closePromise
    const closePromise = server.close()
    context.closePromise = closePromise
    try {
      await closePromise
      context.closeFailure = null
      this.serverCleanupQuarantines.delete(server)
    } catch (error) {
      recordCleanupQuarantineFailure(context, error)
      throw error
    } finally {
      if (context.closePromise === closePromise) {
        context.closePromise = null
      }
    }
  }

  /**
   * Re-attempts every quarantined close. An entry past its retry window is
   * released only by a confirmed close; otherwise it stays quarantined (see
   * `retryCleanupQuarantines`) — a server nobody confirmed dead must not be
   * forgotten just because it has been failing for a while.
   */
  private async closeAllServerCleanupQuarantines(): Promise<void> {
    const contexts = Array.from(this.serverCleanupQuarantines.values())
    if (contexts.length === 0) return
    const failures = await retryCleanupQuarantines({
      contexts,
      close: (context) => this.closeTrackedServer(context.server),
      label: `${this.brand()} server`,
      logger,
    })
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to clean up quarantined ${this.brand()} servers`
      )
    }
  }

  private ensureContext(threadId: string): SessionContext {
    const context = this.sessions.get(threadId)
    if (!context || context.stopped) {
      throw new Error(`${this.brand()} session not found for thread ${threadId}`)
    }
    return context
  }

  /**
   * The provider told us this session is gone (global/server disposed or
   * session deleted). A context that only had its status flipped to
   * "stopped" stayed in the registry, so the next sendTurn reused a dead
   * session. Mark it stopped so ensureContext refuses it, drop it so the
   * hub starts fresh, and run the tracked-server cleanup in the background
   * (its failure stays quarantined for the next retry).
   */
  private retireDisposedContext(context: SessionContext): void {
    context.stopped = true
    context.stopComplete = true
    context.eventAbort.abort()
    // Nothing can answer a permission or question on a session the server
    // already disposed; a pending entry would only make a late reply look
    // routable.
    clearPendingRequests(context)
    const key = context.session.threadId as string
    if (this.sessions.get(key) === context) this.sessions.delete(key)
    void this.closeTrackedServer(context.server).catch(() => {
      // Retained in serverCleanupQuarantines for stopAll / the next startSession.
    })
  }

  private updateSession(
    context: SessionContext,
    patch: Partial<ProviderSession>
  ): void {
    context.session = {
      ...context.session,
      ...patch,
      updatedAt: Date.now(),
    }
  }

  private eventBase(threadId: string, createdAt?: string): ProviderRuntimeBase {
    return {
      threadId,
      providerKind: this.provider,
      providerInstanceId: this.providerInstanceId(),
      eventId: randomUUID(),
      at: Date.now(),
      ...(createdAt ? { createdAt } : {}),
    }
  }

  private emitEvent(event: ProviderRuntimeEvent): void {
    const context = this.sessions.get(event.threadId)
    const dispatchTurnId = context?.activeDispatchTurnId ?? null
    const correlated = withDispatchTurnId(event, dispatchTurnId)
    this.bus.emit("event", correlated)
    if (
      context &&
      (correlated.type === "turn.completed" ||
        correlated.type === "turn.aborted")
    ) {
      context.activeDispatchTurnId = null
    }
  }

  private writeNativeEvent(
    context: SessionContext,
    event: BetterC0deSdkEvent,
    turnId: TurnId | undefined
  ): void {
    const nativeEventLogger = this.options.nativeEventLogger
    if (!nativeEventLogger) return
    const observedAt = new Date().toISOString()
    try {
      nativeEventLogger.write(
        {
          observedAt,
          event: {
            provider: this.provider,
            providerKind: this.provider,
            providerInstanceId: this.providerInstanceId(),
            threadId: context.session.threadId,
            providerThreadId: context.betterC0deSessionId,
            type: event.type,
            ...(turnId ? { turnId } : {}),
            payload: event,
          },
        },
        context.session.threadId
      )
    } catch {
      // Native observability must never interrupt provider delivery.
    }
  }

  private makeEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = sanitizedChildEnvironment()
    for (const item of this.options.environment ?? []) {
      if (!item.name) continue
      env[item.name] = item.value
    }
    return env
  }

  private binaryPath(): string {
    return this.options.binaryPath?.trim() || this.profile.defaultBinaryPath
  }

  private serverUrl(): string | null {
    const value = this.options.serverUrl?.trim()
    return value ? value : null
  }

  private serverPassword(): string | null {
    const value =
      this.options.serverPassword?.trim() ||
      firstEnvValue(this.profile.serverPasswordEnvVars)
    return value ? value : null
  }

  private serverUsername(): string {
    return (
      this.options.serverUsername?.trim() ||
      firstEnvValue(this.profile.serverUsernameEnvVars) ||
      this.profile.serverAuthUsername
    )
  }

  /** `raw.source` stamped on native protocol envelopes. */
  private rawSource(): string {
    return this.profile.rawSource
  }

  /** Product name of the driven CLI, e.g. `BetterC0de` or `OpenCode`. */
  private brand(): string {
    return this.profile.displayName
  }

  /** Synthesised task id namespace, e.g. `betterc0de` or `opencode`. */
  private taskId(suffix: string): string {
    return `${this.profile.taskIdPrefix}-${suffix}`
  }

  /** Metadata namespace for `thread.metadata.updated` payloads. */
  private metadataNamespace(): string {
    return this.profile.metadataNamespace
  }

  private providerInstanceId(): string {
    return this.options.providerInstanceId ?? this.profile.providerKind
  }

  private continuationKey(): string {
    return (
      this.options.continuationKey ??
      `${this.profile.providerKind}:instance:${this.profile.providerKind}`
    )
  }
}

function firstEnvValue(names: ReadonlyArray<string>): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return null
}

interface BetterC0deInventory {
  readonly providerList: ProviderListResponse
  readonly agents: ReadonlyArray<Agent>
  readonly providerV2List: ReadonlyArray<BetterC0deProviderV2>
  readonly modelV2List: ReadonlyArray<BetterC0deModelV2>
  readonly toolIDs: ReadonlyArray<string>
  readonly tools: ReadonlyArray<BetterC0deToolListItem>
}

type ProviderRuntimeBase = Pick<
  ProviderRuntimeEvent,
  | "threadId"
  | "providerKind"
  | "providerInstanceId"
  | "eventId"
  | "at"
  | "createdAt"
>

async function defaultBetterC0deClientFactory(
  input: BetterC0deClientFactoryInput,
  profile: OpenCodeCompatProfile
): Promise<BetterC0deClient> {
  return createBetterC0deCompatHttpClient<BetterC0deClient>({
    baseUrl: input.baseUrl,
    directory: input.directory,
    serverUsername: input.serverUsername,
    serverPassword: input.serverPassword,
    v2Envelope: profile.v2Envelope,
  })
}

async function runBetterC0deCommand(
  binaryPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  brand = "BetterC0de"
): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}> {
  await retryCompatProcessCleanup()
  return new Promise((resolve, reject) => {
    const child = spawnBetterC0deBinary(binaryPath, args, { env })
    const output = createBoundedProcessOutput()
    let settled = false
    let terminating = false
    const onStdout = (chunk: Buffer | string) => {
      if (appendBoundedProcessOutput(output, "stdout", chunk)) return
      beginTermination(
        processOutputLimitError(
          `${brand} compatibility command`,
          output.byteCap
        )
      )
    }
    const onStderr = (chunk: Buffer | string) => {
      if (appendBoundedProcessOutput(output, "stderr", chunk)) return
      beginTermination(
        processOutputLimitError(
          `${brand} compatibility command`,
          output.byteCap
        )
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
          stdout: output.stdout,
          stderr: output.stderr,
          code: code ?? -1,
        })
      )
    }
    const beginTermination = (primaryError: Error) => {
      if (settled || terminating) return
      terminating = true
      clearTimeout(timer)
      void closeCompatProcess(child).then(
        () => finish(() => reject(primaryError)),
        (cleanupError) =>
          finish(() =>
            reject(
              new AggregateError(
                [primaryError, cleanupError],
                `${primaryError.message} Process-tree cleanup also failed.`
              )
            )
          )
      )
    }
    const timer = setTimeout(() => {
      beginTermination(
        new Error(`Timed out while running ${brand} compatibility command.`)
      )
    }, DEFAULT_SERVER_TIMEOUT_MS)

    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", onStderr)
    child.on("error", onError)
    child.on("close", onClose)
  })
}

function parseGenericCliVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)/i)?.[1] ?? null
}

function compareSemverVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function parseVersion(value: string): number[] {
  const numeric = value.match(/\d+(?:\.\d+)*/)?.[0] ?? ""
  return numeric.split(".").map((part) => Number.parseInt(part, 10) || 0)
}

function formatBetterC0deProbeError(input: {
  readonly cause: unknown
  readonly isExternalServer: boolean
  readonly brand: string
}): { readonly installed: boolean; readonly message: string } {
  const brand = input.brand
  const detail = sdkErrorDetail(input.cause).toLowerCase()
  const rules: ReadonlyArray<readonly [RegExp, boolean, string]> = input.isExternalServer
    ? [
        [/401|403|unauthorized|forbidden/, true, "compatibility server rejected authentication. Check the server URL and password."],
        [/econnrefused|enotfound|fetch failed|networkerror|timed out|timeout|socket hang up/, true, "Couldn't reach the configured compatibility server. Check that the server is running and the URL is correct."],
      ]
    : [
        [/enoent|notfound|not recognized/, false, `${brand} compatibility CLI is not installed or not on PATH.`],
        [/quarantine/, true, `macOS is blocking the ${brand} compatibility binary (quarantine). Remove the quarantine attribute from the configured compatibility binary to fix this.`],
        [/invalid code signature|corrupted/, true, `macOS killed the ${brand} compatibility process due to an invalid code signature. The binary may be corrupted. Try reinstalling the compatibility CLI.`],
      ]
  const matched = rules.find(([pattern]) => pattern.test(detail))
  return {
    installed: matched?.[1] ?? true,
    message: matched?.[2] ?? (input.isExternalServer
      ? "Failed to connect to the configured compatibility server."
      : "Failed to execute compatibility CLI health check."),
  }
}

async function connectBetterC0deServer(input: {
  readonly binaryPath: string
  readonly serverUrl?: string | null
  readonly env: NodeJS.ProcessEnv
  readonly profile: OpenCodeCompatProfile
}): Promise<BetterC0deServerConnection> {
  const serverUrl = input.serverUrl?.trim()
  if (serverUrl) {
    return {
      url: serverUrl,
      external: true,
      close: async () => {},
    }
  }
  return startBetterC0deServerProcess({
    binaryPath: input.binaryPath,
    env: input.env,
    profile: input.profile ?? BETTERC0DE_COMPAT_PROFILE,
  })
}

/**
 * Spawns the BetterC0de CLI without `shell: true`. On Windows the shell path
 * split an unquoted install location on spaces; `.cmd` shims still need
 * cmd.exe, so those go through the same quoted-argv wrapper the other
 * adapters use, and a direct `.exe` is spawned as-is.
 */
export function spawnBetterC0deBinary(
  binaryPath: string,
  args: ReadonlyArray<string>,
  options: { readonly env: NodeJS.ProcessEnv }
): ChildProcessWithoutNullStreams {
  const isWindows = process.platform === "win32"
  const directExe =
    isWindows && path.isAbsolute(binaryPath) && /\.exe$/i.test(binaryPath)
  const viaCmd = isWindows && !directExe
  const command = viaCmd
    ? process.env.ComSpec?.trim() || "cmd.exe"
    : binaryPath
  const spawnArgs = viaCmd ? buildWindowsCmdArgs(binaryPath, args) : [...args]
  return spawn(command, spawnArgs, {
    env: sanitizedChildEnvironment(options.env),
    windowsHide: true,
    windowsVerbatimArguments: viaCmd,
    detached: !isWindows,
  }) as ChildProcessWithoutNullStreams
}

async function startBetterC0deServerProcess(input: {
  readonly binaryPath: string
  readonly env: NodeJS.ProcessEnv
  readonly profile: OpenCodeCompatProfile
}): Promise<BetterC0deServerConnection> {
  const port = await findAvailablePort()
  await retryCompatProcessCleanup()
  const configEnv: NodeJS.ProcessEnv = {}
  for (const name of input.profile.configContentEnv) {
    configEnv[name] = EMPTY_CONFIG_CONTENT
  }
  const child = spawnBetterC0deBinary(
    input.binaryPath,
    input.profile.serveArgs(port, DEFAULT_HOSTNAME),
    {
      env: {
        ...input.env,
        ...configEnv,
      },
    }
  )
  return waitForBetterC0deServer(
    child,
    DEFAULT_SERVER_TIMEOUT_MS,
    input.profile
  )
}

function waitForBetterC0deServer(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  profile: OpenCodeCompatProfile
): Promise<BetterC0deServerConnection> {
  const output = createBoundedProcessOutput()
  let settled = false
  let closeComplete = false
  let closePromise: Promise<void> | null = null
  let exitResolver: (code: number) => void = () => {}
  const exitCode = new Promise<number>((resolve) => {
    exitResolver = resolve
  })

  const close = async () => {
    if (closeComplete) return
    if (closePromise) return closePromise
    const operation = (async () => {
      await closeCompatProcess(child)
      closeComplete = true
    })()
    closePromise = operation
    try {
      await operation
    } finally {
      if (closePromise === operation) closePromise = null
    }
  }

  return new Promise((resolve, reject) => {
    const cleanupStartupListeners = () => {
      clearTimeout(timer)
      child.stdout.off("data", onStdout)
      child.stderr.off("data", onStderr)
      child.off("error", onError)
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanupStartupListeners()
      fn()
    }
    const rejectAfterCleanup = (primaryError: Error) => {
      if (settled) return
      settled = true
      cleanupStartupListeners()
      void close().then(
        () => reject(primaryError),
        (cleanupError) =>
          reject(
            new AggregateError(
              [primaryError, cleanupError],
              `${primaryError.message} Process-tree cleanup also failed.`
            )
          )
      )
    }
    const onStdout = (chunk: Buffer) => {
      if (!appendBoundedProcessOutput(output, "stdout", chunk)) {
        rejectAfterCleanup(
          processOutputLimitError(
            `${profile.displayName} compatibility server startup`,
            output.byteCap
          )
        )
        return
      }
      const parsed = parseServerUrlFromOutput(output.stdout, profile)
      if (!parsed) return
      finish(() => {
        // Continue draining diagnostics after readiness so a chatty server
        // cannot block forever on a full stdio pipe.
        child.stdout.resume()
        child.stderr.resume()
        resolve({
          url: parsed,
          external: false,
          close,
          exitCode,
        })
      })
    }
    const onStderr = (chunk: Buffer) => {
      if (appendBoundedProcessOutput(output, "stderr", chunk)) return
      rejectAfterCleanup(
        processOutputLimitError(
          `${profile.displayName} compatibility server startup`,
          output.byteCap
        )
      )
    }
    const onError = (err: Error) => {
      rejectAfterCleanup(err)
    }
    const timer = setTimeout(() => {
      rejectAfterCleanup(
        new Error(
          [
            `Timed out waiting for compatibility server start after ${timeoutMs}ms.`,
            output.stdout.trim() ? `stdout:\n${output.stdout.trim()}` : null,
            output.stderr.trim() ? `stderr:\n${output.stderr.trim()}` : null,
          ]
            .filter(Boolean)
            .join("\n\n")
        )
      )
    }, timeoutMs)
    child.stdout.on("data", onStdout)
    child.stderr.on("data", onStderr)
    child.on("error", onError)
    child.on("exit", (code) => {
      exitResolver(Number(code ?? 0))
      if (!settled) {
        rejectAfterCleanup(
          new Error(
            [
              `compatibility server exited before startup completed (code: ${String(code ?? 0)}).`,
              output.stdout.trim() ? `stdout:\n${output.stdout.trim()}` : null,
              output.stderr.trim() ? `stderr:\n${output.stderr.trim()}` : null,
            ]
              .filter(Boolean)
              .join("\n\n")
          )
        )
      }
    })
  })
}

function parseServerUrlFromOutput(
  output: string,
  profile: OpenCodeCompatProfile
): string | null {
  for (const line of output.split("\n")) {
    if (
      !profile.serverReadyPrefixes.some((prefix) => line.startsWith(prefix))
    ) {
      continue
    }
    const match = line.match(profile.serverReadyUrlPattern)
    return match?.[1] ?? null
  }
  return null
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, DEFAULT_HOSTNAME, () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port)
        else
          reject(new Error("Failed to allocate an compatibility server port."))
      })
    })
  })
}

function unwrapData<T>(result: unknown, message: string): T {
  if (
    result &&
    typeof result === "object" &&
    "data" in result &&
    (result as { data?: unknown }).data !== undefined
  ) {
    return (result as { data: T }).data
  }
  throw new Error(message)
}

function flattenBetterC0deModels(
  input: BetterC0deInventory
): ReadonlyArray<ProviderModel> {
  const connected = new Set(input.providerList.connected)
  const providerV2ById = new Map(
    input.providerV2List.map((provider) => [provider.id, provider])
  )
  const modelV2ByRef = new Map(
    input.modelV2List.map((model) => [
      betterC0deModelRefKey(model.providerID, model.id),
      model,
    ])
  )
  const models: ProviderModel[] = []
  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) continue
    const providerV2 = providerV2ById.get(provider.id)
    for (const model of Object.values(provider.models)) {
      const modelV2 = modelV2ByRef.get(
        betterC0deModelRefKey(provider.id, model.id)
      )
      const name = model.name.trim()
      if (!name) continue
      const variants = {
        ...normalizeBetterC0deModelVariants(model.variants),
        ...normalizeBetterC0deModelV2Variants(modelV2?.variants),
      }
      const endpoint = betterC0deModelV2Endpoint(modelV2, providerV2)
      const limit = modelV2?.limit ?? model.limit
      const releaseDate = betterC0deModelReleaseDate(modelV2)
      const cost = betterC0deModelCost(modelV2)
      models.push({
        slug: `${provider.id}/${model.id}`,
        name: modelV2?.name.trim() || name,
        subProvider: provider.name.trim() || undefined,
        isCustom: false,
        context: formatContextLimit(limit.context),
        tier: modelV2?.status ?? model.status,
        capabilities: betterC0deCapabilitiesForModel({
          providerID: provider.id,
          model: { ...model, variants },
          modelV2,
          agents: input.agents,
        }),
        catalog: {
          providerId: provider.id,
          modelId: model.id,
          api: {
            id: modelV2?.apiID ?? modelV2?.api?.id ?? model.id,
            ...(endpoint?.url ? { url: endpoint.url } : {}),
            ...(endpoint?.package ? { package: endpoint.package } : {}),
          },
          status: modelV2?.status ?? model.status,
          ...(releaseDate ? { releaseDate } : {}),
          limit: {
            context: limit.context,
            ...(modelV2?.limit.input !== undefined
              ? { input: modelV2.limit.input }
              : {}),
            ...(modelV2?.limit.output !== undefined
              ? { output: modelV2.limit.output }
              : {}),
          },
          ...(cost ? { cost } : {}),
          ...(Object.keys(variants).length > 0 ? { variants } : {}),
        },
      })
    }
  }
  return models.sort((left, right) => left.name.localeCompare(right.name))
}

function normalizeBetterC0deModelVariants(
  variants: Record<string, unknown> | undefined
): Record<string, Record<string, unknown>> {
  if (!variants) return {}
  const out: Record<string, Record<string, unknown>> = Object.create(null)
  for (const [key, value] of Object.entries(variants)) {
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
  }
  return out
}

function normalizeBetterC0deModelV2Variants(
  variants: ReadonlyArray<{ readonly id: string }> | undefined
): Record<string, Record<string, unknown>> {
  if (!variants) return {}
  const out: Record<string, Record<string, unknown>> = Object.create(null)
  for (const variant of variants) {
    const id = variant.id.trim()
    if (id) out[id] = {}
  }
  return out
}

function betterC0deModelRefKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

function betterC0deModelReleaseDate(
  model: BetterC0deModelV2 | undefined
): string | undefined {
  const released = model?.time.released
  if (typeof released !== "number" || !Number.isFinite(released))
    return undefined
  if (released <= 0) return undefined
  const date = new Date(released)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function betterC0deModelCost(
  model: BetterC0deModelV2 | undefined
): NonNullable<NonNullable<ProviderModel["catalog"]>["cost"]> | undefined {
  const first = model?.cost[0]
  if (!first) return undefined
  return {
    input: first.input,
    output: first.output,
    cache: {
      read: first.cache.read,
      write: first.cache.write,
    },
  }
}

function betterC0deProviderCatalog(
  input: BetterC0deInventory
): ReadonlyArray<ProviderCatalogEntry> {
  const connected = new Set(input.providerList.connected)
  const providerV2ById = new Map(
    input.providerV2List.map((provider) => [provider.id, provider])
  )
  return input.providerList.all
    .map((provider) => {
      const providerV2 = providerV2ById.get(provider.id)
      const enabledVia = betterC0deProviderEnabledVia(providerV2)
      const endpoint = betterC0deProviderCatalogEndpoint(providerV2)
      return {
        id: provider.id,
        name: provider.name.trim() || provider.id,
        ...(provider.source ? { source: provider.source } : {}),
        connected: connected.has(provider.id),
        enabled: providerV2
          ? providerV2.enabled !== false
          : connected.has(provider.id),
        ...(enabledVia ? { enabledVia } : {}),
        env: [...(providerV2?.env ?? provider.env ?? [])],
        ...(endpoint ? { endpoint } : {}),
        modelCount: Object.keys(provider.models).length,
      }
    })
    .sort((left, right) => {
      if (left.connected !== right.connected) return left.connected ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}

function betterC0deProviderEnabledVia(
  provider: BetterC0deProviderV2 | undefined
): string | undefined {
  if (!provider || provider.enabled === false) return undefined
  // Current `opencode` omits the `enabled` descriptor entirely; only the
  // legacy compatibility CLI reports `{ via, ... }`.
  const enabled = provider.enabled
  if (!enabled || typeof enabled !== "object") return undefined
  return enabled.via
}

function betterC0deProviderCatalogEndpoint(
  provider: BetterC0deProviderV2 | undefined
): ProviderCatalogEntry["endpoint"] | undefined {
  return betterC0deNormalizeEndpoint(provider?.endpoint ?? provider?.api)
}

/**
 * The legacy compatibility CLI publishes a flat `endpoint` object; current
 * `opencode` publishes a nested `api` object. Both normalise to the same
 * catalog endpoint shape, with `unknown` dropped.
 */
function betterC0deNormalizeEndpoint(
  endpoint:
    | { readonly type?: string; readonly url?: string; readonly package?: string; readonly websocket?: boolean }
    | undefined
): ProviderCatalogEntry["endpoint"] | undefined {
  if (!endpoint) return undefined
  const type = endpoint.type
  if (!type || type === "unknown") return undefined
  return {
    type,
    ...(endpoint.url ? { url: endpoint.url } : {}),
    ...(endpoint.package ? { package: endpoint.package } : {}),
    ...(endpoint.websocket !== undefined
      ? { websocket: endpoint.websocket }
      : {}),
  }
}

/**
 * The model/provider v2 endpoint, preferring the legacy `endpoint` object
 * and falling back to the current `opencode` nested `api` descriptor.
 */
function betterC0deModelV2Endpoint(
  model: BetterC0deModelV2 | undefined,
  provider: BetterC0deProviderV2 | undefined
): { readonly type?: string; readonly url?: string; readonly package?: string; readonly websocket?: boolean } | undefined {
  return (
    model?.endpoint ??
    model?.api ??
    provider?.endpoint ??
    provider?.api
  )
}

function betterC0deProviderAgents(
  agents: ReadonlyArray<Agent>
): ReadonlyArray<ProviderAgent> {
  return agents
    .map((agent) => ({
      name: agent.name,
      displayName: titleCaseSlug(agent.name),
      ...(agent.description ? { description: agent.description } : {}),
      mode: agent.mode,
      hidden: agent.hidden === true,
    }))
    .sort((left, right) => {
      const modeRank =
        providerAgentModeRank(left.mode) - providerAgentModeRank(right.mode)
      return modeRank !== 0 ? modeRank : left.name.localeCompare(right.name)
    })
}

function selectBetterC0deToolCatalogTarget(
  providerList: ProviderListResponse,
  modelV2List: ReadonlyArray<BetterC0deModelV2>
): { readonly providerID: string; readonly modelID: string } | null {
  const connectedProviders = new Set(providerList.connected)
  const connectedOnly = connectedProviders.size > 0
  for (const provider of providerList.all) {
    if (connectedOnly && !connectedProviders.has(provider.id)) continue
    const modelID = Object.keys(provider.models).sort()[0]
    if (modelID) return { providerID: provider.id, modelID }
  }
  for (const model of modelV2List) {
    if (connectedOnly && !connectedProviders.has(model.providerID)) continue
    return { providerID: model.providerID, modelID: model.id }
  }
  return null
}

function betterC0deProviderTools(
  inventory: Pick<BetterC0deInventory, "toolIDs" | "tools">
): ReadonlyArray<ProviderTool> {
  const toolsById = new Map<string, ProviderTool>()
  for (const toolID of inventory.toolIDs) {
    const id = toolID.trim()
    if (!id) continue
    toolsById.set(id, {
      id,
      displayName: titleCaseSlug(id),
    })
  }
  for (const tool of inventory.tools) {
    const id = tool.id.trim()
    if (!id) continue
    const description = tool.description?.trim()
    toolsById.set(id, {
      id,
      displayName: titleCaseSlug(id),
      ...(description ? { description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    })
  }
  return Array.from(toolsById.values()).sort((left, right) =>
    left.id.localeCompare(right.id)
  )
}

function providerAgentModeRank(mode: ProviderAgent["mode"]): number {
  if (mode === "primary") return 0
  if (mode === "all") return 1
  if (mode === "subagent") return 2
  return 3
}

function betterC0deCapabilitiesForModel(input: {
  readonly providerID: string
  readonly model: ProviderListResponse["all"][number]["models"][string]
  readonly modelV2?: BetterC0deModelV2
  readonly agents: ReadonlyArray<Agent>
}): ModelCapabilities {
  const variantValues = Object.keys(input.model.variants ?? {})
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues)
  const primaryAgents = input.agents.filter(
    (agent) =>
      !agent.hidden && (agent.mode === "primary" || agent.mode === "all")
  )
  const defaultAgent =
    primaryAgents.find((agent) => agent.name === "build")?.name ??
    primaryAgents[0]?.name
  return {
    attachment: betterC0deModelSupportsAttachment(input.model, input.modelV2),
    optionDescriptors: [
      ...(variantValues.length > 0
        ? [
            {
              id: "variant",
              label: "Variant",
              type: "select" as const,
              options: variantValues.map((value) => ({
                id: value,
                label: titleCaseSlug(value),
                ...(value === defaultVariant
                  ? { isDefault: true as const }
                  : {}),
              })),
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
      ...(primaryAgents.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: primaryAgents.map((agent) => ({
                id: agent.name,
                label: titleCaseSlug(agent.name),
                ...(agent.name === defaultAgent
                  ? { isDefault: true as const }
                  : {}),
              })),
              ...(defaultAgent ? { currentValue: defaultAgent } : {}),
            },
          ]
        : []),
    ],
  }
}

function betterC0deModelSupportsAttachment(
  model: ProviderListResponse["all"][number]["models"][string],
  modelV2: BetterC0deModelV2 | undefined
): boolean {
  const explicitAttachment =
    modelV2?.capabilities?.attachment ??
    model.capabilities?.attachment ??
    model.attachment
  if (typeof explicitAttachment === "boolean") return explicitAttachment

  return (
    betterC0deModalitiesSupportAttachments(modelV2?.capabilities?.input) ||
    betterC0deModalitiesSupportAttachments(model.capabilities?.input)
  )
}

function betterC0deModalitiesSupportAttachments(
  modalities: BetterC0deModelModalities | undefined
): boolean {
  const attachmentModalities = new Set(["image", "pdf", "audio", "video"])
  if (Array.isArray(modalities)) {
    return modalities.some((item) =>
      attachmentModalities.has(item.trim().toLowerCase())
    )
  }
  if (modalities && typeof modalities === "object") {
    return Object.entries(modalities).some(
      ([key, value]) =>
        value === true && attachmentModalities.has(key.trim().toLowerCase())
    )
  }
  return false
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>
): string | undefined {
  if (variants.length === 1) return variants[0]
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined
  }
  if (
    providerID === "openai" ||
    providerID === "betterc0de" ||
    providerID === "BetterC0de"
  ) {
    return variants.includes("medium")
      ? "medium"
      : variants.includes("high")
        ? "high"
        : undefined
  }
  return undefined
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ")
}

function formatContextLimit(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function defaultBetterC0deModels(): ReadonlyArray<ProviderModel> {
  return [
    {
      slug: "openai/gpt-5",
      name: "OpenAI GPT-5",
      shortName: "GPT-5",
      context: "runtime",
      tier: "Runtime",
      capabilities: { optionDescriptors: [] },
      catalog: {
        providerId: "openai",
        modelId: "gpt-5",
        api: { id: "gpt-5" },
      },
    },
  ]
}

function mergeCustomModels(
  base: ReadonlyArray<ProviderModel>,
  customModels: ReadonlyArray<string>
): ReadonlyArray<ProviderModel> {
  const seen = new Set<string>()
  const out: ProviderModel[] = []
  for (const model of base) {
    if (seen.has(model.slug)) continue
    seen.add(model.slug)
    out.push(model)
  }
  for (const slug of customModels) {
    const trimmed = slug.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push({
      slug: trimmed,
      name: titleCaseSlug(trimmed),
      isCustom: true,
      capabilities: { optionDescriptors: [] },
    })
  }
  return out
}

function normalizeCwd(cwd: string | null | undefined): string {
  return cwd?.trim() || process.cwd()
}

function throwIfCompatStartupCancelled(
  signal: AbortSignal,
  brand = "BetterC0de"
): void {
  if (signal.aborted) throw new Error(`${brand} session startup was cancelled.`)
}

async function loadBetterC0deProjectPermissionInputs(
  cwd: string
): Promise<
  readonly [
    Awaited<ReturnType<typeof listProjectTools>>,
    Awaited<ReturnType<typeof listProjectPermissions>>,
  ]
> {
  // Project policy is part of the permission boundary. A malformed,
  // unreadable, or otherwise unverifiable policy must not silently turn into
  // an empty (and therefore more permissive) policy.
  return Promise.all([listProjectTools(cwd), listProjectPermissions(cwd)])
}

type BetterC0deMetadataKind =
  | "skills"
  | "slashCommands"
  | "agents"
  | "tools"
  | "models"
  | "all"

interface BetterC0deMetadataChange {
  readonly metadataKind: BetterC0deMetadataKind
  readonly summary: string
}

function betterC0deMetadataChangeFromFile(
  file: string,
  eventType: "add" | "change" | "unlink",
  brand = "BetterC0de"
): BetterC0deMetadataChange | null {
  const normalized = normalizeBetterC0deMetadataPath(file)
  const segments = normalized.split("/").filter(Boolean)
  const lowerSegments = segments.map((segment) => segment.toLowerCase())
  const fileName = lowerSegments.at(-1) ?? ""
  const verb =
    eventType === "add"
      ? "added"
      : eventType === "unlink"
        ? "removed"
        : "changed"
  const hasSegment = (value: string): boolean =>
    lowerSegments.includes(value.toLowerCase())
  const hasAnySegment = (values: ReadonlyArray<string>): boolean =>
    values.some((value) => hasSegment(value))
  const isMarkdown = fileName.endsWith(".md")
  const isPluginScript =
    fileName.endsWith(".js") ||
    fileName.endsWith(".cjs") ||
    fileName.endsWith(".mjs") ||
    fileName.endsWith(".ts")

  if (
    fileName === "betterc0de.json" ||
    fileName === "betterc0de.jsonc" ||
    fileName === "BetterC0de.json" ||
    fileName === "BetterC0de.jsonc" ||
    fileName === "config.json" ||
    hasSegment(".betterc0de") ||
    hasSegment(".BetterC0de")
  ) {
    return {
      metadataKind: "all",
      summary: `${brand} compatibility configuration ${verb}.`,
    }
  }

  if (
    fileName === "agents.md" ||
    fileName === "claude.md" ||
    fileName === "context.md"
  ) {
    return {
      metadataKind: "all",
      summary: `${brand} compatibility instructions ${verb}.`,
    }
  }

  if (
    fileName === "skill.md" ||
    (hasAnySegment([".agents", ".claude"]) && hasSegment("skills"))
  ) {
    return {
      metadataKind: "skills",
      summary: `${brand} compatibility skills ${verb}.`,
    }
  }

  if (isMarkdown && hasAnySegment(["command", "commands"])) {
    return {
      metadataKind: "slashCommands",
      summary: `${brand} compatibility slash commands ${verb}.`,
    }
  }

  if (isMarkdown && hasAnySegment(["agent", "agents", "mode", "modes"])) {
    return {
      metadataKind: "agents",
      summary: `${brand} compatibility agents ${verb}.`,
    }
  }

  if (isPluginScript && hasAnySegment(["plugin", "plugins"])) {
    return {
      metadataKind: "all",
      summary: `${brand} compatibility plugins ${verb}.`,
    }
  }

  return null
}

function betterC0dePathsOverlap(a: string, b: string): boolean {
  const left = normalizeBetterC0deMetadataPath(a).replace(/\/+$/g, "")
  const right = normalizeBetterC0deMetadataPath(b).replace(/\/+$/g, "")
  if (!left || !right) return false
  if (left === right) return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function normalizeBetterC0deMetadataPath(value: string): string {
  return value.trim().replace(/\\/g, "/")
}

function betterC0deUnifiedDiff(
  diffs: ReadonlyArray<BetterC0deSnapshotFileDiff>
): string {
  return diffs
    .map((diff) => diff.patch?.trim() ?? "")
    .filter((patch) => patch.length > 0)
    .join("\n\n")
}

function betterC0deDiffFiles(
  diffs: ReadonlyArray<BetterC0deSnapshotFileDiff>
): Array<{ path: string; additions: number; deletions: number }> {
  return diffs
    .filter((diff) => typeof diff.file === "string" && diff.file.trim())
    .map((diff) => ({
      path: diff.file?.trim() ?? "",
      additions: Math.max(0, diff.additions),
      deletions: Math.max(0, diff.deletions),
    }))
}

function betterC0deTodoStatus(status: string): string {
  const normalized = status
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_")
  if (normalized === "in_progress") return "in_progress"
  if (normalized === "completed") return "completed"
  if (normalized === "cancelled") return "cancelled"
  return "pending"
}

function betterC0dePtySummary(pty: BetterC0dePtyInfo): string {
  const args = pty.args.length > 0 ? ` ${pty.args.join(" ")}` : ""
  const title = pty.title.trim() || pty.id
  return `${title}: ${pty.command}${args} (${pty.status})`
}

function betterC0deEventSummary(value: string, fallback: string): string {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed
}

function betterC0deSessionConfig(
  info: BetterC0deSessionInfo
): Record<string, unknown> {
  return {
    sessionId: info.id,
    directory: info.directory,
    ...(info.title ? { title: info.title } : {}),
    ...(info.agent ? { agent: info.agent } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(info.version ? { version: info.version } : {}),
    ...(info.summary ? { summary: info.summary } : {}),
  }
}

function normalizeProviderRuntimeMode(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function messageRoleForPart(
  context: SessionContext,
  part: Pick<Part, "messageID" | "type">
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID)
  if (known) return known
  return part.type === "tool" ? "assistant" : undefined
}

function textFromPart(part: Part): string | undefined {
  if (part.type === "text" || part.type === "reasoning") return part.text
  return undefined
}

function resolveTextStreamKind(
  part: Part
): "assistant_text" | "reasoning_text" {
  return part.type === "reasoning" ? "reasoning_text" : "assistant_text"
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  const state = part.state
  if (state.status === "pending") return
  if (state.status === "running") return state.title
  return state.status === "completed" ? state.output : state.error
}

function titleFromToolPart(part: Extract<Part, { type: "tool" }>): string {
  if ("title" in part.state && part.state.title) return part.state.title
  switch (toToolLifecycleItemType(part.tool)) {
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
    case "image_view":
      return "Image"
    default:
      return part.tool
  }
}

function inputFromToolPart(
  part: Extract<Part, { type: "tool" }>
): Record<string, unknown> | undefined {
  return "input" in part.state ? part.state.input : undefined
}

function outputFromToolPart(
  part: Extract<Part, { type: "tool" }>
): string | undefined {
  if (part.state.status === "completed") return part.state.output
  if (part.state.status === "error") return part.state.error
  return undefined
}

function betterC0deNextToolContentText(
  content: ReadonlyArray<BetterC0deNextToolContent>
): string | undefined {
  const text = content
    .map((item) => {
      if (item.type === "text") return item.text ?? ""
      const label = item.name ?? item.uri ?? "file"
      return label ? `[file] ${label}` : ""
    })
    .filter((item) => item.trim().length > 0)
    .join("\n")
    .trim()
  return text || undefined
}

function betterC0deNextToolDetail(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: unknown,
  rawInput: string | undefined
): string | undefined {
  const command = input?.command
  if (
    toToolLifecycleItemType(toolName) === "command_execution" &&
    typeof command === "string" &&
    command.trim()
  ) {
    return command.trim()
  }
  if (typeof output === "string" && output.trim()) return output.trim()
  if (rawInput?.trim()) return rawInput.trim()
  return undefined
}

function metadataFromToolPart(
  part: Extract<Part, { type: "tool" }>
): Record<string, unknown> | undefined {
  return "metadata" in part.state ? part.state.metadata : undefined
}

function toToolLifecycleStatus(
  status: Extract<Part, { type: "tool" }>["state"]["status"]
): "pending" | "running" | "completed" | "failed" {
  if (status === "error") return "failed"
  return status
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  const state = part.state
  if (state.status === "pending") return
  const timestamp = state.status === "running" ? state.time.start : state.time.end
  return isoFromEpochMs(timestamp)
}

function textPartStartedAt(part: Part): string | undefined {
  if ((part.type === "text" || part.type === "reasoning") && part.time) {
    return isoFromEpochMs(part.time.start)
  }
  return undefined
}

function isoFromEpochMs(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function toToolLifecycleItemType(toolName: string): string {
  return toolNameCategory(toolName, "compat")
}

function mapPermissionToRequestType(
  permission: string
):
  | "command_execution_approval"
  | "file_read_approval"
  | "file_change_approval"
  | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval"
    case "read":
      return "file_read_approval"
    case "edit":
      return "file_change_approval"
    default:
      return "unknown"
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept"
    case "always":
      return "acceptForSession"
    case "reject":
    default:
      return "decline"
  }
}

function normalizeQuestionRequest(request: QuestionRequest) {
  return Array.from(request.questions, (source, index) => {
    const result: {
      id: string; header: string; question: string
      options: Array<{ label: string; description: string | undefined }>
      multiSelect?: boolean
    } = {
      id: betterC0deQuestionId(index, source),
      question: source.question,
      header: source.header,
      options: Array.from(source.options, choice => ({ description: choice.description, label: choice.label })),
    }
    if (source.multiple) result.multiSelect = true
    return result
  })
}

function sessionErrorMessage(error: unknown, brand = "BetterC0de"): string {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? value as Record<string, unknown> : {}
  const message = object(object(error).data).message
  if (typeof message === "string" && message.trim()) return message
  return `${brand} session failed.`
}

/**
 * Extracts the scoping session id from an SDK event envelope. BetterC0de
 * compat `session.*` events carry it at the top level while current
 * `opencode` message events nest it inside `info` or `part`.
 */
function readEventSessionId(properties: unknown): string | null {
  if (!properties || typeof properties !== "object") return null
  const record = properties as Record<string, unknown>
  if (typeof record.sessionID === "string" && record.sessionID.trim()) {
    return record.sessionID.trim()
  }
  for (const nestedKey of ["info", "part"] as const) {
    const nested = record[nestedKey]
    if (!nested || typeof nested !== "object") continue
    const nestedSessionId = (nested as Record<string, unknown>).sessionID
    if (typeof nestedSessionId === "string" && nestedSessionId.trim()) {
      return nestedSessionId.trim()
    }
  }
  return null
}

function sdkErrorDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim()
  }
  if (cause && typeof cause === "object") {
    const record = cause as Record<string, unknown>
    const status = (record.response as { status?: number } | undefined)?.status
    const body = record.error ?? record.data ?? record.body
    try {
      return `status=${status ?? "?"} body=${JSON.stringify(body ?? cause)}`
    } catch {
      return String(cause)
    }
  }
  return String(cause)
}
