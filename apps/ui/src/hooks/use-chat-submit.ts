import { useCallback } from "react"
import {
  ATTACHMENTS_ONLY_MESSAGE,
  browserElementAttachment,
  browserElementsPrompt,
  parseGoalCommand,
} from "@betterc0de/schema"
import { maskBrowserMentions } from "@/lib/browser-element-mentions"
import { useBrowserContextStore } from "@/lib/browser-context-store"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import { handleError } from "@/lib/errors/handle"
import { useAppearanceStore } from "@/lib/appearance-store"
import {
  archivedThreadIdsAfterAction,
  resolveAdjacentProjectThread,
  resolveAdjacentSessionThread,
  resolveChildThread,
  resolveParentThread,
  resolvePinnedThreadSlot,
  resolveSessionCommandThread,
  resolveSiblingChildThread,
} from "@/hooks/chat-submit/thread-navigation"
import { useChatStore } from "@/lib/chat-store"
import { HttpError } from "@/lib/errors/types"
import {
  listRuntimeSkills,
  listRuntimeSubagents,
  type RuntimeSkill,
  type RuntimeSubagent,
} from "@/lib/runtime-config"
import {
  sendChatMessage,
  sendGoalControl,
  type WorkspaceProjectReference,
} from "@/services/backend"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import { coerceThinkingModeForModel } from "@/lib/model-capabilities"
import { useSettingsStore } from "@/lib/settings-store"
import {
  savedOrchestration,
  useOrchestrationDraft,
  ORCHESTRATION_OFF,
} from "@/lib/orchestration-composer-store"
import {
  isAskSlashCommand,
  isDebugSlashCommand,
  isDefaultSlashCommand,
  isPlanSlashCommand,
  isSecuritySlashCommand,
} from "@/lib/message-utils"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import type { UiProvider } from "@/lib/provider-types"
import { type ModelCycleFavoriteEntry } from "@/lib/model-cycle"

import type { ChatSubmitPayload } from "@/lib/slash-command-runtime"
import { usePreferencesStore } from "@/lib/preferences-store"
import {
  resolveComposerPreferences,
  selectComposerModel,
} from "@/lib/composer-preferences"
import {
  getProviderComposerSelection,
  upsertProviderComposerSelection,
} from "@/lib/provider-composer-selection"
import {
  latestProviderInstanceId,
  latestProviderContinuationKey,
  resolveProviderModelThinkingSelection,
  resolveDispatchModelId,
} from "@/lib/provider-model-selection"

// Shared across composers showing the same thread; acquired before lazy imports
// or context reads so another submit cannot overtake preparation.
const preparingThreads = new Set<string>()

/**
 * The primary "send a chat turn" handler, factored out of `App.tsx`.
 *
 * Does a lot on the way to the final `sendChatMessage` call:
 *
 * 1. **Mode slash handling**: if the message starts with `/plan`, flip
 *    `chatMode` to "plan" and strip the prefix so the AI gets a clean
 *    prompt. Empty `/plan` substitutes a default "create a plan" message.
 *    `/default` flips back to normal agent mode without sending a provider
 *    turn, matching BetterC0de's build-mode command.
 *
 * 2. **`@mention` resolution**: @-tokens are matched against installed
 *    skills and subagents first (those get their full content inlined as
 *    context), then fall back to file mentions (read from disk relative
 *    to the active project). All resolved contexts are prepended to the
 *    message before send.
 *
 * 3. **Built-in slash commands**: `/model` opens the model picker;
 *    `/help`, `/mcps`, `/skills`, `/agents`, `/status`, `/compact`, `/clear`
 *    are intercepted and produce a markdown response directly — no round-trip
 *    to the AI. Provider slash commands fall through as native `/command`
 *    text; provider skill aliases `/skill` resolve to `$skill` and stay in
 *    the prompt for the selected provider.
 *
 * 4. **Thread creation**: if there's no active thread, create "New Chat"
 *    in the default "BetterC0de" project.
 *
 * 5. **Optimistic user message**: render the user's text immediately, set
 *    the streaming model, kick off the empty-stream placeholder so the
 *    UI can start the shimmer.
 *
 * 6. **Provider routing**: `resolveProviderTarget` may reroute through
 *    OpenRouter if the direct provider has no key. The effective model
 *    ID is adjusted for Anthropic's 200k context window suffix and to
 *    strip slashes for non-OpenRouter providers.
 *
 * 7. **`sendChatMessage`**: the actual wire call. On failure, clear the
 *    streaming state and append an error message so the user sees what
 *    happened.
 */
