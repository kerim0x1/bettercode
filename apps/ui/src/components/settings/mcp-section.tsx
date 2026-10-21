import { useCallback, useEffect, useId, useState } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  slugifyRuntimeId,
  parseCliArgs,
  stringifyCliArgs,
  parseEnvText,
  stringifyEnv,
} from "@/lib/cli-parse"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { BrandMark, BrandMarks } from "@/components/settings/brand-mark"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import {
  canManageRuntimeConfig,
  deleteRuntimeMcp,
  listRuntimeMcps,
  probeRuntimeMcp,
  saveRuntimeMcp,
  setRuntimeMcpEnabled,
  RUNTIME_MCP_SECRET_PLACEHOLDER,
  type RuntimeMcpServer,
} from "@/lib/runtime-config"
import { handleError } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Loader2Icon,
  MonitorIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  WaypointsIcon,
  XIcon,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Wrench01Icon } from "@hugeicons/core-free-icons"
import { useActiveThread } from "@/lib/chat-store"
import {
  describeCliScanProjectScope,
  resolveCliScanContext,
} from "@/lib/cli-scan-context"
import { runCliSync, type CliSyncResult } from "@/hooks/use-cli-auto-sync"

// ── Pure helpers (exported for tests) ──────────────────────────────────────

export type McpTransport = "command" | "http" | "sse"

const TRANSPORT_LABEL: Record<McpTransport, string> = {
  command: "Command",
  http: "HTTP",
  sse: "SSE",
}

/** The CLIs a server can be imported from, by the `source` the desktop keeps. */
const CLI_SOURCE_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
}

export function cliSourceLabel(source: string | undefined): string | null {
  return source ? (CLI_SOURCE_LABEL[source] ?? null) : null
}

/**
 * How a stored server is reached. `oauth` and other remote kinds read as
 * HTTP; a record without a type is a command server unless it only has a URL.
 */
export function mcpTransportOf(server: {
  type?: string | null
  command?: string | null
  url?: string | null
}): McpTransport {
  const key = (server.type ?? "").trim().toLowerCase()
  if (key === "sse") return "sse"
  if (key === "command" || key === "stdio") return "command"
  if (key === "") {
    return server.command?.trim() || !server.url?.trim() ? "command" : "http"
  }
  return "http"
}

/** `Name: value` lines into headers; lines that are not a header are listed. */
export function parseHeaderText(text: string): {
  headers: Record<string, string>
  invalidLines: number[]
} {
  const headers: Record<string, string> = {}
  const invalidLines: number[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const separator = trimmed.indexOf(":")
    const name = separator > 0 ? trimmed.slice(0, separator).trim() : ""
    if (!name || /\s/.test(name)) {
      invalidLines.push(index + 1)
      return
    }
    headers[name] = trimmed.slice(separator + 1).trim()
  })
  return { headers, invalidLines }
}

export function stringifyHeaders(
  headers: Record<string, string> | undefined
): string {
  return Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n")
}

export interface McpServerForm {
  name: string
  transport: McpTransport
  command: string
  args: string
  envText: string
  url: string
  headersText: string
}

export const EMPTY_MCP_FORM: McpServerForm = {
  name: "",
  transport: "command",
  command: "",
  args: "",
  envText: "",
  url: "",
  headersText: "",
}

/** What editing a stored server must keep that the form does not show. */
export interface McpEditContext {
  id: string
  enabled: boolean
  /** The stored `type`, e.g. `oauth`, kept while the transport is unchanged. */
  originalType: string
  originalTransport: McpTransport
  /**
   * Header names an older store kept in `env` of a remote server. They go
   * back to `env`, so a kept `••••••••` value finds its stored value.
   */
  legacyHeaderKeys: string[]
  /** Headers filled from environment variables; kept, not edited here. */
  headerEnvKeys: string[]
}

