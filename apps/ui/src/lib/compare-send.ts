import type { ChatThread } from "@betterc0de/schema"
import { useBrowserContextStore } from "@/lib/browser-context-store"
import { useChatStore } from "@/lib/chat-store"
import type { ChatSubmitPayload } from "@/lib/chat/types"
import {
  resolveComposerPreferences,
  snapshotComposerModelSettings,
} from "@/lib/composer-settings"
import {
  compareBaseTitle,
  compareChatTitle,
  useCompareSelectionStore,
  type CompareModelEntry,
} from "@/lib/compare-models"
import { handleError } from "@/lib/errors/handle"
import { usePreferencesStore } from "@/lib/preferences-store"
import { upsertProviderComposerSelection } from "@/lib/provider-composer-selection"
import { isProviderUnconfigured } from "@/lib/provider-status-hint"
import type { UiProvider } from "@/lib/provider-types"
import { toast } from "@/lib/toast"
import {
  createThreadWorktree,
  upsertThreadMeta,
} from "@/services/backend/coreApi"
import { isGitRepo } from "@/services/backend/gitApi"

/**
 * Sends one prompt to several models, each in its own chat (Compare).
 *
 * The open chat keeps the composer's own model; every other model gets a new
 * chat with the same project, prompt, attachments, mode and permission level.
 * In a Git repository each chat runs in a new worktree of its own, made the
 * way the composer's **New worktree** run location makes it, so the models
 * never edit each other's files. Elsewhere the chats share the folder, after
 * the user confirmed it. The chats share a `compareGroupId`, and their titles
 * end with their model's name. The open chat stays in front; the others run
 * in the background.
 *
 * Loaded on the first comparison only, like the slash-command runtime.
 */

/** One model of a comparison, as the composer resolved it at send time. */
export interface CompareSendModel {
  readonly entry: CompareModelEntry
  readonly provider: UiProvider | undefined
  /** Readable name, for messages. */
  readonly name: string
  /** Its part of the chat's title ("GPT-5"). */
  readonly label: string
}

export interface CompareSendInput {
  readonly originThreadId: string
  /** The composer's own model first. */
  readonly models: ReadonlyArray<CompareSendModel>
  readonly payload: ChatSubmitPayload
  /** Sends in the open chat, through the composer's own path. */
  readonly sendOrigin: (payload: ChatSubmitPayload) => unknown
  /** Sends in another chat: the one the payload names. */
  readonly sendTo: (payload: ChatSubmitPayload) => unknown
  /** Asks before chats that will share one folder start. */
  readonly confirmSharedFolder: (
    count: number,
    projectName: string
  ) => Promise<boolean>
}

interface CompareChat {
  readonly id: string
  readonly model: CompareSendModel
}

function findThread(threadId: string): ChatThread | undefined {
  return useChatStore
    .getState()
    .threads.find((thread) => thread.id === threadId)
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return message.trim() || "The backend gave no reason."
}

/** Why a model cannot take part, or `null`; the same checks a single send makes. */
function unavailableReason(model: CompareSendModel): string | null {
  const { provider } = model
  if (!provider) return `${model.name} is not available. Choose another model.`
  if (isProviderUnconfigured(provider))
    return `${provider.name} is not set up yet.`
  if (provider.modelsReady === false)
    return `The model list for ${provider.name} is still loading. Try again shortly.`
  if (
    provider.modelsReady === true &&
    !provider.models.some((candidate) => candidate.id === model.entry.modelId)
  )
    return `${model.name} is no longer available for ${provider.name}.`
  return null
}

/**
 * New chats for the other models, beside the open one. `createThread` opens
 * each chat it makes, so the open chat is brought back to the front before
 * React renders.
 */
