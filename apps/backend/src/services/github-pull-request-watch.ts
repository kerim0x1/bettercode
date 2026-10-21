import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type {
  GitHubCheckRun,
  GitHubConversationItem,
  GitHubPullRequestWatch,
  GitHubPullRequestWatchList,
  GitHubPullRequestWatchState,
  GitHubWakeNotice,
} from "@betterc0de/schema/http-contracts"
import type { AppState } from "../appState"
import { HttpError } from "../errors"
import { logger } from "../observability/logger"
import { broadcastThreadSettings } from "../ws/threadActivityBroadcast"
import { parseGhJson, runGh } from "./github-cli"
import {
  actionsJobFromUrl,
  failedLogTail,
  parseCheckRuns,
  parseConversation,
  parseReviewComments,
  readPullRequestState,
  type GitHubReviewComment,
} from "./github-pull-request-data"
import { viewerLogin } from "./github-pull-request-actions"
import {
  githubRemote,
  listPullRequests,
  type BranchPullRequest,
} from "./github-pull-requests"
import { resolveApprovedWorkspaceRoot } from "./workspace/authorization"

/**
 * Pull request wake-ups. A chat that turned them on (its `pullRequestWake`
 * setting) is watched at the sidebar's pull request cadence: the pull
 * request of the chat's branch is read through `gh`, and a failed check on
 * its head commit, a new review or review comment, a new conversation
 * comment, or a new merge conflict becomes one message for the chat.
 *
 * The backend only writes the message down (`<dataDir>/pull-request-watch.json`);
 * the desktop window claims it and sends it like a typed message, so the
 * turn runs with the chat's own model and settings, right away when the
 * chat is idle and queued behind the running turn when it is busy.
 *
 * Guards: events are remembered by id (check name and commit, review and
 * comment ids), anything from before the wake-up was turned on is ignored,
 * the signed-in user's own comments never wake the chat (nor do any while
 * that user is unknown), conversation comments count only from the
 * repository's owners, members and collaborators, a chat is woken at most
 * once every ten minutes and twelve times a day, and watching stops when
 * the pull request is merged or closed.
 */

export const WATCH_INTERVAL_MS = 2 * 60_000
const WATCH_INITIAL_DELAY_MS = 45_000
const WATCH_POKE_DELAY_MS = 3_000
export const WAKE_COOLDOWN_MS = 10 * 60_000
export const MAX_WAKES_PER_DAY = 12
const DAY_MS = 24 * 60 * 60_000
const MAX_WATCHED_THREADS = 25
const MAX_SEEN = 500
const MAX_PENDING = 40
const MAX_NOTICES = 100
const NOTICE_TTL_MS = DAY_MS
const STOPPED_VISIBLE_MS = DAY_MS
const EXCERPT_MAX_CHARS = 1_200
const MESSAGE_MAX_CHARS = 12_000
const MAX_LOG_TAILS = 2
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024
const LOG_MAX_BYTES = 1024 * 1024
const WATCH_FILE = "pull-request-watch.json"

/** Associations whose conversation comments may wake a chat. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

// ── Events ──────────────────────────────────────────────────────────────

const wakeEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("check"),
    id: z.string(),
    sha: z.string(),
    name: z.string(),
    workflow: z.string().nullable(),
    url: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("review"),
    id: z.string(),
    author: z.string(),
    state: z.string().nullable(),
    body: z.string(),
  }),
  z.object({
    kind: z.literal("comment"),
    id: z.string(),
    author: z.string(),
    body: z.string(),
    url: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("review_comment"),
    id: z.string(),
    author: z.string(),
    body: z.string(),
    path: z.string().nullable(),
    line: z.number().nullable(),
    url: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("conflict"),
    id: z.string(),
    sha: z.string(),
    base: z.string(),
  }),
])

export type WakeEvent = z.infer<typeof wakeEventSchema>

/** What one look at the pull request saw. */
export interface WatchSnapshot {
  number: number
  title: string
  url: string
  headBranch: string
  baseBranch: string
  headSha: string | null
  mergeable: "mergeable" | "conflicting" | "unknown"
  checkRuns: GitHubCheckRun[]
  conversation: GitHubConversationItem[]
}

