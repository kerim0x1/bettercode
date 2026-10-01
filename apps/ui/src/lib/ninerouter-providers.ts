import {
  NINEROUTER_DISPLAY_NAME,
  NINEROUTER_PROVIDER_KIND,
  nineRouterConnectionIdFromInstanceId,
  nineRouterInstanceId,
  type ModelCapabilities,
  type NineRouterConnectionView,
  type NineRouterProviderView,
} from "@betterc0de/schema"
import { assetUrl } from "@/lib/asset-url"
import type { UiProvider, UiProviderModel } from "@/lib/provider-types"
import {
  getNineRouter,
  updateNineRouterConnection,
} from "@/services/backend/providersApi"

/** Fired after a 9Router connection changes, so pickers reload. */
export const NINEROUTER_UPDATED_EVENT = "betterc0de:ninerouter-updated"

export function notifyNineRouterUpdated(): void {
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(NINEROUTER_UPDATED_EVENT))
}

/**
 * Adds a model id typed in the picker to the connection's custom models (and
 * un-hides it), so it is selectable and sendable like a catalog model.
 */
export async function addNineRouterCustomModel(
  providerInstanceId: string,
  modelId: string
): Promise<void> {
  const id = modelId.trim()
  const connectionId = nineRouterConnectionIdFromInstanceId(providerInstanceId)
  if (!id || !connectionId) return
  const view = await getNineRouter()
  const connection = view.connections.find((entry) => entry.id === connectionId)
  if (!connection) throw new Error("This 9Router connection no longer exists.")
  const known = connection.models.some((model) => model.slug === id)
  const hidden = connection.hiddenModels.includes(id)
  if (!known || hidden) {
    await updateNineRouterConnection(connectionId, {
      ...(known ? {} : { customModels: [...connection.customModels, id] }),
      ...(hidden
        ? {
            hiddenModels: connection.hiddenModels.filter(
              (entry) => entry !== id
            ),
          }
        : {}),
    })
  }
  notifyNineRouterUpdated()
}

/** Picker provider id for one connection: `ninerouter:<connection id>`. */
export function nineRouterUiProviderId(connectionId: string): string {
  return nineRouterInstanceId(connectionId)
}

export function isNineRouterUiProviderId(id: string | null | undefined) {
  return (id ?? "").startsWith(`${NINEROUTER_PROVIDER_KIND}:`)
}

const PICKER_STATE_HINT: Partial<
  Record<NineRouterConnectionView["status"]["state"], string>
> = {
  offline:
    "9Router is not reachable. Start it with “npx 9router” or check the URL in Settings → Providers → 9Router.",
  auth_required:
    "This 9Router needs an API key. Add one in Settings → Providers → 9Router.",
}

function uiModel(model: NineRouterConnectionView["models"][number]) {
  return {
    id: model.slug,
    name: model.name,
    context: model.context ?? "runtime",
    tier: model.tier,
    isCustom: model.isCustom,
    capabilities: (model.capabilities ?? null) as ModelCapabilities | null,
  } satisfies UiProviderModel
}

/**
 * One picker provider per enabled connection. A single connection is just
 * "9Router"; several are named so "Laptop" and "VPS" stay distinguishable.
 * A connection without models whose last check failed is shown disabled with
 * the reason, so the picker explains instead of failing on send.
 */
export function nineRouterUiProviders(
  view: NineRouterProviderView | null
): UiProvider[] {
  if (!view?.enabled) return []
  const connections = view.connections.filter(
    (connection) => connection.enabled
  )
  return connections.map((connection) => {
    const models = connection.models
      .filter((model) => !model.hidden)
      .map(uiModel)
    const hint = PICKER_STATE_HINT[connection.status.state]
    const unusable = models.length === 0 && Boolean(hint)
    return {
      id: nineRouterUiProviderId(connection.id),
      name:
        connections.length === 1
          ? NINEROUTER_DISPLAY_NAME
          : `${NINEROUTER_DISPLAY_NAME} · ${connection.name}`,
      logo: assetUrl("icons/providers/9router.svg"),
      invertDark: true,
      providerKind: NINEROUTER_PROVIDER_KIND,
      providerInstanceId: nineRouterInstanceId(connection.id),
      models,
      modelsReady: connection.status.state !== "unknown" || models.length > 0,
      configured: !unusable,
      authType: "local-server",
      ...(unusable && hint
        ? { setupHint: connection.status.message ?? hint }
        : {}),
    } satisfies UiProvider
  })
}
