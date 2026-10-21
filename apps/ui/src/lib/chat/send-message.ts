/**
 * Chat turn orchestration. Reads the chat, settings, editor and plugin stores,
 * shapes the request, and dispatches through the thin transport in
 * `@/services/backend/chatApi` (or a provider plugin over the desktop bridge).
 *
 * The turn's preparation is the backend's, for every client (`prepareTurn`):
 * it runs the user's blocking "on message send" hooks and builds the system
 * instruction from the user's and the project's settings
 * (apps/backend services/chat/turn-preparation.ts). The request carries what
 * only the renderer knows: the chat and focus modes, the permission level,
 * the design brief and the rule target (the active editor file).
 *
 * The stores and the heavier helpers stay dynamic imports, as they were when
 * this code lived in `chatApi.ts`, so the module evaluation order and the
 * first-frame bundle stay as they were.
 */
import {
  BROWSER_ELEMENT_ATTACHMENT_TYPE,
  parseGoalCommand,
  orchestrationForMain,
} from "@betterc0de/schema"
import type {
  AutonomyRunConfig,
  ChatAttachment,
  ChatOrchestration,
  DesignBrief,
  ModelCapabilities,
  ProviderOptionSelection,
} from "@betterc0de/schema"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import type { SourceProposedPlanReference } from "@/lib/plan-modal"
import {
  postChatAutonomyResume,
  postChatAutonomyStart,
} from "@/services/backend/autonomyApi"
import {
  postChatGoal,
  postChatInterrupt,
  postChatPersistUser,
  postChatSend,
} from "@/services/backend/chatApi"
import { getElectronApi } from "@/services/ipc-facade"
import {
  automaticCompactionModelLimits,
  automaticCompactionUsage,
  buildModelSelection,
  buildProviderPrompt,
  buildWireHistory,
  normalizeOpenAiTarget,
  workspaceRuleTargetPath,
  type ThreadHistoryOptions,
  type WireHistoryMessage,
} from "./request-builders"

async function resolveRendererRuleTargetPath(
  workspaceRoot: string | null | undefined,
  explicitTarget: string | null | undefined
): Promise<string> {
  const explicit = explicitTarget?.trim()
  if (explicit) return explicit
  if (!workspaceRoot) return "."
  try {
    const { useEditorStore } = await import("@/lib/editor-store")
    const editor = useEditorStore.getState()
    const activeTab = editor.tabs.find((tab) => tab.id === editor.activeTabId)
    return (
      workspaceRuleTargetPath(workspaceRoot, activeTab?.filePath ?? "") ?? "."
    )
  } catch {
    return "."
  }
}

/**
 * What a message does for Autonomous Work: `start` opens a run with this
 * message (the backend sends it and continues the run on its own),
 * `resume` continues a paused run with this send's provider, model and
 * permission level (the message itself is not sent).
 */
export type AutonomousTurnRequest =
  | { readonly action: "start"; readonly config: AutonomyRunConfig }
  | { readonly action: "resume" }

export interface DispatchUserMessage {
  id: string
  content: string
  createdAt: string
}

type ChatSendContextCheckpoint = NonNullable<
  import("@betterc0de/schema/http-contracts").ChatSendResponse[
    | "automaticCompaction"
    | "providerHandoff"]
>

function projectContextCheckpoint(
  chatStore: typeof import("@/lib/chat-store"),
  threadId: string,
  compaction: ChatSendContextCheckpoint | undefined
): void {
  if (!compaction) return
  const store = chatStore.useChatStore.getState()
  const existingIds = new Set(
    store.threads
      .find((thread) => thread.id === threadId)
      ?.messages.map((message) => message.id) ?? []
  )
  if (!existingIds.has(compaction.commandMessageId)) {
    store.addMessage(
      threadId,
      {
        id: compaction.commandMessageId,
        role: "user",
        content: compaction.commandContent,
        ...(compaction.reason === "provider-switch"
          ? { internalContext: "provider-handoff" as const }
          : {}),
        createdAt: compaction.commandCreatedAt,
      },
      { persist: false }
    )
  }
  if (!existingIds.has(compaction.checkpointMessageId)) {
    store.addMessage(
      threadId,
      {
        id: compaction.checkpointMessageId,
        role: "assistant",
        content: compaction.checkpointContent,
        compactedContext: true,
        ...(compaction.reason === "provider-switch"
          ? { internalContext: "provider-handoff" as const }
          : {}),
        compactionGeneration: compaction.generation,
        createdAt: compaction.checkpointCreatedAt,
      },
      { persist: false }
    )
  }
}