function excerpt(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > EXCERPT_MAX_CHARS
    ? `${trimmed.slice(0, EXCERPT_MAX_CHARS).trimEnd()}…`
    : trimmed
}

function happenedBefore(at: string | null, since: number): boolean {
  const time = Date.parse(at ?? "")
  return Number.isFinite(time) && time < since
}

function isTrusted(
  author: { authorAssociation: string | null; authorIsBot: boolean },
  allowBots: boolean
): boolean {
  if (author.authorIsBot) return allowBots
  return TRUSTED_ASSOCIATIONS.has(
    (author.authorAssociation ?? "").toUpperCase()
  )
}

/**
 * The new events in one look at a pull request. `seenIds` are every event
 * id that was looked at, including the ones too old to wake the chat, so
 * they are not looked at again.
 */
export function detectWakeEvents(input: {
  snapshot: WatchSnapshot
  reviewComments: readonly GitHubReviewComment[]
  viewerLogin: string | null
  /** When wake-ups were turned on (epoch ms); older events are ignored. */
  since: number
  seen: ReadonlySet<string>
  /** The first look at this pull request: an existing conflict is known. */
  firstSight: boolean
}): { events: WakeEvent[]; seenIds: string[] } {
  const { snapshot, seen, since } = input
  const events: WakeEvent[] = []
  const seenIds: string[] = []
  const consider = (id: string, old: boolean, event: () => WakeEvent) => {
    if (seen.has(id)) return
    seenIds.push(id)
    if (!old) events.push(event())
  }

  if (snapshot.headSha) {
    const sha = snapshot.headSha
    for (const run of snapshot.checkRuns) {
      if (run.status !== "fail") continue
      consider(
        `check:${sha}:${run.workflow ?? ""}:${run.name}`,
        happenedBefore(run.completedAt ?? run.startedAt, since),
        () => ({
          kind: "check",
          id: `check:${sha}:${run.workflow ?? ""}:${run.name}`,
          sha,
          name: run.name,
          workflow: run.workflow,
          url: run.url,
        })
      )
    }
    if (snapshot.mergeable === "conflicting") {
      consider(`conflict:${sha}`, input.firstSight, () => ({
        kind: "conflict",
        id: `conflict:${sha}`,
        sha,
        base: snapshot.baseBranch,
      }))
    }
  }

  // Without knowing who the signed-in user is, its own comments cannot be
  // told apart: wake for none of them this time.
  const viewer = input.viewerLogin?.toLowerCase()
  if (!viewer) return { events, seenIds }
  const fromSomeoneElse = (author: string | null): author is string =>
    Boolean(author) && author!.toLowerCase() !== viewer

  for (const item of snapshot.conversation) {
    if (!fromSomeoneElse(item.author)) continue
    if (item.kind === "comment") {
      // Bots' conversation comments are reports (coverage, previews).
      if (!isTrusted(item, false)) continue
      const id = `comment:${item.id}`
      const author = item.author
      consider(id, happenedBefore(item.createdAt, since), () => ({
        kind: "comment",
        id,
        author,
        body: excerpt(item.body),
        url: item.url,
      }))
      continue
    }
    if (!isTrusted(item, true)) continue
    // An approval without words and a review that only carries inline
    // comments (reported on their own) need nothing from the agent.
    if (item.reviewState === "dismissed") continue
    if (item.reviewState !== "changes_requested" && !item.body.trim()) continue
    const id = `review:${item.id}`
    const author = item.author
    consider(id, happenedBefore(item.createdAt, since), () => ({
      kind: "review",
      id,
      author,
      state: item.reviewState,
      body: excerpt(item.body),
    }))
  }

  for (const comment of input.reviewComments) {
    if (!fromSomeoneElse(comment.author)) continue
    if (!isTrusted(comment, true)) continue
    const id = `review-comment:${comment.id}`
    const author = comment.author
    consider(id, happenedBefore(comment.createdAt, since), () => ({
      kind: "review_comment",
      id,
      author,
      body: excerpt(comment.body),
      path: comment.path,
      line: comment.line,
      url: comment.url,
    }))
  }
  return { events, seenIds }
}

