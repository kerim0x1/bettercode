import { useCallback, useEffect, useRef, useState } from "react"
import { useVoiceStore, getEffectiveApiKey } from "./voice-store"
import { createDeepgramAccessToken } from "@/services/backend"
import {
  DeepgramSession,
  type DeepgramCallbacks,
  type DictationPhase,
} from "./deepgram-session"

export type { DeepgramCallbacks } from "./deepgram-session"

export function useDeepgram() {
  const [phase, setPhase] = useState<DictationPhase>("idle")
  const [error, setError] = useState<string | null>(null)
  const session = useRef<DeepgramSession | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      session.current?.cancel()
      session.current = null
    }
  }, [])

  const start = useCallback(async (callbacks: DeepgramCallbacks) => {
    if (session.current || !mounted.current) return
    const { deepgramConfigured, micDeviceId, voiceLanguage } =
      useVoiceStore.getState()
    const apiKey = getEffectiveApiKey()
    if (!apiKey && !deepgramConfigured) {
      setError("No Deepgram API key configured")
      callbacks.onEnd?.()
      return
    }
    setError(null)
    const next = new DeepgramSession({
      language: voiceLanguage,
      getStream: () =>
        navigator.mediaDevices.getUserMedia({
          audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
        }),
      getAuth: async () =>
        apiKey
          ? { protocol: "token", credential: apiKey }
          : {
              protocol: "bearer",
              credential: (await createDeepgramAccessToken()).accessToken,
            },
      callbacks,
      onPhase: (nextPhase) => {
        if (session.current !== next) return
        if (nextPhase === "idle") session.current = null
        if (mounted.current) setPhase(nextPhase)
      },
      onError: (message) => {
        if (mounted.current && session.current === next) setError(message)
      },
    })
    session.current = next
    await next.start()
  }, [])

  const stop = useCallback(() => session.current?.stop(), [])
  const cancel = useCallback(() => session.current?.cancel(), [])
  const clearError = useCallback(() => setError(null), [])

  return {
    isRecording: phase !== "idle",
    isFinalizing: phase === "finishing",
    error,
    start,
    stop,
    cancel,
    clearError,
  }
}
