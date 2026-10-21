import { create } from "zustand"
import type { SecretPatch, Settings } from "@betterc0de/schema"
import { getSettings, updateSettings } from "@/services/backend"
import { handleError } from "@/lib/errors"

/** Detect system language and map to the closest Deepgram language code */
function detectSystemLanguage(): string {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en"
  // Try exact match first (e.g. "en-US", "pt-BR", "es-419", "fr-CA")
  const exact = nav.replace("_", "-")
  const deepgramExact = new Set([
    "en",
    "en-US",
    "en-GB",
    "en-AU",
    "en-IN",
    "en-NZ",
    "es",
    "es-419",
    "fr",
    "fr-CA",
    "de",
    "de-CH",
    "pt",
    "pt-BR",
    "zh",
    "zh-CN",
    "zh-TW",
    "ja",
    "ko",
    "hi",
    "hi-Latn",
    "ta",
    "bn",
    "gu",
    "kn",
    "ml",
    "mr",
    "pa",
    "te",
    "id",
    "ms",
    "th",
    "vi",
    "tl",
    "ru",
    "uk",
    "pl",
    "cs",
    "sk",
    "bg",
    "hr",
    "sr",
    "sl",
    "sv",
    "no",
    "da",
    "fi",
    "nl",
    "nl-BE",
    "it",
    "el",
    "ro",
    "hu",
    "ca",
    "lt",
    "lv",
    "et",
    "tr",
    "az",
    "kk",
    "ar",
    "he",
    "fa",
    "sw",
    "af",
    "mi",
  ])
  if (deepgramExact.has(exact)) return exact

  // Fall back to base language (e.g. "de-DE" → "de", "it-IT" → "it")
  const base = exact.split("-")[0]
  if (deepgramExact.has(base)) return base

  return "en"
}

/**
 * Built-in Deepgram API key — provides free usage for all users.
 * Users can override with their own key for additional credits.
 */
export const BUILTIN_DEEPGRAM_KEY = ""

/** Returns the active API key: user-provided key takes priority, falls back to built-in */
export function getEffectiveApiKey(): string {
  const { deepgramApiKey } = useVoiceStore.getState()
  return deepgramApiKey || BUILTIN_DEEPGRAM_KEY
}

export interface VoiceState {
  deepgramApiKey: string
  deepgramConfigured: boolean
  micDeviceId: string
  voiceLanguage: string
  setupComplete: boolean
  loaded: boolean

  init: () => Promise<void>
  update: (
    patch: Partial<
      Pick<VoiceState, "deepgramApiKey" | "micDeviceId" | "voiceLanguage">
    >
  ) => Promise<void>
}

type VoiceSettingsPatch = Partial<
  Pick<Settings, "voice_mic_device_id" | "voice_language">
> & {
  deepgram_api_key?: SecretPatch
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  deepgramApiKey: "",
  deepgramConfigured: false,
  micDeviceId: "",
  voiceLanguage: detectSystemLanguage(),
  setupComplete: false,
  loaded: false,

  init: async () => {
    if (get().loaded) return
    try {
      const settings = await getSettings()
      const stored = readSecretState(settings.deepgram_api_key)
      const customKey =
        typeof settings.deepgram_api_key === "string"
          ? settings.deepgram_api_key
          : ""
      set({
        deepgramApiKey: customKey,
        deepgramConfigured: stored?.configured === true || customKey.length > 0,
        micDeviceId: (settings.voice_mic_device_id as string) || "",
        voiceLanguage:
          (settings.voice_language as string) || detectSystemLanguage(),
        setupComplete: !!(
          stored?.configured ||
          customKey ||
          BUILTIN_DEEPGRAM_KEY
        ),
        loaded: true,
      })
    } catch {
      set({ loaded: true, setupComplete: !!BUILTIN_DEEPGRAM_KEY })
    }
  },

  update: async (patch) => {
    const previous = get()
    const next: Partial<VoiceState> = { ...patch }
    if (patch.deepgramApiKey !== undefined) {
      next.setupComplete = !!(patch.deepgramApiKey || BUILTIN_DEEPGRAM_KEY)
      next.deepgramConfigured = patch.deepgramApiKey.length > 0
    }
    set(next)

    const backendPatch: VoiceSettingsPatch = {}
    if (patch.deepgramApiKey !== undefined) {
      backendPatch.deepgram_api_key = patch.deepgramApiKey
        ? { set: patch.deepgramApiKey }
        : { clear: true }
    }
    if (patch.micDeviceId !== undefined)
      backendPatch.voice_mic_device_id = patch.micDeviceId
    if (patch.voiceLanguage !== undefined)
      backendPatch.voice_language = patch.voiceLanguage
    try {
      await updateSettings(backendPatch)
    } catch (e) {
      set({
        deepgramApiKey: previous.deepgramApiKey,
        deepgramConfigured: previous.deepgramConfigured,
        micDeviceId: previous.micDeviceId,
        voiceLanguage: previous.voiceLanguage,
        setupComplete: previous.setupComplete,
      })
      handleError(e, { source: "voice-settings-save" })
      throw e
    }
  },
}))

function readSecretState(
  value: unknown
): { configured: boolean; storage: "encrypted" | "plaintext" } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const state = value as Record<string, unknown>
  if (typeof state.configured !== "boolean") return null
  if (state.storage !== "encrypted" && state.storage !== "plaintext")
    return null
  return { configured: state.configured, storage: state.storage }
}
