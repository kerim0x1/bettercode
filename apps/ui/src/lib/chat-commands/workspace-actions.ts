import { useChatStore } from "@/lib/chat-store"
import { useCheckpointStore } from "@/lib/checkpoint-store"
import { dispatchComposerDraftRestoreAfterSubmit } from "@/lib/composer-draft-events"
import { relativeEditorPath, resolveWorkspaceFilePath } from "@/lib/editor-path"
import { dispatchEditorRevealFile } from "@/lib/editor-reveal-event"
import { useEditorStore } from "@/lib/editor-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import {
  resolveNewThreadContext,
  resolveThreadRuntimePath,
} from "@/lib/thread-context"
import {
  createThreadWorktree,
  loadThreadCheckpointSummary,
  resetThreadWorktree,
  revertThreadCheckpoint,
} from "@/services/backend/coreApi"
import { gitListWorktrees } from "@/services/backend/gitApi"
import { pickFolder, openWorkspace } from "@/services/backend/runtime"
import { buildEditorSelectionContextDraft } from "./input-context"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  type ActiveThreadRef,
} from "./provider-config"

export async function buildOpenFileOutput(
  threadId: string | null,
  args: string[]
): Promise<string> {
  const target = parseOpenFileTarget(args.join(" "))
  if (!target.path) {
    usePreferencesStore.getState().set("appMode", "editor")
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("betterc0de:open-quick-open"))
    }
    return "# Open File\n\nQuick Open is open."
  }

  const thread = threadId
    ? useChatStore
        .getState()
        .threads.find((candidate) => candidate.id === threadId)
    : null
  const runtimePath = resolveThreadRuntimePath(thread)
  if (!runtimePath) {
    return "# Open File\n\n> No workspace folder is available for this chat."
  }

  const fullPath = resolveWorkspaceFilePath(runtimePath, target.path)
  usePreferencesStore.getState().setMultiple({
    appMode: "editor",
    editorSidebarView: "files",
  })
  await useEditorStore.getState().openFile(fullPath, {
    line: target.line,
    column: target.column,
  })
  dispatchEditorRevealFile(fullPath, { defer: true })

  return [
    "# Open File\n",
    `Opened \`${relativeEditorPath(runtimePath, fullPath)}\`.`,
  ].join("\n")
}

export function buildCloseEditorTabOutput(): string {
  const editor = useEditorStore.getState()
  const activeTab = editor.tabs.find((tab) => tab.id === editor.activeTabId)
  if (!activeTab) {
    return "# Close Tab\n\n> No editor tab is open."
  }
  editor.closeTab(activeTab.id)
  return `# Close Tab\n\nClosed \`${activeTab.fileName || activeTab.filePath}\`.`
}

export function buildAddSelectionContextOutput(
  threadId: string | null
): string {
  const editor = useEditorStore.getState()
  const activeTab = editor.tabs.find((tab) => tab.id === editor.activeTabId)
  if (!activeTab) {
    return "# Add Selection\n\n> No editor tab is open."
  }
  const selection = activeTab.selectionContext
  if (!selection || selection.charCount <= 0 || selection.text.length === 0) {
    return "# Add Selection\n\n> No active editor selection to add."
  }
  const store = useChatStore.getState()
  const activeThread = threadId
    ? store.threads.find((candidate) => candidate.id === threadId)
    : null
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const relativePath = relativeEditorPath(runtimePath, activeTab.filePath)
  const nextDraft = buildEditorSelectionContextDraft({
    currentDraft: threadId ? store.getDraft(threadId) : "",
    relativePath,
    language: activeTab.language,
    selection,
  })
  if (threadId) {
    store.setDraft(threadId, nextDraft)
  }
  dispatchComposerDraftRestoreAfterSubmit({ threadId, text: nextDraft })

  const lineLabel =
    selection.startLine === selection.endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}-${selection.endLine}`
  return [
    "# Add Selection\n",
    `Added \`${escapeInlineCode(relativePath)}:${lineLabel}\` to the composer draft.`,
    "",
    "> Review or add an instruction, then submit the message when ready.",
  ].join("\n")
}

