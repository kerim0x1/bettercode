import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { usePluginStore } from "@/lib/plugin-store"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Trash2Icon, PlusIcon } from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { PuzzleIcon } from "@hugeicons/core-free-icons"
import { createLogger } from "@/lib/logger"

const log = createLogger("settings-plugins") // M11

export function SettingsPluginsSection() {
  const _loaded = usePluginStore((s) => s.loaded)
  const plugins = usePluginStore((s) => s.plugins)
  const installPlugin = usePluginStore((s) => s.installPlugin)
  const removePlugin = usePluginStore((s) => s.removePlugin)
  const togglePlugin = usePluginStore((s) => s.togglePlugin)
  const updateConfig = usePluginStore((s) => s.updateConfig)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  useEffect(() => {
    usePluginStore
      .getState()
      .init()
      .catch((e) => {
        log.warn("Failed to initialize plugin store", e)
      })
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-muted-foreground">
          Installed Plugins
        </h4>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs"
          onClick={() => installPlugin()}
        >
          <PlusIcon className="size-3" /> Install Plugin
        </Button>
      </div>

      {/* API status hint */}
      {!window.electronAPI?.pluginList && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-500">
          Plugin system not available. Restart the app to activate.
        </div>
      )}
      <p className="text-[11px] text-muted-foreground/70">
        Plugin contract: plugins must be self-contained and include their own
        runtime dependencies.
      </p>

      {plugins.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/50 px-6 py-8 text-center">
          <HugeiconsIcon
            icon={PuzzleIcon}
            strokeWidth={2}
            className="mx-auto size-8 text-muted-foreground/30"
          />
          <p className="mt-2 text-sm text-muted-foreground">
            No plugins installed
          </p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            Install provider plugins to add extra AI models and tools
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3 gap-1.5"
            onClick={() => installPlugin()}
          >
            <PlusIcon className="size-3" /> Install Plugin
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {plugins.map((plugin) => (
            <div
              key={plugin.manifest.id}
              className="overflow-hidden rounded-xl border border-border/50"
            >
              {/* Plugin header */}
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {plugin.manifest.icon ? (
                    <img src={plugin.manifest.icon} alt="" className="size-5" />
                  ) : (
                    <HugeiconsIcon
                      icon={PuzzleIcon}
                      strokeWidth={2}
                      className="size-4 text-muted-foreground"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {plugin.manifest.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      v{plugin.manifest.version}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                        plugin.status === "active"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : plugin.status === "error"
                            ? "bg-red-500/10 text-red-500"
                            : "bg-muted text-muted-foreground"
                      )}
                    >
                      {plugin.status}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {plugin.manifest.description}
                  </p>
                  <p className="text-[10px] text-muted-foreground/50">
                    by {plugin.manifest.author}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={plugin.enabled}
                    onCheckedChange={(v) => togglePlugin(plugin.manifest.id, v)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setConfirmRemove(plugin.manifest.id)}
                  >
                    <Trash2Icon className="size-3.5 text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>
              </div>

              {/* Plugin error */}
              {plugin.error && (
                <div className="border-t border-border/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
                  {plugin.error}
                </div>
              )}

              {/* Plugin config fields */}
              {plugin.enabled && plugin.manifest.config.length > 0 && (
                <div className="space-y-2 border-t border-border/30 px-4 py-3">
                  {plugin.manifest.config.map((field) => (
                    <div key={field.key} className="flex items-center gap-3">
                      <label className="w-28 shrink-0 text-xs text-muted-foreground">
                        {field.label}
                      </label>
                      {field.type === "select" ? (
                        <select
                          value={
                            configString(plugin.config[field.key]) ||
                            field.default ||
                            ""
                          }
                          onChange={(e) =>
                            updateConfig(
                              plugin.manifest.id,
                              field.key,
                              e.target.value
                            )
                          }
                          className="h-7 flex-1 rounded-md border border-border bg-transparent px-2 text-xs"
                        >
                          {field.options?.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      ) : field.type === "boolean" ? (
                        <Switch
                          checked={plugin.config[field.key] === "true"}
                          onCheckedChange={(v) =>
                            updateConfig(
                              plugin.manifest.id,
                              field.key,
                              String(v)
                            )
                          }
                        />
                      ) : field.type === "secret" ? (
                        <PluginSecretInput
                          value={plugin.config[field.key]}
                          placeholder={field.placeholder || field.default || ""}
                          onPatch={(value) =>
                            updateConfig(plugin.manifest.id, field.key, value)
                          }
                        />
                      ) : (
                        <input
                          type="text"
                          value={configString(plugin.config[field.key])}
                          onChange={(e) =>
                            updateConfig(
                              plugin.manifest.id,
                              field.key,
                              e.target.value
                            )
                          }
                          placeholder={field.placeholder || field.default || ""}
                          className="h-7 flex-1 rounded-md border border-border bg-transparent px-2 text-xs outline-none focus:border-primary"
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Models list */}
              {plugin.enabled && plugin.manifest.models.length > 0 && (
                <div className="border-t border-border/30 px-4 py-2">
                  <p className="mb-1 text-[10px] font-medium text-muted-foreground/50">
                    MODELS
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {plugin.manifest.models.map((m) => (
                      <span
                        key={m.id}
                        className="rounded-md bg-muted px-2 py-0.5 font-mono text-[10px]"
                      >
                        {m.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Remove confirm — inline instead of nested Dialog */}
      {confirmRemove && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="max-w-sm space-y-3 rounded-xl border border-border bg-card p-5 shadow-xl">
            <h3 className="text-sm font-semibold">Remove Plugin?</h3>
            <p className="text-xs text-muted-foreground">
              This plugin and its configuration will be permanently deleted.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmRemove(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  removePlugin(confirmRemove)
                  setConfirmRemove(null)
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PluginSecretInput({
  value,
  placeholder,
  onPatch,
}: {
  value: unknown
  placeholder: string
  onPatch: (patch: { set: string } | { clear: true }) => void
}) {
  const configured =
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { configured?: unknown }).configured === true
  return (
    <div className="flex flex-1 items-center gap-1">
      <input
        type="password"
        defaultValue=""
        placeholder={configured ? "Stored secret" : placeholder}
        onBlur={(event) => {
          const next = event.target.value
          if (!next && configured) return
          onPatch(next ? { set: next } : { clear: true })
        }}
        className="h-7 flex-1 rounded-md border border-border bg-transparent px-2 text-xs outline-none focus:border-primary"
      />
      {configured ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[10px]"
          onClick={() => onPatch({ clear: true })}
        >
          Clear
        </Button>
      ) : null}
    </div>
  )
}

function configString(value: unknown): string {
  return typeof value === "string" ? value : ""
}
