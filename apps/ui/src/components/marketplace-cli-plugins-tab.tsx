import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useCliPlugins } from "@/hooks/use-cli-plugins"
import {
  ConfirmActionDialog,
  type ConfirmActionRequest,
} from "@/components/confirm-action-dialog"
import type { CliPlugin, CliPluginSourceInventory } from "@betterc0de/schema"
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  DownloadIcon,
  FolderOpenIcon,
  Loader2Icon,
  PackageIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  SlashSquareIcon,
  SparklesIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react"

function openInstallPath(p: string) {
  window.electronAPI?.openPath?.(p)
}

function isUserCancelled(error: string | undefined): boolean {
  return Boolean(error && error.toLowerCase().includes("cancelled"))
}

function componentCount(plugin: CliPlugin): number {
  const c = plugin.components
  return (
    c.skills.length +
    c.agents.length +
    c.commands.length +
    c.mcpServers.length +
    c.hooks.length
  )
}

function PluginRow({
  plugin,
  selected,
  busy,
  onSelect,
  onToggle,
}: {
  plugin: CliPlugin
  selected: boolean
  busy: boolean
  onSelect: () => void
  onToggle: (enabled: boolean) => void
}) {
  const displayName = plugin.interface?.displayName || plugin.name
  return (
    <div
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
        selected
          ? "border-primary/50 bg-accent/60"
          : "border-border/40 hover:bg-accent/30"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <PackageIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{displayName}</span>
            <span className="text-xs text-muted-foreground">
              {plugin.version === "unknown" ? "—" : plugin.version}
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {plugin.interface?.shortDescription ||
              plugin.description ||
              plugin.id}
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {plugin.marketplace || "local"}
        </Badge>
        {plugin.scope === "project" && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            project
          </Badge>
        )}
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {busy ? (
        <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Switch
          checked={plugin.enabled}
          onCheckedChange={onToggle}
          aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${displayName}`}
        />
      )}
    </div>
  )
}

function ComponentSection({
  title,
  icon,
  items,
}: {
  title: string
  icon: React.ReactNode
  items: ReadonlyArray<{ name: string; description?: string }>
}) {
  if (items.length === 0) return null
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {title} ({items.length})
      </div>
      <div className="space-y-1">
        {items.map((item) => (
          <div
            key={item.name}
            className="rounded-md border border-border/30 px-2 py-1.5"
          >
            <div className="text-xs font-medium">{item.name}</div>
            {item.description && (
              <div className="line-clamp-2 text-[11px] text-muted-foreground">
                {item.description}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function PluginDetail({
  plugin,
  busy,
  onUninstall,
}: {
  plugin: CliPlugin
  busy: boolean
  onUninstall: () => void
}) {
  const c = plugin.components
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">
            {plugin.interface?.displayName || plugin.name}
          </span>
          <Badge variant="outline" className="text-[10px]">
            {plugin.source === "claude" ? "Claude Code" : "Codex"}
          </Badge>
          <Badge
            variant={plugin.enabled ? "default" : "secondary"}
            className="text-[10px]"
          >
            {plugin.enabled ? "enabled" : "disabled"}
          </Badge>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {plugin.description ||
            plugin.interface?.shortDescription ||
            plugin.id}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          Version: {plugin.version === "unknown" ? "—" : plugin.version}
        </span>
        <span>Marketplace: {plugin.marketplace || "local"}</span>
        <span>Scope: {plugin.scope}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {plugin.installPath && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => openInstallPath(plugin.installPath)}
          >
            <FolderOpenIcon className="size-3" /> Open Folder
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-destructive"
          disabled={busy}
          onClick={onUninstall}
        >
          {busy ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <Trash2Icon className="size-3" />
          )}
          Uninstall
        </Button>
      </div>
      {componentCount(plugin) === 0 ? (
        <div className="text-xs text-muted-foreground">
          No components detected in the plugin directory.
        </div>
      ) : (
        <>
          <ComponentSection
            title="Skills"
            icon={<SparklesIcon className="size-3" />}
            items={c.skills}
          />
          <ComponentSection
            title="Agents"
            icon={<UsersIcon className="size-3" />}
            items={c.agents}
          />
          <ComponentSection
            title="Commands"
            icon={<SlashSquareIcon className="size-3" />}
            items={c.commands}
          />
          <ComponentSection
            title="MCP Servers"
            icon={<ServerIcon className="size-3" />}
            items={c.mcpServers.map((server) => ({
              name: server.name,
              description: server.url || server.command,
            }))}
          />
          <ComponentSection
            title="Hooks"
            icon={<PackageIcon className="size-3" />}
            items={c.hooks.map((name) => ({ name }))}
          />
        </>
      )}
    </div>
  )
}

function filterPlugins(plugins: ReadonlyArray<CliPlugin>, search: string) {
  const query = search.trim().toLowerCase()
  if (!query) return plugins
  return plugins.filter((plugin) =>
    [
      plugin.name,
      plugin.id,
      plugin.description ?? "",
      plugin.interface?.displayName ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(query)
  )
}

function SourceSection({
  label,
  inventory,
  search,
  selectedId,
  mutating,
  onSelect,
  onToggle,
}: {
  label: string
  inventory: CliPluginSourceInventory
  search: string
  selectedId: string | null
  mutating: string | null
  onSelect: (plugin: CliPlugin) => void
  onToggle: (plugin: CliPlugin, enabled: boolean) => void
}) {
  const filtered = useMemo(
    () => filterPlugins(inventory.plugins, search),
    [inventory.plugins, search]
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        {label}
        <span className="font-normal">({inventory.plugins.length})</span>
      </div>
      {inventory.error && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
          <span>{inventory.error}</span>
        </div>
      )}
      {!inventory.cliDetected && !inventory.error ? (
        <div className="text-xs text-muted-foreground">CLI not detected.</div>
      ) : filtered.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          {inventory.plugins.length === 0
            ? "No plugins installed."
            : "No plugins match the search."}
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((plugin) => {
            const key = `${plugin.source}:${plugin.id}`
            return (
              <PluginRow
                key={key}
                plugin={plugin}
                selected={selectedId === key}
                busy={mutating === key}
                onSelect={() => onSelect(plugin)}
                onToggle={(enabled) => onToggle(plugin, enabled)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function AvailableSection({
  plugins,
  search,
  mutating,
  onInstall,
}: {
  plugins: ReadonlyArray<CliPlugin>
  search: string
  mutating: string | null
  onInstall: (plugin: CliPlugin) => void
}) {
  const filtered = useMemo(
    () => filterPlugins(plugins, search),
    [plugins, search]
  )
  if (filtered.length === 0) return null
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-muted-foreground">
        Available ({filtered.length})
      </div>
      <div className="space-y-1.5">
        {filtered.map((plugin) => {
          const key = `${plugin.source}:${plugin.id}`
          return (
            <div
              key={key}
              className="flex items-center gap-3 rounded-lg border border-border/40 px-3 py-2"
            >
              <PackageIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {plugin.name}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {plugin.source === "claude" ? "Claude Code" : "Codex"}
                  </Badge>
                  {plugin.interface?.category && (
                    <Badge variant="outline" className="text-[10px]">
                      {plugin.interface.category}
                    </Badge>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {plugin.description || plugin.marketplace}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={mutating === key}
                onClick={() => onInstall(plugin)}
              >
                {mutating === key ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <DownloadIcon className="size-3" />
                )}
                Install
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Marketplace tab listing plugins installed in the user's Claude Code and
 * Codex CLIs, with enable/disable toggles and install/uninstall handled
 * through the respective CLI (the CLIs stay the source of truth).
 */
export function MarketplaceCliPluginsTab({
  isSimple = false,
}: {
  isSimple?: boolean
}) {
  const {
    inventory,
    available,
    loading,
    availableLoading,
    error,
    mutating,
    refresh,
    loadAvailable,
    mutate,
  } = useCliPlugins()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<CliPlugin | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showAvailable, setShowAvailable] = useState(false)
  const [confirmRequest, setConfirmRequest] =
    useState<ConfirmActionRequest | null>(null)

  const selectedId = selected ? `${selected.source}:${selected.id}` : null
  const selectedLive = useMemo(() => {
    if (!selected || !inventory) return selected
    const pool =
      selected.source === "claude"
        ? inventory.claude.plugins
        : inventory.codex.plugins
    return pool.find((plugin) => plugin.id === selected.id) ?? null
  }, [selected, inventory])

  const runMutation = async (
    mutation: "toggle" | "install" | "uninstall",
    plugin: CliPlugin,
    enabled?: boolean
  ) => {
    setActionError(null)
    const result = await mutate(mutation, plugin.source, plugin.id, enabled)
    if (!result.ok && !isUserCancelled(result.error)) {
      setActionError(result.error || "Operation failed")
    }
    if (result.ok && mutation === "uninstall") setSelected(null)
  }

  // In-app confirmation (replaces the previous native OS dialog).
  const confirmMutation = (
    mutation: "toggle" | "install" | "uninstall",
    plugin: CliPlugin,
    enabled?: boolean
  ) => {
    const cliLabel = plugin.source === "claude" ? "Claude Code" : "Codex"
    const displayName = plugin.interface?.displayName || plugin.name
    if (mutation === "toggle") {
      const next = enabled === true
      setConfirmRequest({
        title: `${next ? "Enable" : "Disable"} "${displayName}"?`,
        description:
          plugin.source === "claude"
            ? `Runs \`claude plugin ${next ? "enable" : "disable"} ${plugin.id}\`. The change applies to every ${cliLabel} session on this machine.`
            : `Updates the enabled flag for [plugins."${plugin.id}"] in ~/.codex/config.toml (a .bak copy is kept). The change applies to every ${cliLabel} session on this machine.`,
        confirmLabel: next ? "Enable" : "Disable",
        onConfirm: () => void runMutation("toggle", plugin, next),
      })
      return
    }
    if (mutation === "install") {
      setConfirmRequest({
        title: `Install "${displayName}"?`,
        description:
          `Runs \`${plugin.source} plugin ${plugin.source === "claude" ? "install" : "add"} ${plugin.id}\`.\n\n` +
          `Plugins can add skills, commands, and MCP servers that influence every future ${cliLabel} session. Only install plugins you trust.`,
        confirmLabel: "Install",
        onConfirm: () => void runMutation("install", plugin),
      })
      return
    }
    setConfirmRequest({
      title: `Uninstall "${displayName}"?`,
      description: `Runs \`${plugin.source} plugin ${plugin.source === "claude" ? "uninstall" : "remove"} ${plugin.id}\`.`,
      confirmLabel: "Uninstall",
      destructive: true,
      onConfirm: () => void runMutation("uninstall", plugin),
    })
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search CLI plugins…"
              className="h-8 pl-8 text-sm"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={availableLoading}
            onClick={() => {
              setShowAvailable(true)
              void loadAvailable()
            }}
          >
            {availableLoading ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <DownloadIcon className="size-3" />
            )}
            Browse Available
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={loading}
            onClick={() => void refresh(true)}
          >
            {loading ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
            Refresh
          </Button>
        </div>
        {(error || actionError) && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{actionError || error}</span>
          </div>
        )}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {loading && !inventory ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" /> Scanning CLI
              plugins…
            </div>
          ) : inventory ? (
            <>
              <SourceSection
                label="Claude Code"
                inventory={inventory.claude}
                search={search}
                selectedId={selectedId}
                mutating={mutating}
                onSelect={setSelected}
                onToggle={(plugin, enabled) =>
                  confirmMutation("toggle", plugin, enabled)
                }
              />
              <SourceSection
                label="Codex"
                inventory={inventory.codex}
                search={search}
                selectedId={selectedId}
                mutating={mutating}
                onSelect={setSelected}
                onToggle={(plugin, enabled) =>
                  confirmMutation("toggle", plugin, enabled)
                }
              />
              {showAvailable && available && (
                <AvailableSection
                  plugins={[...available.claude, ...available.codex]}
                  search={search}
                  mutating={mutating}
                  onInstall={(plugin) => confirmMutation("install", plugin)}
                />
              )}
            </>
          ) : null}
        </div>
      </div>
      {!isSimple && (
        <div className="w-80 shrink-0 rounded-lg border border-border/40">
          {selectedLive ? (
            <PluginDetail
              plugin={selectedLive}
              busy={mutating === selectedId}
              onUninstall={() => confirmMutation("uninstall", selectedLive)}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
              Select a plugin to inspect its skills, agents, commands, and MCP
              servers.
            </div>
          )}
        </div>
      )}
      <ConfirmActionDialog
        request={confirmRequest}
        onClose={() => setConfirmRequest(null)}
      />
    </div>
  )
}
