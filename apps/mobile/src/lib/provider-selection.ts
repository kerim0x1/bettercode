import type {
  ChatMessage,
  ChatThread,
  ModelOption,
  NineRouterProviderView,
  ProviderInstance,
} from "@/types/remote"
import type { RemoteApi } from "@/transport/types"
import {
  NINEROUTER_DISPLAY_NAME,
  NINEROUTER_PROVIDER_KIND,
  isRecord,
  modelCapabilitiesSchema,
  nineRouterConnectionViewSchema,
  nineRouterInstanceId,
  nineRouterProviderViewSchema,
  type NineRouterConnectionView,
} from "@betterc0de/schema"
import {
  chatProviderPriority,
  isHiddenChatProvider,
} from "@betterc0de/schema/model-selection"

/** What a desktop without 9Router support, or without its route, offers. */
export const NO_NINEROUTER: NineRouterProviderView = {
  enabled: false,
  connections: [],
}

/**
 * Connection states in which the desktop can send a turn through 9Router.
 * An unreachable router, a missing or rejected key, or an invalid address
 * would only fail on send, so those connections offer no models.
 */
const USABLE_NINEROUTER_STATES: ReadonlySet<
  NineRouterConnectionView["status"]["state"]
> = new Set(["online", "unknown"])

export function modelOptions(
  instances: ProviderInstance[],
  nineRouter: NineRouterProviderView | null = null
): ModelOption[] {
  // 9Router follows the hub instances, so the CLI providers stay first.
  return [
    ...instanceModelOptions(instances),
    ...nineRouterModelOptions(nineRouter),
  ]
}

function instanceModelOptions(instances: ProviderInstance[]): ModelOption[] {
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

/**
 * One picker group per enabled 9Router connection, as on the desktop: a
 * single connection is "9Router", several are named after the connection.
 * Model ids are 9Router's own (`cc/claude-opus-5-5`, a combo name) and go to
 * the desktop unchanged.
 */
export function nineRouterModelOptions(
  view: NineRouterProviderView | null
): ModelOption[] {
  if (!view?.enabled) return []
  const connections = view.connections.filter(
    (connection) => connection.enabled
  )
  return connections
    .filter((connection) =>
      USABLE_NINEROUTER_STATES.has(connection.status.state)
    )
    .flatMap((connection) => {
      const providerLabel = nineRouterLabel(connection, connections)
      const providerInstanceId = nineRouterInstanceId(connection.id)
      const seen = new Set<string>()
      return connection.models.flatMap((model): ModelOption[] => {
        if (model.hidden || !model.slug.trim() || seen.has(model.slug))
          return []
        seen.add(model.slug)
        const capabilities = modelCapabilitiesSchema.safeParse(
          model.capabilities
        )
        return [
          {
            key: `${NINEROUTER_PROVIDER_KIND}:${connection.id}:${model.slug}`,
            providerKind: NINEROUTER_PROVIDER_KIND,
            providerInstanceId,
            providerLabel,
            modelId: model.slug,
            modelLabel: model.name || model.slug,
            ...(model.tier ? { modelGroup: model.tier } : {}),
            capabilities: capabilities.success ? capabilities.data : null,
          },
        ]
      })
    })
}

function nineRouterLabel(
  connection: NineRouterConnectionView,
  enabled: readonly NineRouterConnectionView[]
): string {
  if (enabled.length === 1) return NINEROUTER_DISPLAY_NAME
  // The picker groups by label: two connections with one name stay apart.
  const shared =
    enabled.filter((other) => other.name === connection.name).length > 1
  return `${NINEROUTER_DISPLAY_NAME} · ${
    shared ? `${connection.name} (${connection.id})` : connection.name
  }`
}

/**
 * The desktop's 9Router view, read defensively: a connection this app
 * cannot read is left out instead of hiding the others.
 */
export function parseNineRouterView(raw: unknown): NineRouterProviderView {
  const view = nineRouterProviderViewSchema.safeParse(raw)
  if (view.success) return view.data
  if (!isRecord(raw) || raw.enabled !== true || !Array.isArray(raw.connections))
    return NO_NINEROUTER
  return {
    enabled: true,
    connections: raw.connections.flatMap((connection: unknown) => {
      const parsed = nineRouterConnectionViewSchema.safeParse(connection)
      return parsed.success ? [parsed.data] : []
    }),
  }
}

/**
 * Every model the desktop can run for a project: its provider instances,
 * then its 9Router connections. 9Router is optional; when the desktop
 * cannot list it (an older desktop, a router that does not answer), the
 * other providers are still offered.
 */
export async function loadModelOptions(
  api: Pick<RemoteApi, "listProviderInstances" | "getNineRouter">,
  cwd?: string | null
): Promise<ModelOption[]> {
  const [instances, nineRouter] = await Promise.all([
    api.listProviderInstances(cwd),
    api.getNineRouter().catch(() => NO_NINEROUTER),
  ])
  return modelOptions(instances, nineRouter)
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
