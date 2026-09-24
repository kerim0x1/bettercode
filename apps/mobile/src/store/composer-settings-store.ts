import { create } from "zustand"
import {
  DEFAULT_PERMISSION_LEVEL,
  normalizeChatMode,
  normalizePermissionLevel,
  type KnownChatMode,
  type PermissionLevel,
} from "@betterc0de/schema/chat-controls"
import { documents } from "@/lib/local-documents"

/**
 * The permission preset and chat mode each chat uses. Like the desktop,
 * the phone keeps them per chat on the device; the desktop does not share
 * its own, and every message carries the values it was sent with.
 */
export interface ComposerSettings {
  permissionLevel: PermissionLevel
  chatMode: KnownChatMode
}

export const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = {
  permissionLevel: DEFAULT_PERMISSION_LEVEL,
  chatMode: "agent",
}

const DOCUMENT = "composer-settings.json"

interface ComposerSettingsStore {
  byThread: Record<string, ComposerSettings>
  /** Reads the settings saved on this phone; called once at start. */
  hydrate(): void
  settingsFor(threadId: string): ComposerSettings
  update(threadId: string, change: Partial<ComposerSettings>): void
  forget(threadId: string): void
  /** Forgets every chat's settings with the pairing they were made for. */
  forgetAll(): void
}

function readSaved(): Record<string, ComposerSettings> {
  try {
    const saved: unknown = JSON.parse(documents.read(DOCUMENT) ?? "{}")
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {}
    const result: Record<string, ComposerSettings> = {}
    for (const [threadId, value] of Object.entries(
      saved as Record<string, Partial<ComposerSettings>>
    )) {
      if (!value || typeof value !== "object") continue
      // Presets or modes that no longer exist read as today's defaults.
      result[threadId] = {
        permissionLevel: normalizePermissionLevel(value.permissionLevel),
        chatMode: normalizeChatMode(value.chatMode),
      }
    }
    return result
  } catch {
    return {}
  }
}

export const useComposerSettings = create<ComposerSettingsStore>((set, get) => {
  const save = (byThread: Record<string, ComposerSettings>) => {
    set({ byThread })
    try {
      documents.write(DOCUMENT, JSON.stringify(byThread))
    } catch {
      // Kept for this session; the next change tries to save again.
    }
  }
  return {
    byThread: {},
    hydrate: () => set({ byThread: readSaved() }),
    settingsFor: (threadId) =>
      get().byThread[threadId] ?? DEFAULT_COMPOSER_SETTINGS,
    update: (threadId, change) =>
      save({
        ...get().byThread,
        [threadId]: { ...get().settingsFor(threadId), ...change },
      }),
    forget: (threadId) => {
      if (!(threadId in get().byThread)) return
      const { [threadId]: _removed, ...rest } = get().byThread
      save(rest)
    },
    forgetAll: () => save({}),
  }
})
