import type { RemoteProtocol } from "@betterc0de/schema/remote-protocol"
import { create } from "zustand"
import { APP_VERSION, CLIENT_INFO, defaultDeviceLabel } from "@/lib/app-info"
import {
  assessCompatibility,
  maxRequestBytes,
  type Compatibility,
} from "@/lib/compat"
import { parsePairingInput } from "@/lib/endpoint"
import { remoteErrorMessage } from "@/lib/remote-errors"
import { setMaxRequestBytes } from "@/lib/request-limit"
import {
  clearStoredProfile,
  readStoredProfile,
  storeProfile,
} from "@/lib/secure-session"
import {
  createDemoTransport,
  DEMO_ENVIRONMENT_ID,
  DEMO_PROTOCOL,
  type DemoOptions,
} from "@/transport/demo"
import {
  createLiveTransport,
  pairMobile,
  RemoteApiError,
} from "@/transport/live"
import type { RemoteTransport } from "@/transport/types"
import type {
  ConnectionProfile,
  RemoteAccessLevel,
  RemoteSessionSummary,
} from "@/types/remote"

export type ConnectionState =
  | "hydrating"
  | "unpaired"
  | "pairing"
  | "checking"
  | "online"
  | "offline"
  /** Remote Access is switched off on the desktop; the pairing is kept. */
  | "remote_disabled"

export type SocketState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error"

/** Why the phone is no longer paired, shown on the pairing screen. */
export interface SessionNotice {
  readonly kind: "session_ended" | "different_desktop"
  readonly message: string
}

export type LogoutResult =
  | { readonly revoked: true }
  /** The desktop could not be told; the pairing is still stored. */
  | { readonly revoked: false; readonly error: string }

interface SessionStore {
  mode: "live" | "demo" | null
  profile: ConnectionProfile | null
  transport: RemoteTransport | null
  protocol: RemoteProtocol | null
  compatibility: Compatibility
  state: ConnectionState
  socketState: SocketState
  error: string | null
  notice: SessionNotice | null
  lastCheckedAt: string | null
  hydrate: () => Promise<void>
  pair: (
    input: string,
    manualBaseUrl?: string,
    label?: string
  ) => Promise<ConnectionProfile>
  check: () => Promise<boolean>
  /** Revokes this phone on the desktop, then forgets it; keeps it if the desktop cannot be told. */
  logout: () => Promise<LogoutResult>
  /** Forgets the pairing on this phone only. */
  forget: () => Promise<void>
  startDemo: (options?: DemoOptions) => void
  exitDemo: () => void
  setSocketState: (state: SocketState) => void
  setProtocol: (protocol: RemoteProtocol | null) => void
  markAppUpdateRequired: (minClientVersion?: string | null) => void
}

const DEMO_SESSION: RemoteSessionSummary = {
  id: "demo-session",
  label: "Demo",
  accessLevel: "full",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
}

/** Stands in for a pairing while the demo runs; never stored, never contacted. */
export const DEMO_PROFILE: ConnectionProfile = {
  baseUrl: "https://demo.invalid",
  environmentId: DEMO_ENVIRONMENT_ID,
  sessionToken: "demo",
  pairedAt: DEMO_SESSION.createdAt,
  session: DEMO_SESSION,
}

/**
 * The fields of a session that change what the app shows or may do.
 * `lastSeenAt` moves every minute and must not replace the profile: every
 * screen keyed on it would reload (the files browser jumped back to the
 * project root, the chat refetched).
 */
function sameStableSession(
  a: RemoteSessionSummary,
  b: RemoteSessionSummary
): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.createdAt === b.createdAt &&
    a.expiresAt === b.expiresAt &&
    (a.accessLevel ?? "full") === (b.accessLevel ?? "full")
  )
}