export async function sendGoalControl(
  threadId: string,
  message: string,
  modelId: string
): Promise<void> {
  const { useChatStore } = await import("@/lib/chat-store")
  const revision = useChatStore
    .getState()
    .getThreadSettings(threadId).goalRevision
  const result = await postChatGoal({ threadId, message, modelId })
  if (
    useChatStore.getState().getThreadSettings(threadId).goalRevision ===
    revision
  ) {
    useChatStore.getState().setThreadSetting(threadId, "goal", result.goal)
  }
  if (!result.goal && parseGoalCommand(message)?.action === "status") {
    const { toast } = await import("sonner")
    toast.info("No goal in this chat. Use /goal followed by your objective.")
  }
}

export const sendChatMessage = async (
  threadId: string,
  message: string,
  modelId: string,
  providerKind: string,
  reasoningEffort?: string | null,
  chatMode?: string | null,
  projectPath?: string | null,
  specialMode?: string | null,
  permissionLevel?: string | null,
  openaiTransport?: string | null,
  /** Codex Fast Mode (priority compute, OpenAI's `serviceTier: "fast"`).
   *  Boolean, orthogonal to reasoningEffort. Ignored on non-Codex providers. */
  fastMode?: boolean | null,
  providerInstanceId?: string | null,
  contextWindow?: string | null,
  capabilities?: ModelCapabilities | null,
  optimisticMessageContent?: string | DispatchUserMessage | null,
  sourceProposedPlan?: SourceProposedPlanReference | null,
  appMode?: "agent" | "editor" | "design" | null,
  designContext?: DesignBrief | null,
  attachments?: ChatAttachment[],
  optionSelections?: ReadonlyArray<ProviderOptionSelection> | null,
  ruleTargetPath?: string | null,
  orchestrationSelection?: ChatOrchestration,
  autonomy?: AutonomousTurnRequest | null
) => {
  const explicitDispatchMessage =
    optimisticMessageContent && typeof optimisticMessageContent === "object"
      ? optimisticMessageContent
      : null
  const optimisticContent =
    typeof optimisticMessageContent === "string"
      ? optimisticMessageContent
      : null
  const visibleUserContent =
    explicitDispatchMessage?.content ?? optimisticContent ?? message
  const dispatchUserMessage: DispatchUserMessage = explicitDispatchMessage ?? {
    id: crypto.randomUUID(),
    content: visibleUserContent,
    createdAt: new Date().toISOString(),
  }
  const openAiTarget = normalizeOpenAiTarget(providerKind, openaiTransport)
  const [chatStoreMod, settingsStoreMod] = await Promise.all([
    import("@/lib/chat-store"),
    import("@/lib/settings-store"),
  ])

  // Design context self-heals: an explicit argument wins (the composer passes
  // brief-or-null depending on app mode), while continuation senders (question
  // answers, autonomous-loop turns, plan handoffs) pass `undefined` and derive
  // the thread's saved brief here — so the design overlay survives mid-thread
  // turns instead of silently dropping after the first message.
  const resolvedDesignContext =
    designContext !== undefined
      ? designContext
      : (chatStoreMod.useChatStore.getState().getThreadSettings(threadId)
          .designBrief ?? null)
  const orchestration = settingsStoreMod.useSettingsStore.getState()
    .orchestratorEnabled
    ? orchestrationForMain(
        orchestrationSelection ??
          chatStoreMod.useChatStore.getState().getThreadSettings(threadId)
            .orchestration ?? { enabled: false },
        openAiTarget.providerKind
      )
    : { enabled: false as const }

  const resolvedRuleTargetPath = await resolveRendererRuleTargetPath(
    projectPath,
    ruleTargetPath
  )
  // The backend prepares the turn (`prepareTurn`): it runs the user's
  // hooks, then builds the system instruction from the user's and the
  // project's settings and from what only the renderer knows, sent here.
  const preparedTurn = {
    prepareTurn: true,
    chatMode,
    specialMode: specialMode ?? null,
    permissionLevel,
    appMode,
    designContext: resolvedDesignContext,
    ruleTargetPath: resolvedRuleTargetPath,
  }
  const modelSelection = buildModelSelection({
    modelId,
    providerKind: openAiTarget.providerKind,
    providerInstanceId,
    reasoningEffort,
    fastMode,
    contextWindow,
    capabilities,
    optionSelections,
  })
  const providerMessage = buildProviderPrompt({
    message,
    providerKind: openAiTarget.providerKind,
    reasoningEffort,
    capabilities,
  })
  const dispatchThread = chatStoreMod.useChatStore
    .getState()
    .threads.find((thread) => thread.id === threadId)
  const autoCompactionUsage = automaticCompactionUsage(dispatchThread?.usage)
  const autoCompactionModelLimits =
    automaticCompactionModelLimits(contextWindow)
  const userMessageMetadata = {
    userMessageId: dispatchUserMessage.id,
    userMessageContent: dispatchUserMessage.content,
    userMessageCreatedAt: dispatchUserMessage.createdAt,
    ...(dispatchThread?.title ? { threadTitle: dispatchThread.title } : {}),
    ...(dispatchThread?.projectName
      ? { threadProjectName: dispatchThread.projectName }
      : {}),
    ...(dispatchThread?.createdAt
      ? { threadCreatedAt: dispatchThread.createdAt }
      : {}),
  }

  if (parseGoalCommand(message)) {
    const { upsertThreadMeta } = await import("@/services/backend/coreApi")
    if (dispatchThread) await upsertThreadMeta(dispatchThread)
    const goalRevision = chatStoreMod.useChatStore
      .getState()
      .getThreadSettings(threadId).goalRevision
    const result = await postChatGoal({
      ...preparedTurn,
      threadId,
      message,
      modelId,
      modelSelection,
      providerKind: openAiTarget.providerKind,
      providerInstanceId,
      reasoningEffort,
      projectPath,
      openaiTransport: openAiTarget.openaiTransport,
      fastMode,
      collaborationMode: specialMode ?? null,
      ...userMessageMetadata,
    })
    if (
      chatStoreMod.useChatStore.getState().getThreadSettings(threadId)
        .goalRevision === goalRevision
    ) {
      chatStoreMod.useChatStore
        .getState()
        .setThreadSetting(threadId, "goal", result.goal)
    }
    if (!result.goal && parseGoalCommand(message)?.action === "status") {
      const { toast } = await import("sonner")
      toast.info("No goal in this chat. Use /goal followed by your objective.")
    }
    return
  }

  // The backend continues a paused run with this send's settings; nothing
  // is sent now (its next turn follows once the chat is idle).
  if (autonomy?.action === "resume") {
    const result = await postChatAutonomyResume({
      ...preparedTurn,
      threadId,
      message,
      orchestration,
      modelId,
      modelSelection,
      providerKind: openAiTarget.providerKind,
      reasoningEffort,
      projectPath,
      openaiTransport: openAiTarget.openaiTransport,
      collaborationMode: specialMode ?? null,
      fastMode,
      providerInstanceId,
      autoCompactionModelLimits,
    })
    chatStoreMod.useChatStore
      .getState()
      .setThreadAutonomy(threadId, result.autonomy)
    return
  }

  const desktopBridge = getElectronApi()
  const plugin = desktopBridge?.pluginSend
    ? await findProviderPlugin(providerKind, modelId)
    : undefined
  // Set when a plugin's turn was prepared but the plugin failed: the
  // backend already ran this message's hooks, and the fallback send below
  // hands this back so they do not run twice.
  let preparedTurnToken: string | undefined
  if (desktopBridge?.pluginSend && plugin) {
    // A provider plugin runs in the desktop process, where the backend
    // cannot send a run's turns.
    if (autonomy)
      throw new Error(
        `Autonomous Work needs a provider BetterC0de runs itself; ${plugin.manifest.name || plugin.manifest.id} is a provider plugin.`
      )
    const history = await buildThreadHistory(
      threadId,
      providerMessage,
      visibleUserContent,
      { maxMessages: 20, maxContentChars: 3000 }
    )

    // The backend prepares a plugin's turn too: the hooks run, the user
    // message is recorded, and the system instruction comes back. A refused
    // hook stops the message here; it must not fall through to the backend.
    const prepared = await postChatPersistUser({
      ...preparedTurn,
      threadId,
      message: providerMessage,
      modelId,
      providerKind: openAiTarget.providerKind,
      providerInstanceId,
      projectPath,
      attachments,
      ...userMessageMetadata,
    })

    try {
      await desktopBridge.pluginSend(plugin.manifest.id, "sendMessage", {
        threadId,
        message: providerMessage,
        modelId,
        modelSelection,
        config: plugin.config,
        mode: chatMode || "agent",
        permissionLevel,
        systemInstruction: prepared.systemInstruction ?? null,
        projectPath,
        ruleTargetPath: resolvedRuleTargetPath,
        appMode,
        designContext: resolvedDesignContext,
        thinkingMode: reasoningEffort,
        openaiTransport: openAiTarget.openaiTransport,
        sourceProposedPlan,
        history,
        attachments: attachments?.filter(
          (attachment) => attachment.type !== BROWSER_ELEMENT_ATTACHMENT_TYPE
        ),
      })
      return
    } catch {
      // Fall through to the backend, without running the hooks again.
      preparedTurnToken = prepared.preparedTurnToken
    }
  }

  // "Claude API" (id: "anthropic") and "Claude CLI" (id: "claude") are both
  // native backend builtins now. Anthropic routes via claudeApi.ts (direct
  // REST), Claude CLI routes via runtime/claude/ClaudeAdapter.ts (Agent SDK
  // → local `claude` binary). Both fall through to the standard /chat/send
  // path below. The legacy CLI-bridge electronAPI.claudeSend fallback that
  // used to short-circuit the anthropic provider was removed in 4a33dfa;
  // the bundled "anthropic-claude" plugin was retired and replaced by the
  // claude builtin in this commit's series.

  // Focus modes are still separate from chat modes. Codex derives its native
  // plan/default collaboration object in the backend from `chatMode` so it can
  // send the same BetterC0de developer instructions every turn.
  const collaborationMode = specialMode ?? null

  const history = await buildThreadHistory(
    threadId,
    providerMessage,
    visibleUserContent
  )

  const sendBody = {
    ...preparedTurn,
    threadId,
    message: providerMessage,
    orchestration,
    modelId,
    modelSelection,
    providerKind: openAiTarget.providerKind,
    reasoningEffort,
    projectPath,
    openaiTransport: openAiTarget.openaiTransport,
    collaborationMode,
    // Codex Fast Mode — priority compute (`serviceTier: "fast"`).
    // Boolean toggle on the BetterC0de model selection.
    fastMode,
    providerInstanceId,
    sourceProposedPlan,
    history,
    attachments,
    autoCompactionUsage,
    autoCompactionModelLimits,
    ...userMessageMetadata,
  }

  // The run's opening message: the backend records the run, sends this
  // message as `/chat/send` would and continues the run on its own.
  if (autonomy?.action === "start") {
    // The run is kept with the chat, so the backend must know the chat.
    const { upsertThreadMeta } = await import("@/services/backend/coreApi")
    if (dispatchThread) await upsertThreadMeta(dispatchThread)
    const started = await postChatAutonomyStart({
      ...sendBody,
      autonomy: autonomy.config,
    })
    chatStoreMod.useChatStore
      .getState()
      .setThreadAutonomy(threadId, started.autonomy)
    projectContextCheckpoint(
      chatStoreMod,
      threadId,
      started.turn.automaticCompaction
    )
    projectContextCheckpoint(
      chatStoreMod,
      threadId,
      started.turn.providerHandoff
    )
    return started.turn
  }

  const result = await postChatSend(
    preparedTurnToken ? { ...sendBody, preparedTurnToken } : sendBody
  )
  projectContextCheckpoint(chatStoreMod, threadId, result.automaticCompaction)
  projectContextCheckpoint(chatStoreMod, threadId, result.providerHandoff)
  return result
}