export function mcpFormFromServer(server: RuntimeMcpServer): {
  form: McpServerForm
  edit: McpEditContext
} {
  const transport = mcpTransportOf(server)
  const remote = transport !== "command"
  const headers = server.headers ?? {}
  const legacy = remote ? server.env : {}
  return {
    form: {
      name: server.name,
      transport,
      command: remote ? "" : server.command,
      args: remote ? "" : stringifyCliArgs(server.args),
      envText: remote ? "" : stringifyEnv(server.env),
      url: server.url ?? "",
      headersText: remote ? stringifyHeaders({ ...legacy, ...headers }) : "",
    },
    edit: {
      id: server.id,
      enabled: server.enabled,
      originalType: server.type ?? "",
      originalTransport: transport,
      legacyHeaderKeys: Object.keys(legacy).filter((key) => !(key in headers)),
      headerEnvKeys: Object.keys(server.headerEnv ?? {}),
    },
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * The `mcp:install` payload for the form, or why it cannot be saved. A remote
 * server sends its URL and headers (placeholders keep stored values); a
 * command server clears the headers a former remote server had.
 */
export function buildMcpSavePayload(
  form: McpServerForm,
  edit: McpEditContext | null
):
  | { ok: true; payload: Partial<RuntimeMcpServer> & { id: string } }
  | { ok: false; error: string } {
  const name = form.name.trim()
  if (!name) return { ok: false, error: "Enter a name." }
  const id = edit?.id ?? slugifyRuntimeId(name)
  if (!id) return { ok: false, error: "Use letters or numbers in the name." }
  const type =
    edit && form.transport === edit.originalTransport && edit.originalType
      ? edit.originalType
      : form.transport
  const base = { id, name, type, enabled: edit?.enabled ?? true }

  if (form.transport === "command") {
    const command = form.command.trim()
    if (!command) {
      return { ok: false, error: "Enter the command that starts the server." }
    }
    return {
      ok: true,
      payload: {
        ...base,
        command,
        args: parseCliArgs(form.args),
        env: parseEnvText(form.envText),
        url: null,
        ...(edit && edit.originalTransport !== "command"
          ? { headers: {}, headerEnv: {} }
          : {}),
      },
    }
  }

  const url = form.url.trim()
  if (!isHttpUrl(url)) {
    return { ok: false, error: "Enter an http:// or https:// URL." }
  }
  const { headers, invalidLines } = parseHeaderText(form.headersText)
  if (invalidLines.length > 0) {
    return {
      ok: false,
      error: `Line ${invalidLines.join(", ")} of the headers isn't "Name: value".`,
    }
  }
  const legacy = new Set(
    edit && edit.originalTransport !== "command" ? edit.legacyHeaderKeys : []
  )
  const env: Record<string, string> = {}
  const staticHeaders: Record<string, string> = {}
  for (const [header, value] of Object.entries(headers)) {
    if (legacy.has(header)) env[header] = value
    else staticHeaders[header] = value
  }
  return {
    ok: true,
    payload: {
      ...base,
      command: "",
      args: [],
      url,
      env,
      headers: staticHeaders,
    },
  }
}

/**
 * The desktop refuses to store a command server the user did not allow in
 * its native approval dialog (apps/shell/mcp-ipc.cjs). Declining is a
 * decision, not a fault, so it gets plain wording.
 */
const COMMAND_NOT_APPROVED = /not (?:allowed|approved)/i

export function mcpActionErrorMessage(
  error: unknown,
  outcome: "Not saved" | "Not changed" | "Not removed"
): string {
  const message = error instanceof Error ? error.message : String(error)
  return COMMAND_NOT_APPROVED.test(message)
    ? `${outcome}: the command wasn't approved.`
    : `${outcome}: ${message}`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** The summary after "Sync from CLI" in Tools & MCP. */
export function describeMcpSync(result: CliSyncResult): {
  title: string
  details: string[]
} {
  if (result.found && !result.found.claude && !result.found.codex) {
    return {
      title: "Claude Code and Codex aren't installed on this computer.",
      details: [],
    }
  }
  const imported = result.imported.mcpServers
  const title =
    imported > 0
      ? `Imported ${plural(imported, "MCP server")}.`
      : "No new MCP servers to import."
  const details: string[] = []
  // An older desktop process imports skills and subagents with the servers.
  const extra: string[] = []
  if (result.imported.skills > 0)
    extra.push(plural(result.imported.skills, "skill"))
  if (result.imported.agents > 0)
    extra.push(plural(result.imported.agents, "subagent"))
  if (extra.length > 0) details.push(`Also imported ${extra.join(" and ")}.`)
  for (const skipped of result.skippedMcpServers ?? []) {
    const from = cliSourceLabel(skipped.source)
    details.push(
      `Skipped ${skipped.name || skipped.id}${from ? ` (${from})` : ""}: ${
        skipped.reason || "BetterC0de can't import it as it is."
      }`
    )
  }
  const workspace = result.skippedWorkspaceAssets ?? 0
  if (workspace > 0) {
    details.push(
      `Left out ${plural(workspace, "project item")}: they apply only in their own project.`
    )
  }
  const scope = describeCliScanProjectScope(result.projectScope).trim()
  if (scope) details.push(scope)
  return { title, details }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── Component ──────────────────────────────────────────────────────────────

type TestResult = { status: "success" | "error"; message?: string }

export function SettingsMcpSection() {
  const activeThread = useActiveThread()
  const activeProjectPath =
    activeThread?.worktreePath ?? activeThread?.projectPath ?? null
  const desktop = canManageRuntimeConfig()
  const confirm = useConfirm()
  const [servers, setServers] = useState<RuntimeMcpServer[]>([])
  const [loading, setLoading] = useState(desktop)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<McpServerForm>(EMPTY_MCP_FORM)
  const [edit, setEdit] = useState<McpEditContext | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [syncing, setSyncing] = useState(false)
  const [syncSummary, setSyncSummary] = useState<{
    title: string
    details: string[]
  } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setServers(await listRuntimeMcps())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!desktop) return
    refresh().catch(() => setLoading(false))
  }, [desktop, refresh])

  const closeForm = useCallback(() => {
    setShowForm(false)
    setEdit(null)
    setForm(EMPTY_MCP_FORM)
    setFormError(null)
  }, [])

  const openAddForm = useCallback(() => {
    setEdit(null)
    setForm(EMPTY_MCP_FORM)
    setFormError(null)
    setShowForm(true)
  }, [])

  const editServer = useCallback((server: RuntimeMcpServer) => {
    const next = mcpFormFromServer(server)
    setEdit(next.edit)
    setForm(next.form)
    setFormError(null)
    setShowForm(true)
  }, [])

  const saveServer = useCallback(async () => {
    if (saving) return
    const built = buildMcpSavePayload(form, edit)
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    const { payload } = built
    if (!edit) {
      const existing = servers.find((server) => server.id === payload.id)
      if (existing) {
        const replace = await confirm({
          title: `Replace ${existing.name}?`,
          description:
            "A server with this name already exists. Adding this one replaces its settings.",
          confirmLabel: "Replace",
          destructive: true,
        })
        if (!replace) return
      }
    }
    setSaving(true)
    setFormError(null)
    try {
      // A new or changed command waits for the desktop's approval dialog.
      await saveRuntimeMcp(payload)
    } catch (error) {
      // Keep the form and its text so the user can change or retry it.
      setFormError(mcpActionErrorMessage(error, "Not saved"))
      return
    } finally {
      setSaving(false)
    }
    // A test of the old settings says nothing about the saved ones.
    setTestResults((prev) => {
      const next = { ...prev }
      delete next[payload.id]
      return next
    })
    toast.success(edit ? `Saved ${payload.name}` : `Added ${payload.name}`)
    closeForm()
    await refresh().catch((error) =>
      handleError(error, { source: "settings-mcp", silent: true })
    )
  }, [closeForm, confirm, edit, form, refresh, saving, servers])

  const toggleServer = useCallback(
    async (server: RuntimeMcpServer, enabled: boolean) => {
      setBusyId(server.id)
      try {
        await setRuntimeMcpEnabled(server.id, enabled)
      } catch (error) {
        handleError(error, { source: "settings-mcp", silent: true })
        toast.error(
          enabled
            ? `Couldn't turn on ${server.name}`
            : `Couldn't turn off ${server.name}`,
          { description: errorText(error) }
        )
      } finally {
        setBusyId(null)
      }
      await refresh().catch(() => {})
    },
    [refresh]
  )

  const removeServer = useCallback(
    async (server: RuntimeMcpServer) => {
      const from = cliSourceLabel(server.source)
      const ok = await confirm({
        title: `Remove ${server.name}?`,
        description: from
          ? `It stays in ${from}'s own config. BetterC0de won't import it again on its own; Sync from CLI brings it back.`
          : "The server and its saved settings are deleted from BetterC0de. This can't be undone.",
        confirmLabel: "Remove",
        destructive: true,
      })
      if (!ok) return
      setBusyId(server.id)
      try {
        await deleteRuntimeMcp(server.id)
      } catch (error) {
        handleError(error, { source: "settings-mcp", silent: true })
        toast.error(`Couldn't remove ${server.name}`, {
          description: errorText(error),
        })
        return
      } finally {
        setBusyId(null)
      }
      setTestResults((prev) => {
        const next = { ...prev }
        delete next[server.id]
        return next
      })
      if (edit?.id === server.id) closeForm()
      await refresh().catch(() => {})
    },
    [closeForm, confirm, edit, refresh]
  )

  const testConnection = useCallback(async (server: RuntimeMcpServer) => {
    setTestingId(server.id)
    try {
      const result = await probeRuntimeMcp(server)
      setTestResults((prev) => ({
        ...prev,
        [server.id]: result.ok
          ? {
              status: "success",
              message: result.note || result.stdout || "The server started.",
            }
          : {
              status: "error",
              message:
                result.error ||
                result.stderr ||
                result.stdout ||
                "The server didn't start.",
            },
      }))
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [server.id]: { status: "error", message: "The test couldn't run." },
      }))
    } finally {
      setTestingId(null)
    }
  }, [])

  const syncFromCli = useCallback(async () => {
    setSyncing(true)
    setSyncSummary(null)
    try {
      const scanContext = await resolveCliScanContext(activeProjectPath)
      // A manual sync imports MCP servers only, and brings back ones the
      // user removed; automatic syncs leave those out.
      const result = await runCliSync({
        ...(scanContext ?? {}),
        kinds: ["mcpServers"],
        includeDismissed: true,
      })
      if (!result) {
        setSyncSummary({
          title: "Only available in the desktop app.",
          details: [],
        })
        return
      }
      if (!result.ok) {
        toast.error("Couldn't sync from Claude Code and Codex", {
          description: result.error || "The import failed.",
        })
        return
      }
      setSyncSummary(describeMcpSync(result))
      await refresh().catch(() => {})
    } catch (error) {
      handleError(error, { source: "settings-mcp-sync", silent: true })
      toast.error("Couldn't sync from Claude Code and Codex", {
        description: errorText(error),
      })
    } finally {
      setSyncing(false)
    }
  }, [activeProjectPath, refresh])

  if (!desktop) {
    return (
      <SettingsSection
        title="MCP servers"
        description="MCP servers give the AI extra tools (databases, browsers, APIs)."
      >
        <SettingsRow
          label="Managed in the BetterC0de desktop app."
          description="Add, edit and sync MCP servers on the computer that runs BetterC0de."
          icon={<MonitorIcon />}
        >
          {null}
        </SettingsRow>
      </SettingsSection>
    )
  }

  if (loading) {
    return (
      <SettingsSection title="MCP servers">
        <div
          role="status"
          className="flex items-center justify-center gap-2 px-6 py-8 text-sm text-muted-foreground"
        >
          <Loader2Icon
            aria-hidden="true"
            className="size-4 motion-safe:animate-spin"
          />
          Loading MCP servers…
        </div>
      </SettingsSection>
    )
  }

  return (
    <>
      <SettingsSection
        title="MCP servers"
        description="MCP servers give the AI extra tools (databases, browsers, APIs)."
      >
        <SettingsRow
          label="Used by"
          description="Claude Code and Codex use their own MCP config."
          icon={<WaypointsIcon />}
        >
          <UsedByProviders />
        </SettingsRow>
        <SettingsRow
          label="Import from Claude Code and Codex"
          description="Adds servers from their MCP config that aren't here yet, including ones you removed."
          icon={<RefreshCwIcon />}
        >
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-2"
            disabled={syncing}
            aria-busy={syncing || undefined}
            onClick={syncFromCli}
          >
            {syncing ? (
              <Loader2Icon
                aria-hidden="true"
                className="size-3.5 motion-safe:animate-spin"
              />
            ) : (
              <BrandMarks ids={["claude", "codex"]} />
            )}
            {syncing ? "Syncing…" : "Sync from CLI"}
          </Button>
        </SettingsRow>
      </SettingsSection>

      {syncSummary ? (
        <SyncSummary
          summary={syncSummary}
          onDismiss={() => setSyncSummary(null)}
        />
      ) : null}

      <SettingsSection title="Servers">
        {servers.length === 0 && !showForm ? (
          <div className="px-6 py-8 text-center">
            <HugeiconsIcon
              icon={Wrench01Icon}
              strokeWidth={2}
              aria-hidden="true"
              className="mx-auto size-8 text-muted-foreground/40"
            />
            <p className="mt-2 text-sm text-muted-foreground">
              No MCP servers yet
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              MCP servers give the AI extra tools (databases, browsers, APIs).
            </p>
          </div>
        ) : null}
        {servers.map((server) => (
          <McpServerRow
            key={server.id}
            server={server}
            busy={busyId === server.id}
            testing={testingId === server.id}
            testResult={testResults[server.id]}
            onTest={() => testConnection(server)}
            onEdit={() => editServer(server)}
            onToggle={(enabled) => toggleServer(server, enabled)}
            onRemove={() => removeServer(server)}
          />
        ))}
        {showForm ? (
          <McpServerFormView
            form={form}
            edit={edit}
            saving={saving}
            error={formError}
            onChange={(next) => {
              setForm(next)
              setFormError(null)
            }}
            onCancel={closeForm}
            onSave={saveServer}
          />
        ) : (
          <div className="px-3 py-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={openAddForm}
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
              Add server
            </Button>
          </div>
        )}
      </SettingsSection>
    </>
  )
}

