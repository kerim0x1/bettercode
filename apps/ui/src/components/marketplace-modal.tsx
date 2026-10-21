import { useState, useEffect, useCallback } from "react"
import { cn } from "@/lib/utils"
import { assetUrl } from "@/lib/asset-url"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import {
  MARKETPLACE_CATALOG,
  type MarketplaceItem,
} from "@/lib/marketplace-data"
import { MarketplaceCliPluginsTab } from "@/components/marketplace-cli-plugins-tab"
import {
  ConfirmActionDialog,
  type ConfirmActionRequest,
} from "@/components/confirm-action-dialog"
import { generateSkillContent } from "@/services/backend/chatApi"
import { useAppearanceStore } from "@/lib/appearance-store"
import { usePluginStore } from "@/lib/plugin-store"
import {
  SearchIcon,
  CheckIcon,
  DownloadIcon,
  ChevronRightIcon,
  PlusIcon,
  Trash2Icon,
  ServerIcon,
  SparklesIcon,
  LinkIcon,
  FileTextIcon,
  WandIcon,
  Loader2Icon,
  BrainIcon,
  ChevronDownIcon,
  PlugIcon,
  FolderOpenIcon,
  TerminalIcon,
} from "lucide-react"

const api = () => window.electronAPI

function openInstallPath(p: string) {
  const e = window.electronAPI
  if (e?.openPath) {
    e.openPath(p)
  } else if (e?.openExternal) {
    // Fallback: resolve ~ to actual path and use file:// protocol
    const resolved = p.startsWith("~")
      ? p.replace("~", window.__BETTERC0DE__?.homePath || "C:\\Users")
      : p
    e.openExternal(`file://${resolved.replace(/\\/g, "/")}`)
  }
}

// ── Shared Icon ──

// Icons that are dark/black and need inversion in dark mode
const DARK_ICONS = ["vercel", "github", "notion", "linear", "openrouter"]

function ItemIcon({
  icon,
  category,
  id,
}: {
  icon?: string
  category: string
  id?: string
}) {
  const [failed, setFailed] = useState(false)
  if (icon && !failed) {
    const needsInvert = DARK_ICONS.some(
      (name) => icon.includes(name) || id?.includes(name)
    )
    return (
      <img
        src={icon}
        alt=""
        className={cn("size-5 shrink-0 rounded", needsInvert && "dark:invert")}
        onError={() => setFailed(true)}
      />
    )
  }
  const cls = "size-5 shrink-0 text-muted-foreground"
  if (category === "mcp") return <ServerIcon className={cls} />
  if (category === "provider") return <PlugIcon className={cls} />
  if (category === "skill") return <SparklesIcon className={cls} />
  return <DownloadIcon className={cls} />
}

// ── Browse Tab ──

/** Map a skills.sh registry entry onto the MarketplaceItem shape. */
function registryEntryToItem(entry: {
  id: string
  skillId: string
  name: string
  source: string
  installs: number
}): MarketplaceItem {
  const installsLabel =
    entry.installs >= 1_000_000
      ? `${(entry.installs / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`
      : entry.installs >= 1_000
        ? `${Math.round(entry.installs / 1_000)}K installs`
        : entry.installs > 0
          ? `${entry.installs} installs`
          : ""
  return {
    id: `sksh:${entry.id}`,
    name: entry.name,
    description: installsLabel
      ? `${entry.source} · ${installsLabel}`
      : entry.source,
    category: "skill",
    source: entry.source,
    skillName: entry.skillId,
    installs: entry.installs,
  }
}

