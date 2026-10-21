import type {
  ConversationImportCandidate,
  ConversationImportList,
  ConversationImportProvider,
  ConversationImportRequest,
  ConversationImportSourceStatus,
  ConversationImportStatus,
  ThreadImportSource,
  ThreadSettingsPatch,
} from "@betterc0de/schema"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { HttpError } from "../../http/errors"
import { logger } from "../../observability/logger"
import type { Db } from "../../persistence/db"
import type { ThreadActivityProjectionQuery } from "../../persistence/projections"
import type { ProviderSessionBindingStore } from "../../provider/runtime/ProviderSessionBindingStore"
import type { ThreadSaveMessage, ThreadService } from "../threads"
import { ClaudeTranscriptParser } from "./claude-transcript"
import { CodexTranscriptParser } from "./codex-transcript"
import { readJsonlLines } from "./jsonl"
import {
  claudeContinuationKeyFor,
  claudeProjectDirectoryName,
  codexContinuationKeyFor,
  comparablePath,
  defaultSessionRoots,
  isAppOwnedFolder,
  listClaudeSessionFiles,
  listCodexSessionFiles,
  type SessionFile,
  type SessionFileListing,
  type SessionRoots,
} from "./sources"
import { ConversationImportStore, sessionKey } from "./store"
import {
  IMPORT_LIMITS,
  type ImportedMessage,
  type ImportedToolCall,
  type ImportedTranscript,
  type ParserOptions,
  type TranscriptParser,
} from "./types"

/**
 * Imports earlier Claude Code and Codex conversations into BetterC0de chats.
 *
 * `list` offers the newest sessions of each CLI, read within a time budget
 * and remembered per file, so opening the picker again is quick. `import`
 * copies the chosen ones: each becomes a chat in the project of the folder
 * it ran in (registered by the chat itself, as any saved chat does), or a
 * chat without a folder when that folder is gone. The chat records where
 * it came from, so the session is offered only once.
 *
 * Where the default Claude Code or Codex instance can resume the session,
 * the chat is bound to it the way a running chat is: the next turn resumes
 * the CLI's own session instead of starting over. Otherwise the next turn
 * starts a new session and the imported messages travel along as its
 * history, as for any chat without a session.
 */

/** The name chats without a folder go by (`resolveNewThreadContext` in the UI). */
const FOLDERLESS_PROJECT_NAME = "BetterC0de"
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

export interface ConversationImportDeps {
  readonly db: Db
  readonly threads: Pick<
    ThreadService,
    "save" | "updateThreadSettings" | "listProjects" | "getThreadSummary"
  >
  readonly bindings: Pick<ProviderSessionBindingStore, "upsert">
  readonly activities: Pick<ThreadActivityProjectionQuery, "upsert">
  /** A provider instance's continuation key; null when it is missing or off. */
  readonly continuationKey: (instanceId: string) => string | null
  /** BetterC0de's data folder: sessions that ran in it are its own. */
  readonly dataDir: string | null
  /** Runs a chat's writes under the checkpoint recovery fence. */
  readonly withMutation: <T>(
    scope: {
      readonly threadIds: readonly string[]
      readonly workspaces: readonly string[]
    },
    run: () => T
  ) => Promise<T>
  readonly roots?: SessionRoots
  readonly tmpDir?: string
  readonly now?: () => Date
}

export interface ConversationImportItemResult {
  provider: ConversationImportProvider
  sessionId: string
  status: ConversationImportStatus
  threadId: string | null
  error?: string
  /** The new chat's list row (`ThreadService.getThreadSummary`). */
  thread?: unknown
}

interface SessionSummary {
  sessionId: string | null
  cwd: string | null
  title: string | null
  startedAt: string | null
  endedAt: string | null
  /** Null when only the start of the file was read. */
  messageCount: number | null
  internal: boolean
}

interface ProjectRef {
  path: string | null
  name: string | null
}

function createParser(
  provider: ConversationImportProvider,
  options: ParserOptions
): TranscriptParser {
  return provider === "claude"
    ? new ClaudeTranscriptParser(options)
    : new CodexTranscriptParser(options)
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isDirectory()
  } catch {
    return false
  }
}