function UsedByProviders() {
  return (
    <span className="flex shrink-0 items-center gap-2 text-[12.5px] text-muted-foreground">
      <BrandMarks ids={["cursor", "grok-cli"]} />
      <span>API models</span>
    </span>
  )
}

function SyncSummary({
  summary,
  onDismiss,
}: {
  summary: { title: string; details: string[] }
  onDismiss: () => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-3 rounded-xl border border-border/50 bg-muted/30 px-4 py-3 text-[12.5px] leading-snug"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{summary.title}</p>
        {summary.details.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {summary.details.map((detail, index) => (
              <li key={index} className="break-words">
                {detail}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss the sync summary"
        className="text-muted-foreground"
        onClick={onDismiss}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  )
}

function serverStatus(
  server: RuntimeMcpServer,
  remote: boolean,
  test: TestResult | undefined
): { label: string; className: string } {
  if (test?.status === "success")
    return { label: "Test passed", className: "bg-success" }
  if (test?.status === "error")
    return { label: "Test failed", className: "bg-destructive" }
  if (!server.enabled)
    return { label: "Off", className: "bg-muted-foreground/40" }
  return remote
    ? {
        label: "On. Remote servers aren't tested here.",
        className: "bg-warning",
      }
    : {
        label: "On, not tested yet. Use Test to check it starts.",
        className: "bg-warning",
      }
}

function McpServerRow({
  server,
  busy,
  testing,
  testResult,
  onTest,
  onEdit,
  onToggle,
  onRemove,
}: {
  server: RuntimeMcpServer
  busy: boolean
  testing: boolean
  testResult: TestResult | undefined
  onTest: () => void
  onEdit: () => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}) {
  const transport = mcpTransportOf(server)
  const remote = transport !== "command"
  const status = serverStatus(server, remote, testResult)
  const from = cliSourceLabel(server.source)
  const signsInThroughCli =
    server.type === "oauth" || server.authenticated === true
  const target = remote
    ? server.url || "No URL"
    : [server.command, stringifyCliArgs(server.args)].filter(Boolean).join(" ")

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 px-4 py-3.5">
      <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-3">
        <span className="mt-1.5 flex size-4 shrink-0 items-center justify-center">
          <span
            role="img"
            aria-label={status.label}
            title={status.label}
            className={cn("size-2 rounded-full", status.className)}
          />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-medium break-words">{server.name}</p>
            {remote ? (
              <Badge variant="outline" className="h-4.5 px-1.5 text-[10px]">
                {TRANSPORT_LABEL[transport]}
              </Badge>
            ) : null}
            {from && server.source ? (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                Imported from
                <BrandMark id={server.source} label />
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 font-mono text-[11.5px] break-all text-muted-foreground">
            {target}
          </p>
          {signsInThroughCli ? (
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              Signs in through Claude Code, so BetterC0de doesn&apos;t start it.
            </p>
          ) : null}
          {testResult?.message ? (
            <p
              role="status"
              className={cn(
                "mt-0.5 line-clamp-3 text-[11.5px] break-words",
                testResult.status === "success"
                  ? "text-success"
                  : "text-destructive"
              )}
            >
              {testResult.message}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {remote ? null : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            disabled={testing}
            aria-label={`Test ${server.name}`}
            aria-busy={testing || undefined}
            onClick={onTest}
          >
            {testing ? (
              <Loader2Icon
                aria-hidden="true"
                className="size-3 motion-safe:animate-spin"
              />
            ) : (
              "Test"
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Edit ${server.name}`}
          title={`Edit ${server.name}`}
          className="text-muted-foreground"
          onClick={onEdit}
        >
          <PencilIcon aria-hidden="true" className="size-3.5" />
        </Button>
        <Switch
          checked={server.enabled}
          disabled={busy}
          aria-label={`Enable ${server.name}`}
          onCheckedChange={onToggle}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${server.name}`}
          title={`Remove ${server.name}`}
          className="text-muted-foreground hover:text-destructive"
          disabled={busy}
          onClick={onRemove}
        >
          <Trash2Icon aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

const FIELD_LABEL_CLASS = "text-[11px] font-medium text-muted-foreground"

function McpServerFormView({
  form,
  edit,
  saving,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  form: McpServerForm
  edit: McpEditContext | null
  saving: boolean
  error: string | null
  onChange: (form: McpServerForm) => void
  onCancel: () => void
  onSave: () => void
}) {
  const id = useId()
  const remote = form.transport !== "command"
  const canSave =
    !!form.name.trim() && (remote ? !!form.url.trim() : !!form.command.trim())
  const secretsShown = remote
    ? form.headersText.includes(RUNTIME_MCP_SECRET_PLACEHOLDER)
    : form.envText.includes(RUNTIME_MCP_SECRET_PLACEHOLDER)

  return (
    <form
      aria-label={edit ? `Edit ${form.name || "MCP server"}` : "New MCP server"}
      className="space-y-3 bg-muted/20 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSave) onSave()
      }}
    >
      <p className="text-[13px] font-semibold">
        {edit ? "Edit MCP server" : "New MCP server"}
      </p>
      <div className="grid gap-3 @min-[560px]/settings:grid-cols-[1fr_12rem]">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-name`} className={FIELD_LABEL_CLASS}>
            Name
          </label>
          <Input
            id={`${id}-name`}
            autoFocus
            className="h-8 text-xs"
            placeholder="My MCP server"
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-transport`} className={FIELD_LABEL_CLASS}>
            Transport
          </label>
          <Select
            value={form.transport}
            onValueChange={(value) =>
              onChange({ ...form, transport: value as McpTransport })
            }
          >
            <SelectTrigger
              id={`${id}-transport`}
              size="sm"
              className="w-full text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="command">Command</SelectItem>
              <SelectItem value="http">HTTP</SelectItem>
              <SelectItem value="sse">SSE</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {remote ? (
        <>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-url`} className={FIELD_LABEL_CLASS}>
              URL
            </label>
            <Input
              id={`${id}-url`}
              type="url"
              inputMode="url"
              className="h-8 font-mono text-xs"
              placeholder="https://mcp.example.com/mcp"
              value={form.url}
              onChange={(e) => onChange({ ...form, url: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-headers`} className={FIELD_LABEL_CLASS}>
              Headers
            </label>
            <Textarea
              id={`${id}-headers`}
              className="min-h-[60px] font-mono text-xs"
              placeholder={"Authorization: Bearer …\nX-Team: platform"}
              value={form.headersText}
              onChange={(e) =>
                onChange({ ...form, headersText: e.target.value })
              }
              rows={3}
            />
            {edit && edit.headerEnvKeys.length > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Headers filled from environment variables stay as they are:{" "}
                <span className="font-mono">
                  {edit.headerEnvKeys.join(", ")}
                </span>
                .
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-command`} className={FIELD_LABEL_CLASS}>
              Command
            </label>
            <Input
              id={`${id}-command`}
              className="h-8 font-mono text-xs"
              placeholder="npx"
              value={form.command}
              onChange={(e) => onChange({ ...form, command: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-args`} className={FIELD_LABEL_CLASS}>
              Arguments
            </label>
            <Input
              id={`${id}-args`}
              className="h-8 font-mono text-xs"
              placeholder="-y @modelcontextprotocol/server-filesystem ~/projects"
              value={form.args}
              onChange={(e) => onChange({ ...form, args: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-env`} className={FIELD_LABEL_CLASS}>
              Environment variables
            </label>
            <Textarea
              id={`${id}-env`}
              className="min-h-[60px] font-mono text-xs"
              placeholder={"KEY=value\nANOTHER_KEY=value"}
              value={form.envText}
              onChange={(e) => onChange({ ...form, envText: e.target.value })}
              rows={3}
            />
          </div>
        </>
      )}

      {secretsShown ? (
        <p className="text-[11px] text-muted-foreground">
          Saved values stay hidden. Leave{" "}
          <span className="font-mono">{RUNTIME_MCP_SECRET_PLACEHOLDER}</span> in
          place to keep a value, or type a new one.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs break-words text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={!canSave || saving}
          aria-busy={saving || undefined}
        >
          {saving ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-3.5 motion-safe:animate-spin"
            />
          ) : null}
          {edit ? "Save server" : "Add server"}
        </Button>
      </div>
    </form>
  )
}