export function buildClearEditorContextOutput(): string {
  const editor = useEditorStore.getState()
  const activeTab = editor.tabs.find((tab) => tab.id === editor.activeTabId)
  if (!activeTab) {
    return "# Editor Context\n\n> No editor tab is open."
  }
  if (activeTab.selectionCharCount <= 0) {
    return "# Editor Context\n\n> No active editor selection context to clear."
  }
  useEditorStore.setState((state) => ({
    tabs: state.tabs.map((tab) =>
      tab.id === activeTab.id
        ? {
            ...tab,
            selectionLineCount: 0,
            selectionCharCount: 0,
            selectionContext: null,
          }
        : tab
    ),
  }))
  return "# Editor Context\n\nCleared the active editor selection context."
}

export async function buildWarpWorkspaceOutput(
  threadId: string | null,
  args: string[]
): Promise<string> {
  const requestedPath = args.join(" ").trim()
  const selectedPath = requestedPath
    ? await openWorkspace(requestedPath)
    : await pickFolder()
  if (!selectedPath) {
    return "# Warp Workspace\n\n> No folder selected."
  }

  const store = useChatStore.getState()
  const activeThread = threadId
    ? store.threads.find((candidate) => candidate.id === threadId)
    : null
  const context = resolveNewThreadContext({
    selectedPath,
    activeThread,
  })

  if (!threadId || !activeThread) {
    const nextThreadId = store.createThread(
      "New Chat",
      context.projectName,
      context.projectPath,
      context.options
    )
    return [
      "# Warp Workspace\n",
      `Created a new chat in **${escapeMarkdownTableCell(context.projectName)}**.`,
      "",
      `Workspace: \`${escapeMarkdownTableCell(context.projectPath ?? selectedPath)}\``,
      `Thread: \`${nextThreadId.slice(0, 8)}\``,
    ].join("\n")
  }

  store.updateThreadContext(threadId, {
    projectName: context.projectName,
    projectPath: context.projectPath ?? selectedPath,
    envMode: "local",
    branch: null,
    worktreePath: null,
    baseBranch: null,
    worktreeState: "none",
  })

  return [
    "# Warp Workspace\n",
    `This chat now uses **${escapeMarkdownTableCell(context.projectName)}**.`,
    "",
    `Workspace: \`${escapeMarkdownTableCell(context.projectPath ?? selectedPath)}\``,
  ].join("\n")
}

export async function buildWorkspaceNewOutput(
  threadId: string | null
): Promise<string> {
  const store = useChatStore.getState()
  const activeThread = threadId
    ? store.threads.find((candidate) => candidate.id === threadId)
    : null
  if (!threadId || !activeThread) {
    return "# New Workspace\n\n> No active chat is available."
  }
  const baseRepoPath = activeThread.projectPath || activeThread.worktreePath
  if (!baseRepoPath) {
    return "# New Workspace\n\n> Open a project folder before creating an isolated worktree."
  }

  try {
    const worktree = await createThreadWorktree(threadId, {
      baseRepoPath,
      firstMessage: null,
    })
    store.updateThreadContext(threadId, {
      envMode: "worktree",
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      baseBranch: worktree.baseBranch,
      worktreeState: "ready",
    })
    return [
      "# New Workspace\n",
      "Created an isolated git worktree for this chat.",
      "",
      `Worktree: \`${escapeMarkdownTableCell(worktree.worktreePath)}\``,
      `Branch: \`${escapeMarkdownTableCell(worktree.branch)}\``,
      `Base: \`${escapeMarkdownTableCell(worktree.baseBranch)}\``,
    ].join("\n")
  } catch (error) {
    return [
      "# New Workspace\n",
      "> Could not create an isolated git worktree.",
      "",
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }
}

export function buildWorkspaceToggleOutput(
  activeThread: ActiveThreadRef
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Workspace\n\n> No workspace folder is open."
  }
  const worktreePath = activeThread?.worktreePath?.trim()
  return [
    "# Workspace\n",
    `Active path: \`${escapeMarkdownTableCell(runtimePath)}\``,
    "",
    worktreePath
      ? `This chat is using an isolated worktree: \`${escapeMarkdownTableCell(worktreePath)}\`.`
      : "This chat is using the shared project workspace.",
    "",
    "Use `/workspace-new` to allocate an isolated git worktree for the active chat, `/workspace-reset` to clean the current worktree, or `/project-open` to choose another folder.",
  ].join("\n")
}