export const useSessionStore = create<SessionStore>((set, get) => {
  // A lifecycle action owns its generation. Awaited work may only commit while
  // that generation is current, including writes to secure storage.
  let generation = 0
  let storageTail: Promise<unknown> = Promise.resolve()
  let pendingCheck: { generation: number; promise: Promise<boolean> } | null =
    null
  const storage = <T>(
    owner: number,
    operation: () => Promise<T>
  ): Promise<T | undefined> => {
    const result = storageTail
      .catch(() => undefined)
      .then(() => (owner === generation ? operation() : undefined))
    storageTail = result
    return result
  }
  const retireTransport = () => {
    const transport = get().transport as
      | (RemoteTransport & { dispose?: () => void })
      | null
    transport?.dispose?.()
  }
  const disconnected = (
    error: string | null = null,
    notice: SessionNotice | null = null
  ) => {
    retireTransport()
    set({
      mode: null,
      profile: null,
      transport: null,
      protocol: null,
      compatibility: { kind: "ok" },
      state: "unpaired",
      socketState: "idle",
      error,
      notice,
      lastCheckedAt: null,
    })
  }
  /** Ends the pairing because the desktop no longer honours it. */
  const unpair = async (notice: SessionNotice) => {
    const invalidation = ++generation
    disconnected(null, notice)
    await storage(invalidation, clearStoredProfile)
  }
  const liveTransport = (profile: ConnectionProfile): RemoteTransport =>
    createLiveTransport(profile, {
      client: CLIENT_INFO,
      onRefusal: (error) => {
        if (get().profile?.sessionToken !== profile.sessionToken) return
        if (error.code === "client_update_required") {
          get().markAppUpdateRequired(error.details.minClientVersion)
        } else if (error.status === 401) {
          // Any refused call means the session may be gone; the bootstrap
          // check decides and explains.
          void get().check()
        }
      },
    })

  return {
    mode: null,
    profile: null,
    transport: null,
    protocol: null,
    compatibility: { kind: "ok" },
    state: "hydrating",
    socketState: "idle",
    error: null,
    notice: null,
    lastCheckedAt: null,

    hydrate: async () => {
      const owner = ++generation
      retireTransport()
      set({
        mode: null,
        profile: null,
        transport: null,
        state: "hydrating",
        socketState: "idle",
        error: null,
      })
      try {
        const profile = await storage(owner, readStoredProfile)
        if (owner !== generation) return
        if (!profile) {
          disconnected()
          return
        }
        set({
          mode: "live",
          profile,
          transport: liveTransport(profile),
          state: "checking",
        })
        await get().check()
      } catch (error) {
        if (owner === generation) disconnected(remoteErrorMessage(error))
      }
    },

    pair: async (input, manualBaseUrl, label) => {
      const owner = ++generation
      retireTransport()
      set({
        mode: null,
        profile: null,
        transport: null,
        state: "pairing",
        socketState: "idle",
        error: null,
        notice: null,
      })
      const assertCurrent = () => {
        if (owner !== generation)
          throw new Error("Pairing was superseded by another session action.")
      }
      try {
        const target = parsePairingInput(input, manualBaseUrl)
        await storage(owner, clearStoredProfile)
        assertCurrent()
        const paired = await pairMobile(
          target.baseUrl,
          target.credential,
          label?.trim() || defaultDeviceLabel(),
          CLIENT_INFO
        )
        assertCurrent()
        const profile: ConnectionProfile = {
          baseUrl: target.baseUrl,
          environmentId: paired.environmentId,
          sessionToken: paired.sessionToken,
          session: paired.session,
          pairedAt: new Date().toISOString(),
        }
        await storage(owner, () => storeProfile(profile))
        assertCurrent()
        set({
          mode: "live",
          profile,
          transport: liveTransport(profile),
          protocol: paired.protocol,
          compatibility: assessCompatibility(paired.protocol, APP_VERSION),
          state: "online",
          socketState: "connecting",
          error: null,
          lastCheckedAt: new Date().toISOString(),
        })
        return profile
      } catch (error) {
        if (owner === generation) disconnected(pairingErrorMessage(error))
        throw error
      }
    },

    check: () => {
      const owner = generation
      if (pendingCheck?.generation === owner) return pendingCheck.promise
      const { profile, transport, mode } = get()
      if (mode === "demo") return Promise.resolve(true)
      if (!profile || !transport) {
        disconnected()
        return Promise.resolve(false)
      }
      const current = () => owner === generation
      const check = async (): Promise<boolean> => {
        // A periodic check of a working connection must not flash "checking".
        if (get().state !== "online") set({ state: "checking", error: null })
        try {
          const bootstrap = await transport.api.bootstrap()
          if (!current()) return false
          if (!bootstrap.enabled) {
            set({
              state: "remote_disabled",
              error: null,
              lastCheckedAt: new Date().toISOString(),
            })
            return false
          }
          if (
            !bootstrap.authenticated ||
            bootstrap.authentication !== "remote"
          ) {
            await unpair({
              kind: "session_ended",
              message:
                "The desktop signed this phone out: it was revoked, it expired, or Remote Access was turned off and on again. Pair it again.",
            })
            return false
          }
          if (bootstrap.environmentId !== profile.environmentId) {
            await unpair({
              kind: "different_desktop",
              message:
                "That address now belongs to a different BetterC0de desktop. Pair this phone with it again.",
            })
            return false
          }
          const next = bootstrap.session
          if (next && !sameStableSession(next, profile.session)) {
            const refreshed = { ...profile, session: next }
            await storage(owner, () => storeProfile(refreshed))
            if (!current()) return false
            set({ profile: refreshed })
          }
          set({
            state: "online",
            protocol: bootstrap.protocol,
            compatibility: assessCompatibility(bootstrap.protocol, APP_VERSION),
            error: null,
            lastCheckedAt: new Date().toISOString(),
          })
          return true
        } catch (error) {
          if (!current()) return false
          if (error instanceof RemoteApiError && error.status === 401) {
            await unpair({
              kind: "session_ended",
              message: "The desktop signed this phone out. Pair it again.",
            })
            return false
          }
          if (
            error instanceof RemoteApiError &&
            error.code === "client_update_required"
          ) {
            get().markAppUpdateRequired(error.details.minClientVersion)
            set({ state: "online", lastCheckedAt: new Date().toISOString() })
            return false
          }
          set({
            state: "offline",
            error: remoteErrorMessage(error),
            lastCheckedAt: new Date().toISOString(),
          })
          return false
        }
      }
      const promise = check().finally(() => {
        if (pendingCheck?.promise === promise) pendingCheck = null
      })
      pendingCheck = { generation: owner, promise }
      return promise
    },

    logout: async () => {
      const { mode, transport } = get()
      if (mode === "demo") {
        get().exitDemo()
        return { revoked: true }
      }
      if (!transport) {
        await get().forget()
        return { revoked: true }
      }
      const owner = generation
      try {
        await transport.api.logout()
      } catch (error) {
        // Forgetting silently would leave a working session on the desktop.
        return { revoked: false, error: remoteErrorMessage(error) }
      }
      // The phone may have paired again while the desktop answered; that
      // newer pairing is not the one being signed out.
      if (owner !== generation) return { revoked: true }
      await get().forget()
      return { revoked: true }
    },

    forget: async () => {
      const owner = ++generation
      disconnected()
      await storage(owner, clearStoredProfile)
    },

    startDemo: (options) => {
      ++generation
      retireTransport()
      set({
        mode: "demo",
        profile: DEMO_PROFILE,
        transport: createDemoTransport(options),
        protocol: DEMO_PROTOCOL,
        compatibility: { kind: "ok" },
        state: "online",
        socketState: "connecting",
        error: null,
        notice: null,
        lastCheckedAt: new Date().toISOString(),
      })
    },

    exitDemo: () => {
      if (get().mode !== "demo") return
      ++generation
      disconnected()
    },

    setSocketState: (socketState) => set({ socketState }),

    setProtocol: (protocol) =>
      set({
        protocol,
        compatibility: assessCompatibility(protocol, APP_VERSION),
      }),

    markAppUpdateRequired: (minClientVersion) =>
      set((state) => ({
        compatibility: {
          kind: "app_update_required",
          minClientVersion:
            minClientVersion ?? state.protocol?.minClientVersion ?? null,
        },
      })),
  }
})

// The stores that send messages read the desktop's request limit from
// request-limit.ts; it follows the protocol of whichever desktop is paired.
useSessionStore.subscribe((state, previous) => {
  if (state.protocol !== previous.protocol)
    setMaxRequestBytes(maxRequestBytes(state.protocol))
})

/** The session's effective access: the desktop's view first (it knows the transport). */
export function selectAccessLevel(
  state: Pick<SessionStore, "protocol" | "profile">
): RemoteAccessLevel {
  return (
    state.protocol?.capabilities?.accessLevel ??
    state.profile?.session.accessLevel ??
    "full"
  )
}

function pairingErrorMessage(error: unknown): string {
  // An older desktop answers a spent or unknown code with a bare 401.
  if (error instanceof RemoteApiError && error.status === 401 && !error.code) {
    return "The code was already used or has expired. Create a new one on the desktop."
  }
  return remoteErrorMessage(error)
}