function createCompareChats(
  origin: ChatThread,
  models: ReadonlyArray<CompareSendModel>,
  groupId: string
): CompareChat[] {
  const prefs = usePreferencesStore.getState()
  const originSettings = useChatStore.getState().settingsByThread[origin.id]
  const composer = resolveComposerPreferences(prefs, originSettings)
  const selections = snapshotComposerModelSettings(
    prefs,
    originSettings
  ).modelSelectionByProvider
  const chats = models.map((model) => {
    const store = useChatStore.getState()
    const id = store.createThread(
      "New Chat",
      origin.projectName,
      origin.projectPath
    )
    const { providerId, modelId, thinkingMode } = model.entry
    store.setThreadSetting(id, "chatMode", composer.chatMode)
    store.setThreadSetting(id, "permissionLevel", composer.permissionLevel)
    store.setThreadSetting(id, "selectedProviderId", providerId)
    store.setThreadSetting(id, "selectedModel", modelId)
    store.setThreadSetting(id, "thinkingMode", thinkingMode)
    store.setThreadSetting(
      id,
      "modelSelectionByProvider",
      upsertProviderComposerSelection(selections, providerId, {
        selectedModel: modelId,
        thinkingMode,
        contextWindow: "1m",
      })
    )
    store.setThreadSetting(id, "compareGroupId", groupId)
    return { id, model }
  })
  useChatStore.getState().setActiveThread(origin.id)
  return chats
}

/**
 * A new worktree for one chat, as the composer's **New worktree** makes it:
 * from the project's repository, on a branch named after the prompt. Chats
 * of a comparison started from a worktree branch off the same base.
 */
async function createChatWorktree(
  threadId: string,
  origin: ChatThread,
  firstMessage: string
): Promise<void> {
  const thread = findThread(threadId)
  if (!thread) throw new Error("The chat was closed.")
  // The worktree belongs to a stored chat; a new chat's own save may still
  // be on its way.
  await upsertThreadMeta(thread)
  const baseBranch = origin.worktreePath?.trim()
    ? origin.baseBranch?.trim()
    : undefined
  const worktree = await createThreadWorktree(threadId, {
    baseRepoPath: origin.projectPath.trim(),
    ...(baseBranch ? { baseBranch } : {}),
    firstMessage,
  })
  useChatStore.getState().updateThreadContext(threadId, {
    envMode: "worktree",
    branch: worktree.branch,
    worktreePath: worktree.worktreePath,
    baseBranch: worktree.baseBranch,
    worktreeState: "ready",
  })
}

/**
 * Titles the chats once their first message is in: one generated title for
 * all of them, each ending with its model ("Fix login · GPT-5"). A chat's own
 * generated title, if it arrives later, gives way to it.
 */
async function titleCompareChats(
  chats: ReadonlyArray<CompareChat>,
  prompt: string,
  sends: ReadonlyArray<Promise<unknown>>
): Promise<void> {
  const [generated] = await Promise.all([
    prompt
      ? import("@/services/backend/chatApi")
          .then(({ generateTitle }) => generateTitle(prompt))
          .then((title) => (typeof title === "string" ? title.trim() : ""))
          .catch(() => "")
      : Promise.resolve(""),
    Promise.allSettled(sends),
  ])
  const base =
    generated && generated.length < 80 ? generated : compareBaseTitle(prompt)
  const store = useChatStore.getState()
  for (const chat of chats) {
    if (!store.threads.some((thread) => thread.id === chat.id)) continue
    store.updateThreadTitle(chat.id, compareChatTitle(base, chat.model.label))
  }
}

/**
 * Starts the comparison. Resolves to `false` when nothing was sent (or the
 * open chat's own send asks to keep the draft), so the composer keeps it.
 */