export class ConversationImportService {
  private readonly store: ConversationImportStore
  private readonly roots: SessionRoots
  private readonly summaries = new Map<
    string,
    { size: number; mtimeMs: number; summary: SessionSummary }
  >()
  /** The listed files by `sessionKey`: an import names a session, never a path. */
  private index = new Map<string, SessionFile>()
  /** Imports run one at a time, so a session is never imported twice. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ConversationImportDeps) {
    this.store = new ConversationImportStore(deps.db)
    this.roots = deps.roots ?? defaultSessionRoots()
  }

  async list(
    filter: {
      provider?: ConversationImportProvider | null
      project?: string | null
      refresh?: boolean
    } = {}
  ): Promise<ConversationImportList> {
    if (filter.refresh) this.summaries.clear()
    const providers: ConversationImportProvider[] = filter.provider
      ? [filter.provider]
      : ["claude", "codex"]
    const projectFilter = filter.project?.trim()
    const projectKey = projectFilter ? comparablePath(projectFilter) : null
    const deadline = Date.now() + IMPORT_LIMITS.scanBudgetMs
    const known = this.store.knownSessions()
    const projects = this.knownProjects()
    const folders = new Map<string, boolean>()
    const index = new Map<string, SessionFile>()
    const candidates: ConversationImportCandidate[] = []
    const sources: ConversationImportSourceStatus[] = []
    let complete = true

    for (const provider of providers) {
      const listing = await this.listFiles(provider)
      const picked = listing.files
        .filter((file) => file.size <= IMPORT_LIMITS.maxFileBytes)
        .slice(0, IMPORT_LIMITS.sessionsPerProvider)
      let skipped = listing.files.length - picked.length
      for (const file of picked) {
        const summary = await this.summarize(file, deadline)
        if (!summary) {
          skipped += 1
          continue
        }
        if (summary.messageCount === null) complete = false
        const sessionId = this.sessionIdOf(file, summary.sessionId)
        if (!sessionId || summary.internal || summary.messageCount === 0)
          continue
        if (
          summary.cwd &&
          isAppOwnedFolder(summary.cwd, this.deps.dataDir, this.deps.tmpDir)
        ) {
          continue
        }
        index.set(sessionKey(provider, sessionId), file)
        if (
          projectKey &&
          (!summary.cwd || comparablePath(summary.cwd) !== projectKey)
        ) {
          continue
        }
        const project = this.projectFor(summary.cwd, projects)
        const folderExists = project.path
          ? await this.folderExists(project.path, folders)
          : false
        candidates.push({
          provider,
          sessionId,
          projectPath: project.path,
          projectName: project.name,
          folderExists,
          title: summary.title ?? "Untitled session",
          startedAt: summary.startedAt,
          // Read only in part, the file's time is the better "last active".
          updatedAt:
            summary.messageCount !== null && summary.endedAt
              ? summary.endedAt
              : new Date(file.mtimeMs).toISOString(),
          messageCount: summary.messageCount,
          threadId: known.get(sessionKey(provider, sessionId)) ?? null,
          resumable: this.resumable(
            provider,
            file,
            folderExists ? project.path : null
          ),
          archived: file.archived,
          sizeBytes: file.size,
        })
      }
      sources.push({
        provider,
        found: listing.found,
        sessions: listing.files.length,
        skipped,
      })
    }

    // A listing of one CLI keeps the other's files available for imports.
    for (const [key, file] of this.index) {
      if (!providers.includes(file.provider) && !index.has(key))
        index.set(key, file)
    }
    this.index = index
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { candidates, sources, complete }
  }

  async import(
    items: ConversationImportRequest["items"]
  ): Promise<{ results: ConversationImportItemResult[] }> {
    const run = this.queue.then(() => this.runImport(items))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async runImport(
    items: ConversationImportRequest["items"]
  ): Promise<{ results: ConversationImportItemResult[] }> {
    const unlisted = new Set(
      items
        .filter(
          (item) => !this.index.has(sessionKey(item.provider, item.sessionId))
        )
        .map((item) => item.provider)
    )
    if (unlisted.size > 0) await this.reindex([...unlisted])
    const projects = this.knownProjects()
    const results: ConversationImportItemResult[] = []
    for (const item of items) {
      results.push(
        await this.importOne(item.provider, item.sessionId, projects)
      )
    }
    return { results }
  }

  private async importOne(
    provider: ConversationImportProvider,
    sessionId: string,
    projects: Map<string, ProjectRef>
  ): Promise<ConversationImportItemResult> {
    const key = sessionKey(provider, sessionId)
    const failed = (error: string): ConversationImportItemResult => ({
      provider,
      sessionId,
      status: "failed",
      threadId: null,
      error,
    })
    try {
      const existing = this.store.knownSessions().get(key)
      if (existing) {
        return { provider, sessionId, status: "skipped", threadId: existing }
      }
      const file = this.index.get(key)
      if (!file)
        return failed("This conversation is no longer on this computer.")
      if (file.size > IMPORT_LIMITS.maxFileBytes) {
        return failed("This conversation is too large to import.")
      }
      const transcript = await this.readTranscript(file)
      if (!transcript) return failed("This conversation couldn't be read.")
      if (
        transcript.internal ||
        (transcript.cwd &&
          isAppOwnedFolder(transcript.cwd, this.deps.dataDir, this.deps.tmpDir))
      ) {
        return failed("This session was not one of your conversations.")
      }
      const first = transcript.messages[0]
      const last = transcript.messages[transcript.messages.length - 1]
      if (!first || !last) {
        return failed("This conversation has no messages to import.")
      }

      const project = this.projectFor(transcript.cwd, projects)
      const folderExists = project.path
        ? await isDirectory(project.path)
        : false
      const projectPath = folderExists && project.path ? project.path : ""
      const projectName =
        folderExists && project.name ? project.name : FOLDERLESS_PROJECT_NAME
      const resumable = this.resumable(provider, file, projectPath || null)
      const threadId = randomUUID()
      const importedAt = (this.deps.now?.() ?? new Date()).toISOString()
      const source: ThreadImportSource = {
        provider,
        sessionId,
        filePath: file.path,
        importedAt,
        resumable,
        ...(transcript.omittedMessages > 0
          ? { omittedMessages: transcript.omittedMessages }
          : {}),
      }

      await this.deps.withMutation(
        { threadIds: [threadId], workspaces: projectPath ? [projectPath] : [] },
        () =>
          this.deps.db.transaction(() => {
            this.deps.threads.save({
              thread_id: threadId,
              title: transcript.title ?? "Imported conversation",
              project_name: projectName,
              project_path: projectPath,
              created_at: transcript.startedAt ?? first.createdAt,
              updated_at: transcript.endedAt ?? last.createdAt,
              codex_thread_id: null,
              messages: transcript.messages.map((message) =>
                toSaveMessage(message, provider)
              ),
            })
            this.store.setSource(threadId, source)
            // Continuing the chat picks the CLI it came from.
            this.deps.threads.updateThreadSettings(threadId, {
              selectedProviderId: provider,
            } as ThreadSettingsPatch)
            if (resumable) {
              this.bindNativeSession({
                threadId,
                provider,
                sessionId,
                projectPath,
                importedAt,
              })
            }
          })()
      )
      logger.info(
        {
          provider,
          messages: transcript.messages.length,
          omitted: transcript.omittedMessages,
          resumable,
          folderless: !projectPath,
        },
        "Imported a conversation"
      )
      return {
        provider,
        sessionId,
        status: "imported",
        threadId,
        thread: this.deps.threads.getThreadSummary(threadId) ?? undefined,
      }
    } catch (error) {
      // Only the kind of failure: a message could quote the conversation.
      logger.warn(
        {
          provider,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        "Conversation import failed"
      )
      return failed(
        error instanceof HttpError
          ? error.message
          : "This conversation couldn't be imported."
      )
    }
  }

  /**
   * Binds the chat to the CLI's session the way a running chat is bound
   * (`ProviderSessionBindingStore`), so the next turn resumes it.
   */
  private bindNativeSession(input: {
    threadId: string
    provider: ConversationImportProvider
    sessionId: string
    projectPath: string
    importedAt: string
  }): void {
    const { threadId, provider, sessionId } = input
    // The default instance of each CLI uses the session folders read here.
    const instanceId = provider
    const continuationKey = this.deps.continuationKey(instanceId)
    if (!continuationKey) return
    this.deps.bindings.upsert({
      threadId,
      providerInstanceId: instanceId,
      providerKind: provider,
      providerThreadId: sessionId,
      // The cursors each adapter writes for its own sessions
      // (`makeClaudeResumeCursor`, Codex's `{ threadId }`); Claude resumes at
      // the end of the session.
      resumeCursor:
        provider === "claude"
          ? {
              threadId,
              resume: sessionId,
              sessionId,
              turnCount: 0,
              turnResumeSessionAts: [],
            }
          : { threadId: sessionId },
      continuationKey,
      status: "stopped",
      cwd: input.projectPath || null,
    })
    // Both CLIs compact a resumed session themselves. Saying so, as their
    // usage reports do, keeps BetterC0de's own compaction from summarising
    // the imported messages, which would start a new session instead.
    this.deps.activities.upsert({
      activity_id: `conversation-import:${threadId}`,
      thread_id: threadId,
      turn_id: null,
      provider_instance_id: instanceId,
      kind: "context-window.updated",
      tone: "info",
      summary: "Context window updated",
      payload: {
        compactsAutomatically: true,
        providerKind: provider,
        providerInstanceId: instanceId,
      },
      created_at: input.importedAt,
    })
  }

