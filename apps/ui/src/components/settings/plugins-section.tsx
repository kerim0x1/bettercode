import { useEffect, useId, useState } from "react"
import { cn } from "@/lib/utils"
import {
  usePluginStore,
  type InstalledPlugin,
  type PluginConfigField,
} from "@/lib/plugin-store"
import { useAppUiStore } from "@/lib/app-ui-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { BrandMarks } from "@/components/settings/brand-mark"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import {
  FolderOpenIcon,
  Loader2Icon,
  MonitorIcon,
  PlusIcon,
  ShieldAlertIcon,
  StoreIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { PuzzleIcon } from "@hugeicons/core-free-icons"
import { createLogger } from "@/lib/logger"
import { getElectronApi, hasElectronApi } from "@/services/ipc-facade"

const log = createLogger("settings-plugins") // M11

export function SettingsPluginsSection() {
  const loaded = usePluginStore((s) => s.loaded)
  const plugins = usePluginStore((s) => s.plugins)
  const installPlugin = usePluginStore((s) => s.installPlugin)
  const removePlugin = usePluginStore((s) => s.removePlugin)
  const togglePlugin = usePluginStore((s) => s.togglePlugin)
  const updateConfig = usePluginStore((s) => s.updateConfig)
  const confirm = useConfirm()
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    usePluginStore
      .getState()
      .init()
      .catch((e) => {
        log.warn("Failed to initialize plugin store", e)
      })
  }, [])

  // A paired browser has no desktop bridge: plugins live on the computer
  // that runs BetterC0de.
  if (!hasElectronApi()) {
    return (
      <SettingsSection title="Plugins">
        <SettingsRow
          label="Plugins are managed in the desktop app."
          description="Open BetterC0de on the computer it runs on to install or change plugins."
          icon={<MonitorIcon />}
        >
          {null}
        </SettingsRow>
      </SettingsSection>
    )
  }

  const pluginSystemReady = Boolean(getElectronApi()?.pluginList)

  const install = async () => {
    if (installing) return
    setInstalling(true)
    try {
      await installPlugin()
    } finally {
      setInstalling(false)
    }
  }

  const remove = async (plugin: InstalledPlugin) => {
    const ok = await confirm({
      title: `Remove ${plugin.manifest.name}?`,
      description:
        "The plugin and its settings are deleted from this computer. This can't be undone.",
      confirmLabel: "Remove",
      destructive: true,
    })
    if (!ok) return
    await removePlugin(plugin.manifest.id)
  }

  return (
    <>
      <SettingsSection
        title="Plugins"
        description="Plugins can add extra AI providers and models."
      >
        {!pluginSystemReady ? (
          <SettingsRow
            label="Plugins aren't available yet"
            description="Restart BetterC0de to finish enabling plugins."
            icon={<TriangleAlertIcon className="text-warning" />}
          >
            {null}
          </SettingsRow>
        ) : null}
        <SettingsRow
          label="Install a plugin"
          description="Plugins run code on this computer. Only install ones you trust."
          icon={<ShieldAlertIcon />}
        >
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5"
            disabled={!pluginSystemReady || installing}
            onClick={install}
          >
            {installing ? (
              <Loader2Icon
                aria-hidden="true"
                className="size-3.5 motion-safe:animate-spin"
              />
            ) : (
              <FolderOpenIcon aria-hidden="true" className="size-3.5" />
            )}
            Install from folder
          </Button>
        </SettingsRow>
        <SettingsRow
          label="Claude Code & Codex plugins"
          description="Install and manage them in the Marketplace, on its Plugins tab."
          icon={<StoreIcon />}
        >
          <div className="flex shrink-0 items-center gap-3">
            <BrandMarks ids={["claude", "codex"]} />
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => useAppUiStore.getState().setMarketplaceOpen(true)}
            >
              Open Marketplace
            </Button>
          </div>
        </SettingsRow>
      </SettingsSection>

      <section aria-label="Installed plugins" className="space-y-2.5">
        <h4 className="text-[13px] font-semibold text-foreground">
          Installed plugins
        </h4>
        {!loaded ? (
          <div
            role="status"
            className="flex items-center justify-center gap-2 rounded-xl border border-border/50 px-6 py-8 text-sm text-muted-foreground"
          >
            <Loader2Icon
              aria-hidden="true"
              className="size-4 motion-safe:animate-spin"
            />
            Loading plugins…
          </div>
        ) : plugins.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/50 px-6 py-8 text-center">
            <HugeiconsIcon
              icon={PuzzleIcon}
              strokeWidth={2}
              aria-hidden="true"
              className="mx-auto size-8 text-muted-foreground/40"
            />
            <p className="mt-2 text-sm text-muted-foreground">
              No plugins installed
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Plugins can add extra AI providers and models.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 gap-1.5"
              disabled={!pluginSystemReady || installing}
              onClick={install}
            >
              <PlusIcon aria-hidden="true" className="size-3.5" /> Install
              plugin
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {plugins.map((plugin) => (
              <PluginCard
                key={plugin.manifest.id}
                plugin={plugin}
                onToggle={(enabled) =>
                  togglePlugin(plugin.manifest.id, enabled)
                }
                onRemove={() => remove(plugin)}
                onConfig={(key, value) =>
                  updateConfig(plugin.manifest.id, key, value)
                }
              />
            ))}
          </div>
        )}
      </section>
    </>
  )
}

const STATUS_LABEL: Record<InstalledPlugin["status"], string> = {
  active: "Active",
  error: "Error",
  disabled: "Off",
}