export async function buildWorkspaceListOutput(
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Worktrees\n\n> No workspace folder is open."
  }

  try {
    const worktrees = await gitListWorktrees(runtimePath)
    if (worktrees.length === 0) {
      return "# Worktrees\n\n> No git worktrees were reported for this workspace."
    }
    const activePath = activeThread?.worktreePath || activeThread?.projectPath
    return [
      "# Worktrees\n",
      `Repository: \`${escapeMarkdownTableCell(runtimePath)}\``,
      "",
      "| Active | Path | Branch | Head | State |",
      "|:-------|:-----|:-------|:-----|:------|",
      ...worktrees.map((worktree) => {
        const active =
          activePath && pathsEqualForDisplay(worktree.path, activePath)
            ? "Yes"
            : ""
        const state = [
          worktree.bare ? "bare" : "",
          worktree.detached ? "detached" : "",
          worktree.prunable ? "prunable" : "",
        ]
          .filter(Boolean)
          .join(", ")
        const head = (worktree.head ?? "").slice(0, 12) || "-"
        return `| ${active} | \`${escapeMarkdownTableCell(worktree.path)}\` | ${escapeMarkdownTableCell(worktree.branch ?? "-")} | \`${escapeMarkdownTableCell(head)}\` | ${escapeMarkdownTableCell(state || "ready")} |`
      }),
      "",
      "Use `/workspace-new` to create an isolated worktree for this chat, `/workspace-reset` to clean it, or `/workspace-remove` to remove the active chat worktree.",
    ].join("\n")
  } catch (error) {
    return [
      "# Worktrees\n",
      "> Could not list git worktrees for this workspace.",
      "",
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }
}

