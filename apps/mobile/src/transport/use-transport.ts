import { hasFeature } from "@/lib/compat"
import { selectAccessLevel, useSessionStore } from "@/store/session-store"
import type { RemoteApi, RemoteTransport } from "./types"

/** The connection screens talk through: the paired desktop or the demo. */
export function useTransport(): RemoteTransport | null {
  return useSessionStore((state) => state.transport)
}

/** `null` while nothing is paired; screens render their empty state then. */
export function useRemoteApi(): RemoteApi | null {
  return useSessionStore((state) => state.transport?.api ?? null)
}

/** A read-only session can watch but not send, approve or change anything. */
export function useReadOnly(): boolean {
  return useSessionStore((state) => selectAccessLevel(state) === "read_only")
}

/** Additive desktop features, available only when the desktop lists them. */
export function useFeature(feature: string): boolean {
  return useSessionStore((state) => hasFeature(state.protocol, feature))
}