/**
 * The pending events still worth a message: a failed check or a conflict
 * only while the pull request's head is the commit it was seen on.
 */
export function currentEvents(
  events: readonly WakeEvent[],
  snapshot: Pick<WatchSnapshot, "headSha" | "mergeable">
): WakeEvent[] {
  return events.filter((event) => {
    if (event.kind === "check") return event.sha === snapshot.headSha
    if (event.kind === "conflict")
      return (
        event.sha === snapshot.headSha && snapshot.mergeable === "conflicting"
      )
    return true
  })
}

/** Whether a chat may be woken now: ten minutes apart, twelve a day. */
export function canWake(
  record: { lastWokeAt: string | null; wakeTimes: readonly string[] },
  now: number
): boolean {
  const lastWoke = Date.parse(record.lastWokeAt ?? "")
  if (Number.isFinite(lastWoke) && now - lastWoke < WAKE_COOLDOWN_MS)
    return false
  const today = record.wakeTimes.filter((at) => {
    const time = Date.parse(at)
    return Number.isFinite(time) && now - time < DAY_MS
  })
  return today.length < MAX_WAKES_PER_DAY
}

/** A fence that a quoted text cannot close early. */
function fenceFor(text: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length)
  )
  return "`".repeat(Math.max(3, longest + 1))
}

function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")
}

function inlineCode(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``
}

/** The one-line summary and the message for a chat about `events`. */
export function formatWakeNotice(input: {
  pullRequest: Pick<
    WatchSnapshot,
    "number" | "title" | "url" | "headBranch" | "baseBranch"
  >
  events: readonly WakeEvent[]
  /** Failed log tails by check event id. */
  logTails?: ReadonlyMap<string, string>
}): { title: string; text: string } {
  const { pullRequest, events } = input
  const checks = events.filter(
    (event): event is Extract<WakeEvent, { kind: "check" }> =>
      event.kind === "check"
  )
  const reviews = events.filter(
    (event): event is Extract<WakeEvent, { kind: "review" }> =>
      event.kind === "review"
  )
  const comments = events.filter(
    (event): event is Extract<WakeEvent, { kind: "comment" }> =>
      event.kind === "comment"
  )
  const reviewComments = events.filter(
    (event): event is Extract<WakeEvent, { kind: "review_comment" }> =>
      event.kind === "review_comment"
  )
  const conflict = events.find(
    (event): event is Extract<WakeEvent, { kind: "conflict" }> =>
      event.kind === "conflict"
  )

  const parts: string[] = []
  if (checks.length > 0)
    parts.push(checks.length === 1 ? "a check failed" : "checks failed")
  if (reviews.some((review) => review.state === "changes_requested"))
    parts.push("changes requested")
  else if (reviews.length > 0 || reviewComments.length > 0)
    parts.push("new review")
  if (comments.length > 0) parts.push("new comments")
  if (conflict) parts.push("merge conflict")
  const summary = parts.join(", ") || "new activity"
  const title = `${summary.charAt(0).toUpperCase()}${summary.slice(1)} on #${pullRequest.number}`

  const sections: string[] = [
    `GitHub update on pull request #${pullRequest.number} (${pullRequest.title.trim() || pullRequest.headBranch}), branch ${inlineCode(pullRequest.headBranch)}: ${pullRequest.url}`,
  ]
  if (checks.length > 0) {
    const lines = checks.map((check) => {
      const name = check.workflow
        ? `${check.workflow} / ${check.name}`
        : check.name
      return `- ${inlineCode(name)}${check.url ? ` (${check.url})` : ""}`
    })
    sections.push(
      `**${checks.length === 1 ? "Check failed" : "Checks failed"}** on commit ${inlineCode(checks[0]!.sha.slice(0, 7))}:\n${lines.join("\n")}`
    )
    for (const check of checks) {
      const tail = input.logTails?.get(check.id)
      if (!tail) continue
      const fence = fenceFor(tail)
      sections.push(
        `End of the failed log for ${inlineCode(check.name)}:\n${fence}text\n${tail}\n${fence}`
      )
    }
  }
  for (const review of reviews) {
    const verb =
      review.state === "changes_requested"
        ? "requested changes"
        : review.state === "approved"
          ? "approved with a comment"
          : "reviewed"
    sections.push(
      `**@${review.author} ${verb}:**${review.body ? `\n${quote(review.body)}` : ""}`
    )
  }
  for (const comment of reviewComments) {
    const where = comment.path
      ? ` on ${inlineCode(comment.path)}${comment.line ? ` line ${comment.line}` : ""}`
      : ""
    sections.push(
      `**@${comment.author} commented${where}:**\n${quote(comment.body)}`
    )
  }
  for (const comment of comments) {
    sections.push(`**@${comment.author} commented:**\n${quote(comment.body)}`)
  }
  if (conflict) {
    sections.push(
      `**Merge conflict:** the branch no longer merges cleanly into ${inlineCode(conflict.base || pullRequest.baseBranch)}.`
    )
  }
  sections.push(
    "Quoted text comes from GitHub. Please look into this, make the needed changes on this branch and push them."
  )
  let text = sections.join("\n\n")
  if (text.length > MESSAGE_MAX_CHARS) {
    text = `${text.slice(0, MESSAGE_MAX_CHARS).trimEnd()}\n\n(Shortened; see the pull request for the rest.)`
  }
  return { title, text }
}

