import type { CommitMessageRequest } from "@betterc0de/schema/git-commit-message"
import type {
  ApprovalResponse,
  ChatSendResponse,
  HttpContractRequest,
  HttpContractResponse,
  ThreadMetadataUpdate,
} from "@betterc0de/schema/http-contracts"
import type { RemoteProtocol } from "@betterc0de/schema/remote-protocol"
import type {
  ChatMessage,
  ChatThread,
  DirectoryResult,
  FileSearchResult,
  ProjectSummary,
  ProviderInstance,
  RemoteBootstrap,
  RemoteStatus,
  ThreadActivity,
  ThreadDiffs,
} from "@/types/remote"

/** One page of chats, newest first, and the cursor of the next page. */
export interface ThreadPage {
  threads: ChatThread[]
  nextCursor: string | null
}

export interface MessagePageOptions {
  /** Newest messages first when omitted; the backend returns `sequence` then. */
  limit?: number
  /** Only messages before this sequence number ("load earlier"). */
  beforeSequence?: number
}

export interface FileContent {
  content: string
  path: string
  /** Only from desktops that list the `workspace.write.ifMatch` feature. */
  sha256?: string
  size?: number
  isUtf8?: boolean
}

/** Chat request bodies are validated by the shared contracts on the way out. */
export type ChatRequestBody = Record<string, unknown>

/** The branch, its upstream, and the changed files by state. */
export type GitStatusResult = HttpContractResponse<"gitStatus">
/** A diff as the desktop shows it: cut on a line boundary when it is large. */
export type GitDiffResult = HttpContractResponse<"gitDiff">
export type GitHunkRequest = HttpContractRequest<"gitHunkApply">
export type GitHunkResult = HttpContractResponse<"gitHunkApply">
export type GitLogEntry = HttpContractResponse<"gitLog">["commits"][number]
export type GeneratedCommitMessage =
  HttpContractResponse<"generateCommitMessage">

/** Lets a caller stop waiting for a slow request. */
export interface CallOptions {
  signal?: AbortSignal
}

/**
 * Everything the app asks the desktop over HTTP. The live implementation
 * talks to a paired desktop; the demo implementation answers from memory,
 * so screens and stores cannot tell them apart.
 */
export interface RemoteApi {
  bootstrap(): Promise<RemoteBootstrap>
  status(): Promise<RemoteStatus>
  logout(): Promise<{ loggedOut: boolean }>
  listThreadsPage(cursor?: string | null): Promise<ThreadPage>
  /** `null` when the chat does not exist (or the desktop is too old to say). */
  getThread(threadId: string): Promise<ChatThread | null>
  listMessages(
    threadId: string,
    options?: MessagePageOptions
  ): Promise<ChatMessage[]>
  listActivities(threadId: string): Promise<ThreadActivity[]>
  listDiffs(threadId: string): Promise<ThreadDiffs>
  listProjects(): Promise<ProjectSummary[]>
  createThread(thread: ChatThread): Promise<void>
  /** Only from desktops that list the `threads.rename` feature. */
  renameThread(threadId: string, title: string): Promise<ThreadMetadataUpdate>
  /** Deletes the chat, its history and its worktree on the desktop. */
  deleteThread(threadId: string): Promise<void>
  /** A project's local branches, and the checked-out one. */
  listBranches(cwd: string): Promise<HttpContractResponse<"gitBranches">>
  /**
   * Gives a chat its own git worktree, on a new branch from `baseBranch`
   * (the checked-out branch when omitted). The desktop records it on the chat.
   */
  createWorktree(
    threadId: string,
    body: { baseRepoPath: string; baseBranch?: string }
  ): Promise<HttpContractResponse<"createThreadWorktree">>
  /**
   * Returns the chat and its whole project folder to the checkpoint after
   * turn `turnCount` (from the chat's `checkpoint.captured` activities).
   */
  revertCheckpoint(
    threadId: string,
    turnCount: number
  ): Promise<HttpContractResponse<"revertThreadCheckpoint">>
  listProviderInstances(cwd?: string | null): Promise<ProviderInstance[]>
  goal(body: ChatRequestBody): Promise<{ goal: ChatThread["goal"] | null }>
  sendMessage(body: ChatRequestBody): Promise<ChatSendResponse>
  interrupt(body: {
    providerKind: string
    providerInstanceId?: string | null
    threadId: string
  }): Promise<{ status: "interrupted" }>
  /** Switches a chat's permission preset, in its running turn where the provider can. */
  setPermissionMode(body: {
    threadId: string
    providerKind: string
    providerInstanceId?: string | null
    permissionLevel: string
  }): Promise<ApprovalResponse>
  respondApproval(body: ChatRequestBody): Promise<ApprovalResponse>
  respondPlan(body: ChatRequestBody): Promise<ApprovalResponse>
  respondUserInput(body: ChatRequestBody): Promise<ApprovalResponse>
  rejectUserInput(body: ChatRequestBody): Promise<ApprovalResponse>
  listDirectory(path: string, showHidden?: boolean): Promise<DirectoryResult>
  searchFiles(
    root: string,
    query: string,
    limit?: number
  ): Promise<FileSearchResult>
  readFile(root: string, absolutePath: string): Promise<FileContent>

