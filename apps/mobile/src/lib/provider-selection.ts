import type {
  ChatMessage,
  ChatThread,
  ModelOption,
  ProviderInstance,
} from "@/types/remote"
import {
  chatProviderPriority,
  isHiddenChatProvider,
} from "@betterc0de/schema/model-selection"

export function modelOptions(instances: ProviderInstance[]): ModelOption[] {
  return (
    instances
      .filter(
        (instance) =>
          !isHiddenChatProvider(instance.instanceId, instance.driver) &&
          instance.enabled &&
          instance.installed &&
          instance.configured &&
          instance.status !== "disabled" &&
          instance.status !== "error" &&
          instance.availability !== "unavailable"
      )
      .sort(
        (left, right) =>
          chatProviderPriority(left.driver) - chatProviderPriority(right.driver)
      )
      // Models keep the provider's own order; the desktop does not promote any.
      .flatMap((instance) =>
        instance.models.map((model) => ({
          key: `${instance.instanceId}:${model.slug}`,
          providerKind: instance.driver,
          providerInstanceId: instance.instanceId,
          providerLabel: instance.displayName || instance.driver,
          modelId: model.slug,
          modelLabel: model.shortName || model.name || model.slug,
          capabilities: model.capabilities ?? null,
        }))
      )
  )
}

export function preferredModel(
  thread: ChatThread,
  messages: ChatMessage[],
  options: ModelOption[]
): ModelOption | null {
  const sessionInstance = thread.session?.providerInstanceId
  const sessionKind = thread.session?.providerKind
  const lastModel = [...messages]
    .reverse()
    .find(
      (message) => typeof message.modelId === "string" && message.modelId.trim()
    )?.modelId

  return (
    options.find(
      (option) =>
        option.providerInstanceId === sessionInstance &&
        option.modelId === lastModel
    ) ??
    options.find(
      (option) =>
        option.providerKind === sessionKind && option.modelId === lastModel
    ) ??
    options.find((option) => option.providerInstanceId === sessionInstance) ??
    options.find((option) => option.providerKind === sessionKind) ??
    options.find((option) => option.modelId === lastModel) ??
    options[0] ??
    null
  )
}
