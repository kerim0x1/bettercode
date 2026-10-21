import type { ChatSendBody } from "@betterc0de/schema"
import type { AppState } from "../../appState"
import type { RemoteProviderTurnReservation } from "../../remote/providerTurnOwnership"
import type { ThreadAutonomyRuns } from "./autonomy"

/** What a run's turns are sent with: the opening (or resuming) request's settings and caller. */
export interface AutonomyContext {
  body: ChatSendBody
  reserveRemoteTurn: () => RemoteProviderTurnReservation | null
  /** Set after the first turn: later turns follow the chat's live permission level. */
  continued?: boolean
}

export const threadAutonomyRuns = new WeakMap<
  AppState,
  ThreadAutonomyRuns<AutonomyContext>
>()