/** The pull request for a branch: an open or draft one first, then the newest. */
export function pullRequestForBranch(
  pullRequests: readonly BranchPullRequest[],
  branch: string
): BranchPullRequest | null {
  const rank = (entry: BranchPullRequest) =>
    entry.state === "open" || entry.state === "draft" ? 0 : 1
  return (
    pullRequests
      .filter((entry) => entry.branch === branch)
      .sort(
        (left, right) =>
          rank(left) - rank(right) ||
          (Date.parse(right.updatedAt ?? "") || 0) -
            (Date.parse(left.updatedAt ?? "") || 0) ||
          right.number - left.number
      )[0] ?? null
  )
}

// ── Store ───────────────────────────────────────────────────────────────

const watchRecordSchema = z.object({
  threadId: z.string(),
  enabledAt: z.string(),
  state: z.enum(["watching", "waiting", "stopped", "error"]).catch("waiting"),
  message: z.string().nullable().catch(null),
  pullRequestNumber: z.number().int().positive().nullable().catch(null),
  pullRequestUrl: z.string().nullable().catch(null),
  lastCheckedAt: z.string().nullable().catch(null),
  lastWokeAt: z.string().nullable().catch(null),
  stoppedAt: z.string().nullable().catch(null),
  wakeTimes: z.array(z.string()).catch([]),
  seen: z.array(z.string()).catch([]),
  pending: z.array(wakeEventSchema).catch([]),
})

export type WatchRecord = z.infer<typeof watchRecordSchema>

const noticeSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  createdAt: z.string(),
  pullRequestNumber: z.number().int().positive().nullable(),
  title: z.string(),
  text: z.string(),
})

const watchFileSchema = z.object({
  version: z.literal(1),
  watches: z.record(z.string(), watchRecordSchema).catch({}),
  notices: z.array(noticeSchema).catch([]),
})

type WatchFile = z.infer<typeof watchFileSchema>