export async function buildWorkspaceResetOutput(
  threadId: string | null,
  args: readonly string[]
): Promise<string> {
  const store = useChatStore.getState()
  const activeThread = threadId
    ? store.threads.find((candidate) => candidate.id === threadId)
    : null
  if (!threadId || !activeThread) {
    return "# Reset Workspace\n\n> No active chat is available."
  }

  const worktreePath = activeThread.worktreePath?.trim()
  if (!worktreePath) {
    return "# Reset Workspace\n\n> This chat is not using an isolated worktree."
  }

  const clean = !args.includes("--keep-untracked")
  const updateSubmodules = !args.includes("--skip-submodules")

  try {
    const reset = await resetThreadWorktree(threadId, {
      clean,
      updateSubmodules,
    })
    store.updateThreadContext(threadId, {
      envMode: "worktree",
      branch: reset.branch,
      worktreePath: reset.worktreePath,
      baseBranch: reset.baseBranch,
      worktreeState: "ready",
    })
    return [
      "# Reset Workspace\n",
      "Reset the isolated worktree for this chat.",
      "",
      `Worktree: \`${escapeMarkdownTableCell(reset.worktreePath)}\``,
      `Branch: \`${escapeMarkdownTableCell(reset.branch)}\``,
      `Base: \`${escapeMarkdownTableCell(reset.baseBranch)}\``,
      `Head: \`${escapeMarkdownTableCell((reset.headSha ?? "").slice(0, 12) || "-")}\``,
      `Clean untracked files: ${clean ? "yes" : "no"}`,
      `Update submodules: ${updateSubmodules ? "yes" : "no"}`,
    ].join("\n")
  } catch (error) {
    return [
      "# Reset Workspace\n",
      "> Could not reset the isolated worktree.",
      "",
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }
}

function pathsEqualForDisplay(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.trim().replace(/\\/g, "/").replace(/\/+$/g, "")
  return normalize(left) === normalize(right)
}

function parseOpenFileTarget(value: string): {
  path: string
  line?: number
  column?: number
} {
  const cleaned = value.trim().replace(/^["']|["']$/g, "")
  if (!cleaned) return { path: "" }
  const match = cleaned.match(/^(.*?)(?::(\d+))(?::(\d+))?$/)
  if (!match) return { path: cleaned }
  const path = match[1]?.trim() ?? cleaned
  if (!path) return { path: cleaned }
  const line = Number(match[2])
  const column = Number(match[3])
  return {
    path,
    line: Number.isInteger(line) && line > 0 ? line : undefined,
    column: Number.isInteger(column) && column > 0 ? column : undefined,
  }
}

export async function buildUndoCheckpointOutput(
  threadId: string | null,
  requestedTurn?: string
): Promise<string> {
  if (!threadId) {
    return "# Undo\n\n> No active chat to restore."
  }

  try {
    // Only the newest restorable turn is needed; the summary view never
    // loads diff bodies (a long thread holds hundreds of them).
    const { currentTurnCount: currentTurn } =
      await loadThreadCheckpointSummary(threadId)
    if (currentTurn <= 0) {
      return "# Undo\n\n> No checkpoint is available for this chat yet."
    }

    const explicitTurn = parseRequestedTurn(requestedTurn)
    if (explicitTurn === "invalid") {
      return "# Undo\n\n> Usage: `/undo` or `/undo <turn-number>`."
    }
    const targetTurn =
      typeof explicitTurn === "number"
        ? Math.min(explicitTurn, currentTurn)
        : Math.max(0, currentTurn - 1)
    if (targetTurn >= currentTurn) {
      return `# Undo\n\n> Already at checkpoint turn ${currentTurn}.`
    }

    const result = await revertThreadCheckpoint(threadId, targetTurn)
    if (!result.reverted) {
      return [
        "# Undo\n",
        "> Checkpoint restore failed.",
        "",
        result.reason ? `Reason: ${result.reason}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    }

    applyLocalCheckpointRevert(threadId, result.boundaryMessageId, targetTurn)
    return [
      "# Undo\n",
      `Restored checkpoint turn **${targetTurn}**.`,
      "",
      `- Rolled back turns: ${result.rolledBackTurns}`,
      `- Deleted messages: ${result.deletedMessages}`,
    ].join("\n")
  } catch (error) {
    return [
      "# Undo\n",
      "> Checkpoint restore failed.",
      "",
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    ].join("\n")
  }
}

export async function buildRedoCheckpointOutput(
  threadId: string | null
): Promise<string> {
  if (!threadId) {
    return "# Redo\n\n> No active chat to redo."
  }
  return [
    "# Redo\n",
    "> Redo is unavailable after a server-authoritative checkpoint restore.",
    "",
    "Undo retires future Git refs and provider history so the filesystem, provider session, and durable chat record cannot diverge. No state was changed.",
  ].join("\n")
}

function applyLocalCheckpointRevert(
  threadId: string,
  boundaryMessageId: string | null,
  targetTurn: number,
  options: { preserveCheckpointRefs?: boolean } = {}
): void {
  useChatStore.setState((state) => {
    const restStreaming = { ...state.streamingByThread }
    const restActivities = { ...state.activitiesByThread }
    const restActivitiesLoaded = { ...state.activitiesLoadedByThread }
    delete restStreaming[threadId]
    delete restActivities[threadId]
    delete restActivitiesLoaded[threadId]
    return {
      streamingByThread: restStreaming,
      activitiesByThread: restActivities,
      activitiesLoadedByThread: restActivitiesLoaded,
      threads: state.threads.map((thread) => {
        if (thread.id !== threadId) return thread
        const boundaryIndex = boundaryMessageId
          ? thread.messages.findIndex(
              (message) => message.id === boundaryMessageId
            )
          : -1
        const messages =
          boundaryMessageId && boundaryIndex >= 0
            ? thread.messages.slice(0, boundaryIndex + 1)
            : []
        return {
          ...thread,
          messages,
          messageCount: messages.length,
          updatedAt: new Date().toISOString(),
        }
      }),
    }
  })
  useCheckpointStore.getState().deleteCheckpointsAfter(threadId, {
    turnNumber: targetTurn,
    preserveRefs: options.preserveCheckpointRefs ?? false,
  })
  void useChatStore.getState().hydrateThreadActivities(threadId)
}

function parseRequestedTurn(
  value: string | undefined
): number | "invalid" | null {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return "invalid"
  return parsed
}
