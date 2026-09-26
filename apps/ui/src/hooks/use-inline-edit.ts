import { useCallback } from "react"
import { useChatStore } from "@/lib/chat-store"
import { sendChatMessage } from "@/services/backend"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import { resolveDispatchModelId } from "@/lib/provider-model-selection"
import { coerceThinkingModeForModel } from "@/lib/model-capabilities"
import type { InlineEditRequest } from "@/components/monaco-editor-wrapper"
import type { UiProvider } from "@/lib/provider-types"

/**
 * Handler for the editor's "inline edit" feature (Ctrl+K).
 *
 * Silent flow — the user wanted inline edits NOT to appear in the chat
 * UI. We:
 *
 *  1. Create a **hidden thread** with a `__inline-edit-` title prefix.
 *     `SidebarThreadList` filters out any thread whose title starts with
 *     that prefix, so it's invisible to the user.
 *  2. Crucially **do not flip `activeThreadId`** — the user stays on
 *     whatever thread they had open.
 *  3. Build a prompt describing the scope (whole-file vs. selected
 *     range) + the user's instruction + the selected text snippet
 *     (truncated at 20k chars).
 *  4. Send the prompt to the hidden thread. The AI's tool calls write to
 *     disk as normal; the editor picks up the changes via its own file-
 *     watcher.
 *  5. On completion (success or error) **delete the hidden thread** so
 *     it never persists. The whole flow leaves no trace in the chat UI.
 */
export function useInlineEdit({
  selectedModel,
  selectedProvider,
  thinkingMode,
  specialMode,
  permissionLevel,
  contextWindow,
}: {
  selectedModel: string
  selectedProvider: UiProvider | undefined
  thinkingMode: string | null
  specialMode: string | null
  permissionLevel: string
  contextWindow: string
}) {
  return useCallback(
    async (request: InlineEditRequest) => {
      const storeAtStart = useChatStore.getState()
      const activeThread = storeAtStart.activeThreadId
        ? storeAtStart.threads.find(
            (t) => t.id === storeAtStart.activeThreadId
          )
        : null
      const projectPath = activeThread?.projectPath ?? ""
      const projectName = activeThread?.projectName ?? "BetterC0de"

      const hiddenThreadId = crypto.randomUUID()
      const nowIso = new Date().toISOString()
      useChatStore.setState((state) => ({
        threads: [
          ...state.threads,
          {
            id: hiddenThreadId,
            title: `__inline-edit-${Date.now()}__`,
            projectName,
            projectPath,
            messages: [],
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        // IMPORTANT: do NOT touch activeThreadId — the user stays on
        // whatever thread they were viewing before.
      }))

      const rangeLabel = request.isWholeFile
        ? "whole file"
        : `L${request.selection.startLine}:C${request.selection.startColumn} - L${request.selection.endLine}:C${request.selection.endColumn}`
      const selectedSnippet =
        request.selectedText.length > 20000
          ? `${request.selectedText.slice(0, 20000)}\n\n[truncated ${request.selectedText.length - 20000} chars]`
          : request.selectedText
      const prompt = [
        `Apply an inline edit to \`${request.filePath}\`.`,
        `Scope: ${rangeLabel}.`,
        request.isWholeFile
          ? "Edit the file based on the instruction."
          : "Edit only the selected range unless minimal adjacent context is required for correctness.",
        `Instruction: ${request.instruction}`,
        "",
        "Selected content/context:",
        `\`\`\`${request.language || ""}`,
        selectedSnippet,
        "```",
        "",
        "Use file tools to apply the change directly in the repository.",
      ].join("\n")

      try {
        const target = await resolveProviderTarget(
          selectedProvider,
          selectedModel
        )
        const effectiveModel = resolveDispatchModelId(
          target.providerKind,
          selectedModel
        )
        await sendChatMessage(
          hiddenThreadId,
          prompt,
          effectiveModel,
          target.providerKind,
          coerceThinkingModeForModel(
            selectedProvider,
            selectedModel,
            thinkingMode
          ),
          "agent",
          projectPath || null,
          specialMode,
          permissionLevel,
          target.openaiTransport,
          null,
          target.providerInstanceId,
          contextWindow,
        )
      } catch (err) {
        console.error("[inline-edit] failed:", err)
      } finally {
        // Clean up the hidden thread regardless of success/error so it
        // never leaks into the sidebar or persists on disk.
        useChatStore.getState().deleteThread(hiddenThreadId)
      }
    },
    [
      contextWindow,
      permissionLevel,
      selectedModel,
      selectedProvider,
      specialMode,
      thinkingMode,
    ]
  )
}