function emptyFile(): WatchFile {
  return { version: 1, watches: {}, notices: [] }
}

export function newWatchRecord(threadId: string, now: number): WatchRecord {
  return {
    threadId,
    enabledAt: new Date(now).toISOString(),
    state: "waiting",
    message: "Checking the pull request…",
    pullRequestNumber: null,
    pullRequestUrl: null,
    lastCheckedAt: null,
    lastWokeAt: null,
    stoppedAt: null,
    wakeTimes: [],
    seen: [],
    pending: [],
  }
}

/**
 * The watcher's memory, one small JSON file in the data folder, written
 * atomically (temp + rename) and readable only by this user: it holds
 * excerpts of pull request comments until the desktop sends them.
 */
export class PullRequestWatchStore {
  private file: WatchFile | null = null
  /** Called when a chat turned wake-ups on, to look sooner. */
  onEnabled: (() => void) | null = null

  constructor(private readonly filePath: string) {}

  private data(): WatchFile {
    if (this.file) return this.file
    try {
      const parsed = watchFileSchema.safeParse(
        JSON.parse(fs.readFileSync(this.filePath, "utf8"))
      )
      this.file = parsed.success ? parsed.data : emptyFile()
    } catch {
      this.file = emptyFile()
    }
    return this.file
  }