function BrowseTab({ isSimple = false }: { isSimple?: boolean }) {
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [installedCommands, setInstalledCommands] = useState<Set<string>>(
    new Set()
  )
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set())
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState("")
  const [tab, setTab] = useState<"all" | "provider" | "mcp" | "skill">("all")
  const [preview, setPreview] = useState<MarketplaceItem | null>(null)
  // Live skills.sh registry: popular list auto-loaded on mount, remote
  // fuzzy search (whole registry) once the query has >= 2 characters.
  const [registryItems, setRegistryItems] = useState<MarketplaceItem[]>([])
  const [registryLoading, setRegistryLoading] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const registryApiMissing = !api()?.skillsShSearch

  useEffect(() => {
    let alive = true
    const fetcher = api()?.skillsShSearch
    if (!fetcher) return
    setRegistryLoading(true)
    const timer = window.setTimeout(
      async () => {
        try {
          const res = await fetcher(
            search.trim().length >= 2 ? search.trim() : undefined
          )
          if (!alive) return
          if (res?.ok && res.skills) {
            setRegistryItems(res.skills.map(registryEntryToItem))
            setRegistryError(null)
          } else {
            setRegistryItems([])
            setRegistryError(res?.error || "skills.sh registry is unreachable")
          }
        } catch (err) {
          if (!alive) return
          setRegistryItems([])
          setRegistryError(err instanceof Error ? err.message : String(err))
        } finally {
          if (alive) setRegistryLoading(false)
        }
      },
      search.trim().length >= 2 ? 300 : 0
    )
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [search])

  // Load installed skills, mcps AND plugins from disk
  useEffect(() => {
    const loadInstalled = async () => {
      const ids = new Set<string>()
      const commands = new Set<string>()
      const names = new Set<string>()
      try {
        const skills = await api()?.skillList?.()
        if (Array.isArray(skills))
          (skills as { id: string; name?: string }[]).forEach((s) => {
            ids.add(s.id)
            if (s.name) names.add(s.name.toLowerCase())
          })
      } catch {
        /* Expected: skill API may not be available yet */
      }
      try {
        const mcps = await api()?.mcpList?.()
        if (Array.isArray(mcps))
          (mcps as { id: string; command?: string; name?: string }[]).forEach(
            (m) => {
              ids.add(m.id)
              if (m.command) commands.add(m.command)
              if (m.name) names.add(m.name.toLowerCase())
            }
          )
      } catch {
        /* Expected: MCP API may not be available yet */
      }
      try {
        const plugins = await api()?.pluginList?.()
        if (Array.isArray(plugins))
          (plugins as { manifest: { id: string; name?: string } }[]).forEach(
            (p) => {
              ids.add(p.manifest.id)
              if (p.manifest.name) names.add(p.manifest.name.toLowerCase())
            }
          )
      } catch {
        /* Expected: plugin API may not be available yet */
      }
      // Also check plugin store for providers loaded in-memory
      try {
        const storePlugins = usePluginStore.getState().plugins
        if (Array.isArray(storePlugins))
          storePlugins.forEach((p) => {
            ids.add(p.manifest.id)
            if (p.manifest.name) names.add(p.manifest.name.toLowerCase())
          })
      } catch {
        /* Expected: store may not be initialized */
      }
      setInstalled(ids)
      setInstalledCommands(commands)
      setInstalledNames(names)
    }
    loadInstalled()
  }, [])

  /** Check if a marketplace item is installed (by id, command, or name) */
  const isItemInstalled = useCallback(
    (item: MarketplaceItem): boolean => {
      if (installed.has(item.id)) return true
      if (
        item.category === "mcp" &&
        item.command &&
        installedCommands.has(item.command)
      )
        return true
      if (
        item.category === "skill" &&
        installedNames.has(item.name.toLowerCase())
      )
        return true
      return false
    },
    [installed, installedCommands, installedNames]
  )

  const [confirmRequest, setConfirmRequest] =
    useState<ConfirmActionRequest | null>(null)

  const handleInstall = useCallback(async (item: MarketplaceItem) => {
    setInstalling((p) => {
      const n = new Set(p)
      n.add(item.id)
      return n
    })
    try {
      if (item.category === "mcp") {
        // MCP: save as server config in mcp-servers.json
        const envObj: Record<string, string> = {}
        if (item.env)
          item.env.forEach((k) => {
            envObj[k] = ""
          })
        await api()?.mcpInstall?.({
          id: item.id,
          name: item.name,
          command: item.command || "npx",
          args: item.args || [],
          env: envObj,
        })
      } else if (item.category === "skill") {
        // Skill: real install from the skills.sh registry (fetches the
        // actual SKILL.md files into ~/.claude/skills + ~/.codex/skills).
        // Replaces the old stub that only synthesized name+description.
        if (!item.source) throw new Error("Skill has no skills.sh source repo")
        const res = await api()?.skillsShAdd?.(item.source, item.skillName)
        if (!res?.ok) {
          throw new Error(res?.error || "skills.sh installation failed")
        }
      } else {
        const res = await api()?.pluginInstallDefault?.(item.id)
        if (!res?.ok) {
          console.error("Plugin install failed:", res?.error)
          throw new Error(res?.error || "Plugin installation failed")
        }
        // Refresh plugin store so it appears in dropdown immediately
        await usePluginStore.getState().refresh()
      }
      setInstalled((p) => {
        const n = new Set(p)
        n.add(item.id)
        return n
      })
    } catch (e) {
      console.error("Install failed:", e)
    } finally {
      setInstalling((p) => {
        const n = new Set(p)
        n.delete(item.id)
        return n
      })
    }
  }, [])

  // Skill installs execute `npx skills add` (downloads + runs remote
  // code), so they get an in-app confirmation first; MCP/provider installs
  // only write local config and stay one-click.
  const requestInstall = useCallback(
    (item: MarketplaceItem) => {
      if (item.category !== "skill") {
        void handleInstall(item)
        return
      }
      setConfirmRequest({
        title: `Install ${item.skillName ? `skill "${item.skillName}"` : "skills"} from ${item.source}?`,
        description:
          `Runs \`npx skills add ${item.source}\`, which downloads and executes the skills CLI and copies skill files from that repository into ~/.claude/skills and ~/.codex/skills.\n\n` +
          "Skills influence every future chat turn of those CLIs. Only install from sources you trust.",
        confirmLabel: "Install",
        onConfirm: () => void handleInstall(item),
      })
    },
    [handleInstall]
  )

  const handleUninstall = useCallback(async (id: string) => {
    // Find the item to determine category
    const item = MARKETPLACE_CATALOG.find((i) => i.id === id)
    try {
      if (item?.category === "mcp") {
        await api()?.mcpRemove?.(id)
      } else if (item?.category === "provider") {
        await api()?.pluginRemove?.(id)
        await usePluginStore.getState().refresh()
      } else {
        await api()?.skillDelete?.(id)
      }
      setInstalled((p) => {
        const n = new Set(p)
        n.delete(id)
        return n
      })
    } catch (e) {
      console.error("Uninstall failed:", e)
    }
  }, [])

  // Curated catalog entries pass the local text filter; live registry
  // results already matched the query remotely (fuzzy), so they render in
  // their own "Discover skills" section below. Registry entries that
  // duplicate a curated skill (same source + skillName) are dropped.
  const filtered = MARKETPLACE_CATALOG.filter((item) => {
    if (tab !== "all" && item.category !== tab) return false
    if (
      search &&
      !item.name.toLowerCase().includes(search.toLowerCase()) &&
      !item.description.toLowerCase().includes(search.toLowerCase())
    )
      return false
    return true
  })
  const curatedSkillKeys = new Set(
    MARKETPLACE_CATALOG.filter(
      (item) => item.category === "skill" && item.source
    ).map((item) => `${item.source}#${item.skillName ?? ""}`)
  )
  const showRegistry = tab === "all" || tab === "skill"
  const registryFiltered = showRegistry
    ? registryItems.filter(
        (item) =>
          !curatedSkillKeys.has(`${item.source}#${item.skillName ?? ""}`)
      )
    : []

  // skills.sh installs land in the CLIs' global skill dirs (both agents).
  const PATHS = {
    skill: "~/.claude/skills · ~/.codex/skills",
    mcp: "~/.betterc0de",
    provider: "~/.betterc0de/plugins",
  }
  const categoryIcon = (c: string) =>
    c === "provider" ? (
      <PlugIcon className="size-3.5" />
    ) : c === "mcp" ? (
      <ServerIcon className="size-3.5" />
    ) : (
      <SparklesIcon className="size-3.5" />
    )
  const categoryLabel = (c: string) =>
    c === "provider" ? "Provider" : c === "mcp" ? "MCP Server" : "Skill"

  // Skill preview panel
  if (preview) {
    const isInst = isItemInstalled(preview)
    const basePath = PATHS[preview.category] || PATHS.skill
    const previewPath =
      preview.category === "mcp" ? basePath : `${basePath}/${preview.id}`
    return (
      <div className="flex h-full flex-col">
        {/* Back bar */}
        <button
          type="button"
          onClick={() => setPreview(null)}
          className={cn(
            "flex shrink-0 items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
            isSimple ? "mb-2" : "mb-4"
          )}
        >
          <ChevronRightIcon className="size-4 rotate-180" /> Back to Marketplace
        </button>

        {/* Header */}
        <div
          className={cn(
            "flex shrink-0 items-start",
            isSimple ? "mb-3 gap-2" : "mb-5 gap-4"
          )}
        >
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-muted/50">
            <ItemIcon
              icon={preview.icon}
              category={preview.category}
              id={preview.id}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold">{preview.name}</h2>
              {isInst && (
                <Badge
                  className="gap-1 border-emerald-500/20 bg-emerald-500/15 text-[10px] text-emerald-600 dark:text-emerald-400"
                  variant="outline"
                >
                  <CheckIcon className="size-3" /> Installed
                </Badge>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Badge className="gap-1 text-[10px]" variant="outline">
                {categoryIcon(preview.category)}{" "}
                {categoryLabel(preview.category)}
              </Badge>
              {preview.source && (
                <span className="text-[11px] text-muted-foreground/50">
                  {preview.source}
                </span>
              )}
              {preview.installs && (
                <span className="text-[11px] text-muted-foreground/50">
                  {preview.installs >= 1000
                    ? `${Math.round(preview.installs / 1000)}K`
                    : preview.installs}{" "}
                  installs
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {isInst ? (
              <>
                <Badge
                  className="h-8 gap-1 border-emerald-500/20 bg-emerald-500/15 px-3 text-[10px] text-emerald-600 dark:text-emerald-400"
                  variant="outline"
                >
                  <CheckIcon className="size-3" /> Installed
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => requestInstall(preview)}
                  disabled={installing.has(preview.id)}
                >
                  {installing.has(preview.id) ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <DownloadIcon className="size-3.5" />
                  )}
                  Reinstall
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => openInstallPath(previewPath)}
                >
                  <FolderOpenIcon className="size-3.5" /> Open Folder
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    handleUninstall(preview.id)
                    setPreview(null)
                  }}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={installing.has(preview.id)}
                onClick={() => requestInstall(preview)}
              >
                {installing.has(preview.id) ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <DownloadIcon className="size-3.5" />
                )}
                {installing.has(preview.id) ? "Installing..." : "Install"}
              </Button>
            )}
          </div>
        </div>

        {/* Content */}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/40 bg-muted/10",
            isSimple ? "p-3" : "p-5"
          )}
        >
          <p
            className={cn(
              "text-sm leading-relaxed text-muted-foreground",
              isSimple ? "mb-2" : "mb-4"
            )}
          >
            {preview.description}
          </p>

          {/* MCP connection info */}
          {preview.category === "mcp" && preview.command && (
            <div
              className={cn(
                "rounded-lg border border-border/30 bg-card",
                isSimple ? "mb-2 p-3" : "mb-4 p-4"
              )}
            >
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
                <TerminalIcon className="size-3.5" /> Connection
              </p>
              <code className="mb-2 block font-mono text-xs text-muted-foreground">
                {preview.command} {(preview.args || []).join(" ")}
              </code>
              {preview.env?.length ? (
                <div className="mt-3">
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    Required Environment Variables:
                  </p>
                  {preview.env.map((e) => (
                    <code
                      key={e}
                      className="block font-mono text-[11px] text-muted-foreground"
                    >
                      {e}
                    </code>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          {/* Install path */}
          {isInst && (
            <button
              type="button"
              onClick={() => openInstallPath(previewPath)}
              className="group/p flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border/30 px-3 py-2 text-left transition-all hover:border-border hover:bg-muted/30"
            >
              <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover/p:text-foreground" />
              <span className="truncate font-mono text-xs text-muted-foreground/60 transition-colors group-hover/p:text-foreground">
                {previewPath}
              </span>
              <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground/30 transition-colors group-hover/p:text-foreground" />
            </button>
          )}
        </div>
        <ConfirmActionDialog
          request={confirmRequest}
          onClose={() => setConfirmRequest(null)}
        />
      </div>
    )
  }

  // Group by category for section headers
  const CATEGORIES = [
    { key: "featured", label: "Featured" },
    { key: "mcp", label: "MCP Servers" },
    { key: "skill", label: "Skills" },
    { key: "provider", label: "Providers" },
  ]
  // Functional nav — every entry maps to a real filter (the old list had
  // decorative labels that all reset to "all", which read as broken).
  const NAV_ITEMS: Array<{ label: string; tab: "all" | "mcp" | "skill" }> = [
    { label: "Featured", tab: "all" },
    { label: "Skills", tab: "skill" },
    { label: "MCP Servers", tab: "mcp" },
  ]

  return (
    <div className="flex h-full">
      {/* Left nav */}
      <div
        className={cn(
          "shrink-0 border-r border-border/30 pr-2",
          isSimple ? "w-40 py-2" : "w-56 py-4"
        )}
      >
        <p
          className={cn(
            "px-4 text-xs font-semibold text-muted-foreground",
            isSimple ? "mb-2" : "mb-3"
          )}
        >
          Marketplace
        </p>
        <nav className="space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => setTab(item.tab)}
              className={cn(
                "flex w-full items-center rounded-md px-4 py-1.5 text-left text-xs whitespace-nowrap transition-colors",
                tab === item.tab
                  ? "bg-muted/40 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/20 hover:text-foreground"
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Right content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Search bar */}
        <div
          className={cn(
            "shrink-0",
            isSimple ? "px-3 pt-2 pb-2" : "px-5 pt-4 pb-3"
          )}
        >
          <div className="relative">
            <SearchIcon className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the skills.sh registry, MCPs, and more"
              className={cn(
                "rounded-2xl pl-10 text-sm",
                isSimple ? "h-8" : "h-10"
              )}
            />
            {registryLoading && (
              <Loader2Icon className="absolute top-1/2 right-3.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
        </div>

        {/* Items grid */}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto",
            isSimple ? "px-3 pb-3" : "px-5 pb-5"
          )}
        >
          {(() => {
            const renderCard = (item: MarketplaceItem) => {
              const isInst = isItemInstalled(item)
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setPreview(item)}
                  className={cn(
                    "flex items-center rounded-xl border text-left transition-all",
                    isSimple ? "gap-2 px-3 py-2" : "gap-3 px-4 py-3",
                    isInst
                      ? "border-border bg-card"
                      : "border-border/30 hover:border-border/60 hover:bg-muted/10"
                  )}
                >
                  <div
                    className={cn(
                      "flex shrink-0 items-center justify-center rounded-xl bg-muted/50",
                      isSimple ? "size-8" : "size-10"
                    )}
                  >
                    <ItemIcon
                      icon={item.icon}
                      category={item.category}
                      id={item.id}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-medium">
                        {item.name}
                      </p>
                      {isInst && (
                        <Badge
                          className="shrink-0 gap-0.5 border-emerald-500/20 bg-emerald-500/15 text-[9px] text-emerald-600 dark:text-emerald-400"
                          variant="outline"
                        >
                          <CheckIcon className="size-2.5" /> Installed
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/30" />
                </button>
              )
            }
            const registrySection = showRegistry && (
              <div key="registry" className={cn(isSimple ? "mb-3" : "mb-5")}>
                <div
                  className={cn(
                    "flex items-center gap-2",
                    isSimple ? "mb-1.5" : "mb-2.5"
                  )}
                >
                  <p className="text-xs font-semibold text-muted-foreground">
                    {search.trim().length >= 2
                      ? `Discover skills — skills.sh results for "${search.trim()}"`
                      : "Discover skills — popular on skills.sh"}
                  </p>
                  {registryLoading && (
                    <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
                  )}
                </div>
                {registryApiMissing ? (
                  <p className="rounded-lg border border-border/40 px-3 py-2 text-xs text-muted-foreground">
                    Restart BetterC0de to enable live skills.sh browsing (new
                    app version detected).
                  </p>
                ) : registryError ? (
                  <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                    skills.sh registry unavailable: {registryError}
                  </p>
                ) : registryFiltered.length === 0 && !registryLoading ? (
                  <p className="rounded-lg border border-border/40 px-3 py-2 text-xs text-muted-foreground">
                    {search.trim().length >= 2
                      ? "No skills found in the registry for this search."
                      : "No registry data loaded yet."}
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {registryFiltered.map(renderCard)}
                  </div>
                )}
              </div>
            )
            if (filtered.length === 0 && !showRegistry) {
              return (
                <p className="py-16 text-center text-sm text-muted-foreground/50">
                  No results
                </p>
              )
            }
            return (
              <>
                {/* Curated sections */}
                {(tab === "all"
                  ? CATEGORIES
                  : [{ key: tab, label: categoryLabel(tab) }]
                ).map(({ key, label }) => {
                  const sectionItems =
                    key === "featured"
                      ? filtered.slice(0, 4)
                      : filtered.filter((i) =>
                          key === "all" ? true : i.category === key
                        )
                  if (sectionItems.length === 0) return null
                  return (
                    <div key={key} className={cn(isSimple ? "mb-3" : "mb-5")}>
                      <p
                        className={cn(
                          "text-xs font-semibold text-muted-foreground",
                          isSimple ? "mb-1.5" : "mb-2.5"
                        )}
                      >
                        {label}
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {sectionItems.map(renderCard)}
                      </div>
                    </div>
                  )
                })}
                {/* Live skills.sh registry — always visible on Featured/Skills */}
                {registrySection}
              </>
            )
          })()}
        </div>
      </div>
      <ConfirmActionDialog
        request={confirmRequest}
        onClose={() => setConfirmRequest(null)}
      />
    </div>
  )
}

// ── My Skills Tab ──

interface CustomSkill {
  id: string
  name: string
  version: string
  public: boolean
  content: string
  createdAt: string
  sourceUrl?: string
}

function MySkillsTab({ isSimple = false }: { isSimple?: boolean }) {
  const [skills, setSkills] = useState<CustomSkill[]>([])
  const [importUrl, setImportUrl] = useState("")
  const [importName, setImportName] = useState("")
  const [showImport, setShowImport] = useState(false)
  const [loading, setLoading] = useState(false)
  const [previewSkill, setPreviewSkill] = useState<CustomSkill | null>(null)
  // skills.sh (npx skills) import state
  const [showSkillsSh, setShowSkillsSh] = useState(false)
  const [skillsShRepo, setSkillsShRepo] = useState("")
  const [skillsShSkills, setSkillsShSkills] = useState<string[] | null>(null)
  const [skillsShBusy, setSkillsShBusy] = useState(false)
  const [skillsShStatus, setSkillsShStatus] = useState<string | null>(null)
  const [confirmRequest, setConfirmRequest] =
    useState<ConfirmActionRequest | null>(null)

  const refresh = useCallback(async () => {
    const bridge = api()
    if (!bridge?.skillList) return
    const list = await bridge.skillList()
    setSkills((list as CustomSkill[]) || [])
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleImportUrl = async () => {
    if (!importUrl.trim()) return
    setLoading(true)
    const res = await api()?.skillImportUrl?.(
      importUrl.trim(),
      importName.trim() || undefined
    )
    if (res?.ok) {
      setImportUrl("")
      setImportName("")
      setShowImport(false)
      refresh()
    }
    setLoading(false)
  }

  const confirmImportUrl = () => {
    const url = importUrl.trim()
    if (!url) return
    let host = url
    try {
      host = new URL(url).host
    } catch {
      /* validated in the handler */
    }
    setConfirmRequest({
      title: `Import skill from ${host}?`,
      description:
        `${url}\n\n` +
        "Imported skills are added to Claude's system prompt and can influence every future chat turn. Only import from sources you trust.",
      confirmLabel: "Import",
      onConfirm: () => void handleImportUrl(),
    })
  }

  const handleSkillsShPreview = async () => {
    if (!skillsShRepo.trim()) return
    setSkillsShBusy(true)
    setSkillsShStatus(null)
    setSkillsShSkills(null)
    const res = await api()?.skillsShPreview?.(skillsShRepo.trim())
    if (res?.ok) {
      setSkillsShSkills(res.skills ?? [])
      if ((res.skills ?? []).length === 0) {
        setSkillsShStatus(
          "No skills detected — you can still install the whole repo."
        )
      }
    } else if (!res?.error?.toLowerCase().includes("cancelled")) {
      setSkillsShStatus(res?.error || "Preview failed")
    }
    setSkillsShBusy(false)
  }

  const handleSkillsShAdd = async (skill?: string) => {
    if (!skillsShRepo.trim()) return
    setSkillsShBusy(true)
    setSkillsShStatus(null)
    const res = await api()?.skillsShAdd?.(skillsShRepo.trim(), skill)
    if (res?.ok) {
      const count = res.installed?.length ?? 0
      setSkillsShStatus(
        count > 0
          ? `Installed ${count} skill ${count === 1 ? "entry" : "entries"} into ~/.claude/skills and ~/.codex/skills.`
          : "Done — skills were already present (updated in place)."
      )
      refresh()
    } else if (!res?.error?.toLowerCase().includes("cancelled")) {
      setSkillsShStatus(res?.error || "Install failed")
    }
    setSkillsShBusy(false)
  }

  const confirmSkillsShAdd = (skill?: string) => {
    const repo = skillsShRepo.trim()
    if (!repo) return
    setConfirmRequest({
      title: `Install ${skill ? `skill "${skill}"` : "skills"} from ${repo}?`,
      description:
        `Runs \`npx skills add ${repo}\`, which downloads and executes the skills CLI and copies skill files from that repository into ~/.claude/skills and ~/.codex/skills.\n\n` +
        "Skills influence every future chat turn of those CLIs. Only install from sources you trust.",
      confirmLabel: "Install",
      onConfirm: () => void handleSkillsShAdd(skill),
    })
  }

  const handleDelete = async (id: string) => {
    await api()?.skillDelete?.(id)
    refresh()
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "flex shrink-0 items-center gap-2",
          isSimple ? "mb-2" : "mb-3"
        )}
      >
        <p className="flex-1 text-sm font-medium">Your Custom Skills</p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => {
            setShowSkillsSh(!showSkillsSh)
            setShowImport(false)
          }}
        >
          <SparklesIcon className="size-3" /> Add from skills.sh
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => {
            setShowImport(!showImport)
            setShowSkillsSh(false)
          }}
        >
          <LinkIcon className="size-3" /> Import from URL
        </Button>
      </div>

      {showImport && (
        <div
          className={cn(
            "shrink-0 space-y-2 rounded-lg border border-border/50",
            isSimple ? "mb-2 p-2" : "mb-3 p-3"
          )}
        >
          <Input
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="https://example.com/skill.md"
            className="h-8 text-xs"
          />
          <div className="flex gap-2">
            <Input
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              placeholder="Skill name (optional)"
              className="h-8 flex-1 text-xs"
            />
            <Button
              size="sm"
              className="h-8 gap-1 text-xs"
              onClick={confirmImportUrl}
              disabled={loading || !importUrl.trim()}
            >
              {loading ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <DownloadIcon className="size-3" />
              )}{" "}
              Import
            </Button>
          </div>
        </div>
      )}

      {showSkillsSh && (
        <div
          className={cn(
            "shrink-0 space-y-2 rounded-lg border border-border/50",
            isSimple ? "mb-2 p-2" : "mb-3 p-3"
          )}
        >
          <div className="flex gap-2">
            <Input
              value={skillsShRepo}
              onChange={(e) => {
                setSkillsShRepo(e.target.value)
                setSkillsShSkills(null)
                setSkillsShStatus(null)
              }}
              placeholder="owner/repo (e.g. anthropics/skills)"
              className="h-8 flex-1 text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs"
              onClick={handleSkillsShPreview}
              disabled={skillsShBusy || !skillsShRepo.trim()}
            >
              {skillsShBusy ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <SearchIcon className="size-3" />
              )}{" "}
              Preview
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1 text-xs"
              onClick={() => confirmSkillsShAdd()}
              disabled={skillsShBusy || !skillsShRepo.trim()}
            >
              {skillsShBusy ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <DownloadIcon className="size-3" />
              )}{" "}
              Install All
            </Button>
          </div>
          {skillsShSkills && skillsShSkills.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {skillsShSkills.map((name) => (
                <Button
                  key={name}
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 text-[11px]"
                  disabled={skillsShBusy}
                  onClick={() => confirmSkillsShAdd(name)}
                >
                  <DownloadIcon className="size-2.5" /> {name}
                </Button>
              ))}
            </div>
          )}
          {skillsShStatus && (
            <p className="text-[11px] text-muted-foreground">
              {skillsShStatus}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground/60">
            Installs via `npx skills add` into ~/.claude/skills and
            ~/.codex/skills — skills appear in the $-picker after a provider
            refresh.
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {previewSkill ? (
          <div className="flex h-full flex-col">
            <button
              type="button"
              onClick={() => setPreviewSkill(null)}
              className={cn(
                "flex shrink-0 items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
                isSimple ? "mb-2" : "mb-3"
              )}
            >
              <ChevronRightIcon className="size-4 rotate-180" /> Back
            </button>
            <div
              className={cn(
                "flex shrink-0 items-center",
                isSimple ? "mb-2 gap-2" : "mb-4 gap-3"
              )}
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50">
                <SparklesIcon className="size-5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold">{previewSkill.name}</h3>
                  <Badge variant="outline" className="text-[9px]">
                    v{previewSkill.version}
                  </Badge>
                </div>
                {previewSkill.sourceUrl && (
                  <p className="truncate text-[10px] text-muted-foreground/50">
                    {previewSkill.sourceUrl}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={() =>
                    openInstallPath(`~/.betterc0de/skills/${previewSkill.id}`)
                  }
                >
                  <FolderOpenIcon className="size-3" /> Open Folder
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    handleDelete(previewSkill.id)
                    setPreviewSkill(null)
                  }}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </div>
            <div
              className={cn(
                "min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/40 bg-muted/10",
                isSimple ? "p-2" : "p-4"
              )}
            >
              <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {previewSkill.content || "No content"}
              </pre>
            </div>
          </div>
        ) : skills.length === 0 ? (
          <div className="py-12 text-center">
            <SparklesIcon className="mx-auto size-8 text-muted-foreground/20" />
            <p className="mt-2 text-sm text-muted-foreground">
              No custom skills yet
            </p>
            <p className="mt-1 text-xs text-muted-foreground/50">
              Import from a URL or create one
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {skills.map((skill) => (
              <div
                key={skill.id}
                className={cn(
                  "flex cursor-pointer items-center rounded-lg border border-border/50 transition-colors hover:bg-muted/10",
                  isSimple ? "gap-2 px-3 py-2" : "gap-3 px-4 py-3"
                )}
                onClick={() => setPreviewSkill(skill)}
              >
                <SparklesIcon className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{skill.name}</p>
                    <Badge variant="outline" className="text-[9px]">
                      v{skill.version}
                    </Badge>
                    <Badge
                      variant={skill.public ? "default" : "secondary"}
                      className="text-[9px]"
                    >
                      {skill.public ? "Public" : "Offline"}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground/50">
                    {skill.content?.slice(0, 80) || "No content"}
                  </p>
                </div>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/30" />
              </div>
            ))}
          </div>
        )}
      </div>
      <ConfirmActionDialog
        request={confirmRequest}
        onClose={() => setConfirmRequest(null)}
      />
    </div>
  )
}

// ── Create Skill Tab ──

// The skill-architect system prompt moved to the backend
// (chat.ts generateSkillContent) alongside the generation call.

// IDs MUST be canonical Anthropic slugs — bare names (`opus`/`sonnet`/
// `haiku`) get rejected by Anthropic with 404.
const MODELS = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic" },
  { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" },
  { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
  },
  { id: "gpt-5.4", name: "GPT 5.4", provider: "openai" },
  { id: "gpt-5.4-mini", name: "GPT 5.4 Mini", provider: "openai" },
]

const THINKING_MODES = [
  { id: "none", label: "Off" },
  { id: "Low", label: "Low" },
  { id: "Medium", label: "Medium" },
  { id: "High", label: "High" },
  { id: "Ultra Think", label: "Ultra" },
]

function CreateSkillTab({ isSimple = false }: { isSimple?: boolean }) {
  const [name, setName] = useState("")
  const [version, setVersion] = useState("1.0")
  const [isPublic, setIsPublic] = useState(false)
  const [content, setContent] = useState("")
  const [prompt, setPrompt] = useState("")
  const [model, setModel] = useState("claude-opus-5")
  const [thinking, setThinking] = useState("High")
  const [generating, setGenerating] = useState(false)
  const [reasoning, setReasoning] = useState("")
  const [streamText, setStreamText] = useState("")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showReasoning, setShowReasoning] = useState(true)

  // Listen for plugin streaming events
  useEffect(() => {
    const bridge = api()
    if (!bridge?.onPluginEvent) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = bridge.onPluginEvent((event: any) => {
      if (!event.threadId?.startsWith("skill-gen-")) return
      const { type, payload } = event
      if (type === "reasoning_delta" && payload.delta) {
        setReasoning((prev) => prev + payload.delta)
      } else if (type === "reasoning_replace" && payload.text) {
        setReasoning(payload.text)
      } else if (type === "content_delta" && payload.delta) {
        setStreamText((prev) => prev + payload.delta)
      } else if (type === "content_replace" && payload.text) {
        setStreamText(payload.text)
      } else if (type === "turn_completed") {
        setGenerating(false)
        // Move streamed content to the editor
        setContent(
          (prev) =>
            prev ||
            setStreamText((s) => {
              setContent(s)
              return s
            }) ||
            ""
        )
      }
    })
    return cleanup
  }, [])

  // When streaming completes, copy to content
  useEffect(() => {
    if (!generating && streamText && !content) {
      setContent(streamText)
    }
  }, [generating, streamText, content])

  const handleSave = async () => {
    if (!name.trim() || !content.trim()) return
    setSaving(true)
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
    await api()?.skillSave?.({
      id,
      name: name.trim(),
      version,
      isPublic,
      content,
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleGenerate = async () => {
    if (!prompt.trim() || !name.trim()) return
    setGenerating(true)
    setReasoning("")
    setStreamText("")
    setContent("")

    try {
      // One-shot generation via the backend's native text-generation
      // pipeline (Codex/Claude CLI with helper-model fallback). Replaces
      // the retired anthropic-claude plugin codepath that no-op'd.
      const result = await generateSkillContent({
        name: name.trim(),
        requirements: prompt.trim(),
      })
      setContent(result.content)
    } catch (err) {
      setReasoning(
        `Generation failed: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setGenerating(false)
    }
  }

  const bumpVersion = () => {
    const parts = version.split(".")
    const minor = parseInt(parts[1] || "0") + 1
    setVersion(`${parts[0]}.${minor}`)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Config row */}
      <div
        className={cn(
          "shrink-0",
          isSimple ? "mb-2 space-y-2" : "mb-3 space-y-3"
        )}
      >
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-[10px] text-muted-foreground">
              Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Custom Skill"
              className="h-8 text-xs"
            />
          </div>
          <div className="w-24">
            <label className="mb-1 block text-[10px] text-muted-foreground">
              Version
            </label>
            <div className="flex items-center gap-1">
              <Input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                className="h-8 text-xs"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={bumpVersion}
                title="Bump version"
              >
                <PlusIcon className="size-3" />
              </Button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10px] text-muted-foreground">
              Visibility
            </label>
            <div className="flex h-8 items-center gap-2">
              <Switch checked={isPublic} onCheckedChange={setIsPublic} />
              <span className="text-[10px] text-muted-foreground">
                {isPublic ? "Public" : "Offline"}
              </span>
            </div>
          </div>
        </div>

        {/* Prompt */}
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe what this skill should do, what rules it follows, target audience, use cases..."
          rows={2}
          className="rounded-lg text-xs"
        />

        {/* Toolbar: Model + Thinking + Generate */}
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
              >
                <img
                  src={
                    MODELS.find((m) => m.id === model)?.provider === "anthropic"
                      ? assetUrl("icons/providers/claude.svg")
                      : assetUrl("icons/providers/openai.svg")
                  }
                  alt=""
                  className={cn(
                    "size-3.5",
                    MODELS.find((m) => m.id === model)?.provider === "openai" &&
                      "dark:invert"
                  )}
                />
                {MODELS.find((m) => m.id === model)?.name || model}
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {MODELS.map((m) => (
                <DropdownMenuItem key={m.id} onClick={() => setModel(m.id)}>
                  <img
                    src={
                      m.provider === "anthropic"
                        ? assetUrl("icons/providers/claude.svg")
                        : assetUrl("icons/providers/openai.svg")
                    }
                    alt=""
                    className={cn(
                      "size-3.5",
                      m.provider === "openai" && "dark:invert"
                    )}
                  />
                  <span className="flex-1">{m.name}</span>
                  {model === m.id && (
                    <CheckIcon className="size-3.5 text-primary" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
              >
                <BrainIcon className="size-3.5" />
                {thinking === "none" ? "No thinking" : thinking}
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {THINKING_MODES.map((t) => (
                <DropdownMenuItem key={t.id} onClick={() => setThinking(t.id)}>
                  <BrainIcon className="size-3.5" />
                  <span className="flex-1">{t.label}</span>
                  {thinking === t.id && (
                    <CheckIcon className="size-3.5 text-primary" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex-1" />

          <Button
            size="sm"
            className="h-8 gap-1.5"
            onClick={handleGenerate}
            disabled={generating || !prompt.trim() || !name.trim()}
          >
            {generating ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <WandIcon className="size-3.5" />
            )}
            {generating ? "Generating..." : "Generate"}
          </Button>
        </div>
      </div>

      {/* Main area: Reasoning + Content side by side */}
      <div className={cn("flex min-h-0 flex-1", isSimple ? "gap-2" : "gap-3")}>
        {/* Left: Reasoning/Thinking (collapsible) */}
        {(reasoning || generating) && (
          <div className="flex w-[280px] shrink-0 flex-col overflow-hidden rounded-lg border border-border/50">
            <button
              type="button"
              onClick={() => setShowReasoning(!showReasoning)}
              className="flex shrink-0 items-center gap-2 border-b border-border/30 px-3 py-2 text-[10px] font-medium text-muted-foreground hover:bg-muted/30"
            >
              <BrainIcon className="size-3" />
              {generating ? "Thinking..." : "Reasoning"}
              {generating && (
                <Loader2Icon className="ml-auto size-3 animate-spin" />
              )}
              <ChevronDownIcon
                className={cn(
                  "ml-auto size-3 transition-transform",
                  !showReasoning && "-rotate-90"
                )}
              />
            </button>
            {showReasoning && (
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <p className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground/70">
                  {reasoning || (generating ? "Thinking..." : "")}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Right: Content — shows streaming or editable */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-1 flex shrink-0 items-center gap-2">
            <label className="text-[10px] text-muted-foreground">
              Skill Content
            </label>
            {generating && streamText && (
              <Badge variant="secondary" className="gap-1 text-[9px]">
                <Loader2Icon className="size-2.5 animate-spin" />
                Streaming
              </Badge>
            )}
          </div>
          {generating && streamText ? (
            // Streaming view — read-only with live content
            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/50 px-3 py-2">
              <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/80">
                {streamText}
              </pre>
            </div>
          ) : (
            // Editable textarea
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={
                "# My Skill\n\nDescribe what this skill does...\n\n## Core Rules\n1. Rule one\n2. Rule two\n\n## Examples\n..."
              }
              className="min-h-0 flex-1 rounded-lg font-mono text-xs"
            />
          )}
        </div>
      </div>

      {/* Save footer */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 border-t border-border/30",
          isSimple ? "mt-2 pt-2" : "mt-3 pt-3"
        )}
      >
        <Button
          size="sm"
          className="gap-1.5"
          onClick={handleSave}
          disabled={saving || !name.trim() || !content.trim()}
        >
          {saving ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : saved ? (
            <CheckIcon className="size-3" />
          ) : (
            <FileTextIcon className="size-3" />
          )}
          {saved ? "Saved!" : "Save Skill"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={bumpVersion}
        >
          <PlusIcon className="size-3" /> New Version
        </Button>
        {streamText && !content && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setContent(streamText)}
          >
            <CheckIcon className="size-3" /> Accept Generated
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Main Modal ──

export function MarketplaceModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const isSimple = useAppearanceStore((s) => s.chatUiStyle === "simple")
  if (!open) return null

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0",
          isSimple ? "h-[80vh] sm:max-w-4xl" : "h-[90vh] sm:max-w-7xl"
        )}
        style={{ fontSize: "16px", borderRadius: "var(--radius-xl, 0.875rem)" }}
      >
        <DialogTitle className="sr-only">Marketplace</DialogTitle>

        <Tabs defaultValue="browse" className="flex h-full flex-col">
          {/* Header */}
          <div
            className={cn(
              "flex shrink-0 items-center gap-3 border-b border-border/40",
              isSimple ? "px-4 py-2" : "px-5 py-3"
            )}
          >
            <PackageIcon className="size-5" />
            <span className="font-semibold">Marketplace</span>
            <div className="flex-1" />
            <TabsList>
              <TabsTrigger value="browse">Browse</TabsTrigger>
              <TabsTrigger value="cli-plugins">Plugins</TabsTrigger>
              <TabsTrigger value="my-skills">My Skills</TabsTrigger>
              <TabsTrigger value="create">Create Skill</TabsTrigger>
            </TabsList>
          </div>

          {/* Content */}
          <TabsContent
            value="browse"
            className={cn("m-0 min-h-0 flex-1", isSimple ? "p-3" : "p-5")}
          >
            <BrowseTab isSimple={isSimple} />
          </TabsContent>
          <TabsContent
            value="cli-plugins"
            className={cn("m-0 min-h-0 flex-1", isSimple ? "p-3" : "p-5")}
          >
            <MarketplaceCliPluginsTab isSimple={isSimple} />
          </TabsContent>
          <TabsContent
            value="my-skills"
            className={cn("m-0 min-h-0 flex-1", isSimple ? "p-3" : "p-5")}
          >
            <MySkillsTab isSimple={isSimple} />
          </TabsContent>
          <TabsContent
            value="create"
            className={cn("m-0 min-h-0 flex-1", isSimple ? "p-3" : "p-5")}
          >
            <CreateSkillTab isSimple={isSimple} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// Need PackageIcon — import from lucide
import { PackageIcon } from "lucide-react"
