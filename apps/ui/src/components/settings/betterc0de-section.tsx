import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import {
  BotIcon,
  BracesIcon,
  CircleAlertIcon,
  CloudIcon,
  CpuIcon,
  FileCogIcon,
  FileTextIcon,
  GaugeIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlugIcon,
  PuzzleIcon,
  RefreshCwIcon,
  Settings2Icon,
  ShieldCheckIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SquareSlashIcon,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { SettingsSection } from "@/components/settings/atoms"
import { BrandMarks } from "@/components/settings/brand-mark"
import { useActiveThread } from "@/lib/chat-store"
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

type BlockKey = keyof BetterC0deProjectState

/** Why each part of the project's config failed to load, when it did. */
type BlockErrors = Partial<Record<BlockKey, string>>

const BLOCK_LABEL: Record<BlockKey, string> = {
  config: "config settings",
  commands: "commands",
  agents: "agents",
  skills: "skills",
  mcps: "MCP servers",
  instructions: "instructions",
  references: "references",
  formatters: "formatters",
  lspServers: "language servers",
  permissions: "permissions",
  providers: "providers",
  plugins: "plugins",
  tools: "tool settings",
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

/** A table row: three text cells and an optional mark before the first. */
type TableRow = readonly [string, string, string, ReactNode?]

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The tools that read an instruction file, by its name: CLAUDE.md is
 * Claude Code's, AGENTS.md the shared standard Codex and Cursor read, and
 * .cursorrules / .cursor/rules are Cursor's.
 */
function instructionBrands(sourcePath: string): readonly string[] {
  const normalized = sourcePath.replace(/\\/g, "/").toLowerCase()
  const name = normalized.split("/").pop() ?? ""
  if (name === "claude.md" || name === "claude.local.md") return ["claude"]
  if (name === "agents.md") return ["codex", "cursor"]
  if (name === ".cursorrules" || normalized.includes(".cursor/rules/")) {
    return ["cursor"]
  }
  return []
}

/** Project skills from Claude Code's folder or the shared agents folder. */
function skillBrands(sourcePath: string): readonly string[] {
  const normalized = sourcePath.replace(/\\/g, "/").toLowerCase()
  if (normalized.includes(".claude/skills/")) return ["claude"]
  if (
    normalized.includes(".agents/skills/") ||
    normalized.includes(".codex/skills/")
  ) {
    return ["codex"]
  }
  return []
}

/** The brand mark id for a provider id from the project's config. */
function providerBrandId(id: string): string | null {
  switch (id.trim().toLowerCase()) {
    case "anthropic":
      return "anthropic"
    case "openai":
      return "openai"
    case "xai":
    case "grok":
      return "grok"
    case "openrouter":
      return "openrouter"
    case "lmstudio":
      return "lmstudio"
    default:
      return null
  }
}

function brandMarks(ids: readonly string[]): ReactNode {
  return ids.length > 0 ? <BrandMarks ids={ids} /> : undefined
}

export function SettingsBetterC0deSection() {
  const activeThread = useActiveThread()
  // The chat's own checkout, like Rules: a ready worktree first.
  const workspacePath =
    (activeThread?.worktreeState && activeThread.worktreeState !== "ready"
      ? ""
      : activeThread?.worktreePath?.trim()) ||
    activeThread?.projectPath?.trim() ||
    ""
  const [state, setState] = useState<BetterC0deProjectState>(EMPTY_STATE)
  const [errors, setErrors] = useState<BlockErrors>({})
  const [loading, setLoading] = useState(false)
  const request = useRef(0)

  const refresh = useCallback(async () => {
    const requestId = ++request.current
    if (!workspacePath) {
      setState(EMPTY_STATE)
      setErrors({})
      setLoading(false)
      return
    }
    setLoading(true)
    // Each part loads on its own: one failing request shows its own error
    // instead of blanking the page.
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
    ] = await Promise.allSettled([
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
    if (requestId !== request.current) return
    const nextErrors: BlockErrors = {}
    function settled<T>(
      key: BlockKey,
      result: PromiseSettledResult<T>,
      fallback: T
    ): T {
      if (result.status === "fulfilled") return result.value
      nextErrors[key] = errorText(result.reason)
      return fallback
    }
    setState({
      config: settled("config", config, []),
      commands: settled("commands", commands, []),
      agents: settled("agents", agents, []),
      skills: settled("skills", skills, []),
      mcps: settled("mcps", mcps, []),
      instructions: settled("instructions", instructions, []),
      references: settled("references", references, []),
      formatters: settled("formatters", formatters, []),
      lspServers: settled("lspServers", lspServers, []),
      permissions: settled("permissions", permissions, []),
      providers: settled("providers", providers, null),
      plugins: settled("plugins", plugins, []),
      tools: settled("tools", tools, []),
    })
    setErrors(nextErrors)
    setLoading(false)
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!workspacePath) {
    return (
      <SettingsSection
        title="BetterC0de Compatibility"
        description="What this project's config files set up (read-only)."
      >
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          Open a chat in a project to see its config.
        </div>
      </SettingsSection>
    )
  }

  const failedKeys = Object.keys(errors) as BlockKey[]
  const allFailed = failedKeys.length === Object.keys(BLOCK_LABEL).length
  const providerSummary = state.providers
  const runtimeConfigRows = state.config.filter((setting) =>
    isBetterC0deRuntimeConfigKey(setting.key)
  )
  const appRuntimeConfigRows = state.config.filter((setting) =>
    isBetterC0deAppRuntimeConfigKey(setting.key)
  )
  const providerRows: TableRow[] =
    providerSummary?.providers.map((provider): TableRow => {
      const brand = providerBrandId(provider.id)
      return [
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
        brandMarks(brand ? [brand] : []),
      ]
    }) ?? []
  const providerModelRows: TableRow[] =
    providerSummary?.providers.flatMap((provider) => {
      const brand = providerBrandId(provider.id)
      return provider.models.map(
        (model): TableRow => [
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
            model.variants.length
              ? `variants ${formatList(model.variants)}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ") ||
            model.name ||
            "-",
          model.sourcePath,
          brandMarks(brand ? [brand] : []),
        ]
      )
    }) ?? []
  const providerAuthRows: TableRow[] =
    providerSummary?.authAccounts.map((account): TableRow => {
      const brand = providerBrandId(account.serviceId)
      return [
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
        brandMarks(brand ? [brand] : []),
      ]
    }) ?? []
  const agentPermissionRows: TableRow[] = state.agents.flatMap((agent) =>
    agent.permissions.map(
      (rule): TableRow => [
        agent.name || agent.id,
        `${rule.permission} ${rule.pattern} -> ${rule.action}`,
        rule.sourcePath,
      ]
    )
  )
  const summaryRows: ReadonlyArray<{
    label: string
    value: number
    block: BlockKey
  }> = [
    { label: "Config", value: state.config.length, block: "config" },
    { label: "Commands", value: state.commands.length, block: "commands" },
    { label: "Agents", value: state.agents.length, block: "agents" },
    { label: "Skills", value: state.skills.length, block: "skills" },
    { label: "MCP", value: state.mcps.length, block: "mcps" },
    {
      label: "References",
      value: state.references.length,
      block: "references",
    },
    {
      label: "Permissions",
      value: state.permissions.length,
      block: "permissions",
    },
    {
      label: "Agent permissions",
      value: agentPermissionRows.length,
      block: "agents",
    },
    {
      label: "Providers",
      value: providerSummary?.providers.length ?? 0,
      block: "providers",
    },
    { label: "Plugins", value: state.plugins.length, block: "plugins" },
    { label: "Tool settings", value: state.tools.length, block: "tools" },
  ]

  const configRow = (setting: WorkspaceProjectConfigSetting): TableRow => [
    setting.label,
    setting.value,
    setting.sourcePath,
  ]

  return (
    <div className="space-y-4">
      <SettingsSection
        title="BetterC0de Project"
        description="Settings found in this project's files."
        icon={<SectionIcon icon={FileCogIcon} />}
      >
        <div className="space-y-4 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {activeThread?.projectName ||
                  workspacePath.split(/[\\/]/).pop()}
              </div>
              <div
                className="truncate font-mono text-[11px] text-muted-foreground"
                title={workspacePath}
              >
                {workspacePath}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void refresh()}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? (
                <Loader2Icon
                  aria-hidden="true"
                  className="size-3.5 motion-safe:animate-spin"
                />
              ) : (
                <RefreshCwIcon aria-hidden="true" className="size-3.5" />
              )}
              Refresh
            </Button>
          </div>

          {allFailed ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <CircleAlertIcon
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0"
              />
              <span className="min-w-0 text-pretty">
                Couldn&apos;t load this project&apos;s config:{" "}
                {errors.config ?? Object.values(errors)[0]}
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {summaryRows.map(({ label, value, block }) => {
                const failed = Boolean(errors[block])
                return (
                  <div
                    key={label}
                    className="rounded-md border border-border/50 bg-muted/20 px-3 py-2"
                  >
                    <div
                      className={
                        failed
                          ? "text-lg font-semibold text-destructive tabular-nums"
                          : "text-lg font-semibold tabular-nums"
                      }
                    >
                      {failed ? (
                        <span title="Couldn't load">
                          <span aria-hidden="true">–</span>
                          <span className="sr-only">Couldn&apos;t load</span>
                        </span>
                      ) : (
                        value
                      )}
                    </div>
                    <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                      {label}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </SettingsSection>

      {allFailed ? null : (
        <>
          <ConfigSection
            title="Provider Policy"
            icon={SlidersHorizontalIcon}
            errors={errors}
            blocks={["providers"]}
          >
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
              ) : errors.providers ? null : (
                <div className="text-muted-foreground">
                  No provider policy found.
                </div>
              )}
            </div>
          </ConfigSection>

          <ConfigSection
            title="Project Providers"
            icon={CloudIcon}
            errors={errors}
            blocks={["providers"]}
          >
            <CompactTable
              empty="No custom project providers found."
              rows={providerRows}
              failed={Boolean(errors.providers)}
            />
          </ConfigSection>

          <ConfigSection
            title="Project Provider Models"
            icon={CpuIcon}
            errors={errors}
            blocks={["providers"]}
          >
            <CompactTable
              empty="No project provider model overrides found."
              rows={providerModelRows}
              failed={Boolean(errors.providers)}
            />
          </ConfigSection>

          <ConfigSection
            title="Provider Auth"
            icon={KeyRoundIcon}
            errors={errors}
            blocks={["providers"]}
          >
            <CompactTable
              empty="No provider auth accounts found."
              rows={providerAuthRows}
              failed={Boolean(errors.providers)}
            />
          </ConfigSection>

          <ConfigSection
            title="Runtime Limits"
            icon={GaugeIcon}
            errors={errors}
            blocks={["config"]}
          >
            <CompactTable
              empty="No attachment, tool output, or compaction settings found."
              rows={runtimeConfigRows.map(configRow)}
              failed={Boolean(errors.config)}
            />
          </ConfigSection>

          <ConfigSection
            title="Runtime & App Config"
            icon={Settings2Icon}
            errors={errors}
            blocks={["config"]}
          >
            <CompactTable
              empty="No runtime, server, watcher, or app config found."
              rows={appRuntimeConfigRows.map(configRow)}
              failed={Boolean(errors.config)}
            />
          </ConfigSection>

          <ConfigSection
            title="Config Settings"
            icon={FileCogIcon}
            errors={errors}
            blocks={["config"]}
          >
            <CompactTable
              empty="No config settings found."
              rows={state.config.map(configRow)}
              failed={Boolean(errors.config)}
            />
          </ConfigSection>

          <ConfigSection
            title="Commands"
            icon={SquareSlashIcon}
            errors={errors}
            blocks={["commands"]}
          >
            <CompactTable
              empty="No project commands found."
              failed={Boolean(errors.commands)}
              rows={state.commands.map(
                (command): TableRow => [
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
                ]
              )}
            />
          </ConfigSection>

          <ConfigSection
            title="Permissions"
            icon={ShieldIcon}
            errors={errors}
            blocks={["permissions"]}
          >
            <CompactTable
              empty="No project permission rules found."
              failed={Boolean(errors.permissions)}
              rows={state.permissions.map(
                (rule): TableRow => [
                  `${rule.permission} ${rule.pattern}`,
                  rule.action,
                  rule.sourcePath,
                ]
              )}
            />
          </ConfigSection>

          <ConfigSection
            title="Agent Permissions"
            icon={ShieldCheckIcon}
            errors={errors}
            blocks={["agents"]}
          >
            <CompactTable
              empty="No agent-specific permission rules found."
              rows={agentPermissionRows}
              failed={Boolean(errors.agents)}
            />
          </ConfigSection>

          <ConfigSection
            title="Agents & Skills"
            icon={BotIcon}
            errors={errors}
            blocks={["agents", "skills"]}
          >
            <CompactTable
              empty="No project agents or skills found."
              failed={Boolean(errors.agents || errors.skills)}
              rows={[
                ...state.agents.map(
                  (agent): TableRow => [
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
                  ]
                ),
                ...state.skills.map(
                  (skill): TableRow => [
                    `$${skill.name}`,
                    skill.description || `${skill.content.length} chars`,
                    skill.sourceUrl || skill.sourcePath,
                    brandMarks(skillBrands(skill.sourcePath)),
                  ]
                ),
              ]}
            />
          </ConfigSection>

          <ConfigSection
            title="MCP & References"
            icon={PlugIcon}
            errors={errors}
            blocks={["mcps", "references"]}
          >
            <CompactTable
              empty="No project MCP servers or references found."
              failed={Boolean(errors.mcps || errors.references)}
              rows={[
                ...state.mcps.map(
                  (mcp): TableRow => [
                    mcp.name || mcp.id,
                    [
                      mcp.type === "remote"
                        ? mcp.url || mcp.command
                        : [mcp.command, ...mcp.args].join(" "),
                      mcp.envKeys?.length
                        ? `env ${formatList(mcp.envKeys)}`
                        : "",
                      mcp.headerKeys?.length
                        ? `headers ${formatList(mcp.headerKeys)}`
                        : "",
                      mcp.timeoutMs ? `timeout ${mcp.timeoutMs}ms` : "",
                      mcp.oauth ? `oauth ${formatMcpOAuth(mcp)}` : "",
                      mcp.authStatus ? `auth ${formatMcpAuthStatus(mcp)}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · "),
                    mcp.enabled
                      ? mcp.sourcePath
                      : `${mcp.sourcePath} (disabled)`,
                  ]
                ),
                ...state.references.map(
                  (ref): TableRow => [
                    `@${ref.name}`,
                    ref.kind === "git"
                      ? [ref.repository, ref.branch].filter(Boolean).join(" ")
                      : ref.relativePath || ref.path || ref.message || ref.kind,
                    ref.sourcePath,
                  ]
                ),
              ]}
            />
          </ConfigSection>

          <ConfigSection
            title="Formatters & LSP"
            icon={BracesIcon}
            errors={errors}
            blocks={["formatters", "lspServers"]}
          >
            <CompactTable
              empty="No formatter or language server config found."
              failed={Boolean(errors.formatters || errors.lspServers)}
              rows={[
                ...state.formatters.map(
                  (formatter): TableRow => [
                    formatter.name || formatter.id,
                    formatter.builtin
                      ? "built-in"
                      : [formatter.command, ...formatter.args].join(" "),
                    `${formatter.sourcePath} (${formatFormatterStatus(formatter)})`,
                  ]
                ),
                ...state.lspServers.map(
                  (server): TableRow => [
                    server.name || server.id,
                    server.builtin
                      ? "built-in"
                      : [server.command, ...server.args].join(" "),
                    server.enabled
                      ? server.sourcePath
                      : `${server.sourcePath} (disabled)`,
                  ]
                ),
              ]}
            />
          </ConfigSection>

          <ConfigSection
            title="Instructions"
            icon={FileTextIcon}
            errors={errors}
            blocks={["instructions"]}
          >
            <CompactTable
              empty="No project instruction files found."
              failed={Boolean(errors.instructions)}
              rows={state.instructions.map(
                (instruction): TableRow => [
                  instruction.sourcePath,
                  `${instruction.content.length} chars`,
                  instruction.content.split(/\r?\n/)[0] || "-",
                  brandMarks(instructionBrands(instruction.sourcePath)),
                ]
              )}
            />
          </ConfigSection>

          <ConfigSection
            title="Plugins & Tools"
            icon={PuzzleIcon}
            errors={errors}
            blocks={["plugins", "tools"]}
          >
            <CompactTable
              empty="No project plugins or tool settings found."
              failed={Boolean(errors.plugins || errors.tools)}
              rows={[
                ...state.plugins.map(
                  (plugin): TableRow => [
                    plugin.spec,
                    plugin.kind,
                    [
                      plugin.message ?? plugin.sourcePath,
                      plugin.metaLoadCount
                        ? `loaded ${plugin.metaLoadCount}x`
                        : "",
                      plugin.metaVersion ? `v${plugin.metaVersion}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  ]
                ),
                ...state.tools.map(
                  (tool): TableRow => [
                    tool.tool,
                    tool.kind === "custom"
                      ? `custom${tool.exportName ? `:${tool.exportName}` : ""}`
                      : tool.enabled
                        ? "enabled"
                        : "disabled",
                    tool.sourcePath,
                  ]
                ),
              ]}
            />
          </ConfigSection>
        </>
      )}
    </div>
  )
}

function SectionIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
}

/** A settings card for one part of the config, with that part's errors. */
function ConfigSection({
  title,
  icon,
  errors,
  blocks,
  children,
}: {
  title: string
  icon: LucideIcon
  errors: BlockErrors
  blocks: readonly BlockKey[]
  children: ReactNode
}) {
  const failures = blocks.flatMap((block) =>
    errors[block]
      ? [`Couldn't load ${BLOCK_LABEL[block]}: ${errors[block]}`]
      : []
  )
  return (
    <SettingsSection title={title} icon={<SectionIcon icon={icon} />}>
      {failures.map((failure) => (
        <p
          key={failure}
          role="alert"
          className="flex items-start gap-2 px-4 py-2.5 text-xs text-destructive"
        >
          <CircleAlertIcon
            aria-hidden="true"
            className="mt-px size-3.5 shrink-0"
          />
          <span className="min-w-0 text-pretty">{failure}</span>
        </p>
      ))}
      {children}
    </SettingsSection>
  )
}

function KeyValue({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono" title={value || undefined}>
        {value || "-"}
      </span>
    </div>
  )
}

function CompactTable({
  empty,
  rows,
  failed = false,
}: {
  empty: string
  rows: ReadonlyArray<TableRow>
  /** A part of this table failed to load; its error is shown above. */
  failed?: boolean
}) {
  if (rows.length === 0) {
    return failed ? null : (
      <div className="px-4 py-3 text-xs text-muted-foreground">{empty}</div>
    )
  }
  return (
    <div className="@container divide-y divide-border/40">
      {rows.map((row, index) => (
        <div
          key={`${row[0]}-${index}`}
          className="grid gap-x-3 gap-y-0.5 px-4 py-2.5 text-xs @lg:grid-cols-[minmax(110px,0.9fr)_minmax(120px,1fr)_minmax(120px,1fr)]"
        >
          <span className="flex min-w-0 items-center gap-2">
            {row[3] ? (
              <span className="flex shrink-0 items-center">{row[3]}</span>
            ) : null}
            <span className="min-w-0 truncate font-medium" title={row[0]}>
              {row[0]}
            </span>
          </span>
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={row[1]}
          >
            {row[1]}
          </span>
          <span
            className="min-w-0 truncate font-mono text-muted-foreground/80"
            title={row[2]}
          >
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