  save(): void {
    const data = this.data()
    const temp = `${this.filePath}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(temp, JSON.stringify(data), {
        encoding: "utf8",
        mode: 0o600,
      })
      fs.renameSync(temp, this.filePath)
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "pull request watch state could not be saved"
      )
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        // Nothing to clean up.
      }
    }
  }

  record(threadId: string): WatchRecord | null {
    return this.data().watches[threadId] ?? null
  }

  /** The record of a watched chat, created when it has none. */
  ensure(threadId: string, now: number): WatchRecord {
    const data = this.data()
    const existing = data.watches[threadId]
    if (existing && existing.state !== "stopped") return existing
    const created = newWatchRecord(threadId, now)
    data.watches[threadId] = created
    return created
  }

  remove(threadId: string): void {
    const data = this.data()
    delete data.watches[threadId]
    data.notices = data.notices.filter((notice) => notice.threadId !== threadId)
  }

  records(): WatchRecord[] {
    return Object.values(this.data().watches)
  }

  addNotice(notice: GitHubWakeNotice): void {
    const data = this.data()
    data.notices = [...data.notices, notice].slice(-MAX_NOTICES)
  }

  notices(now: number): GitHubWakeNotice[] {
    const data = this.data()
    const fresh = data.notices.filter((notice) => {
      const created = Date.parse(notice.createdAt)
      return Number.isFinite(created) && now - created < NOTICE_TTL_MS
    })
    if (fresh.length !== data.notices.length) data.notices = fresh
    return fresh
  }

  /** Takes a notice out for sending; null when another window took it. */
  claim(noticeId: string): GitHubWakeNotice | null {
    const data = this.data()
    const notice = data.notices.find((entry) => entry.id === noticeId) ?? null
    if (!notice) return null
    data.notices = data.notices.filter((entry) => entry.id !== noticeId)
    this.save()
    return notice
  }
}

const stores = new WeakMap<AppState, PullRequestWatchStore>()

export function pullRequestWatchStore(state: AppState): PullRequestWatchStore {
  let store = stores.get(state)
  if (!store) {
    store = new PullRequestWatchStore(
      path.join(state.config.dataDir, WATCH_FILE)
    )
    stores.set(state, store)
  }
  return store
}

// ── Chats and their status ──────────────────────────────────────────────

interface WatchedThreadRow {
  thread_id: string
  project_path: string | null
  worktree_path: string | null
  branch: string | null
}

/** The chats with wake-ups on, most recently active first. */
function watchedThreads(state: AppState): WatchedThreadRow[] {
  const rows = state.db
    .prepare(
      `SELECT thread_id, project_path, worktree_path, branch
       FROM projection_threads
       WHERE status = 'active' AND settings_json LIKE '%"pullRequestWake":true%'
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(MAX_WATCHED_THREADS) as WatchedThreadRow[]
  // The LIKE is a prefilter; the parsed settings decide.
  return rows.filter(
    (row) =>
      state.threads.getThreadSettings(row.thread_id)?.pullRequestWake === true
  )
}

function toWatch(
  record: WatchRecord,
  enabled: boolean
): GitHubPullRequestWatch {
  return {
    threadId: record.threadId,
    enabled,
    state: record.state,
    pullRequestNumber: record.pullRequestNumber,
    pullRequestUrl: record.pullRequestUrl,
    message: record.message,
    lastCheckedAt: record.lastCheckedAt,
    lastWokeAt: record.lastWokeAt,
  }
}

/**
 * Every watched chat's status, the ones that stopped in the last day, and
 * the messages waiting for the desktop.
 */
export function listPullRequestWatches(
  state: AppState
): GitHubPullRequestWatchList {
  const store = pullRequestWatchStore(state)
  const now = Date.now()
  const watches: GitHubPullRequestWatch[] = []
  let changed = false
  for (const record of store.records()) {
    const enabled =
      state.threads.getThreadSettings(record.threadId)?.pullRequestWake === true
    const stoppedRecently =
      record.state === "stopped" &&
      now - (Date.parse(record.stoppedAt ?? "") || 0) < STOPPED_VISIBLE_MS
    if (!enabled && !stoppedRecently) {
      store.remove(record.threadId)
      changed = true
      continue
    }
    watches.push(toWatch(record, enabled))
  }
  // A chat turned on elsewhere (another client, a restored file) is
  // watched from now on.
  const listed = new Set(watches.map((watch) => watch.threadId))
  for (const row of watchedThreads(state)) {
    if (listed.has(row.thread_id)) continue
    watches.push(toWatch(store.ensure(row.thread_id, now), true))
    changed = true
  }
  const notices = store.notices(now)
  if (changed) store.save()
  return { watches, notices }
}

/**
 * Turns a chat's wake-ups on or off: the setting is kept with the chat
 * (and every client hears it), the watcher's memory here.
 */
export function setPullRequestWatch(
  state: AppState,
  threadId: string,
  enabled: boolean
): GitHubPullRequestWatch | null {
  if (!state.threads.hasThread(threadId)) {
    throw new HttpError(404, "This chat no longer exists.", "thread_not_found")
  }
  const settings = state.threads.updateThreadSettings(threadId, {
    pullRequestWake: enabled ? true : null,
  })
  broadcastThreadSettings({ threadId, settings })
  const store = pullRequestWatchStore(state)
  if (!enabled) {
    store.remove(threadId)
    store.save()
    return null
  }
  const record = store.ensure(threadId, Date.now())
  store.save()
  store.onEnabled?.()
  return toWatch(record, true)
}

// ── Watcher ─────────────────────────────────────────────────────────────

/** One look at a pull request through `gh pr view`. */
async function readSnapshot(
  slug: string,
  number: number
): Promise<{ snapshot: WatchSnapshot; state: string }> {
  const result = await runGh(
    [
      "pr",
      "view",
      String(number),
      "--repo",
      slug,
      "--json",
      "number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,statusCheckRollup,comments,reviews",
    ],
    { maxOutputBytes: SNAPSHOT_MAX_BYTES, timeoutMs: 30_000 }
  )
  const row = parseGhJson(result.stdout)
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("unreadable pull request")
  }
  const value = row as Record<string, unknown>
  const mergeable = String(value.mergeable ?? "").toUpperCase()
  return {
    state: readPullRequestState(value),
    snapshot: {
      number,
      title: typeof value.title === "string" ? value.title : "",
      url: typeof value.url === "string" ? value.url : "",
      headBranch:
        typeof value.headRefName === "string" ? value.headRefName : "",
      baseBranch:
        typeof value.baseRefName === "string" ? value.baseRefName : "",
      headSha: typeof value.headRefOid === "string" ? value.headRefOid : null,
      mergeable:
        mergeable === "CONFLICTING"
          ? "conflicting"
          : mergeable === "MERGEABLE"
            ? "mergeable"
            : "unknown",
      checkRuns: parseCheckRuns(value.statusCheckRollup),
      conversation: parseConversation(value.comments, value.reviews).items,
    },
  }
}