  /**
   * Whether the default instance can resume the session: it uses the same
   * CLI home, and for Claude Code the chat's folder maps to the project
   * folder the session file is in (the CLI looks the session up there).
   */
  private resumable(
    provider: ConversationImportProvider,
    file: SessionFile,
    projectPath: string | null
  ): boolean {
    if (provider === "claude") {
      if (!projectPath) return false
      const key = this.deps.continuationKey("claude")
      if (!key || key !== claudeContinuationKeyFor(this.roots.claude))
        return false
      return (
        path.basename(path.dirname(file.path)) ===
        claudeProjectDirectoryName(path.resolve(projectPath).normalize("NFC"))
      )
    }
    if (file.archived) return false
    const key = this.deps.continuationKey("codex")
    return Boolean(key) && key === codexContinuationKeyFor(this.roots.codex)
  }

  private async summarize(
    file: SessionFile,
    deadline: number
  ): Promise<SessionSummary | null> {
    const cached = this.summaries.get(file.path)
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs)
      return cached.summary
    const parser = createParser(file.provider, {
      keepMessages: false,
      fallbackAt: new Date(file.mtimeMs).toISOString(),
    })
    // Once the budget is spent, the start of a file still gives its title
    // and folder; only the count is then missing.
    const read = await readJsonlLines(
      file.path,
      (line) => parser.pushLine(line),
      Date.now() >= deadline
        ? { limitBytes: IMPORT_LIMITS.headBytes }
        : { shouldStop: () => Date.now() >= deadline }
    )
    if (!read) return null
    const transcript = parser.finish()
    const summary: SessionSummary = {
      sessionId: transcript.sessionId,
      cwd: transcript.cwd,
      title: transcript.title,
      startedAt: transcript.startedAt,
      endedAt: transcript.endedAt,
      messageCount: read.complete ? transcript.messageCount : null,
      internal: transcript.internal,
    }
    if (read.complete) {
      if (this.summaries.size >= IMPORT_LIMITS.summaryCacheEntries)
        this.summaries.clear()
      this.summaries.set(file.path, {
        size: file.size,
        mtimeMs: file.mtimeMs,
        summary,
      })
    }
    return summary
  }

  private async readTranscript(
    file: SessionFile
  ): Promise<ImportedTranscript | null> {
    const parser = createParser(file.provider, {
      keepMessages: true,
      fallbackAt: new Date(file.mtimeMs).toISOString(),
    })
    const read = await readJsonlLines(
      file.path,
      (line) => parser.pushLine(line),
      { limitBytes: IMPORT_LIMITS.maxFileBytes }
    )
    return read ? parser.finish() : null
  }

  /**
   * Claude Code resumes a session by its file name; Codex by the id in the
   * rollout's `session_meta`, which its file name repeats.
   */
  private sessionIdOf(file: SessionFile, inFile: string | null): string | null {
    const id =
      file.provider === "claude"
        ? (file.idHint ?? inFile)
        : (inFile ?? file.idHint)
    return id && SESSION_ID.test(id) ? id : null
  }

  private listFiles(
    provider: ConversationImportProvider
  ): Promise<SessionFileListing> {
    return provider === "claude"
      ? listClaudeSessionFiles(this.roots.claude)
      : listCodexSessionFiles(this.roots.codex)
  }

  /** Files by their name's session id, for an import that came before any listing. */
  private async reindex(
    providers: ConversationImportProvider[]
  ): Promise<void> {
    for (const provider of providers) {
      const listing = await this.listFiles(provider)
      for (const file of listing.files.slice(
        0,
        IMPORT_LIMITS.sessionsPerProvider
      )) {
        const sessionId = this.sessionIdOf(file, null)
        const key = sessionId ? sessionKey(provider, sessionId) : null
        if (key && !this.index.has(key)) this.index.set(key, file)
      }
    }
  }

  /** The folders chats are in already, so an import joins the same project. */
  private knownProjects(): Map<string, ProjectRef> {
    const projects = new Map<string, ProjectRef>()
    for (const raw of this.deps.threads.listProjects()) {
      const project = raw as { name?: unknown; path?: unknown }
      if (typeof project.path !== "string" || !project.path.trim()) continue
      projects.set(comparablePath(project.path), {
        path: project.path,
        name:
          typeof project.name === "string" && project.name.trim()
            ? project.name
            : path.basename(project.path),
      })
    }
    return projects
  }

  private projectFor(
    cwd: string | null,
    projects: Map<string, ProjectRef>
  ): ProjectRef {
    if (!cwd) return { path: null, name: null }
    return (
      projects.get(comparablePath(cwd)) ?? {
        path: cwd,
        name: path.basename(path.resolve(cwd)) || cwd,
      }
    )
  }

  private async folderExists(
    folder: string,
    cache: Map<string, boolean>
  ): Promise<boolean> {
    const cached = cache.get(folder)
    if (cached !== undefined) return cached
    const exists = await isDirectory(folder)
    cache.set(folder, exists)
    return exists
  }
}

