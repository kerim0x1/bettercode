import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2Icon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SettingsSection } from "@/components/settings/atoms"
import { useActiveThread } from "@/lib/chat-store"
import {
  BETTERC0DE_COMPOSER_KEYBIND_DEFAULTS,
  BETTERC0DE_KEYBIND_DEFAULTS,
} from "@/lib/betterc0de-keybinds"
import {
  BETTERC0DE_CLI_ENTRYPOINTS,
  BETTERC0DE_HTTP_OPERATIONS,
  BETTERC0DE_PARITY_AREAS,
  betterC0deGapRows,
} from "@/lib/betterc0de-parity"
import {
  listProjectAgents,
  listProjectCommands,
  listProjectConfigSettings,
  listProjectFormatters,
  listProjectInstructions,
  listProjectLspServers,
  listProjectMcpServers,
  listProjectPermissions,
  listProjectPlugins,
  listProjectProviders,
  listProjectReferences,
  listProjectSkills,
  listProjectTools,
  type WorkspaceProjectAgent,
  type WorkspaceProjectCommand,
  type WorkspaceProjectConfigSetting,
  type WorkspaceProjectFormatter,
  type WorkspaceProjectInstruction,
  type WorkspaceProjectLspServer,
  type WorkspaceProjectMcpServer,
  type WorkspaceProjectPermissionRule,
  type WorkspaceProjectPlugin,
  type WorkspaceProjectProvidersSummary,
  type WorkspaceProjectReference,
  type WorkspaceProjectSkill,
  type WorkspaceProjectToolFlag,
} from "@/services/backend/workspaceApi"

interface BetterC0deProjectState {
  config: WorkspaceProjectConfigSetting[]
  commands: WorkspaceProjectCommand[]
  agents: WorkspaceProjectAgent[]
  skills: WorkspaceProjectSkill[]
  mcps: WorkspaceProjectMcpServer[]
  instructions: WorkspaceProjectInstruction[]
  references: WorkspaceProjectReference[]
  formatters: WorkspaceProjectFormatter[]
  lspServers: WorkspaceProjectLspServer[]
  permissions: WorkspaceProjectPermissionRule[]
  providers: WorkspaceProjectProvidersSummary | null
  plugins: WorkspaceProjectPlugin[]
  tools: WorkspaceProjectToolFlag[]
}

const EMPTY_STATE: BetterC0deProjectState = {
  config: [],
  commands: [],
  agents: [],
  skills: [],
  mcps: [],
  instructions: [],
  references: [],
  formatters: [],
  lspServers: [],
  permissions: [],
  providers: null,
  plugins: [],
  tools: [],
}

