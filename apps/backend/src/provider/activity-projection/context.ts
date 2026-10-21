import type { LegacyProviderEvent } from "../types"

/**
 * What every projector family sees: the event, its flattened payload and the
 * identity already derived from it.
 */
export interface ProjectionContext {
  readonly event: LegacyProviderEvent
  readonly eventType: string
  readonly threadId: string
  readonly payload: Record<string, unknown>
  readonly providerKind: string | undefined
  readonly providerInstanceId: string | undefined
  readonly createdAt: string | undefined
  readonly sequence: number
}
