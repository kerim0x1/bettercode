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
    features: [REMOTE_FEATURES.threadsGet],
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
  private readonly approvalAsked = new Set<string>()
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
      listProviderInstances: async () => copy(DEMO_PROVIDER_INSTANCES),
      goal: async () => ({ goal: null }),
      sendMessage: async (body) => this.send(body),
      interrupt: async ({ threadId }) => {
        this.cancelTurn(threadId, true)
        return { status: "interrupted" as const }
      },
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
    const threadId = String(body.threadId ?? "")
    const thread = this.threads.find((item) => item.id === threadId)
    if (!thread) throw new Error("Chat not found.")
    if (this.turns.has(threadId))
      throw new Error("The agent is still working on the previous message.")
    const text = String(body.message ?? body.userMessageContent ?? "").trim()
    const createdAt =
      typeof body.userMessageCreatedAt === "string"
        ? body.userMessageCreatedAt
        : this.now().toISOString()
    const messageId =
      typeof body.userMessageId === "string"
        ? body.userMessageId
        : this.id("demo-user")
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
      },
    ]
    const turnId = this.id("demo-turn")
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
    void this.runTurn(threadId, turnId, text)
    return { status: "streaming" as const, turnId }
  }

  private async runTurn(
    threadId: string,
    turnId: string,
    request: string
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
    if (turn.cancelled) return
    await this.stream(turn, threadId, "content", replyFor(request, ranTests))
    if (turn.cancelled) return
    this.finishTurn(threadId, turn, "turn_completed", ranTests)
  }

  private async askToRunTests(
    turn: RunningTurn,
    threadId: string
  ): Promise<boolean> {
    const requestId = this.id("demo-approval")
    const payload = {
      requestId,
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
    this.emit(threadId, turn.turnId, event)
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
    payload: Record<string, unknown>
  ): void {
    const activity: ThreadActivity = {
      id: this.id("demo-activity"),
      threadId,
      turnId,
      providerInstanceId: DEMO_PROVIDER.instanceId,
      kind,
      tone: "approval",
      summary,
      payload,
      sequence: this.counter,
      createdAt: this.now().toISOString(),
    }
    this.activities[threadId] = [...(this.activities[threadId] ?? []), activity]
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

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > 48
    ? `${oneLine.slice(0, 47)}…`
    : oneLine || "New Chat"
}

function replyFor(request: string, ranTests: boolean): string {
  const topic =
    request.replace(/\s+/g, " ").trim().slice(0, 120) || "your request"
  return [
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
