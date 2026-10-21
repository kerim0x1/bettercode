/**
 * Shared prop types for the ChatComposer sub-components.
 *
 * Extracted during the chat-composer refactor so that the minimal-footer
 * and full-footer files can both import the same interface without
 * circular deps.
 */

import type { PermissionLevel } from "@/lib/preferences-store"
import type { UiProvider } from "@/lib/provider-types"
import type { AutonomousStatus } from "@/lib/chat-store"
import type { ChatSubmitPayload } from "@/hooks/use-chat-submit"

/** The favourite-entry shape expected by the model picker */
export interface FavoriteEntry {
  key: string
  provider: UiProvider
  model: { id: string; name: string; context?: string; tier?: string }
}

/**
 * Props shared by both `ComposerMinimalFooter` and `ComposerFullFooter`.
 *
 * These are all passed through from the top-level `ChatComposer` component
 * (see `ChatComposerProps` below for the full composer input).
 */
export interface ComposerFooterProps {
  threadId?: string | null
  handleSubmit: (payload: ChatSubmitPayload) => void
  handleStop: () => void
  handleVoiceClick: (threadId?: string | null) => void
  handleVoiceContextMenu: (e: React.MouseEvent) => void
  thinkingMode: string | null
  setThinkingMode: (mode: string | null, providerId?: string) => void
  autonomousMode: boolean
  autonomousStatus: AutonomousStatus
  chatMode: string
  setChatMode: (mode: string) => void
  permissionLevel: PermissionLevel
  setPermissionLevel: (level: PermissionLevel) => void
  contextWindow: string
  setContextWindow: (w: "200k" | "1m", providerId?: string) => void
  /**
   * Codex / Claude CLI Fast Mode toggle — boolean. Maps to
   * `serviceTier: "fast"` on Codex's `turn/start` payload and to
   * `settings.fastMode: true` in the Claude Agent SDK `ClaudeQueryOptions`.
   * Both are priority-compute / fast-route flags, orthogonal to reasoning
   * effort. UI shows the toggle only when the active model exposes the
   * `fastMode` capability, with a Codex/Claude fallback before descriptors load.
   */
  fastMode: boolean
  setFastMode: (value: boolean) => void
  currentModelName: string
  selectedProvider: UiProvider | undefined
  currentProvider: UiProvider | undefined
  selectedProviderId: string
  selectedModel: string
  setSelectedModel: (id: string, providerId?: string) => void
  setSelectedProviderId: (id: string) => void
  providers: UiProvider[]
  favoriteEntries: FavoriteEntry[]
  toggleFavorite: (providerId: string, modelId: string) => void
  isFavorite: (providerId: string, modelId: string) => boolean
  isLmStudio: boolean
  isStreaming: boolean
  modelPickerOpen?: boolean
  setModelPickerOpen?: (open: boolean) => void
  planFollowUpActive?: boolean
  hideSubmit?: boolean
  voiceSetupComplete: boolean
  deepgram: { isRecording: boolean }
  setTerminalOpen: (open: boolean) => void
  setVoiceModalOpen: (open: boolean) => void
  setAutonomousDialogOpen: (open: boolean) => void
  appMode?: "agent" | "editor" | "design"
}

/**
 * Everything `ChatComposer` reads: the footer props plus the textarea and
 * pane wiring around them.
 */
export interface ChatComposerProps extends ComposerFooterProps {
  isActive?: boolean
  /** Focuses the owning pane before one of its menus opens. */
  activatePane?: () => void
  minimalChat: boolean
  /** Slash-command detection for the textarea (text, caret position). */
  checkSlash: (text: string, cursor?: number) => void
  /** File-mention detection for the textarea. */
  checkMention: (text: string) => void
  activeProjectPath?: string | null
  /**
   * Sends to the chat the payload's `threadId` names, past this column's
   * own binding. Compare starts the other models' chats through it.
   */
  submitToThread?: (payload: ChatSubmitPayload) => unknown
}
