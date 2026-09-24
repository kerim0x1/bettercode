import {
  chatAttachmentsSchema,
  type ChatAttachment,
} from "@betterc0de/schema/chat-attachment"
import {
  REMOTE_API_VERSION,
  REMOTE_FEATURES,
  type RemoteProtocol,
} from "@betterc0de/schema/remote-protocol"
import type {
  ChatMessage,
  ChatThread,
  DirectoryEntry,
  RemoteBootstrap,
  RemoteSessionSummary,
  ThreadActivity,
} from "@/types/remote"
import { maxRequestBytes } from "@/lib/compat"
import { requestBytes } from "@/lib/request-size"
import { RemoteApiError } from "../live/http"
import type { ChatRequestBody, RemoteApi } from "../types"
import {
  DEMO_ENVIRONMENT_ID,
  DEMO_FILES,
  DEMO_PROJECTS,
  DEMO_PROVIDER,
  DEMO_PROVIDER_INSTANCES,
  demoDiffs,
  demoMessages,
  demoThreads,
} from "./fixtures"

/**
 * An in-memory stand-in for a paired desktop. It backs "Try the demo"
 * (App Review has no desktop to pair with), the component tests and the
 * end-to-end flows. It never touches the network.
 *
 * A message sent in the demo gets a scripted reply that streams like a real
 * agent: a short reasoning phase, one approval request per chat ("Run npm
 * test"), then the answer, which is stored like a real reply.
 */

export interface DemoOptions {
  /** Delay between streamed chunks; 0 streams as fast as timers allow. */
  readonly chunkDelayMs?: number
  readonly now?: () => Date
}

export const DEMO_PROTOCOL: RemoteProtocol = {
  apiVersion: REMOTE_API_VERSION,
  // The demo ships inside the app, so it accepts whichever app runs it.
  minClientVersion: "0.0.0",
  backendVersion: "demo",
  capabilities: {
    accessLevel: "full",
    terminalGranted: false,
    maxRequestBytes: 2 * 1024 * 1024,
    features: [REMOTE_FEATURES.threadsGet, REMOTE_FEATURES.threadsRename],
  },
}

interface RunningTurn {
  readonly turnId: string
  cancelled: boolean
  content: string
  readonly timers: Set<ReturnType<typeof setTimeout>>
}

export class DemoBackend {
  private readonly now: () => Date
  private readonly chunkDelayMs: number
  private readonly session: RemoteSessionSummary
  private threads: ChatThread[]
  private readonly messages: Record<string, ChatMessage[]>
  private readonly activities: Record<string, ThreadActivity[]> = {}
  private readonly listeners = new Set<(frame: unknown) => void>()
  /** Open approval requests: requestId → the chat it belongs to and how to answer it. */
  private readonly approvals = new Map<
    string,
    { threadId: string; resolve: (approved: boolean) => void }
  >()
  private readonly turns = new Map<string, RunningTurn>()
  /**
   * Message id → the turn it started, and the request it came with (text
   * and attachments), as the desktop records each dispatch.
   */
  private readonly dispatches = new Map<
    string,
    { threadId: string; turnId: string; request: string }
  >()
  private readonly approvalAsked = new Set<string>()
  /** Per chat, a checkpoint after each finished turn, as the desktop keeps them. */
  private readonly checkpoints = new Map<
    string,
    Array<{ turnCount: number; messageCount: number; activityId: string }>
  >()
  private counter = 0
  readonly api: RemoteApi

  constructor(options: DemoOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.chunkDelayMs = options.chunkDelayMs ?? 45
    const now = this.now()
    this.threads = demoThreads(now)
    this.messages = demoMessages(now)
    this.session = {
      id: "demo-session",
      label: "Demo",
      accessLevel: "full",
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    }
    this.api = this.createApi()
  }

