import { ErrorBoundary } from "@/components/error-boundary"
import { EditorPanel } from "@/components/editor-panel"
import { DiffPanel } from "@/components/diff-panel"
import type { UiProvider } from "@/lib/provider-types"
import type { InlineEditRequest } from "@/components/monaco-editor-wrapper"
import { resolveProviderModelSwitchSelection } from "@/lib/provider-model-selection"
import { clampEditorChatPanelWidth } from "@/lib/editor-layout"

/**
 * Editor-mode left side: the code editor + inline diff panel, followed by a
 * vertical resize handle that controls the adjacent chat column.
 *
 * No terminal here — editor mode is a pure code surface. The integrated
 * terminal lives in agent mode only, which is why the View menu's
 * "Toggle Terminal" entry is hidden while this mode is active.
 *
 * Renders nothing when there's no active thread or the thread has no
 * project path — editor mode without a project doesn't make sense.
 *
 * The inline-edit feature passes through `onInlineEdit` + the full model
 * picker state so the editor's "Ask AI" action can create an inline-edit
 * turn bound to the current provider/model selection.
 */
export function EditorModeSplitView({
  projectPath,
  handleInlineEdit,
  providers,
  selectedModel,
  selectedProviderId,
  thinkingMode,
  setSelectedModel,
  setSelectedProviderId,
  setContextWindow,
  setThinkingMode,
  diffOpen,
  setDiffOpen,
  chatPanelWidth,
  setChatPanelWidth,
}: {
  projectPath: string
  handleInlineEdit: (request: InlineEditRequest) => void | Promise<void>
  providers: UiProvider[]
  selectedModel: string
  selectedProviderId: string
  thinkingMode: string | null
  setSelectedModel: (id: string, providerId?: string) => void
  setSelectedProviderId: (id: string) => void
  setContextWindow: (w: "200k" | "1m", providerId?: string) => void
  setThinkingMode: (mode: string | null, providerId?: string) => void
  diffOpen: boolean
  setDiffOpen: (open: boolean) => void
  chatPanelWidth: number
  setChatPanelWidth: (width: number) => void
}) {
  if (!projectPath) {
    return null
  }

  return (
    <>
      {/* Code surface: a card on the shell, like the agent chat. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/40 bg-background">
        <ErrorBoundary label="Editor">
          <EditorPanel
            projectPath={projectPath}
            onInlineEdit={handleInlineEdit}
            inlineEditProviders={providers}
            inlineEditSelectedModelId={selectedModel}
            inlineEditSelectedProviderId={selectedProviderId}
            onInlineEditModelChange={(modelId, providerId) => {
              const provider = providers.find((item) => item.id === providerId)
              if (!provider) {
                setSelectedModel(modelId, providerId)
                setSelectedProviderId(providerId)
                setContextWindow("1m", providerId)
                return
              }
              const nextSelection = resolveProviderModelSwitchSelection({
                provider,
                modelId,
                thinkingMode,
                contextWindow: "1m",
              })
              setSelectedProviderId(nextSelection.providerId)
              setSelectedModel(nextSelection.modelId, nextSelection.providerId)
              setContextWindow(
                nextSelection.contextWindow,
                nextSelection.providerId
              )
              setThinkingMode(
                nextSelection.thinkingMode,
                nextSelection.providerId
              )
            }}
          />
        </ErrorBoundary>
        <DiffPanel
          open={diffOpen}
          onClose={() => setDiffOpen(false)}
          cwd={projectPath}
        />
      </div>

      {/* Resize handle — drags the chat column's width */}
      <ChatResizeHandle
        chatPanelWidth={chatPanelWidth}
        setChatPanelWidth={setChatPanelWidth}
      />
    </>
  )
}

function ChatResizeHandle({
  chatPanelWidth,
  setChatPanelWidth,
}: {
  chatPanelWidth: number
  setChatPanelWidth: (width: number) => void
}) {
  return (
    <div
      role="separator"
      aria-label="Resize code and chats"
      aria-orientation="vertical"
      aria-valuenow={chatPanelWidth}
      aria-valuemin={300}
      aria-valuemax={800}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        setChatPanelWidth(
          clampEditorChatPanelWidth(
            (event.currentTarget.nextElementSibling?.getBoundingClientRect()
              .width ?? chatPanelWidth) + (event.key === "ArrowLeft" ? 20 : -20)
          )
        )
      }}
      className="mx-0.5 w-1 shrink-0 cursor-col-resize rounded-full transition-colors hover:bg-border focus-visible:bg-border focus-visible:outline-none active:bg-muted-foreground/50"
      onMouseDown={(e) => {
        e.preventDefault()
        const startX = e.clientX
        const startW =
          e.currentTarget.nextElementSibling?.getBoundingClientRect().width ??
          chatPanelWidth
        const onMove = (ev: MouseEvent) =>
          setChatPanelWidth(
            clampEditorChatPanelWidth(startW - (ev.clientX - startX))
          )
        const onUp = () => {
          document.removeEventListener("mousemove", onMove)
          document.removeEventListener("mouseup", onUp)
        }
        document.addEventListener("mousemove", onMove)
        document.addEventListener("mouseup", onUp)
      }}
    />
  )
}