/** Provider kinds the backend serves itself, never a plugin by model id. */
const BUILTIN_PROVIDER_KINDS = new Set([
  "openai",
  "openai-api",
  "openai_api",
  "openai-oauth",
  "openai_oauth",
  "openai-cli",
  "openai_cli",
  "codexcli",
  "codex-cli",
  "anthropic",
  "claude",
  "anthropic_cli",
  "google",
  "grok",
  "grok_cli",
  "grok-cli",
  "grokcli",
  "openrouter",
  "lmstudio",
])

/**
 * The enabled provider plugin that serves this provider kind (or, for a
 * kind the backend does not serve, this model), if any. A plugin store that
 * cannot be read means none: the turn goes to the backend.
 */
async function findProviderPlugin(providerKind: string, modelId: string) {
  try {
    const { usePluginStore } = await import("@/lib/plugin-store")
    const plugins = usePluginStore
      .getState()
      .plugins.filter(
        (plugin) => plugin.enabled && plugin.manifest.type === "provider"
      )
    const providerKey = providerKind.trim().toLowerCase()
    const directPlugin = plugins.find(
      (plugin) =>
        plugin.manifest.id === providerKind ||
        plugin.manifest.id === providerKey
    )
    const fallbackByModel = !BUILTIN_PROVIDER_KINDS.has(providerKey)
      ? plugins.find((plugin) =>
          plugin.manifest.models.some((model) => model.id === modelId)
        )
      : undefined
    return directPlugin ?? fallbackByModel
  } catch {
    return undefined
  }
}