  /** Runtime frames, in the same shape the desktop's WebSocket sends. */
  subscribe(listener: (frame: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Stops every scripted turn; nothing is scheduled afterwards. */
  dispose(): void {
    for (const threadId of [...this.turns.keys()]) this.cancelTurn(threadId)
    this.listeners.clear()
  }

  // -------------------------------------------------------------------------

  private createApi(): RemoteApi {
    // JSON copies: callers must never mutate the demo's state, and
    // structuredClone is not available on every React Native engine.
    const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    return {
      bootstrap: async (): Promise<RemoteBootstrap> => ({
        enabled: true,
        authenticated: true,
        authentication: "remote",
        environmentId: DEMO_ENVIRONMENT_ID,
        session: copy(this.session),
        protocol: copy(DEMO_PROTOCOL),
      }),
      status: async () => ({
        enabled: true,
        listeningOnNetwork: false,
        environmentId: DEMO_ENVIRONMENT_ID,
        host: "demo",
        port: 0,
        authentication: "remote",
        currentSessionId: this.session.id,
        endpoints: [],
      }),
      logout: async () => ({ loggedOut: true }),
      listThreadsPage: async () => ({
        threads: copy(
          [...this.threads].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt)
          )
        ),
        nextCursor: null,
      }),
      getThread: async (threadId) =>
        copy(this.threads.find((thread) => thread.id === threadId) ?? null),
      listMessages: async (threadId) => copy(this.messages[threadId] ?? []),
      listActivities: async (threadId) => copy(this.activities[threadId] ?? []),
      listDiffs: async (threadId) => {
        const diffs = demoDiffs(this.now())
        return {
          turnDiffs: diffs.turnDiffs.filter(
            (diff) => diff.threadId === threadId
          ),
          checkpointDiffs: [],
        }
      },
      listProjects: async () => copy(DEMO_PROJECTS),
      createThread: async (thread) => {
        this.threads = [
          { ...copy(thread), session: this.idleSession() },
          ...this.threads.filter((item) => item.id !== thread.id),
        ]
        this.messages[thread.id] ??= []
      },
      renameThread: async (threadId, title) => {
        if (!this.threads.some((thread) => thread.id === threadId))
          throw new RemoteApiError("thread not found", 404, "thread_not_found")
        const update = {
          threadId,
          title: title.trim(),
          updatedAt: this.now().toISOString(),
        }
        this.updateThread(threadId, (thread) => ({
          ...thread,
          title: update.title,
          updatedAt: update.updatedAt,
        }))
        const frame = { channel: "thread.metadata", data: update }
        for (const listener of [...this.listeners]) listener(frame)
        return copy(update)
      },
      listBranches: async (cwd) => {
        if (!DEMO_PROJECTS.some((project) => project.path === cwd))
          throw new RemoteApiError("Not a git repository.", 400)
        return { branches: ["main", "release/1.4"], current: "main" }
      },
      createWorktree: async (threadId, body) => {
        if (!this.threads.some((thread) => thread.id === threadId))
          throw new RemoteApiError("thread not found", 404, "thread_not_found")
        const short = threadId.replace(/[^a-z0-9]/gi, "").slice(0, 8)
        const worktree = {
          worktreeId: this.id("demo-worktree"),
          threadId,
          worktreePath: `/Users/demo/.betterc0de/worktrees/${short}`,
          branch: `agent/${short}/demo`,
          baseBranch: body.baseBranch ?? "main",
          headSha: null,
        }
        this.updateThread(threadId, (thread) => ({
          ...thread,
          envMode: "worktree",
          worktreePath: worktree.worktreePath,
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          worktreeState: "ready",
          updatedAt: this.now().toISOString(),
        }))
        return copy(worktree)
      },
      revertCheckpoint: async (threadId, turnCount) =>
        this.revertCheckpoint(threadId, turnCount),
      deleteThread: async (threadId) => {
        this.cancelTurn(threadId)
        this.threads = this.threads.filter((thread) => thread.id !== threadId)
        delete this.messages[threadId]
        delete this.activities[threadId]
      },
      listProviderInstances: async () => copy(DEMO_PROVIDER_INSTANCES),
      goal: async () => ({ goal: null }),
      sendMessage: async (body) => this.send(body),
      interrupt: async ({ threadId }) => {
        this.cancelTurn(threadId, true)
        return { status: "interrupted" as const }
      },
      // The scripted agent follows a new preset at once.
      setPermissionMode: async () => ({
        status: "acknowledged" as const,
        applied: "live" as const,
      }),
      respondApproval: async (body) => this.resolveApproval(body),
      respondPlan: async (body) => this.resolveApproval(body),
      respondUserInput: async (body) =>
        this.resolveApproval({ ...body, decision: "approve" }),
      rejectUserInput: async (body) =>
        this.resolveApproval({ ...body, decision: "deny" }),
      listDirectory: async (path) => this.listDirectory(path),
      searchFiles: async (root, needle, limit = 200) => {
        const files = DEMO_FILES[root] ?? {}
        const lower = needle.toLowerCase()
        const entries = Object.entries(files)
          .filter(([relative]) => relative.toLowerCase().includes(lower))
          .slice(0, limit)
          .map(([relative, content], index) => ({
            path: `${root}/${relative}`,
            name: relative.split("/").pop() ?? relative,
            isDir: content === null,
            score: 1_000 - index,
          }))
        return { entries, truncated: false, tookMs: 1 }
      },
      readFile: async (root, absolutePath) => {
        const relative = absolutePath.slice(root.length + 1)
        const content = DEMO_FILES[root]?.[relative]
        if (typeof content !== "string") throw new Error("File not found.")
        return {
          content,
          path: absolutePath,
          size: content.length,
          isUtf8: true,
        }
      },
    }
  }