function PluginCard({
  plugin,
  onToggle,
  onRemove,
  onConfig,
}: {
  plugin: InstalledPlugin
  onToggle: (enabled: boolean) => Promise<boolean>
  onRemove: () => void
  onConfig: (key: string, value: unknown) => Promise<boolean>
}) {
  const name = plugin.manifest.name
  return (
    <div className="overflow-hidden rounded-xl border border-border/50 bg-card/30">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          {plugin.manifest.icon ? (
            <img src={plugin.manifest.icon} alt="" className="size-5" />
          ) : (
            <HugeiconsIcon
              icon={PuzzleIcon}
              strokeWidth={2}
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
          )}
        </div>
        <div className="min-w-[min(100%,12rem)] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            <span className="text-[11px] text-muted-foreground">
              v{plugin.manifest.version}
            </span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                plugin.status === "active"
                  ? "bg-success/10 text-success"
                  : plugin.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground"
              )}
            >
              {STATUS_LABEL[plugin.status] ?? plugin.status}
            </span>
          </div>
          {plugin.manifest.description ? (
            <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
              {plugin.manifest.description}
            </p>
          ) : null}
          {plugin.manifest.author ? (
            <p className="text-[11px] text-muted-foreground">
              by {plugin.manifest.author}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={plugin.enabled}
            aria-label={`Enable ${name}`}
            onCheckedChange={(value) => void onToggle(value)}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${name}`}
            title={`Remove ${name}`}
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2Icon aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </div>

      {plugin.error && (
        <div
          role="alert"
          className="border-t border-border/30 bg-destructive/5 px-4 py-2 text-xs break-words text-destructive"
        >
          {plugin.error}
        </div>
      )}

      {plugin.enabled && plugin.manifest.config.length > 0 && (
        <div className="space-y-2 border-t border-border/30 px-4 py-3">
          {plugin.manifest.config.map((field) => (
            <PluginConfigRow
              key={field.key}
              pluginName={name}
              field={field}
              value={plugin.config[field.key]}
              onSave={(value) => onConfig(field.key, value)}
            />
          ))}
        </div>
      )}

      {plugin.enabled && plugin.manifest.models.length > 0 && (
        <div className="border-t border-border/30 px-4 py-2">
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">
            Models
          </p>
          <div className="flex flex-wrap gap-1">
            {plugin.manifest.models.map((m) => (
              <span
                key={m.id}
                className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px]"
              >
                {m.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PluginConfigRow({
  pluginName,
  field,
  value,
  onSave,
}: {
  pluginName: string
  field: PluginConfigField
  value: unknown
  onSave: (value: unknown) => Promise<boolean>
}) {
  const id = useId()
  const label = field.label || field.key
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <label
        htmlFor={id}
        className="w-28 shrink-0 text-xs break-words text-muted-foreground"
      >
        {label}
      </label>
      {field.type === "select" ? (
        <Select
          value={configString(value) || field.default || ""}
          onValueChange={(next) => void onSave(next)}
        >
          <SelectTrigger
            id={id}
            size="sm"
            className="min-w-40 flex-1 text-xs"
            aria-label={`${pluginName}: ${label}`}
          >
            <SelectValue placeholder={field.placeholder || "Choose…"} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === "boolean" ? (
        <Switch
          id={id}
          checked={configString(value) === "true"}
          aria-label={`${pluginName}: ${label}`}
          onCheckedChange={(next) => void onSave(String(next))}
        />
      ) : field.type === "secret" ? (
        <PluginSecretInput
          id={id}
          value={value}
          placeholder={field.placeholder || field.default || ""}
          onPatch={(patch) => void onSave(patch)}
        />
      ) : (
        <PluginDraftInput
          id={id}
          numeric={field.type === "number"}
          value={configString(value)}
          placeholder={field.placeholder || field.default || ""}
          onCommit={(next) => onSave(next)}
        />
      )}
    </div>
  )
}

/**
 * A text or number setting edited as a local draft and saved on blur or
 * Enter, so typing is never overwritten by the store while a save is in
 * flight. Escape restores the saved value. A newer stored value replaces
 * the draft while the field is not being edited.
 */
function PluginDraftInput({
  id,
  numeric,
  value,
  placeholder,
  onCommit,
}: {
  id: string
  numeric: boolean
  value: string
  placeholder: string
  onCommit: (value: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!editing && !saving) setDraft(value)
  }, [editing, saving, value])

  const commit = async () => {
    setEditing(false)
    const next = numeric ? draft.trim() : draft
    if (next === value || saving) return
    if (numeric && next !== "" && !Number.isFinite(Number(next))) {
      setDraft(value)
      return
    }
    setSaving(true)
    try {
      const saved = await onCommit(next)
      if (!saved) setDraft(value)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Input
      id={id}
      type={numeric ? "number" : "text"}
      inputMode={numeric ? "decimal" : undefined}
      value={draft}
      placeholder={placeholder}
      aria-busy={saving || undefined}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        setEditing(true)
        setDraft(event.target.value)
      }}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          setDraft(value)
          setEditing(false)
        }
      }}
      className="h-7 min-w-40 flex-1 text-xs"
    />
  )
}

function PluginSecretInput({
  id,
  value,
  placeholder,
  onPatch,
}: {
  id: string
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
    <div className="flex min-w-40 flex-1 items-center gap-1">
      <Input
        id={id}
        type="password"
        defaultValue=""
        autoComplete="off"
        placeholder={configured ? "Stored secret" : placeholder}
        onBlur={(event) => {
          const next = event.target.value
          // An empty field changes nothing; Clear removes a stored secret.
          if (!next) return
          // Never keep a submitted secret in the field.
          event.target.value = ""
          onPatch({ set: next })
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
        className="h-7 flex-1 text-xs"
      />
      {configured ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
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
