import { useState } from "react"
import { RefreshCwIcon } from "lucide-react"
import { SettingsSection, SettingsRow } from "@/components/settings/atoms"
import { Button } from "@/components/ui/button"
import { useProviders } from "@/hooks/use-providers"
import { SETTINGS_UPDATED_EVENT } from "@/lib/settings-store"
import { refreshModels } from "@/services/backend/providersApi"
import {
  providerActivationKeys,
  usePreferencesStore,
} from "@/lib/preferences-store"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"

export function SettingsModelVisibilitySection() {
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const providers = useProviders(undefined, true)
  const prefs = usePreferencesStore()
  const hiddenProviders = new Set(prefs.hiddenProviders)
  const hiddenModels = new Set(prefs.hiddenModels)

  const toggleProvider = (id: string) => {
    const current = prefs.hiddenProviders
    const aliases = providerActivationKeys(id)
    const isHidden = aliases.some((alias) => current.includes(alias))
    const next = isHidden
      ? current.filter((p) => !aliases.includes(p))
      : [...current, id]
    prefs.set("hiddenProviders", next)
  }

  const toggleModel = (id: string) => {
    const current = prefs.hiddenModels
    const next = current.includes(id)
      ? current.filter((m) => m !== id)
      : [...current, id]
    prefs.set("hiddenModels", next)
  }

  const refreshApiModels = async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      await refreshModels()
      window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT))
    } catch {
      setRefreshError("Could not refresh API models. Try again.")
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <>
      <div className="mt-6" />
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          Model Visibility
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => void refreshApiModels()}
        >
          <RefreshCwIcon className="mr-1.5 size-3" />
          {refreshing ? "Refreshing…" : "Refresh API models"}
        </Button>
      </div>
      {refreshError && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {refreshError}
        </p>
      )}
      <p className="mb-3 text-xs text-muted-foreground/60">
        Toggle providers and individual models on/off in the chat model
        selector.
      </p>

      {providers.map((provider) => {
        const isProviderHidden = providerActivationKeys(provider.id).some(
          (id) => hiddenProviders.has(id)
        )
        return (
          <SettingsSection key={provider.id} title={provider.name}>
            <SettingsRow
              label="Show Provider"
              description={`Show ${provider.name} in the model dropdown`}
            >
              <Switch
                checked={!isProviderHidden}
                onCheckedChange={() => toggleProvider(provider.id)}
              />
            </SettingsRow>
            {!isProviderHidden && provider.models.length > 0 && (
              <div className="space-y-1.5 px-4 py-2">
                <p className="mb-1 text-[10px] font-medium text-muted-foreground/50">
                  MODELS
                </p>
                {provider.models.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center justify-between gap-3 py-0.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-xs">
                        {model.name}
                      </span>
                      <span className="shrink-0 text-[9px] text-muted-foreground/40">
                        {model.context}
                      </span>
                      {model.tier && (
                        <Badge
                          variant="outline"
                          className="shrink-0 px-1 py-0 text-[8px]"
                        >
                          {model.tier}
                        </Badge>
                      )}
                    </div>
                    <Switch
                      checked={!hiddenModels.has(model.id)}
                      onCheckedChange={() => toggleModel(model.id)}
                      size="sm"
                    />
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>
        )
      })}
    </>
  )
}