export async function dispatchCompare(
  input: CompareSendInput
): Promise<boolean | void> {
  const { originThreadId, models, payload } = input
  const [primary, ...others] = models
  const origin = findThread(originThreadId)
  if (!origin || !primary || others.length === 0) return false
  const unavailable = models.map(unavailableReason).find(Boolean)
  if (unavailable) {
    toast.error("Can't start the comparison", { description: unavailable })
    return false
  }

  const selection = useCompareSelectionStore.getState()
  const prompt = (payload.visibleText ?? payload.text).trim()
  const projectPath = origin.projectPath.trim()
  let chats: CompareChat[] = []
  let started = false
  try {
    selection.setProgress(originThreadId, "Checking the project…")
    // A chat without a folder runs in a scratch folder of its own.
    const repository =
      Boolean(projectPath) &&
      (Boolean(origin.worktreePath?.trim()) ||
        (await isGitRepo(projectPath).catch(() => false)))
    if (projectPath && !repository) {
      selection.setProgress(originThreadId, null)
      const confirmed = await input.confirmSharedFolder(
        models.length,
        origin.projectName || projectPath
      )
      if (!confirmed) return false
    }

    const groupId = crypto.randomUUID()
    chats = createCompareChats(origin, others, groupId)

    if (repository) {
      // One after another: parallel `git worktree add` runs contend for the
      // repository's locks. The open chat goes last, so a comparison that
      // cannot start leaves it as it was.
      const targets = [
        ...chats.map((chat) => chat.id),
        ...(origin.worktreePath?.trim() ? [] : [originThreadId]),
      ]
      const failures = new Map<string, string>()
      for (const [index, threadId] of targets.entries()) {
        if (threadId === originThreadId && failures.size === chats.length) break
        selection.setProgress(
          originThreadId,
          `Creating worktree ${index + 1} of ${targets.length}…`
        )
        try {
          await createChatWorktree(threadId, origin, prompt)
        } catch (error) {
          failures.set(threadId, errorText(error))
        }
      }
      const failed = chats.filter((chat) => failures.has(chat.id))
      for (const chat of failed) useChatStore.getState().deleteThread(chat.id)
      chats = chats.filter((chat) => !failures.has(chat.id))
      if (chats.length === 0) {
        const reason = failures.values().next().value ?? ""
        toast.error("Couldn't create the worktrees", { description: reason })
        return false
      }
      for (const chat of failed) {
        toast.warning(`${chat.model.name} was left out`, {
          description: `Couldn't create its worktree: ${failures.get(chat.id) ?? ""}`,
        })
      }
      const originFailure = failures.get(originThreadId)
      if (originFailure) {
        toast.warning(`${primary.name} runs in the project folder`, {
          description: `Couldn't create its worktree: ${originFailure}`,
        })
      }
    }

    // The chats are ready: the open one joins the group and the draft
    // comparison is spent.
    const store = useChatStore.getState()
    store.setThreadSetting(originThreadId, "compareGroupId", groupId)
    selection.clear(originThreadId)
    const elements =
      useBrowserContextStore.getState().byThread[originThreadId] ?? []
    for (const chat of chats) {
      for (const element of elements)
        useBrowserContextStore.getState().add(chat.id, element)
    }
    selection.setProgress(originThreadId, null)

    started = true
    const sends = chats.map((chat) =>
      Promise.resolve()
        .then(() => input.sendTo({ ...payload, threadId: chat.id }))
        .catch((error) => {
          handleError(error, { source: "compare-send" })
        })
    )
    const originSend = Promise.resolve().then(() => input.sendOrigin(payload))
    void titleCompareChats(
      [{ id: originThreadId, model: primary }, ...chats],
      prompt,
      [originSend, ...sends]
    )
    return (await originSend) === false ? false : undefined
  } catch (error) {
    handleError(error, { source: "compare-send" })
    if (started) return undefined
    // Nothing was sent: the chats made so far go again, the draft stays.
    for (const chat of chats) useChatStore.getState().deleteThread(chat.id)
    useChatStore
      .getState()
      .setThreadSetting(originThreadId, "compareGroupId", undefined)
    return false
  } finally {
    selection.setProgress(originThreadId, null)
  }
}