  gitStatus(cwd: string, options?: CallOptions): Promise<GitStatusResult>
  /** The unstaged changes, or with `staged` the staged ones. */
  gitDiff(
    cwd: string,
    staged?: boolean,
    options?: CallOptions
  ): Promise<GitDiffResult>
  gitStage(cwd: string, paths: string[]): Promise<void>
  gitUnstage(cwd: string, paths: string[]): Promise<void>
  gitStageAll(cwd: string): Promise<void>
  gitUnstageAll(cwd: string): Promise<void>
  /** Restores a changed file from the index; its changes are lost. */
  gitDiscard(cwd: string, path: string): Promise<void>
  /** Stages or discards one unstaged hunk, or unstages a staged one. */
  gitApplyHunk(body: GitHunkRequest): Promise<GitHunkResult>
  gitCommit(cwd: string, message: string): Promise<void>
  /** With `setUpstream` and the branch, publishes the branch to origin. */
  gitPush(
    cwd: string,
    options?: { setUpstream?: boolean; branch?: string }
  ): Promise<void>
  gitPull(cwd: string): Promise<void>
  /** Fetches every remote; the status afterwards shows what came in. */
  gitFetch(cwd: string): Promise<GitStatusResult>
  /** Switches branch, or with `create` makes a new one from the current. */
  gitCheckout(cwd: string, branch: string, create?: boolean): Promise<void>
  /** The latest commits, newest first. */
  gitLog(cwd: string, count?: number): Promise<GitLogEntry[]>
  /**
   * The desktop's commit message generator, given the summary that
   * @betterc0de/schema/git-commit-message makes of what a commit would take.
   */
  generateCommitMessage(
    request: CommitMessageRequest,
    options?: CallOptions
  ): Promise<GeneratedCommitMessage>
}

export type ChannelState = "connecting" | "live" | "reconnecting" | "error"

export interface ChannelHandlers {
  onFrame: (frame: unknown) => void
  onState: (state: ChannelState) => void
  /** The desktop refused the session; the channel waits for `reconnectNow()`. */
  onUnauthorized?: () => void
  /** The desktop needs a newer app; the pairing itself is still valid. */
  onUpdateRequired?: () => void
  /** Sent on every authentication and whenever the desktop's offer changes. */
  onProtocol?: (protocol: RemoteProtocol | null) => void
}

/** The live event stream (WebSocket) or its demo counterpart. */
export interface RemoteChannel {
  start(): void
  stop(): void
  reconnectNow(): void
}

export interface RemoteTransport {
  readonly kind: "live" | "demo"
  readonly api: RemoteApi
  createChannel(handlers: ChannelHandlers): RemoteChannel
}