export function SettingsBetterC0deSection() {
  const activeThread = useActiveThread()
  const workspacePath = useMemo(
    () => activeThread?.projectPath || activeThread?.worktreePath || "",
    [activeThread?.projectPath, activeThread?.worktreePath]
  )
  const [state, setState] = useState<BetterC0deProjectState>(EMPTY_STATE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setState(EMPTY_STATE)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [
        config,
        commands,
        agents,
        skills,
        mcps,
        instructions,
        references,
        formatters,
        lspServers,
        permissions,
        providers,
        plugins,
        tools,
      ] = await Promise.all([
        listProjectConfigSettings(workspacePath),
        listProjectCommands(workspacePath),
        listProjectAgents(workspacePath),
        listProjectSkills(workspacePath),
        listProjectMcpServers(workspacePath),
        listProjectInstructions(workspacePath),
        listProjectReferences(workspacePath),
        listProjectFormatters(workspacePath),
        listProjectLspServers(workspacePath),
        listProjectPermissions(workspacePath),
        listProjectProviders(workspacePath),
        listProjectPlugins(workspacePath),
        listProjectTools(workspacePath),
      ])
      setState({
        config,
        commands,
        agents,
        skills,
        mcps,
        instructions,
        references,
        formatters,
        lspServers,
        permissions,
        providers,
        plugins,
        tools,
      })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load BetterC0de compatibility config"
      )
      setState(EMPTY_STATE)
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!workspacePath) {
    return (
      <SettingsSection
        title="BetterC0de Compatibility"
        description="Open a workspace folder to inspect BetterC0de project configuration."
      >
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No workspace folder is active.
        </div>
      </SettingsSection>
    )
  }

  const providerSummary = state.providers
  const runtimeConfigRows = state.config.filter((setting) =>
    isBetterC0deRuntimeConfigKey(setting.key)
  )
  const appRuntimeConfigRows = state.config.filter((setting) =>
    isBetterC0deAppRuntimeConfigKey(setting.key)
  )
  const tuiConfigRows = state.config.filter((setting) =>
    isBetterC0deTuiConfigKey(setting.key)
  )
  const providerRows =
    providerSummary?.providers.map((provider): [string, string, string] => [
      provider.name || provider.id,
      [
        provider.api ? `api ${provider.api}` : "",
        provider.npm ? `npm ${provider.npm}` : "",
        provider.env.length ? `env ${formatList(provider.env)}` : "",
        provider.whitelist.length
          ? `allow ${formatList(provider.whitelist)}`
          : "",
        provider.blacklist.length
          ? `block ${formatList(provider.blacklist)}`
          : "",
        `options ${formatProjectProviderOptions(provider)}`,
        `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(" · "),
      provider.sourcePath,
    ]) ?? []
  const providerModelRows =
    providerSummary?.providers.flatMap((provider) =>
      provider.models.map((model): [string, string, string] => [
        `${provider.id}/${model.id}`,
        [
          model.status ? `status ${model.status}` : "",
          model.releaseDate ? `released ${model.releaseDate}` : "",
          formatProviderModelCapabilities(model),
          formatProviderModelModalities(model),
          model.contextLimit ? `ctx ${model.contextLimit}` : "",
          model.inputLimit ? `in ${model.inputLimit}` : "",
          model.outputLimit ? `out ${model.outputLimit}` : "",
          formatProviderModelCost(model),
          model.providerApi ? `api ${model.providerApi}` : "",
          model.providerNpm ? `npm ${model.providerNpm}` : "",
          model.optionKeys.length
            ? `options ${formatList(model.optionKeys)}`
            : "",
          model.headerKeys.length
            ? `headers ${formatList(model.headerKeys)}`
            : "",
          model.variants.length ? `variants ${formatList(model.variants)}` : "",
        ]
          .filter(Boolean)
          .join(" · ") ||
          model.name ||
          "-",
        model.sourcePath,
      ])
    ) ?? []
  const providerAuthRows =
    providerSummary?.authAccounts.map((account): [string, string, string] => [
      account.serviceId,
      [
        account.activeCredentialType
          ? `active ${account.activeCredentialType}`
          : "",
        account.activeExpired ? "expired" : "",
        `${account.accountCount} account${account.accountCount === 1 ? "" : "s"}`,
        account.credentialTypes.length
          ? `types ${formatList(account.credentialTypes)}`
          : "",
        account.metadataKeys?.length
          ? `metadata ${formatList(account.metadataKeys)}`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
      account.sourcePath,
    ]) ?? []
  const agentPermissionRows = state.agents.flatMap((agent) =>
    agent.permissions.map((rule): [string, string, string] => [
      agent.name || agent.id,
      `${rule.permission} ${rule.pattern} -> ${rule.action}`,
      rule.sourcePath,
    ])
  )
  const summaryRows = [
    ["Config", state.config.length],
    ["Commands", state.commands.length],
    ["Agents", state.agents.length],
    ["Skills", state.skills.length],
    ["MCP", state.mcps.length],
    ["Refs", state.references.length],
    ["Permissions", state.permissions.length],
    ["Agent perms", agentPermissionRows.length],
    ["Providers", providerSummary?.providers.length ?? 0],
    ["Plugins", state.plugins.length],
    ["Tool flags", state.tools.length],
  ] as const
  const gapRows = betterC0deGapRows()

  return (
    <div className="space-y-4">
      <SettingsSection
        title="BetterC0de Project"
        description="Project-local compatibility config loaded from the active thread workspace."
      >
        <div className="space-y-4 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {activeThread?.projectName || workspacePath.split("/").pop()}
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {workspacePath}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
              Refresh
            </Button>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {summaryRows.map(([label, value]) => (
              <div
                key={label}
                className="rounded-md border border-border/50 bg-muted/20 px-3 py-2"
              >
                <div className="text-lg font-semibold tabular-nums">
                  {value}
                </div>
                <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="BetterC0de Compatibility Audit">
        <CompactTable
          empty="No BetterC0de compatibility rows loaded."
          rows={BETTERC0DE_PARITY_AREAS.map((area) => [
            area.area,
            area.status,
            `${area.chat} · ${area.notes}`,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="BetterC0de Gap Report">
        <CompactTable
          empty="No BetterC0de gaps found."
          rows={gapRows.map((row) => [
            `${row.surface}: ${row.entry}`,
            row.access,
            `${row.status} · ${row.notes}`,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="External CLI References">
        <CompactTable
          empty="No external CLI references loaded."
          rows={BETTERC0DE_CLI_ENTRYPOINTS.map((entry) => [
            entry.chat,
            entry.cli,
            `${entry.status} · ${entry.notes}`,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="Compatibility HTTP/API Operations">
        <CompactTable
          empty="No compatibility HTTP/API operations loaded."
          rows={BETTERC0DE_HTTP_OPERATIONS.map((operation) => [
            operation.id,
            `${operation.method} ${operation.path}`,
            `${operation.chat} · ${operation.status} · ${operation.notes}`,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="Provider Policy">
        <div className="space-y-2 px-4 py-3 text-xs">
          {providerSummary ? (
            <>
              <KeyValue
                label="Default model"
                value={providerSummary.defaultModel}
              />
              <KeyValue
                label="Small model"
                value={providerSummary.smallModel}
              />
              <KeyValue
                label="Enabled providers"
                value={formatList(providerSummary.enabledProviders)}
              />
              <KeyValue
                label="Disabled providers"
                value={formatList(providerSummary.disabledProviders)}
              />
            </>
          ) : (
            <div className="text-muted-foreground">
              No provider policy found.
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Project Providers">
        <CompactTable
          empty="No custom BetterC0de project providers found."
          rows={providerRows}
        />
      </SettingsSection>

      <SettingsSection title="Project Provider Models">
        <CompactTable
          empty="No BetterC0de project provider model overrides found."
          rows={providerModelRows}
        />
      </SettingsSection>

      <SettingsSection title="Provider Auth">
        <CompactTable
          empty="No BetterC0de provider auth accounts found."
          rows={providerAuthRows}
        />
      </SettingsSection>

      <SettingsSection title="Runtime Limits">
        <CompactTable
          empty="No BetterC0de attachment, tool output, or compaction settings found."
          rows={runtimeConfigRows.map((setting) => [
            setting.label,
            setting.value,
            setting.sourcePath,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="Runtime & App Config">
        <CompactTable
          empty="No BetterC0de runtime, server, watcher, or app config found."
          rows={appRuntimeConfigRows.map((setting) => [
            setting.label,
            setting.value,
            setting.sourcePath,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="TUI & Keybinds">
        <CompactTable
          empty="No BetterC0de terminal UI settings or keybind overrides found."
          rows={tuiConfigRows.map((setting) => [
            setting.label,
            setting.value,
            setting.sourcePath,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="BetterC0de Default Keybinds">
        <CompactTable
          empty="No BetterC0de keybind defaults loaded."
          rows={BETTERC0DE_KEYBIND_DEFAULTS.map((item) => [
            item.command,
            item.binding,
            item.slash ?? item.description,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="BetterC0de Composer Keybinds">
        <CompactTable
          empty="No BetterC0de composer keybind defaults loaded."
          rows={BETTERC0DE_COMPOSER_KEYBIND_DEFAULTS.map((item) => [
            item.command,
            item.binding,
            item.handling ?? item.description,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="Config Settings">
        <CompactTable
          empty="No BetterC0de config settings found."
          rows={state.config.map((setting) => [
            setting.label,
            setting.value,
            setting.sourcePath,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="Commands">
        <CompactTable
          empty="No project commands found."
          rows={state.commands.map((command) => [
            `/${command.name}`,
            [
              command.agent ? `agent ${command.agent}` : "",
              command.model ? `model ${command.model}` : "",
              typeof command.subtask === "boolean"
                ? `subtask ${command.subtask ? "on" : "off"}`
                : "",
            ]
              .filter(Boolean)
              .join(" · ") ||
              command.description ||
              "-",
            command.sourcePath,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="Permissions">
        <CompactTable
          empty="No global BetterC0de permission rules found."
          rows={state.permissions.map((rule) => [
            `${rule.permission} ${rule.pattern}`,
            rule.action,
            rule.sourcePath,
          ])}
        />
      </SettingsSection>

      <SettingsSection title="Agent Permissions">
        <CompactTable
          empty="No agent-scoped BetterC0de permission rules found."
          rows={agentPermissionRows}
        />
      </SettingsSection>

      <SettingsSection title="Agents & Skills">
        <CompactTable
          empty="No BetterC0de project agents or skills found."
          rows={[
            ...state.agents.map((agent): [string, string, string] => [
              agent.name || agent.id,
              [
                agent.mode || "agent",
                agent.model ? `model ${agent.model}` : "",
                agent.enabled ? "" : "disabled",
                agent.hidden ? "hidden" : "",
              ]
                .filter(Boolean)
                .join(" · "),
              agent.sourcePath,
            ]),
            ...state.skills.map((skill): [string, string, string] => [
              `$${skill.name}`,
              skill.description || `${skill.content.length} chars`,
              skill.sourceUrl || skill.sourcePath,
            ]),
          ]}
        />
      </SettingsSection>

      <SettingsSection title="MCP & References">
        <CompactTable
          empty="No BetterC0de MCP servers or references found."
          rows={[
            ...state.mcps.map((mcp): [string, string, string] => [
              mcp.name || mcp.id,
              [
                mcp.type === "remote"
                  ? mcp.url || mcp.command
                  : [mcp.command, ...mcp.args].join(" "),
                mcp.envKeys?.length ? `env ${formatList(mcp.envKeys)}` : "",
                mcp.headerKeys?.length
                  ? `headers ${formatList(mcp.headerKeys)}`
                  : "",
                mcp.timeoutMs ? `timeout ${mcp.timeoutMs}ms` : "",
                mcp.oauth ? `oauth ${formatMcpOAuth(mcp)}` : "",
                mcp.authStatus ? `auth ${formatMcpAuthStatus(mcp)}` : "",
              ]
                .filter(Boolean)
                .join(" · "),
              mcp.enabled ? mcp.sourcePath : `${mcp.sourcePath} (disabled)`,
            ]),
            ...state.references.map((ref): [string, string, string] => [
              `@${ref.name}`,
              ref.kind === "git"
                ? [ref.repository, ref.branch].filter(Boolean).join(" ")
                : ref.relativePath || ref.path || ref.message || ref.kind,
              ref.sourcePath,
            ]),
          ]}
        />
      </SettingsSection>

      <SettingsSection title="Formatters & LSP">
        <CompactTable
          empty="No BetterC0de formatter or LSP config found."
          rows={[
            ...state.formatters.map((formatter): [string, string, string] => [
              formatter.name || formatter.id,
              formatter.builtin
                ? "built-in"
                : [formatter.command, ...formatter.args].join(" "),
              `${formatter.sourcePath} (${formatFormatterStatus(formatter)})`,
            ]),
            ...state.lspServers.map((server): [string, string, string] => [
              server.name || server.id,
              server.builtin
                ? "built-in"
                : [server.command, ...server.args].join(" "),
              server.enabled
                ? server.sourcePath
                : `${server.sourcePath} (disabled)`,
            ]),
          ]}
        />
      </SettingsSection>

      <SettingsSection title="Instructions">
        <CompactTable
          empty="No BetterC0de project instructions found."
          rows={state.instructions.map((instruction) => [
            instruction.sourcePath,
            `${instruction.content.length} chars`,
            instruction.content.split(/\r?\n/)[0] || "-",
          ])}
        />
      </SettingsSection>

      <SettingsSection title="Plugins & Tools">
        <CompactTable
          empty="No BetterC0de plugins or tool flags found."
          rows={[
            ...state.plugins.map((plugin): [string, string, string] => [
              plugin.spec,
              plugin.kind,
              [
                plugin.message ?? plugin.sourcePath,
                plugin.metaLoadCount ? `loaded ${plugin.metaLoadCount}x` : "",
                plugin.metaVersion ? `v${plugin.metaVersion}` : "",
              ]
                .filter(Boolean)
                .join(" · "),
            ]),
            ...state.tools.map((tool): [string, string, string] => [
              tool.tool,
              tool.kind === "custom"
                ? `custom${tool.exportName ? `:${tool.exportName}` : ""}`
                : tool.enabled
                  ? "enabled"
                  : "disabled",
              tool.sourcePath,
            ]),
          ]}
        />
      </SettingsSection>
    </div>
  )
}

function KeyValue({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono">{value || "-"}</span>
    </div>
  )
}

function CompactTable({
  empty,
  rows,
}: {
  empty: string
  rows: ReadonlyArray<readonly [string, string, string]>
}) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">{empty}</div>
    )
  }
  return (
    <div className="divide-y divide-border/40">
      {rows.map((row, index) => (
        <div
          key={`${row[0]}-${index}`}
          className="grid grid-cols-[minmax(110px,0.9fr)_minmax(120px,1fr)_minmax(120px,1fr)] gap-3 px-4 py-2.5 text-xs"
        >
          <span className="min-w-0 truncate font-medium">{row[0]}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {row[1]}
          </span>
          <span className="min-w-0 truncate font-mono text-muted-foreground/80">
            {row[2]}
          </span>
        </div>
      ))}
    </div>
  )
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "-"
}

function formatProjectProviderOptions(
  provider: WorkspaceProjectProvidersSummary["providers"][number]
): string {
  const knownKeys = new Set([
    "apiKey",
    "baseURL",
    "enterpriseUrl",
    "setCacheKey",
    "timeout",
    "chunkTimeout",
  ])
  const parts = [
    provider.hasApiKey || provider.optionKeys.includes("apiKey")
      ? "apiKey(masked)"
      : "",
    provider.baseURL ? `baseURL ${provider.baseURL}` : "",
    provider.enterpriseUrl ? `enterpriseUrl ${provider.enterpriseUrl}` : "",
    typeof provider.setCacheKey === "boolean"
      ? `setCacheKey ${provider.setCacheKey ? "true" : "false"}`
      : "",
    provider.timeout === false
      ? "timeout disabled"
      : typeof provider.timeout === "number"
        ? `timeout ${provider.timeout}ms`
        : "",
    typeof provider.chunkTimeout === "number"
      ? `chunkTimeout ${provider.chunkTimeout}ms`
      : "",
    ...provider.optionKeys.filter((key) => !knownKeys.has(key)),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : "-"
}

function formatProviderModelCapabilities(
  model: WorkspaceProjectProvidersSummary["providers"][number]["models"][number]
): string {
  return [
    model.attachment ? "attachments" : "",
    model.reasoning ? "reasoning" : "",
    model.toolCall ? "tools" : "",
    model.temperature ? "temperature" : "",
    model.interleaved
      ? `interleaved${model.interleavedField ? `:${model.interleavedField}` : ""}`
      : "",
    model.experimental ? "experimental" : "",
  ]
    .filter(Boolean)
    .join(", ")
}

function formatProviderModelModalities(
  model: WorkspaceProjectProvidersSummary["providers"][number]["models"][number]
): string {
  const input = model.inputModalities?.length
    ? `modalities in ${formatList(model.inputModalities)}`
    : ""
  const output = model.outputModalities?.length
    ? `out ${formatList(model.outputModalities)}`
    : ""
  return [input, output].filter(Boolean).join(" · ")
}

function formatProviderModelCost(
  model: WorkspaceProjectProvidersSummary["providers"][number]["models"][number]
): string {
  const base = formatCostRecord(model.cost)
  const over200k = formatCostRecord(model.contextOver200kCost)
  if (!base && !over200k) return ""
  return [base ? `cost ${base}` : "", over200k ? `>200k ${over200k}` : ""]
    .filter(Boolean)
    .join(" · ")
}

function formatCostRecord(values?: Record<string, number>): string {
  if (!values) return ""
  return Object.entries(values)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ")
}

function formatMcpOAuth(
  mcp: Pick<WorkspaceProjectMcpServer, "oauth" | "oauthKeys">
): string {
  if (mcp.oauth === "configured") {
    return mcp.oauthKeys && mcp.oauthKeys.length > 0
      ? `configured (${mcp.oauthKeys.join(", ")})`
      : "configured"
  }
  if (mcp.oauth === "disabled") return "disabled"
  return "auto"
}

function formatMcpAuthStatus(
  mcp: Pick<WorkspaceProjectMcpServer, "authStatus" | "authStorageKeys">
): string {
  const status =
    mcp.authStatus === "authenticated"
      ? "authenticated"
      : mcp.authStatus === "expired"
        ? "expired"
        : "not authenticated"
  const storage =
    mcp.authStorageKeys && mcp.authStorageKeys.length > 0
      ? ` (${mcp.authStorageKeys.join(", ")})`
      : ""
  return `${status}${storage}`
}

function formatFormatterStatus(formatter: WorkspaceProjectFormatter): string {
  if (!formatter.enabled) return "disabled"
  if (formatter.available === false) return "unavailable"
  if (formatter.available === true) return "available"
  return "enabled"
}

function isBetterC0deRuntimeConfigKey(key: string): boolean {
  return (
    key === "attachment" ||
    key.startsWith("attachment.") ||
    key === "tool_output" ||
    key.startsWith("tool_output.") ||
    key === "compaction" ||
    key.startsWith("compaction.")
  )
}

function isBetterC0deAppRuntimeConfigKey(key: string): boolean {
  return (
    key === "shell" ||
    key === "logLevel" ||
    key === "server" ||
    key.startsWith("server.") ||
    key === "watcher" ||
    key.startsWith("watcher.") ||
    key === "snapshot" ||
    key === "share" ||
    key === "autoshare" ||
    key === "autoupdate" ||
    key === "default_agent" ||
    key === "username" ||
    key === "layout" ||
    key === "enterprise" ||
    key.startsWith("enterprise.") ||
    key === "experimental" ||
    key.startsWith("experimental.")
  )
}

function isBetterC0deTuiConfigKey(key: string): boolean {
  return (
    key === "theme" ||
    key === "keybinds" ||
    key.startsWith("keybinds.") ||
    key === "plugin_enabled" ||
    key.startsWith("plugin_enabled.") ||
    key === "leader_timeout" ||
    key === "attention" ||
    key.startsWith("attention.") ||
    key === "scroll_speed" ||
    key === "scroll_acceleration" ||
    key.startsWith("scroll_acceleration.") ||
    key === "diff_style" ||
    key === "mouse"
  )
}