/** The newest inline review comments; none when GitHub does not answer. */
async function readReviewComments(
  slug: string,
  number: number
): Promise<GitHubReviewComment[]> {
  try {
    const result = await runGh(
      [
        "api",
        "--method",
        "GET",
        `repos/${slug}/pulls/${number}/comments`,
        "-f",
        "per_page=50",
        "-f",
        "sort=created",
        "-f",
        "direction=desc",
      ],
      { maxOutputBytes: SNAPSHOT_MAX_BYTES }
    )
    return parseReviewComments(parseGhJson(result.stdout))
  } catch {
    return []
  }
}

/** The end of the failed log of up to two failed Actions jobs. */
async function readFailedLogTails(
  slug: string,
  events: readonly WakeEvent[]
): Promise<Map<string, string>> {
  const tails = new Map<string, string>()
  const checks = events.filter(
    (event): event is Extract<WakeEvent, { kind: "check" }> =>
      event.kind === "check"
  )
  for (const check of checks.slice(0, MAX_LOG_TAILS)) {
    const job = actionsJobFromUrl(check.url)
    if (!job) continue
    try {
      const result = await runGh(
        job.jobId
          ? ["run", "view", "--repo", slug, "--job", job.jobId, "--log-failed"]
          : ["run", "view", job.runId, "--repo", slug, "--log-failed"],
        { maxOutputBytes: LOG_MAX_BYTES, timeoutMs: 25_000 }
      )
      const tail = failedLogTail(result.stdout)
      if (tail) tails.set(check.id, tail)
    } catch {
      // A log is a nicety; the check's link is in the message anyway.
    }
  }
  return tails
}

function setStatus(
  record: WatchRecord,
  state: GitHubPullRequestWatchState,
  message: string | null
): void {
  record.state = state
  record.message = message
}

/**
 * Looks at every watched chat's pull request at the sidebar's two-minute
 * cadence, one chat after another, and writes down a message where
 * something new happened. Its timers never keep the process alive.
 */
export class PullRequestWatcher {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private stopped = false

  constructor(
    private readonly state: AppState,
    private readonly intervalMs = WATCH_INTERVAL_MS
  ) {}

