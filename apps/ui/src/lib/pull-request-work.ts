import type { GitHubPullRequestDetail } from "@betterc0de/schema/http-contracts"
import { useChatStore } from "@/lib/chat-store"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import {
  githubPullRequestDiff,
  githubWorkOnPullRequest,
} from "@/services/backend/github-api"

/**
 * Starting a chat from a pull request: "Work on this PR" opens a chat in a
 * worktree checked out on the pull request's branch (through the same
 * worktree manager as any chat worktree); "Ask the agent to review" opens a
 * read-only chat that is sent a review request with the diff.
 */

const REVIEW_DIFF_MAX_CHARS = 80_000

export type PullRequestForChat = Pick<
  GitHubPullRequestDetail,
  "number" | "title" | "url" | "headBranch" | "baseBranch" | "body" | "author"
>

function normalizeFolder(folder: string): string {
  return folder.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function folderName(folder: string): string {
  return folder.split(/[/\\]/).filter(Boolean).pop() || "Project"
}

function chatTitle(pullRequest: PullRequestForChat, prefix: string): string {
  const title = `${prefix} #${pullRequest.number}: ${pullRequest.title}`
  return title.length > 80 ? `${title.slice(0, 79)}…` : title
}

function openThread(threadId: string, label: string): void {
  window.dispatchEvent(
    new CustomEvent("betterc0de:open-thread", {
      detail: { threadId, label },
    })
  )
}

/**
 * A new chat on the pull request's branch. Throws (and removes the empty
 * chat) when the branch cannot be checked out.
 */
export async function workOnPullRequest(
  cwd: string,
  pullRequest: PullRequestForChat
): Promise<{ threadId: string; crossRepository: boolean }> {
  const store = useChatStore.getState()
  const title = chatTitle(pullRequest, "PR")
  const threadId = store.createThread(title, folderName(cwd), cwd, {})
  let result: Awaited<ReturnType<typeof githubWorkOnPullRequest>>
  try {
    result = await githubWorkOnPullRequest({
      cwd,
      number: pullRequest.number,
      threadId,
    })
  } catch (error) {
    useChatStore.getState().deleteThread(threadId)
    throw error
  }
  const latest = useChatStore.getState()
  if (result.mode === "worktree") {
    latest.updateThreadContext(threadId, {
      envMode: "worktree",
      branch: result.branch,
      worktreePath: result.path,
      baseBranch: result.baseBranch,
      worktreeState: "ready",
    })
  } else {
    // The branch is already checked out: in the project itself, or in a
    // folder the chat moves to.
    const sameFolder = normalizeFolder(result.path) === normalizeFolder(cwd)
    latest.updateThreadContext(threadId, {
      ...(sameFolder
        ? {}
        : { projectPath: result.path, projectName: folderName(result.path) }),
      branch: result.branch,
      baseBranch: result.baseBranch,
    })
  }
  latest.setDraft(
    threadId,
    `Pull request #${pullRequest.number} "${pullRequest.title}" (${pullRequest.url}) is checked out on ${result.branch}. `
  )
  openThread(threadId, title)
  return { threadId, crossRepository: result.crossRepository }
}

/** The review request a read-only chat is sent. */
export function reviewPrompt(
  pullRequest: PullRequestForChat,
  diff: { text: string; truncated: boolean }
): string {
  const description = pullRequest.body.trim()
  const fence = "`".repeat(
    Math.max(
      3,
      ...[...diff.text.matchAll(/`+/g)].map((match) => match[0].length + 1)
    )
  )
  return [
    `Review pull request #${pullRequest.number}: ${pullRequest.title}`,
    `${pullRequest.url}`,
    `Branch ${pullRequest.headBranch} into ${pullRequest.baseBranch}${pullRequest.author ? `, by @${pullRequest.author}` : ""}.`,
    "",
    "Read the change and the code around it, then report what should change before it is merged: bugs and edge cases first, then risks (security, data, performance), missing tests, and readability. Name the file and line for each point and say how sure you are. Don't change any files. The workspace may be on another branch; the diff below is the change under review.",
    ...(description
      ? [
          "",
          "Description (from GitHub):",
          ...description.split("\n").map((line) => `> ${line}`),
        ]
      : []),
    "",
    diff.truncated
      ? "Diff (shortened; read the rest on GitHub or with gh pr diff):"
      : "Diff:",
    `${fence}diff`,
    diff.text,
    fence,
  ].join("\n")
}

/**
 * A read-only chat in the project folder that is sent a review request with
 * the pull request's diff, right away.
 */
export async function askAgentToReview(
  cwd: string,
  pullRequest: PullRequestForChat
): Promise<string> {
  const diff = await githubPullRequestDiff(cwd, pullRequest.number)
  const truncated = diff.truncated || diff.diff.length > REVIEW_DIFF_MAX_CHARS
  const text = reviewPrompt(pullRequest, {
    text: diff.diff.slice(0, REVIEW_DIFF_MAX_CHARS),
    truncated,
  })
  const store = useChatStore.getState()
  const title = chatTitle(pullRequest, "Review")
  const threadId = store.createThread(title, folderName(cwd), cwd, {})
  store.setThreadSetting(threadId, "permissionLevel", "read-only")
  useMessageQueueStore.getState().enqueue(threadId, {
    text,
    visibleText: `Review pull request #${pullRequest.number}: ${pullRequest.title} (${pullRequest.url}). The diff was attached; read-only.`,
    files: [],
    browserElements: [],
  })
  openThread(threadId, title)
  return threadId
}