/** One imported message in the form the thread store saves (`parseThreadSaveMessage`). */
function toSaveMessage(
  message: ImportedMessage,
  provider: ConversationImportProvider
): ThreadSaveMessage {
  return {
    message_id: randomUUID(),
    turn_id: null,
    role: message.role,
    content: message.text,
    created_at: message.createdAt,
    extra: {
      reasoning: message.reasoning ?? null,
      reasoningDurationMs: null,
      toolCalls: message.toolCalls
        ? message.toolCalls.map((call) => toToolCall(call, provider))
        : null,
      questions: null,
      answeredQuestions: null,
      diffs: null,
      attachments: null,
      usage: null,
      modelId: message.modelId ?? null,
      compactedContext: false,
      compactionGeneration: null,
    },
  }
}

/** A `ToolCall` (packages/schema domain.ts) with the imported, shortened values. */
function toToolCall(
  call: ImportedToolCall,
  provider: ConversationImportProvider
): Record<string, unknown> {
  const hasOutput = call.output !== undefined
  return {
    id: call.id,
    name: call.name,
    input: call.input,
    state: !hasOutput
      ? "input-available"
      : call.failed
        ? "output-error"
        : "output-available",
    providerKind: provider,
    ...(hasOutput ? { output: call.output } : {}),
    ...(call.failed
      ? { error: call.output?.trim() || "The tool failed." }
      : {}),
    ...(call.outputTruncated ? { outputTruncated: true } : {}),
  }
}