async function buildThreadHistory(
  threadId: string,
  currentMessage: string,
  optimisticMessageContent?: string | null,
  options?: ThreadHistoryOptions
): Promise<WireHistoryMessage[]> {
  const { useChatStore } = await import("@/lib/chat-store")
  const thread = useChatStore.getState().threads.find((t) => t.id === threadId)

  const all = thread?.messages ?? []
  if (all.length === 0) return []

  return buildWireHistory(
    all,
    currentMessage,
    optimisticMessageContent,
    options
  )
}

export const interruptTurn = async (
  threadId: string,
  providerKind: string,
  providerInstanceId?: string | null,
  options: {
    /** False when a steer stops the turn: its message is sent next. */
    pauseQueue?: boolean
  } = {}
) => {
  // All stop entry points (composer, shortcuts and slash commands) pause
  // follow-ups before their stream can settle and trigger the next send.
  if (options.pauseQueue !== false) {
    try {
      useMessageQueueStore.getState().pause(threadId)
    } catch {
      /* Already paused in memory. */
    }
  }
  const desktopBridge = getElectronApi()
  if (desktopBridge?.pluginSend) {
    try {
      const { usePluginStore } = await import("@/lib/plugin-store")
      const plugin = usePluginStore
        .getState()
        .plugins.find(
          (item) => item.enabled && item.manifest.id === providerKind
        )
      if (plugin) {
        await desktopBridge.pluginSend(plugin.manifest.id, "interrupt", {
          threadId,
        })
        return
      }
    } catch {
      // fall through to backend
    }
  }

  // "Claude (Anthropic)" interrupts go through the standard backend route,
  // matching its send path. The Electron claudeInterrupt IPC was the
  // companion to the removed claudeSend short-circuit above.

  return postChatInterrupt({ threadId, providerKind, providerInstanceId })
}