export function useChatSubmit({
  providers = [],
  favoriteEntries = [],
  toggleFavorite,
  isFavorite,
  appMode,
  openModelPicker,
  openCommandPalette,
  closeSlash,
  closeMention,
}: {
  providers?: UiProvider[]
  favoriteEntries?: ModelCycleFavoriteEntry[]
  toggleFavorite?: (providerId: string, modelId: string) => void
  isFavorite?: (providerId: string, modelId: string) => boolean
  appMode: "agent" | "editor" | "design"
  openModelPicker?: () => void
  openCommandPalette?: () => void
  closeSlash: () => void
  closeMention: () => void
}) {
  return useCallback(
    async (msg: ChatSubmitPayload) => {
      const rawText =
        msg.text.trim() ||
        (msg.files.length > 0 ? ATTACHMENTS_ONLY_MESSAGE : "")
      const trimmedText = rawText.trim()
      if (!trimmedText) return
      closeSlash()
      closeMention()

      // Capture ownership and settings before even the lazy command import.
      // React may not have rendered a newly focused pane yet, and context
      // preparation can finish after the user has switched to another chat.
      const initialChat = useChatStore.getState()
      const originThreadId =
        msg.threadId === undefined ? initialChat.activeThreadId : msg.threadId
      const browserElements =
        msg.queuedSubmission?.browserElements ??
        (originThreadId
          ? [
              ...(useBrowserContextStore.getState().byThread[originThreadId] ??
                []),
            ]
          : [])
      const activeThread =
        initialChat.threads.find((thread) => thread.id === originThreadId) ??
        null
      if (originThreadId && !activeThread) return
      const enqueue = () => {
        if (!originThreadId || msg.queuedSubmission) return false
        try {
          const {
            threadId: _threadId,
            queuedSubmission: _queued,
            ...payload
          } = msg
          useMessageQueueStore
            .getState()
            .enqueue(originThreadId, { ...payload, browserElements })
          useBrowserContextStore
            .getState()
            .consume(originThreadId, browserElements)
          return true
        } catch (error) {
          handleError(error, { source: "message-queue" })
          return false
        }
      }
      if (
        originThreadId &&
        ((preparingThreads.has(originThreadId) &&
          !/^\/goal(?:\s|$)/i.test(trimmedText)) ||
          (!trimmedText.startsWith("/") &&
            (initialChat.streamingByThread[originThreadId]?.isStreaming ||
              (!msg.queuedSubmission &&
                useMessageQueueStore
                  .getState()
                  .messages.some(
                    (entry) => entry.threadId === originThreadId
                  )))))
      )
        return enqueue()
      const prefs = usePreferencesStore.getState()
      const threadSettings = originThreadId
        ? initialChat.settingsByThread[originThreadId]
        : undefined
      const composer = resolveComposerPreferences(prefs, threadSettings)
      const orchestration = originThreadId
        ? savedOrchestration(threadSettings?.orchestration)
        : useOrchestrationDraft.getState().selection
      const activities = originThreadId
        ? (initialChat.activitiesByThread[originThreadId] ?? [])
        : []
      const selection = resolveProviderModelThinkingSelection({
        ...composer,
        providers,
        lockedProviderInstanceId:
          activeThread?.session?.providerInstanceId ??
          latestProviderInstanceId(activities),
        lockedContinuationKey:
          activeThread?.session?.continuationKey ??
          latestProviderContinuationKey(activities),
      })
      const selectedProvider = selection.provider
      const selectedProviderId =
        selectedProvider?.id ?? composer.selectedProviderId
      const selectedModel = selection.modelId
      const thinkingMode = selection.thinkingMode
      const {
        chatMode,
        specialMode,
        permissionLevel,
        contextWindow,
        fastMode,
      } = composer
      let submissionThreadId = originThreadId
      let userMessageRecorded = false
      let streamingStarted = false
      const ensureThread = () => {
        if (!submissionThreadId) {
          const chat = useChatStore.getState()
          const focusedThreadId = chat.activeThreadId
          submissionThreadId = chat.createThread("New Chat", "BetterC0de")
          chat.setThreadSetting(
            submissionThreadId,
            "orchestration",
            orchestration
          )
          useOrchestrationDraft.getState().set(ORCHESTRATION_OFF)
          const threadComposer = {
            selectedProviderId,
            selectedModel,
            thinkingMode,
            chatMode,
            specialMode,
            permissionLevel,
            contextWindow,
          }
          for (const [key, value] of Object.entries(threadComposer)) {
            chat.setThreadSetting(
              submissionThreadId,
              key as keyof typeof threadComposer,
              value
            )
          }
          chat.setThreadSetting(
            submissionThreadId,
            "modelSelectionByProvider",
            upsertProviderComposerSelection(
              prefs.modelSelectionByProvider,
              selectedProviderId,
              { selectedModel, thinkingMode, contextWindow, fastMode }
            )
          )
          if (focusedThreadId !== originThreadId)
            chat.setActiveThread(focusedThreadId)
        }
        return submissionThreadId
      }
      const setChatMode = (mode: string) => {
        useChatStore
          .getState()
          .setThreadSetting(ensureThread(), "chatMode", mode)
      }
      const setSelectedProviderId = (id: string) => {
        usePreferencesStore.getState().set("selectedProviderId", id)
        useChatStore
          .getState()
          .setThreadSetting(ensureThread(), "selectedProviderId", id)
      }
      const setSelectedModel = (id: string, providerId?: string) =>
        selectComposerModel(ensureThread(), id, providerId)
      const requireAvailableModel = (
        provider: UiProvider | undefined,
        modelId: string
      ): boolean => {
        if (provider?.modelsReady === false) {
          handleError(
            new Error(
              `The model list for ${provider.name} is still loading. Try again shortly.`
            ),
            { source: "chat-submit" }
          )
          return false
        }
        if (
          provider?.modelsReady !== true ||
          provider.models.some((model) => model.id === modelId)
        )
          return true
        handleError(
          new Error(
            `Model ${modelId} is no longer available for ${provider.name}. Choose another model before sending.`
          ),
          { source: "chat-submit" }
        )
        openModelPicker?.()
        return false
      }

      const ownsPreparation =
        originThreadId && !preparingThreads.has(originThreadId)
      if (ownsPreparation) preparingThreads.add(originThreadId)
      try {
        if (/^\/goal(?:\s|$)/i.test(trimmedText)) {
          const threadId = ensureThread()
          const command = parseGoalCommand(trimmedText)
          if (
            command &&
            ["status", "pause", "clear"].includes(command.action)
          ) {
            await sendGoalControl(threadId, trimmedText, selectedModel)
            return
          }
          const target = await resolveProviderTarget(
            selectedProvider,
            selectedModel
          )
          if (!requireAvailableModel(selectedProvider, selectedModel))
            return false
          const modelId = resolveDispatchModelId(
            target.providerKind,
            selectedModel
          )
          const options =
            getProviderComposerSelection(
              selectedProvider?.id,
              prefs.modelSelectionByProvider,
              threadSettings?.modelSelectionByProvider
            )?.optionSelections ?? null
          await sendChatMessage(
            threadId,
            trimmedText,
            modelId,
            target.providerKind,
            selectedProvider?.modelsReady === false
              ? thinkingMode
              : coerceThinkingModeForModel(
                  selectedProvider,
                  selectedModel,
                  thinkingMode
                ),
            chatMode,
            resolveThreadRuntimePath(activeThread),
            specialMode,
            permissionLevel,
            target.openaiTransport,
            fastMode,
            target.providerInstanceId,
            contextWindow,
            selectedProvider?.models.find((model) => model.id === selectedModel)
              ?.capabilities,
            null,
            null,
            appMode,
            threadSettings?.designBrief ?? null,
            [],
            options
          )
          return
        }
        const {
          buildBetterC0deDefaultAgentContext,
          buildBetterC0deDefaultCommandPrompt,
          buildBetterC0dePrTerminalCommand,
          buildBetterC0dePrTerminalOutput,
          buildProjectCommandPrompt,
          buildProjectReferenceMentionContext,
          buildProjectSkillCommandPrompt,
          defaultPromptForMode,
          dispatchPrefilledTerminalCommand,
          extractBetterC0deMentions,
          isProviderNativeSlashCommand,
          listProjectReferencesSafe,
          listProjectRuntimeSkills,
          listProjectRuntimeSubagents,
          mergeRuntimeSkills,
          mergeRuntimeSubagents,
          normalizeChatAttachments,
          recordPromptHistory,
          providerSkillSlashPrompt,
          resolveProjectCommandModelOverride,
          runRegisteredSlashCommand,
          stripModeSlashPrompt,
        } = await import("@/lib/slash-command-runtime")

        if (isDefaultSlashCommand(trimmedText)) {
          if (chatMode !== "agent") setChatMode("agent")
          const store = useChatStore.getState()
          const threadId = ensureThread()
          store.addMessage(threadId, {
            id: crypto.randomUUID(),
            role: "user",
            content: rawText,
            createdAt: new Date().toISOString(),
          })
          userMessageRecorded = true
          store.addMessage(threadId, {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "# Build Mode\n\nNormal build mode is active.",
            createdAt: new Date().toISOString(),
          })
          return
        }

        const explicitPlanSlash = isPlanSlashCommand(trimmedText)
        const explicitAskSlash = isAskSlashCommand(trimmedText)
        const explicitSecuritySlash = isSecuritySlashCommand(trimmedText)
        const explicitDebugSlash = isDebugSlashCommand(trimmedText)
        const explicitModeSlash =
          explicitPlanSlash ||
          explicitAskSlash ||
          explicitSecuritySlash ||
          explicitDebugSlash
        const slashMode = explicitPlanSlash
          ? "plan"
          : explicitAskSlash
            ? "ask"
            : explicitSecuritySlash
              ? "security"
              : explicitDebugSlash
                ? "debug"
                : null
        const activeRuntimePath = resolveThreadRuntimePath(activeThread)
        const prTerminalCommand = buildBetterC0dePrTerminalCommand(trimmedText)
        if (prTerminalCommand.shouldOpen && prTerminalCommand.command) {
          const store = useChatStore.getState()
          const threadId = ensureThread()
          store.addMessage(threadId, {
            id: crypto.randomUUID(),
            role: "user",
            content: rawText,
            createdAt: new Date().toISOString(),
          })
          userMessageRecorded = true
          dispatchPrefilledTerminalCommand(
            activeThread,
            prTerminalCommand.command
          )
          store.addMessage(threadId, {
            id: crypto.randomUUID(),
            role: "assistant",
            content: buildBetterC0dePrTerminalOutput(
              prTerminalCommand.command,
              activeRuntimePath
            ),
            createdAt: new Date().toISOString(),
          })
          return
        }
        const betterC0deDefaultCommand = explicitModeSlash
          ? null
          : buildBetterC0deDefaultCommandPrompt(trimmedText, activeRuntimePath)
        const projectCommand =
          explicitModeSlash || betterC0deDefaultCommand
            ? null
            : await buildProjectCommandPrompt(
                trimmedText,
                activeRuntimePath,
                permissionLevel
              )
        const projectSkillCommand =
          explicitModeSlash || betterC0deDefaultCommand || projectCommand
            ? null
            : await buildProjectSkillCommandPrompt(
                trimmedText,
                activeRuntimePath
              )
        const providerSkillPrompt =
          explicitModeSlash ||
          betterC0deDefaultCommand ||
          projectCommand ||
          projectSkillCommand
            ? null
            : providerSkillSlashPrompt(trimmedText, selectedProvider)
        const effectiveChatMode =
          msg.chatModeOverride ??
          projectCommand?.chatModeOverride ??
          projectSkillCommand?.chatModeOverride ??
          betterC0deDefaultCommand?.chatModeOverride ??
          slashMode ??
          chatMode
        const effectivePermissionLevel =
          betterC0deDefaultCommand?.permissionLevelOverride ?? permissionLevel
        if (slashMode && chatMode !== slashMode) {
          setChatMode(slashMode)
        }

        const userMessage =
          projectCommand?.prompt ??
          projectSkillCommand?.prompt ??
          providerSkillPrompt ??
          betterC0deDefaultCommand?.prompt ??
          (explicitModeSlash
            ? stripModeSlashPrompt(trimmedText, slashMode) ||
              defaultPromptForMode(slashMode)
            : rawText)
        const visibleUserMessage =
          msg.visibleText ??
          (betterC0deDefaultCommand ||
          projectCommand ||
          projectSkillCommand ||
          providerSkillPrompt
            ? rawText
            : userMessage)

        // Resolve @ file and skill mentions — read content and prepend as context
        let messageText = userMessage
        const defaultAgentContext =
          effectiveChatMode === "agent" &&
          !explicitModeSlash &&
          !betterC0deDefaultCommand &&
          !projectCommand &&
          !projectSkillCommand
            ? await buildBetterC0deDefaultAgentContext(activeRuntimePath)
            : null
        if (defaultAgentContext) {
          messageText = `${defaultAgentContext}\n\n${messageText}`
        }
        const mentions = extractBetterC0deMentions(
          maskBrowserMentions(messageText, browserElements)
        )
        if (mentions.length > 0) {
          let installedSkills: RuntimeSkill[] = []
          let installedSubagents: RuntimeSubagent[] = []
          let projectReferences: WorkspaceProjectReference[] = []
          const fileContextEnabled =
            useAppearanceStore.getState().fileContextEnabled
          try {
            const [
              skills,
              subagents,
              projectSkills,
              projectSubagents,
              references,
            ] = await Promise.all([
              listRuntimeSkills(),
              listRuntimeSubagents(),
              listProjectRuntimeSkills(activeRuntimePath),
              listProjectRuntimeSubagents(activeRuntimePath),
              fileContextEnabled
                ? listProjectReferencesSafe(activeRuntimePath)
                : Promise.resolve([]),
            ])
            installedSkills = mergeRuntimeSkills(skills, projectSkills)
            installedSubagents = mergeRuntimeSubagents(
              subagents,
              projectSubagents
            )
            projectReferences = references
          } catch {
            console.warn(
              "Failed to load installed skills/subagents/references for mention resolution"
            )
          }
          const skillIds = new Set(
            installedSkills
              .filter((skill) => skill.enabled)
              .map((skill) => skill.id)
          )
          const subagentIds = new Set(
            installedSubagents
              .filter((subagent) => subagent.enabled && !subagent.hidden)
              .map((subagent) => subagent.id)
          )

          const fileContexts: string[] = []
          const skillContexts: string[] = []
          for (const mentionName of mentions) {
            if (skillIds.has(mentionName)) {
              const skill = installedSkills.find((s) => s.id === mentionName)
              if (skill?.content) {
                skillContexts.push(
                  `[Skill: ${skill.name}]\n\`\`\`\n${skill.content}\n\`\`\``
                )
              }
              continue
            }
            if (fileContextEnabled) {
              const referenceContext = buildProjectReferenceMentionContext(
                projectReferences,
                mentionName
              )
              if (referenceContext) {
                skillContexts.push(referenceContext)
                continue
              }
            }
            if (subagentIds.has(mentionName)) {
              const subagent = installedSubagents.find(
                (s) => s.id === mentionName
              )
              if (subagent?.prompt) {
                skillContexts.push(
                  `[Subagent: ${subagent.name}]\n\`\`\`\n${subagent.prompt}\n\`\`\``
                )
              }
              continue
            }
            // Otherwise treat as file mention. The mention regex is permissive
            // (matches `@web.de`, `@something.txt`) so 404s are routine here —
            // pass `silent404` to keep DevTools quiet for non-file mentions.
            if (!fileContextEnabled || !activeRuntimePath) continue
            try {
              const { readFile } = await import("@/services/backend")
              const fullPath =
                activeRuntimePath.replace(/\\/g, "/") + "/" + mentionName
              const result = await readFile(fullPath, { silent404: true })
              if (result && result.content) {
                fileContexts.push(
                  `[File: ${mentionName}]\n\`\`\`\n${result.content}\n\`\`\``
                )
              }
            } catch {
              /* file not found — ignore */
            }
          }
          const allContexts = [...skillContexts, ...fileContexts]
          if (allContexts.length > 0) {
            messageText = allContexts.join("\n\n") + "\n\n" + messageText
          }
        }

        // Intercept slash commands — don't send to AI
        if (
          !explicitModeSlash &&
          !betterC0deDefaultCommand &&
          !projectCommand &&
          !projectSkillCommand &&
          !providerSkillPrompt &&
          trimmedText.startsWith("/") &&
          !isProviderNativeSlashCommand(trimmedText, selectedProvider)
        ) {
          const cmd = trimmedText.split(/\s/)[0].toLowerCase()
          const args = trimmedText.split(/\s+/).slice(1)
          const store = useChatStore.getState()
          let threadId = submissionThreadId
          let output = ""
          let outputMessageId: string | undefined
          let outputMessageCreatedAt: string | undefined
          let outputMessageCompactionGeneration: number | undefined
          let outputUserMessageId: string | undefined
          let outputUserMessageCreatedAt: string | undefined

          const slashResult = await runRegisteredSlashCommand({
            cmd,
            args,
            trimmedText,
            rawText,
            threadId,
            selectedProvider,
            selectedProviderId,
            selectedModel,
            providers,
            favoriteEntries,
            toggleFavorite,
            isFavorite,
            setSelectedProviderId,
            setSelectedModel,
            thinkingMode,
            chatMode,
            setChatMode,
            specialMode,
            permissionLevel,
            contextWindow,
            fastMode,
            appMode,
            openModelPicker,
            openCommandPalette,
            closeSlash,
            activeThread,
            effectiveChatMode,
          })
          if (slashResult?.handled) {
            output = slashResult.output
            threadId = slashResult.threadId ?? threadId
            outputMessageId = slashResult.outputMessageId
            outputMessageCreatedAt = slashResult.outputMessageCreatedAt
            outputMessageCompactionGeneration =
              slashResult.outputMessageCompactionGeneration
            outputUserMessageId = slashResult.outputUserMessageId
            outputUserMessageCreatedAt = slashResult.outputUserMessageCreatedAt
            if (output) {
              if (!threadId) {
                threadId = ensureThread()
              }
              const backendPersistedCompaction =
                outputMessageId !== undefined &&
                outputMessageCompactionGeneration !== undefined
              store.addMessage(
                threadId,
                {
                  id: outputUserMessageId ?? crypto.randomUUID(),
                  role: "user",
                  content: rawText,
                  createdAt:
                    outputUserMessageCreatedAt ?? new Date().toISOString(),
                },
                { persist: !backendPersistedCompaction }
              )
              userMessageRecorded = true
              store.addMessage(
                threadId,
                {
                  id: outputMessageId ?? crypto.randomUUID(),
                  role: "assistant",
                  content: output,
                  ...(outputMessageId ? { compactedContext: true } : {}),
                  ...(outputMessageCompactionGeneration !== undefined
                    ? {
                        compactionGeneration: outputMessageCompactionGeneration,
                      }
                    : {}),
                  createdAt: outputMessageCreatedAt ?? new Date().toISOString(),
                },
                { persist: !backendPersistedCompaction }
              )
            }
            return
          }
          // Unknown slash command — fall through to send to AI
        }

        const store = useChatStore.getState()

        // Create thread if none active — no folder required, can be assigned later
        if (
          originThreadId &&
          !store.threads.some((thread) => thread.id === originThreadId)
        )
          return
        const threadId = ensureThread()
        if (
          msg.queuedSubmission &&
          useMessageQueueStore
            .getState()
            .messages.find((entry) => entry.id === msg.queuedSubmission?.id)
            ?.pauseRequested
        )
          return false
        // Native slash commands reach the provider too. Local commands above
        // remain available while a turn is running.
        if (useChatStore.getState().streamingByThread[threadId]?.isStreaming)
          return enqueue()
        const projectModelOverride = resolveProjectCommandModelOverride(
          projectCommand?.command.model,
          selectedProvider,
          providers
        )
        const turnProvider = projectModelOverride?.provider ?? selectedProvider
        const turnModel = projectModelOverride?.modelId ?? selectedModel
        if (!requireAvailableModel(turnProvider, turnModel)) return false
        const attachments = normalizeChatAttachments(msg.files)
        const browserContext = browserElementsPrompt(browserElements)
        if (browserContext) messageText = `${browserContext}\n\n${messageText}`
        const visibleAttachments = [
          ...attachments,
          ...browserElements.map(browserElementAttachment),
        ]
        recordPromptHistory(visibleUserMessage, threadId, activeThread)

        // Add user message immediately (optimistic)
        const dispatchUserMessage = {
          id: msg.queuedSubmission?.id ?? crypto.randomUUID(),
          role: "user",
          content: visibleUserMessage,
          ...(visibleAttachments.length > 0
            ? { attachments: visibleAttachments }
            : {}),
          modelId: turnModel,
          createdAt:
            msg.queuedSubmission?.createdAt ?? new Date().toISOString(),
        } as const
        if (
          !msg.queuedSubmission ||
          !store.threads
            .find((thread) => thread.id === threadId)
            ?.messages.some((message) => message.id === dispatchUserMessage.id)
        ) {
          store.addMessage(threadId, dispatchUserMessage, {
            persist: useSettingsStore.getState().autoSaveConversations,
          })
        }
        userMessageRecorded = true

        // Mark as streaming immediately + store which model is being used
        useChatStore.getState().setStreamingModelId(threadId, turnModel)
        store.appendStreamDelta(threadId, "")
        streamingStarted = true

        const target = await resolveProviderTarget(turnProvider, turnModel)
        if (
          !useChatStore
            .getState()
            .threads.some((thread) => thread.id === threadId)
        )
          return
        const runtimePath = resolveThreadRuntimePath(activeThread)
        const effectiveModel = resolveDispatchModelId(target.providerKind, turnModel)
        // Fast Mode is only meaningful on Codex CLI (`serviceTier: "fast"`)
        // and Claude CLI (`settings.fastMode: true`). On every other
        // provider the backend silently drops the field, so we don't gate
        // it here — the wire format already filters.
        const selectedModelCapabilities =
          turnProvider?.models.find((model) => model.id === turnModel)
            ?.capabilities ?? null
        const selectedProviderOptions =
          getProviderComposerSelection(
            turnProvider?.id,
            prefs.modelSelectionByProvider,
            threadSettings?.modelSelectionByProvider
          )?.optionSelections ?? null
        const designContext =
          appMode === "design" ? (threadSettings?.designBrief ?? null) : null
        await sendChatMessage(
          threadId,
          messageText,
          effectiveModel,
          target.providerKind,
          turnProvider?.modelsReady === false
            ? thinkingMode
            : coerceThinkingModeForModel(turnProvider, turnModel, thinkingMode),
          effectiveChatMode,
          runtimePath,
          specialMode,
          effectivePermissionLevel,
          target.openaiTransport,
          fastMode,
          target.providerInstanceId,
          contextWindow,
          selectedModelCapabilities,
          dispatchUserMessage,
          msg.sourceProposedPlan ?? null,
          appMode,
          designContext,
          visibleAttachments,
          selectedProviderOptions,
          null,
          orchestration
        )
        if (!msg.queuedSubmission)
          useBrowserContextStore.getState().consume(threadId, browserElements)
      } catch (err) {
        if (
          originThreadId &&
          !useChatStore
            .getState()
            .threads.some((thread) => thread.id === originThreadId)
        )
          return
        const threadId = ensureThread()
        const providerStillActive =
          err instanceof HttpError &&
          err.status === 409 &&
          (err.code === "turn_active" ||
            err.message.includes("already has active provider work"))
        if (streamingStarted && !providerStillActive)
          useChatStore.getState().clearStreaming(threadId)
        if (providerStillActive) return false
        if (
          !userMessageRecorded &&
          (!msg.queuedSubmission ||
            !useChatStore
              .getState()
              .threads.find((thread) => thread.id === threadId)
              ?.messages.some(
                (message) => message.id === msg.queuedSubmission?.id
              ))
        ) {
          useChatStore.getState().addMessage(
            threadId,
            {
              id: msg.queuedSubmission?.id ?? crypto.randomUUID(),
              role: "user",
              content: msg.visibleText ?? rawText,
              modelId: selectedModel,
              createdAt:
                msg.queuedSubmission?.createdAt ?? new Date().toISOString(),
            },
            { persist: useSettingsStore.getState().autoSaveConversations }
          )
        }
        useChatStore.getState().addMessage(threadId, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          createdAt: new Date().toISOString(),
        })
        if (msg.queuedSubmission) throw err
      } finally {
        if (ownsPreparation) preparingThreads.delete(originThreadId)
      }
    },
    [
      providers,
      favoriteEntries,
      toggleFavorite,
      isFavorite,
      appMode,
      openModelPicker,
      openCommandPalette,
      closeSlash,
      closeMention,
    ]
  )
}
export {
  archivedThreadIdsAfterAction,
  resolveAdjacentProjectThread,
  resolveAdjacentSessionThread,
  resolveChildThread,
  resolveParentThread,
  resolvePinnedThreadSlot,
  resolveSessionCommandThread,
  resolveSiblingChildThread,
}
export { betterC0deShareModeFromProjectSettings } from "@/lib/betterc0de-share-policy"

// Keep component payload types eager; load command implementation on submit.
export type * from "@/lib/slash-command-runtime"
