import React, { useMemo, useState } from "react"
import { CheckIcon, Loader2Icon, PlusIcon, SearchIcon } from "lucide-react"
import { ProviderIcon } from "@/components/provider-icon"
import {
  SimpleDropdownLabel,
  SimpleDropdownSubItem,
} from "@/components/ui/simple-dropdown"
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import type { UiProvider, UiProviderModel } from "@/lib/provider-types"
import {
  filterPickerModels,
  groupPickerModels,
  pickerCustomModelCandidate,
  pickerShowsModelSearch,
} from "@/lib/model-picker-search"
import { addNineRouterCustomModel } from "@/lib/ninerouter-providers"
import { handleError } from "@/lib/errors"

/**
 * Model rows for one provider in the composer's model menu. 9Router lists get
 * a filter box, are grouped by account, and accept any model id the router
 * can route ("Use … as model" adds it to the connection). Other providers
 * render their flat list unchanged.
 */
export function ModelSearchSubmenu({
  provider,
  models,
  selectedProviderId,
  selectedModel,
  onSelect,
}: {
  provider: UiProvider
  models: readonly UiProviderModel[]
  selectedProviderId: string
  selectedModel: string
  onSelect: (modelId: string) => void
}) {
  const [query, setQuery] = useState("")
  const [adding, setAdding] = useState(false)
  const searchable = pickerShowsModelSearch(provider)
  const groups = useMemo(
    () => groupPickerModels(provider, filterPickerModels(models, query)),
    [provider, models, query]
  )
  const custom = pickerCustomModelCandidate(provider, query)
  const empty = groups.every((group) => group.models.length === 0)

  const addCustom = async (id: string) => {
    if (!provider.providerInstanceId) return
    setAdding(true)
    try {
      await addNineRouterCustomModel(provider.providerInstanceId, id)
      onSelect(id)
    } catch (error) {
      handleError(error, { source: "ninerouter-custom-model" })
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      {searchable && (
        <div className="sticky top-0 z-10 bg-popover/95 p-1 backdrop-blur-sm">
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              aria-label={`Search ${provider.name} models`}
              autoFocus
              value={query}
              placeholder="Search or type a model ID"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && custom && empty) {
                  event.preventDefault()
                  void addCustom(custom)
                }
              }}
              className="h-7 w-full rounded-md border border-border/60 bg-background pr-2 pl-6 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
            />
          </div>
        </div>
      )}
      {groups.map((group) =>
        group.models.length === 0 ? null : (
          <div key={group.label ?? "models"}>
            {group.label && (
              <SimpleDropdownLabel>{group.label}</SimpleDropdownLabel>
            )}
            {group.models.map((model) => {
              const isSelected =
                selectedProviderId === provider.id && selectedModel === model.id
              return (
                <SimpleDropdownSubItem
                  key={model.id}
                  onClick={() => onSelect(model.id)}
                  active={isSelected}
                >
                  <ProviderIcon
                    provider={provider}
                    className="!size-3.5 shrink-0"
                  />
                  <span className="flex-1 truncate text-left">
                    {model.name}
                  </span>
                  {group.label &&
                    model.context &&
                    model.context !== "runtime" && (
                      <span className="text-[10px] text-muted-foreground">
                        {model.context}
                      </span>
                    )}
                  {isSelected && (
                    <CheckIcon className="size-3 shrink-0 text-primary" />
                  )}
                </SimpleDropdownSubItem>
              )
            })}
          </div>
        )
      )}
      {empty && !custom && (
        <SimpleDropdownSubItem className="pointer-events-none opacity-60">
          <span className="flex-1 text-xs text-muted-foreground">
            {query.trim() ? "No model matches" : "No models available"}
          </span>
        </SimpleDropdownSubItem>
      )}
      {custom && (
        <SimpleDropdownSubItem
          keepOpen={adding}
          disabled={adding}
          onClick={() => void addCustom(custom)}
        >
          {adding ? (
            <Loader2Icon className="size-3.5 shrink-0 motion-safe:animate-spin" />
          ) : (
            <PlusIcon className="size-3.5 shrink-0" />
          )}
          <span className="flex-1 truncate text-left">
            Use “{custom}” as model
          </span>
        </SimpleDropdownSubItem>
      )}
    </>
  )
}

/**
 * Radix-menu variant for the full model picker: same filter, grouping and
 * custom-id action, with the caller rendering each model row. Keys typed in
 * the filter stay out of the menu's typeahead.
 */
export function ModelSearchMenuList<T extends UiProviderModel>({
  provider,
  models,
  onSelect,
  renderModel,
}: {
  provider: UiProvider
  models: readonly T[]
  onSelect: (modelId: string) => void
  renderModel: (model: T) => React.ReactNode
}) {
  const [query, setQuery] = useState("")
  const [adding, setAdding] = useState(false)
  const groups = useMemo(
    () => groupPickerModels(provider, filterPickerModels(models, query)),
    [provider, models, query]
  )
  if (!pickerShowsModelSearch(provider)) return <>{models.map(renderModel)}</>
  const custom = pickerCustomModelCandidate(provider, query)
  const empty = groups.every((group) => group.models.length === 0)
  const addCustom = async (id: string) => {
    if (!provider.providerInstanceId) return
    setAdding(true)
    try {
      await addNineRouterCustomModel(provider.providerInstanceId, id)
      onSelect(id)
    } catch (error) {
      handleError(error, { source: "ninerouter-custom-model" })
    } finally {
      setAdding(false)
    }
  }
  return (
    <>
      <div className="relative p-1">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          aria-label={`Search ${provider.name} models`}
          value={query}
          placeholder="Search or type a model ID"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") return
            event.stopPropagation()
            if (event.key === "Enter" && custom && empty) {
              event.preventDefault()
              void addCustom(custom)
            }
          }}
          className="h-8 w-full rounded-md border border-border/60 bg-background pr-2 pl-7 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
        />
      </div>
      {groups.map((group) =>
        group.models.length === 0 ? null : (
          <DropdownMenuGroup key={group.label ?? "models"}>
            {group.label && (
              <DropdownMenuLabel className="text-[9px] font-medium tracking-wider text-muted-foreground uppercase">
                {group.label}
              </DropdownMenuLabel>
            )}
            {group.models.map(renderModel)}
          </DropdownMenuGroup>
        )
      )}
      {empty && !custom && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {query.trim() ? "No model matches" : "No models available"}
        </p>
      )}
      {custom && (
        <DropdownMenuItem
          disabled={adding}
          onSelect={(event) => {
            event.preventDefault()
            void addCustom(custom)
          }}
          className="gap-2"
        >
          {adding ? (
            <Loader2Icon className="size-3.5 motion-safe:animate-spin" />
          ) : (
            <PlusIcon className="size-3.5" />
          )}
          <span className="flex-1 truncate">Use “{custom}” as model</span>
        </DropdownMenuItem>
      )}
    </>
  )
}
