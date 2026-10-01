import { useMemo, useState } from "react"
import { useProviders } from "@/hooks/use-providers"
import {
  useLmStudioModelsSync,
  type LmStudioModel,
} from "@/hooks/use-lm-studio-models"
import {
  useOpenRouterCustomModelsSync,
  useOpenRouterModelsSync,
} from "@/hooks/use-openrouter-models"
import {
  buildOpenRouterGroupModels,
  openRouterCustomUiModels,
} from "@/lib/openrouter-live-models"
import type { OpenRouterLiveModel } from "@/services/backend/providersApi"
import { useNineRouterView } from "@/hooks/use-ninerouter"
import { nineRouterUiProviders } from "@/lib/ninerouter-providers"

/**
 * Returns the app's provider list with the live model lists merged in.
 *
 * The regular `useProviders()` hook returns static builtin providers
 * plus plugin providers; three provider families need live data on top:
 *
 *  - LM Studio's `models: []` starts empty because the actual list lives
 *    on the local server at `localhost:1234`.
 *  - The OpenRouter picker groups (or-qwen, or-deepseek, …) carry curated
 *    fallback ids that rot as OpenRouter rotates its catalog; when the
 *    backend's cached live catalog is available it replaces them.
 *  - 9Router contributes one entry per enabled connection, each with the
 *    models that router currently serves; they follow OpenRouter.
 *
 * Both polling effects share the same `active` gate (user selected the
 * provider or has the model picker open), and `useMemo` splices the live
 * lists in so the merged result is a drop-in replacement for
 * `useProviders()`.
 */
export function useProvidersWithLmStudio(active: boolean, cwd?: string | null) {
  const baseProviders = useProviders(cwd)
  const [lmModels, setLmModels] = useState<LmStudioModel[]>([])
  useLmStudioModelsSync(active, setLmModels)
  const [orModels, setOrModels] = useState<OpenRouterLiveModel[] | null>(null)
  useOpenRouterModelsSync(active, setOrModels)
  const [orCustomModels, setOrCustomModels] = useState<string[]>([])
  useOpenRouterCustomModelsSync(setOrCustomModels)
  const { view: nineRouterView } = useNineRouterView(active)
  const providers = useMemo(() => {
    const orGroups =
      orModels && orModels.length > 0
        ? buildOpenRouterGroupModels(orModels)
        : null
    const merged = baseProviders.map((p) => {
      if (p.id === "lmstudio") return { ...p, models: lmModels }
      // The dedicated OpenRouter entry mirrors Settings → Custom models.
      if (p.id === "openrouter") {
        return { ...p, models: openRouterCustomUiModels(orCustomModels) }
      }
      const live = orGroups?.get(p.id)
      return live && live.length > 0 ? { ...p, models: live } : p
    })
    const nineRouter = nineRouterUiProviders(nineRouterView)
    if (nineRouter.length === 0) return merged
    const anchor = merged.findIndex((p) => p.id === "openrouter")
    return anchor < 0
      ? [...merged, ...nineRouter]
      : [
          ...merged.slice(0, anchor + 1),
          ...nineRouter,
          ...merged.slice(anchor + 1),
        ]
  }, [baseProviders, lmModels, orModels, orCustomModels, nineRouterView])
  return providers
}