  start(): void {
    this.stopped = false
    this.schedule(WATCH_INITIAL_DELAY_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Looks soon (a chat just turned wake-ups on). */
  poke(): void {
    if (this.stopped || this.polling) return
    this.schedule(WATCH_POKE_DELAY_MS)
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), delayMs)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    this.timer = null
    try {
      await this.poll()
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "pull request watch failed"
      )
    } finally {
      this.schedule(this.intervalMs)
    }
  }

  /** One round over every watched chat. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return
    const state = this.state
    if (state.taintedRef() || state.drainingRef()) return
    this.polling = true
    const store = pullRequestWatchStore(state)
    store.onEnabled = () => this.poke()
    try {
      const rows = watchedThreads(state)
      for (const row of rows) {
        if (this.stopped) break
        const record = store.ensure(row.thread_id, Date.now())
        try {
          await this.check(row, record)
        } catch (error) {
          setStatus(
            record,
            "error",
            error instanceof HttpError
              ? error.message
              : "Couldn't read the pull request. Trying again shortly."
          )
        }
        record.lastCheckedAt = new Date().toISOString()
      }
    } finally {
      store.save()
      this.polling = false
    }
  }

  private async check(
    row: WatchedThreadRow,
    record: WatchRecord
  ): Promise<void> {
    const state = this.state
    const folder = row.worktree_path?.trim() || row.project_path?.trim()
    const branch = row.branch?.trim()
    if (!folder || !branch) {
      setStatus(record, "waiting", "This chat has no branch yet.")
      return
    }
    let cwd: string
    try {
      cwd = await resolveApprovedWorkspaceRoot(state, folder)
    } catch {
      setStatus(record, "error", "The chat's folder isn't available.")
      return
    }
    const listing = await listPullRequests(cwd)
    if (!listing.available) {
      setStatus(
        record,
        "error",
        "GitHub CLI isn't available or signed in, or the repository has no GitHub remote."
      )
      return
    }
    const pullRequest = pullRequestForBranch(listing.pullRequests, branch)
    if (!pullRequest) {
      record.pullRequestNumber = null
      record.pullRequestUrl = null
      setStatus(record, "waiting", `No pull request for ${branch} yet.`)
      return
    }
    if (pullRequest.state === "merged" || pullRequest.state === "closed") {
      this.stopWatching(record, pullRequest.number, pullRequest.state)
      return
    }
    const remote = await githubRemote(cwd)
    if (!remote) {
      setStatus(record, "error", "The repository has no GitHub remote.")
      return
    }
    const firstSight = record.pullRequestNumber !== pullRequest.number
    if (firstSight) record.pending = []
    record.pullRequestNumber = pullRequest.number
    record.pullRequestUrl = pullRequest.url
    const { snapshot, state: prState } = await readSnapshot(
      remote.slug,
      pullRequest.number
    )
    if (prState === "merged" || prState === "closed") {
      this.stopWatching(record, pullRequest.number, prState)
      return
    }
    const [reviewComments, viewer] = await Promise.all([
      readReviewComments(remote.slug, pullRequest.number),
      viewerLogin(),
    ])
    const since = Date.parse(record.enabledAt) || Date.now()
    const detected = detectWakeEvents({
      snapshot,
      reviewComments,
      viewerLogin: viewer,
      since,
      seen: new Set(record.seen),
      firstSight,
    })
    record.seen = [...record.seen, ...detected.seenIds].slice(-MAX_SEEN)
    record.pending = [...record.pending, ...detected.events].slice(-MAX_PENDING)
    setStatus(record, "watching", null)

    const now = Date.now()
    if (record.pending.length === 0 || !canWake(record, now)) return
    const events = currentEvents(record.pending, snapshot)
    record.pending = []
    if (events.length === 0) return
    const logTails = await readFailedLogTails(remote.slug, events)
    const notice = formatWakeNotice({ pullRequest: snapshot, events, logTails })
    const at = new Date(now).toISOString()
    pullRequestWatchStore(state).addNotice({
      id: randomUUID(),
      threadId: record.threadId,
      createdAt: at,
      pullRequestNumber: snapshot.number,
      title: notice.title,
      text: notice.text,
    })
    record.lastWokeAt = at
    record.wakeTimes = [...record.wakeTimes, at].filter(
      (time) => now - (Date.parse(time) || 0) < DAY_MS
    )
  }

  /** The pull request is done: the chat's setting goes off, every client hears it. */
  private stopWatching(
    record: WatchRecord,
    number: number,
    prState: string
  ): void {
    const state = this.state
    try {
      const settings = state.threads.updateThreadSettings(record.threadId, {
        pullRequestWake: null,
      })
      broadcastThreadSettings({ threadId: record.threadId, settings })
    } catch {
      // The chat is gone; its record goes with the next listing.
    }
    record.pending = []
    record.pullRequestNumber = number
    record.stoppedAt = new Date().toISOString()
    setStatus(
      record,
      "stopped",
      `Pull request #${number} was ${prState === "merged" ? "merged" : "closed"}. Wake-ups are off.`
    )
  }
}
