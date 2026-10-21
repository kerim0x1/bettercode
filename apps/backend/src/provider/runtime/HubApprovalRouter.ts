import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderKind,
  ProviderRuntimeEvent,
  ThreadId,
} from "./contracts"
import type { HubApprovalRequests } from "./HubApprovalRequests"
import { ProviderInstanceUnavailableError } from "./ProviderHubErrors"
import type { ProviderRuntimeInstance } from "./ProviderHubTypes"
import type { ProviderSessionBindingStore } from "./ProviderSessionBindingStore"

/** What approval routing needs from the hub. */
export interface HubApprovalRouterHost {
  resolveInstance(input: {
    readonly provider?: ProviderKind | null
    readonly instanceId?: string | null
  }): ProviderRuntimeInstance | null
  recoverSessionForThread(input: {
    readonly instance: ProviderRuntimeInstance
    readonly thread: ThreadId
    readonly bindings?: ProviderSessionBindingStore
  }): Promise<boolean>
  /** The instance the thread's active turn runs on, if any. */
  activeTurnInstanceId(thread: string): string | null | undefined
}

/**
 * Routes approval answers and permission-mode changes to the instance that
 * owns the thread's session, recovering that session first. The live request
 * bookkeeping and the policy-driven auto-answers stay in
 * {@link HubApprovalRequests}; this class only decides where a response goes.
 */
export class HubApprovalRouter {
  constructor(
    private readonly requests: HubApprovalRequests,
    private readonly host: HubApprovalRouterHost
  ) {}

  /** Called only after the event has entered the hub's delivery lane. */
  observe(
    instance: ProviderRuntimeInstance,
    event: ProviderRuntimeEvent
  ): void {
    this.requests.observe(instance, event)
  }

  async respondToRequest(
    provider: ProviderKind,
    thread: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    instanceId?: string | null,
    bindings?: ProviderSessionBindingStore
  ): Promise<void> {
    const instance = this.host.resolveInstance({
      provider,
      instanceId: instanceId ?? null,
    })
    if (!instance)
      throw new ProviderInstanceUnavailableError(provider, instanceId)
    await this.host.recoverSessionForThread({ instance, thread, bindings })
    await instance.adapter.respondToRequest(thread, requestId, decision)
  }

  async setPermissionMode(
    provider: ProviderKind,
    thread: ThreadId,
    mode: "default" | "plan" | "acceptEdits" | "bypassPermissions",
    instanceId?: string | null,
    bindings?: ProviderSessionBindingStore,
    permissionLevel?: string
  ): Promise<{ applied: "live" | "queued" | "unsupported" }> {
    const instance = this.host.resolveInstance({
      provider,
      instanceId: instanceId ?? null,
    })
    if (!instance)
      throw new ProviderInstanceUnavailableError(provider, instanceId)
    const activeInstanceId = this.host.activeTurnInstanceId(thread)
    if (activeInstanceId && activeInstanceId !== instance.instanceId) {
      throw new ProviderInstanceUnavailableError(provider, instanceId)
    }
    const change = this.requests.updatePermissionMode(
      thread,
      mode,
      permissionLevel
    )
    await this.requests.reconcile(instance, thread)
    if (instance.adapter.setPermissionMode && change.nativeMode) {
      await this.host.recoverSessionForThread({ instance, thread, bindings })
      const native = await instance.adapter.setPermissionMode(
        thread,
        change.nativeMode
      )
      return { applied: change.applied === "live" ? "live" : native.applied }
    }
    return { applied: change.applied }
  }
}
