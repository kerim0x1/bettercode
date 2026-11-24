import type { ProviderKind, ThreadId } from "./contracts"
import {
  isProviderSessionContinuationCompatible,
  type ProviderSessionBinding,
  type ProviderSessionBindingStore,
} from "./ProviderSessionBindingStore"

/**
 * Pure selection over persisted session bindings: which binding a thread can
 * resume on, and which foreign-provider binding would conflict with a new
 * session. The hub applies the answer; it does not compute it.
 */

export function selectRecoveryBinding(input: {
  readonly bindings: ProviderSessionBindingStore
  readonly thread: ThreadId
  readonly providerKind: ProviderKind
  readonly providerInstanceId: string
  readonly continuationKey: string | null
  readonly directBinding: ProviderSessionBinding | null
}): ProviderSessionBinding | null {
  const threadGeneration = input.bindings.getThreadGeneration?.(input.thread)
  // A current, compatible binding is usually enough to resume the session.
  // Only look at the other instances when the direct binding cannot resume.
  const fallbackBindings =
    threadGeneration === undefined
      ? (input.bindings.listForThread?.(input.thread) ??
        (input.directBinding ? [input.directBinding] : []))
      : undefined
  const currentGeneration =
    threadGeneration ?? latestBindingGeneration(fallbackBindings ?? [])
  if (
    isResumableBinding(input.directBinding) &&
    isProviderSessionContinuationCompatible(input.directBinding, input) &&
    (input.directBinding.generation ?? 0) === currentGeneration
  ) {
    return input.directBinding
  }
  const bindings =
    fallbackBindings ?? input.bindings.listForThread?.(input.thread) ?? []
  const candidates = bindings.filter(
    (binding) =>
      binding.providerKind === input.providerKind &&
      binding.providerInstanceId !== input.providerInstanceId &&
      isProviderSessionContinuationCompatible(binding, input) &&
      (binding.generation ?? 0) === currentGeneration &&
      isResumableBinding(binding)
  )
  return candidates[candidates.length - 1] ?? null
}

export function findConflictingProviderBinding(input: {
  readonly bindings?: ProviderSessionBindingStore
  readonly threadId: string
  readonly providerKind: ProviderKind
}): ProviderSessionBinding | null {
  const bindings = input.bindings?.listForThread?.(input.threadId) ?? []
  const currentGeneration =
    input.bindings?.getThreadGeneration?.(input.threadId) ??
    latestBindingGeneration(bindings)
  return (
    bindings.find(
      (binding) =>
        binding.providerKind !== input.providerKind &&
        (binding.generation ?? 0) === currentGeneration &&
        isCurrentProviderBinding(binding)
    ) ?? null
  )
}

function latestBindingGeneration(
  bindings: ReadonlyArray<ProviderSessionBinding>
): number {
  return bindings.reduce(
    (latest, binding) => Math.max(latest, binding.generation ?? 0),
    0
  )
}

function isCurrentProviderBinding(binding: ProviderSessionBinding): boolean {
  if (
    binding.providerThreadId !== null ||
    binding.resumeCursor !== null ||
    binding.activeTurnId !== null
  ) {
    return true
  }
  return (
    binding.status === "starting" ||
    binding.status === "ready" ||
    binding.status === "running" ||
    binding.status === "closing"
  )
}

function isResumableBinding(
  binding: ProviderSessionBinding | null
): binding is ProviderSessionBinding {
  return (
    !!binding && (binding.resumeCursor != null || !!binding.providerThreadId)
  )
}
