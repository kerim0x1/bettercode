import { useState } from "react"
import { EyeOffIcon, RefreshCwIcon } from "lucide-react"
import { SettingsDisclosure } from "@/components/settings/atoms"
import { Button } from "@/components/ui/button"
import { useProviders } from "@/hooks/use-providers"
import { SETTINGS_UPDATED_EVENT } from "@/lib/settings-store"
import { refreshModels } from "@/services/backend/providersApi"
import {
  providerActivationKeys,
  usePreferencesStore,
} from "@/lib/preferences-store"
import { Switch } from "@/components/ui/switch"
import { ProviderIcon } from "@/components/provider-icon"
import { cn } from "@/lib/utils"

/**
 * "Model visibility": which providers and models the chat's model picker
 * offers. Each provider is a card that starts closed, with its own switch on
 * the header and its models inside.
 */
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

  const setModels = (ids: readonly string[], shown: boolean) => {
    const current = prefs.hiddenModels
    const next = shown
      ? current.filter((id) => !ids.includes(id))
      : [...new Set([...current, ...ids])]
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
    <section aria-label="Model visibility" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-foreground">
            Model visibility
          </h3>
          <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
            Which providers and models the chat&apos;s model picker offers.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => void refreshApiModels()}
          className="h-8 gap-1.5 rounded-lg px-3 text-[12px]"
        >
          <RefreshCwIcon
            className={cn("size-3.5", refreshing && "motion-safe:animate-spin")}
          />
          {refreshing ? "Refreshing…" : "Refresh API models"}
        </Button>
      </div>
      {refreshError && (
        <p role="alert" className="text-xs text-destructive">
          {refreshError}
        </p>
      )}

      <div className="space-y-2">
        {providers.map((provider) => {
          const isProviderHidden = providerActivationKeys(provider.id).some(
            (id) => hiddenProviders.has(id)
          )
          const modelIds = provider.models.map((model) => model.id)
          const shownCount = provider.models.filter(
            (model) => !hiddenModels.has(model.id)
          ).length
          const summary = isProviderHidden
            ? "Hidden from the model picker"
            : provider.models.length === 0
              ? "No models listed yet"
              : shownCount === provider.models.length
                ? `All ${provider.models.length} models shown`
                : `${shownCount} of ${provider.models.length} models shown`
          return (
            <SettingsDisclosure
              key={provider.id}
              label={provider.name}
              icon={
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-foreground/[0.05]">
                  <ProviderIcon provider={provider} className="!size-[18px]" />
                </span>
              }
              meta={
                isProviderHidden ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <EyeOffIcon className="size-3" />
                    Hidden
                  </span>
                ) : null
              }
              summary={summary}
              actions={
                <Switch
                  aria-label={`Show ${provider.name} in the model picker`}
                  title="Show in the model picker"
                  checked={!isProviderHidden}
                  onCheckedChange={() => toggleProvider(provider.id)}
                />
              }
              bodyClassName="px-4 py-3"
            >
              {isProviderHidden ? (
                <p className="text-[12px] text-muted-foreground">
                  {provider.name} is hidden from the model picker. Turn it on to
                  choose its models.
                </p>
              ) : provider.models.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  No models listed yet. Sign in or add a key, then refresh.
                </p>
              ) : (
                <>
                  <div className="mb-1.5 flex items-center justify-between gap-3">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      Models
                    </span>
                    <span className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={shownCount === provider.models.length}
                        onClick={() => setModels(modelIds, true)}
                        className="h-6 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        Show all
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={shownCount === 0}
                        onClick={() => setModels(modelIds, false)}
                        className="h-6 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        Hide all
                      </Button>
                    </span>
                  </div>
                  <ul className="divide-y divide-border/30">
                    {provider.models.map((model) => {
                      const shown = !hiddenModels.has(model.id)
                      const context =
                        model.context &&
                        model.context.toLowerCase() !==
                          model.tier?.toLowerCase()
                          ? model.context
                          : null
                      return (
                        <li
                          key={model.id}
                          className="flex items-center justify-between gap-3 py-2"
                        >
                          <span
                            className={cn(
                              "flex min-w-0 items-center gap-2 transition-opacity",
                              !shown && "opacity-50"
                            )}
                          >
                            <span className="truncate text-[12.5px]">
                              {model.name}
                            </span>
                            {context ? (
                              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                                {context}
                              </span>
                            ) : null}
                            {model.tier ? (
                              <span className="shrink-0 rounded-md bg-foreground/[0.06] px-1.5 py-px text-[10px] text-muted-foreground">
                                {model.tier}
                              </span>
                            ) : null}
                          </span>
                          <Switch
                            aria-label={`Show ${model.name}`}
                            checked={shown}
                            onCheckedChange={() => toggleModel(model.id)}
                            size="sm"
                          />
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </SettingsDisclosure>
          )
        })}
      </div>
    </section>
  )
}