  private idleSession(): ChatThread["session"] {
    return {
      providerKind: DEMO_PROVIDER.kind,
      providerInstanceId: DEMO_PROVIDER.instanceId,
      status: "ready",
      activeTurnId: null,
    }
  }

  private listDirectory(path: string) {
    const root = Object.keys(DEMO_FILES).find(
      (candidate) => path === candidate || path.startsWith(`${candidate}/`)
    )
    if (!root) throw new Error("Folder not found.")
    const folder = path === root ? "" : path.slice(root.length + 1)
    const entries: DirectoryEntry[] = Object.entries(DEMO_FILES[root] ?? {})
      .filter(([relative]) => {
        const slash = relative.lastIndexOf("/")
        return (slash === -1 ? "" : relative.slice(0, slash)) === folder
      })
      .map(([relative, content]) => ({
        name: relative.split("/").pop() ?? relative,
        path: `${root}/${relative}`,
        isDir: content === null,
        isSymlink: false,
        size: content === null ? null : content.length,
        mtime: this.now().getTime(),
      }))
      .sort(
        (a, b) =>
          Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)
      )
    return {
      path,
      parent: path === root ? null : path.slice(0, path.lastIndexOf("/")),
      entries,
      truncated: false,
    }
  }

  // -------------------------------------------------------------------------
  // Scripted turns
  // -------------------------------------------------------------------------

  private async send(body: ChatRequestBody) {
    // The desktop's body limit, which it states to the phone.
    if (requestBytes(body) > maxRequestBytes(DEMO_PROTOCOL)) {
      throw new RemoteApiError(
        "request body too large",
        413,
        "request_too_large"
      )
    }
    const threadId = String(body.threadId ?? "")
    const thread = this.threads.find((item) => item.id === threadId)
    if (!thread) throw new Error("Chat not found.")
    const text = String(body.message ?? body.userMessageContent ?? "").trim()
    // The desktop's own rule for attachments (@betterc0de/schema).
    const parsed = chatAttachmentsSchema.safeParse(body.attachments ?? [])
    if (!parsed.success) {
      throw new RemoteApiError(
        `Invalid attachments: ${parsed.error.issues[0]?.message ?? "rejected"}`,
        400
      )
    }
    const attachments = parsed.data
    const request = JSON.stringify({ text, attachments })
    const createdAt =
      typeof body.userMessageCreatedAt === "string"
        ? body.userMessageCreatedAt
        : this.now().toISOString()
    const messageId =
      typeof body.userMessageId === "string"
        ? body.userMessageId
        : this.id("demo-user")
    // Like the desktop: a message sent again under its id is answered with
    // the turn it started, not run twice.
    const earlier = this.dispatches.get(messageId)
    if (earlier) {
      if (earlier.threadId !== threadId || earlier.request !== request) {
        throw new RemoteApiError(
          `Dispatch id '${messageId}' is already bound to a different request.`,
          409,
          "dispatch_id_conflict"
        )
      }
      return {
        status:
          this.turns.get(threadId)?.turnId === earlier.turnId
            ? ("streaming" as const)
            : ("completed" as const),
        turnId: earlier.turnId,
        replayed: true as const,
      }
    }
    if (this.turns.has(threadId)) {
      throw new RemoteApiError(
        `Thread '${threadId}' already has active provider work.`,
        409,
        "turn_active"
      )
    }
    this.messages[threadId] = [
      ...(this.messages[threadId] ?? []).filter(
        (message) => message.id !== messageId
      ),
      {
        id: messageId,
        role: "user",
        content: text,
        createdAt,
        dispatchStatus: "accepted",
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    ]
    const turnId = this.id("demo-turn")
    this.dispatches.set(messageId, { threadId, turnId, request })
    this.updateThread(threadId, (item) => ({
      ...item,
      title: item.title === "New Chat" ? titleFrom(text) : item.title,
      updatedAt: this.now().toISOString(),
      messageCount: (this.messages[threadId] ?? []).length,
      session: {
        ...this.idleSession(),
        status: "running",
        activeTurnId: turnId,
      },
    }))
    void this.runTurn(threadId, turnId, text, attachments)
    return { status: "streaming" as const, turnId }
  }

  private async runTurn(
    threadId: string,
    turnId: string,
    request: string,
    attachments: readonly ChatAttachment[]
  ): Promise<void> {
    const turn: RunningTurn = {
      turnId,
      cancelled: false,
      content: "",
      timers: new Set(),
    }
    this.turns.set(threadId, turn)
    this.emit(threadId, turnId, "turn_started")
    await this.stream(
      turn,
      threadId,
      "reasoning",
      "Reading the project and the files involved…"
    )

    let ranTests = false
    if (!turn.cancelled && !this.approvalAsked.has(threadId)) {
      this.approvalAsked.add(threadId)
      ranTests = await this.askToRunTests(turn, threadId)
    }
    if (ranTests && !turn.cancelled) await this.runTests(turn, threadId)
    if (turn.cancelled) return
    await this.stream(
      turn,
      threadId,
      "content",
      replyFor(request, ranTests, attachments)
    )
    if (turn.cancelled) return
    this.finishTurn(threadId, turn, "turn_completed", ranTests)
  }

  /** The approved command, recorded step by step as a desktop records a tool. */
  private async runTests(turn: RunningTurn, threadId: string): Promise<void> {
    const tool = {
      providerKind: DEMO_PROVIDER.kind,
      providerInstanceId: DEMO_PROVIDER.instanceId,
      toolId: this.id("demo-live-tool"),
      toolName: "Bash",
      input: { command: "npm test" },
    }
    this.addActivity(
      threadId,
      turn.turnId,
      "tool.started",
      "Ran command",
      tool,
      "tool"
    )
    await this.wait(turn, this.chunkDelayMs * 10)
    if (turn.cancelled) return
    this.addActivity(
      threadId,
      turn.turnId,
      "tool.completed",
      "Ran command completed",
      { ...tool, output: "24 passed (1.8s)" },
      "tool"
    )
  }

  private async askToRunTests(
    turn: RunningTurn,
    threadId: string
  ): Promise<boolean> {
    const requestId = this.id("demo-approval")
    const payload = {
      requestId,
      // The desktop records the provider with the request, for answering it.
      providerKind: DEMO_PROVIDER.kind,
      providerInstanceId: DEMO_PROVIDER.instanceId,
      title: "Run npm test",
      toolName: "Bash",
      input: { command: "npm test" },
      detail: "Run the project's test suite to check the change.",
    }
    this.addActivity(
      threadId,
      turn.turnId,
      "approval.requested",
      "Run npm test",
      payload
    )
    this.emit(threadId, turn.turnId, "tool_approval_requested", payload)
    const approved = await new Promise<boolean>((resolve) => {
      this.approvals.set(requestId, { threadId, resolve })
    })
    this.approvals.delete(requestId)
    this.addActivity(
      threadId,
      turn.turnId,
      "approval.resolved",
      approved ? "Approved" : "Denied",
      {
        requestId,
        decision: approved ? "approve" : "deny",
      }
    )
    this.emit(threadId, turn.turnId, "tool_approval_resolved", { requestId })
    return approved
  }

  private resolveApproval(body: ChatRequestBody) {
    const requestId = String(body.requestId ?? "")
    const approval = this.approvals.get(requestId)
    if (!approval)
      return {
        status: "failed" as const,
        error: "This request was already answered.",
      }
    approval.resolve(body.decision === "approve")
    return { status: "acknowledged" as const, applied: "live" as const }
  }

  private async stream(
    turn: RunningTurn,
    threadId: string,
    kind: "reasoning" | "content",
    text: string
  ): Promise<void> {
    for (const chunk of text.match(/\S+\s*/g) ?? []) {
      if (turn.cancelled) return
      if (kind === "content") {
        turn.content += chunk
        this.emit(threadId, turn.turnId, "content_delta", { delta: chunk })
      } else {
        this.emit(threadId, turn.turnId, "reasoning_delta", {
          delta: chunk,
          streamKind: "reasoning",
        })
      }
      await this.wait(turn, this.chunkDelayMs)
    }
  }

  private finishTurn(
    threadId: string,
    turn: RunningTurn,
    event: "turn_completed" | "turn_interrupted",
    ranTests: boolean
  ): void {
    if (turn.content.trim()) {
      this.messages[threadId] = [
        ...(this.messages[threadId] ?? []),
        {
          id: this.id("demo-assistant"),
          role: "assistant",
          content: turn.content.trim(),
          createdAt: this.now().toISOString(),
          turnId: turn.turnId,
          modelId: DEMO_PROVIDER.model,
          ...(ranTests
            ? {
                toolCalls: [
                  {
                    id: this.id("demo-tool"),
                    name: "Bash",
                    input: { command: "npm test" },
                    output: "24 passed (1.8s)",
                    state: "output-available" as const,
                  },
                ],
              }
            : {}),
        },
      ]
    }
    this.turns.delete(threadId)
    this.updateThread(threadId, (item) => ({
      ...item,
      updatedAt: this.now().toISOString(),
      messageCount: (this.messages[threadId] ?? []).length,
      session: this.idleSession(),
    }))
    if (event === "turn_completed" && turn.content.trim()) {
      this.captureCheckpoint(threadId, turn.turnId)
    }
    this.emit(threadId, turn.turnId, event)
  }

  /** What the desktop's checkpoint reactor records after a finished turn. */
  private captureCheckpoint(threadId: string, turnId: string): void {
    const list = this.checkpoints.get(threadId) ?? []
    const turnCount = list.length + 1
    this.addActivity(
      threadId,
      turnId,
      "checkpoint.captured",
      "Checkpoint captured",
      {
        status: "ready",
        checkpointRef: `demo-checkpoint-${turnCount}`,
        turn_id: turnId,
        turn_index: turnCount,
        checkpointTurnCount: turnCount,
      },
      "info"
    )
    const activityId = this.activities[threadId]?.at(-1)?.id ?? ""
    this.checkpoints.set(threadId, [
      ...list,
      {
        turnCount,
        messageCount: (this.messages[threadId] ?? []).length,
        activityId,
      },
    ])
  }

  private revertCheckpoint(threadId: string, turnCount: number) {
    if (this.turns.has(threadId)) {
      throw new RemoteApiError(
        `Thread '${threadId}' already has active provider work.`,
        409,
        "turn_active"
      )
    }
    const list = this.checkpoints.get(threadId) ?? []
    const target = list.find((checkpoint) => checkpoint.turnCount === turnCount)
    if (!target) {
      return {
        reverted: false,
        rolledBackTurns: 0,
        deletedMessages: 0,
        boundaryMessageId: null,
        reason: `No checkpoint for turn ${turnCount}.`,
      }
    }
    const later = list.filter((checkpoint) => checkpoint.turnCount > turnCount)
    const messages = this.messages[threadId] ?? []
    const kept = messages.slice(0, target.messageCount)
    this.messages[threadId] = kept
    const dropped = new Set(later.map((checkpoint) => checkpoint.activityId))
    this.activities[threadId] = (this.activities[threadId] ?? []).filter(
      (activity) => !dropped.has(activity.id)
    )
    this.checkpoints.set(
      threadId,
      list.filter((checkpoint) => checkpoint.turnCount <= turnCount)
    )
    this.updateThread(threadId, (item) => ({
      ...item,
      updatedAt: this.now().toISOString(),
      messageCount: kept.length,
    }))
    return {
      reverted: true,
      rolledBackTurns: later.length,
      deletedMessages: messages.length - kept.length,
      boundaryMessageId: kept.at(-1)?.id ?? null,
    }
  }

  private cancelTurn(threadId: string, notify = false): void {
    const turn = this.turns.get(threadId)
    if (!turn) return
    turn.cancelled = true
    for (const timer of turn.timers) clearTimeout(timer)
    turn.timers.clear()
    for (const approval of this.approvals.values()) {
      if (approval.threadId === threadId) approval.resolve(false)
    }
    if (notify) this.finishTurn(threadId, turn, "turn_interrupted", false)
    else this.turns.delete(threadId)
  }

  private wait(turn: RunningTurn, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        turn.timers.delete(timer)
        resolve()
      }, ms)
      turn.timers.add(timer)
    })
  }

  private emit(
    threadId: string,
    turnId: string,
    eventType: string,
    payload: Record<string, unknown> = {}
  ): void {
    const frame = {
      channel: "provider.runtimeEvent",
      data: {
        event_type: eventType,
        thread_id: threadId,
        turn_id: turnId,
        providerKind: DEMO_PROVIDER.kind,
        providerInstanceId: DEMO_PROVIDER.instanceId,
        payload,
      },
    }
    for (const listener of [...this.listeners]) listener(frame)
  }

  private addActivity(
    threadId: string,
    turnId: string,
    kind: string,
    summary: string,
    payload: Record<string, unknown>,
    tone: ThreadActivity["tone"] = "approval"
  ): void {
    const activity: ThreadActivity = {
      id: this.id("demo-activity"),
      threadId,
      turnId,
      providerInstanceId: DEMO_PROVIDER.instanceId,
      kind,
      tone,
      summary,
      payload,
      sequence: this.counter,
      createdAt: this.now().toISOString(),
    }
    this.activities[threadId] = [...(this.activities[threadId] ?? []), activity]
    const frame = { channel: "thread.activity", data: activity }
    for (const listener of [...this.listeners]) listener(frame)
  }

  private updateThread(
    threadId: string,
    update: (thread: ChatThread) => ChatThread
  ): void {
    this.threads = this.threads.map((thread) =>
      thread.id === threadId ? update(thread) : thread
    )
  }

  private id(prefix: string): string {
    this.counter += 1
    return `${prefix}-${this.counter}`
  }
}

/** The size of what an attachment's data URL carries, as a reply states it. */
function attachmentKilobytes(attachment: ChatAttachment): number {
  const base64 = attachment.url.slice(attachment.url.indexOf(",") + 1)
  return Math.max(1, Math.round((base64.length * 3) / 4 / 1024))
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > 48
    ? `${oneLine.slice(0, 47)}…`
    : oneLine || "New Chat"
}

function replyFor(
  request: string,
  ranTests: boolean,
  attachments: readonly ChatAttachment[]
): string {
  const topic =
    request.replace(/\s+/g, " ").trim().slice(0, 120) || "your request"
  const received =
    attachments.length === 0
      ? []
      : [
          `I received ${attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`}: ${attachments
            .map(
              (attachment) =>
                `${attachment.filename ?? "attachment"} (${attachmentKilobytes(attachment)} KB)`
            )
            .join(", ")}.`,
          "",
        ]
  return [
    ...received,
    `Here is how I would handle **${topic}**:`,
    "",
    "1. Read the files involved and check how they are used.",
    "2. Make the change in small steps.",
    ranTests
      ? "3. Run the tests: 24 passed."
      : "3. Leave the tests for you to run, as you asked.",
    "",
    "_This is the demo. Pair the app with the BetterC0de desktop app to run a real agent on your own projects._",
  ].join("\n")
}
