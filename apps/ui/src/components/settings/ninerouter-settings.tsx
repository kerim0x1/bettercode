import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  NINEROUTER_DEFAULT_BASE_URL,
  NINEROUTER_DOCS_URL,
  normalizeNineRouterBaseUrl,
  type NineRouterConnectionView,
  type NineRouterDetectResult,
  type NineRouterProviderView,
} from "@betterc0de/schema"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RadarIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  WifiOffIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { cn } from "@/lib/utils"
import { notifyNineRouterUpdated } from "@/lib/ninerouter-providers"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import {
  addNineRouterConnection,
  detectNineRouter,
  getNineRouter,
  removeNineRouterConnection,
  testNineRouterConnection,
  updateNineRouterConnection,
} from "@/services/backend/providersApi"

type Status = NineRouterConnectionView["status"]

export interface NineRouterConnectionDraft {
  name: string
  baseUrl: string
  apiKey: string
}

/** Edit form result: only the fields that changed. */
export interface NineRouterConnectionEdit {
  name?: string
  baseUrl?: string
  apiKey?: { set: string } | { clear: true }
  tokenSaver?: boolean
}

export interface NineRouterSettingsPanelProps {
  view: NineRouterProviderView | null
  detection: NineRouterDetectResult | null
  busy: string | null
  error: string | null
  onToggleProvider: (enabled: boolean) => void
  onDetect: () => void
  onAdd: (draft: NineRouterConnectionDraft) => Promise<boolean>
  onEdit: (id: string, edit: NineRouterConnectionEdit) => Promise<boolean>
  onToggleConnection: (id: string, enabled: boolean) => void
  onTest: (id: string) => void
  onRemove: (id: string) => void
  onSetHidden: (id: string, hiddenModels: string[]) => void
  onSetCustom: (id: string, customModels: string[]) => void
  onOpenExternal: (url: string) => void
}

const STATUS_COPY: Record<Status["state"], string> = {
  unknown: "Not checked",
  online: "Online",
  auth_required: "Needs API key",
  offline: "Offline",
  error: "Error",
}

function StatusLabel({ status }: { status: Status }) {
  const Icon =
    status.state === "online"
      ? CheckCircle2Icon
      : status.state === "offline"
        ? WifiOffIcon
        : status.state === "unknown"
          ? CircleDashedIcon
          : AlertTriangleIcon
  const details = [
    status.state === "online" && status.version ? `v${status.version}` : null,
    status.state === "online" && status.latencyMs !== null
      ? `${status.latencyMs} ms`
      : null,
    status.state === "online" && status.modelCount !== null
      ? `${status.modelCount} ${status.modelCount === 1 ? "model" : "models"}`
      : null,
  ].filter(Boolean)
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px]",
        status.state === "online"
          ? "text-success"
          : status.state === "auth_required"
            ? "text-warning"
            : status.state === "unknown"
              ? "text-muted-foreground"
              : "text-destructive"
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {STATUS_COPY[status.state]}
      {details.length > 0 && (
        <span className="text-muted-foreground">· {details.join(" · ")}</span>
      )}
    </span>
  )
}

export function NineRouterSettingsPanel(props: NineRouterSettingsPanelProps) {
  const { view, detection, busy } = props
  const [draft, setDraft] = useState<NineRouterConnectionDraft>({
    name: "",
    baseUrl: "",
    apiKey: "",
  })
  const draftUrl = normalizeNineRouterBaseUrl(draft.baseUrl)
  const connections = view?.connections ?? []
  const disabled = busy !== null
  const showDetection =
    detection?.found === true &&
    !detection.alreadyConnected &&
    detection.baseUrl

  const submitDraft = async () => {
    if (!draft.name.trim() || !draftUrl) return
    if (await props.onAdd(draft))
      setDraft({ name: "", baseUrl: "", apiKey: "" })
  }

  return (
    <SettingsSection
      title="9Router"
      description="Use your 9Router connections — Claude Code, Codex, Copilot, Kiro, combos and API accounts — as models in BetterC0de."
    >
      <SettingsRow
        label="Enable 9Router"
        description="Show the models of every enabled connection in the model picker."
      >
        <Switch
          aria-label="Enable 9Router"
          checked={view?.enabled !== false}
          disabled={disabled || !view}
          onCheckedChange={props.onToggleProvider}
        />
      </SettingsRow>
      <div
        className="space-y-3 px-4 py-3 [&_[data-slot=switch-thumb]]:motion-reduce:transition-none [&_button]:transition-[color,background-color,border-color,box-shadow,opacity,translate] [&_button]:motion-reduce:transition-none"
        aria-label="9Router connections"
        aria-busy={disabled}
      >
        {props.error && (
          <p role="alert" className="text-xs break-words text-destructive">
            {props.error}
          </p>
        )}
        {showDetection && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-3"
          >
            <RadarIcon
              className="size-4 shrink-0 text-success"
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1 text-xs">
              <span className="font-medium">
                9Router is running on this computer
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {detection.baseUrl}
                {detection.version ? ` · v${detection.version}` : ""}
              </span>
            </p>
            <Button
              type="button"
              size="xs"
              disabled={disabled}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  name: current.name || "Local",
                  baseUrl: detection.baseUrl!,
                }))
              }
            >
              <PlusIcon />
              Use this router
            </Button>
          </div>
        )}
        {!view ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading 9Router connections…
          </p>
        ) : (
          <>
            {connections.length === 0 && !showDetection && (
              <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
                <p className="text-xs text-muted-foreground">
                  No connection yet. Start 9Router with{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                    npx 9router
                  </code>{" "}
                  and add it below, or connect a remote router with its URL and
                  API key.
                </p>
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={disabled}
                    onClick={props.onDetect}
                  >
                    <RadarIcon />
                    Look for a local router
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => props.onOpenExternal(NINEROUTER_DOCS_URL)}
                  >
                    <ExternalLinkIcon />
                    9Router on GitHub
                  </Button>
                </div>
                {detection && !detection.found && (
                  <p
                    role="status"
                    className="text-[11px] text-muted-foreground"
                  >
                    No router answered on localhost:20128.
                  </p>
                )}
              </div>
            )}
            {connections.length > 0 && (
              <ol className="space-y-2">
                {connections.map((connection) => (
                  <NineRouterConnectionCard
                    key={connection.id}
                    {...props}
                    connection={connection}
                    providerEnabled={view.enabled}
                  />
                ))}
              </ol>
            )}
            <form
              className="space-y-2 border-t border-border pt-3"
              aria-label="Add 9Router connection"
              onSubmit={(event) => {
                event.preventDefault()
                void submitDraft()
              }}
            >
              <p className="text-xs font-medium">Add connection</p>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <Input
                  aria-label="Connection name"
                  placeholder="Name, e.g. Laptop or VPS"
                  value={draft.name}
                  maxLength={60}
                  disabled={disabled}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
                <Input
                  aria-label="Router URL"
                  className="font-mono text-xs md:text-xs"
                  placeholder={NINEROUTER_DEFAULT_BASE_URL}
                  value={draft.baseUrl}
                  maxLength={2048}
                  spellCheck={false}
                  disabled={disabled}
                  aria-invalid={draft.baseUrl.trim() !== "" && !draftUrl}
                  onChange={(event) =>
                    setDraft({ ...draft, baseUrl: event.target.value })
                  }
                />
              </div>
              <Input
                aria-label="Router API key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="API key from the 9Router dashboard (optional for a local router)"
                value={draft.apiKey}
                maxLength={4096}
                disabled={disabled}
                onChange={(event) =>
                  setDraft({ ...draft, apiKey: event.target.value })
                }
              />
              {draft.baseUrl.trim() !== "" && (
                <p
                  className={cn(
                    "text-[11px] break-all",
                    draftUrl ? "text-muted-foreground" : "text-destructive"
                  )}
                >
                  {draftUrl
                    ? `Requests go to ${draftUrl}`
                    : "Enter an http(s) address, for example http://localhost:20128/v1"}
                </p>
              )}
              <Button
                size="sm"
                disabled={disabled || !draft.name.trim() || !draftUrl}
              >
                {busy === "add" ? (
                  <Loader2Icon className="motion-safe:animate-spin" />
                ) : (
                  <PlusIcon />
                )}
                Add and check
              </Button>
            </form>
            <p className="text-[11px] text-muted-foreground">
              Keys are encrypted on this device and only sent to the router they
              belong to. 9Router itself decides which account serves a model;
              combos fall back across accounts.
            </p>
          </>
        )}
      </div>
    </SettingsSection>
  )
}

function NineRouterConnectionCard({
  connection,
  providerEnabled,
  busy,
  ...props
}: NineRouterSettingsPanelProps & {
  connection: NineRouterConnectionView
  providerEnabled: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const disabled = busy !== null
  const working = busy === connection.id
  const label = connection.name
  return (
    <li className="rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-xs font-medium break-words">
          {label}
        </span>
        {working ? (
          <span
            role="status"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
          >
            <Loader2Icon
              className="size-3 motion-safe:animate-spin"
              aria-hidden="true"
            />
            Checking…
          </span>
        ) : (
          <StatusLabel status={connection.status} />
        )}
        <Switch
          aria-label={`Enable ${label}`}
          checked={connection.enabled}
          disabled={disabled || !providerEnabled}
          onCheckedChange={(enabled) =>
            props.onToggleConnection(connection.id, enabled)
          }
        />
      </div>
      <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">
        {connection.baseUrl}
      </p>
      <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <KeyRoundIcon className="size-3" aria-hidden="true" />
        {connection.secret.configured
          ? connection.secret.storage === "encrypted"
            ? "API key saved · encrypted"
            : "API key saved · plaintext"
          : "No API key"}
        {!connection.tokenSaver && " · Token saver off"}
      </p>
      {connection.status.message && (
        <p className="mt-1 text-[11px] break-words text-muted-foreground">
          {connection.status.message}
        </p>
      )}
      {connection.status.latestVersion &&
        connection.status.version &&
        connection.status.latestVersion !== connection.status.version && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            9Router {connection.status.latestVersion} is available.
          </p>
        )}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={disabled}
          onClick={() => props.onTest(connection.id)}
        >
          <RefreshCwIcon />
          Check and reload models
        </Button>
        {connection.dashboardUrl && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => props.onOpenExternal(connection.dashboardUrl)}
          >
            <ExternalLinkIcon />
            Dashboard
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={editing}
          disabled={disabled}
          onClick={() => setEditing(!editing)}
        >
          <PencilIcon />
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={showModels}
          onClick={() => setShowModels(!showModels)}
        >
          {showModels ? <ChevronUpIcon /> : <ChevronDownIcon />}
          Models ({connection.models.length})
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${label}`}
          disabled={disabled}
          onClick={() => props.onRemove(connection.id)}
        >
          <Trash2Icon />
        </Button>
      </div>
      {editing && (
        <ConnectionEditForm
          connection={connection}
          disabled={disabled}
          onCancel={() => setEditing(false)}
          onSave={async (edit) => {
            if (await props.onEdit(connection.id, edit)) setEditing(false)
          }}
        />
      )}
      {showModels && (
        <ConnectionModels
          connection={connection}
          disabled={disabled}
          onSetHidden={(hidden) => props.onSetHidden(connection.id, hidden)}
          onSetCustom={(custom) => props.onSetCustom(connection.id, custom)}
        />
      )}
    </li>
  )
}

function ConnectionEditForm({
  connection,
  disabled,
  onCancel,
  onSave,
}: {
  connection: NineRouterConnectionView
  disabled: boolean
  onCancel: () => void
  onSave: (edit: NineRouterConnectionEdit) => Promise<void>
}) {
  const [name, setName] = useState(connection.name)
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl)
  const [apiKey, setApiKey] = useState("")
  const [clearKey, setClearKey] = useState(false)
  const [tokenSaver, setTokenSaver] = useState(connection.tokenSaver)
  const normalized = normalizeNineRouterBaseUrl(baseUrl)
  const urlChanged = normalized !== null && normalized !== connection.baseUrl
  const keyRequired =
    urlChanged && connection.secret.configured && !apiKey.trim() && !clearKey
  const edit: NineRouterConnectionEdit = {
    ...(name.trim() && name.trim() !== connection.name
      ? { name: name.trim() }
      : {}),
    ...(urlChanged && normalized ? { baseUrl: normalized } : {}),
    ...(apiKey.trim()
      ? { apiKey: { set: apiKey.trim() } }
      : clearKey
        ? { apiKey: { clear: true as const } }
        : {}),
    ...(tokenSaver !== connection.tokenSaver ? { tokenSaver } : {}),
  }
  const canSave =
    !disabled &&
    name.trim() !== "" &&
    normalized !== null &&
    !keyRequired &&
    Object.keys(edit).length > 0
  return (
    <form
      className="mt-3 space-y-2 border-t border-border pt-3"
      aria-label={`Edit ${connection.name}`}
      onSubmit={(event) => {
        event.preventDefault()
        if (canSave) void onSave(edit)
      }}
    >
      <Input
        aria-label="Connection name"
        value={name}
        maxLength={60}
        disabled={disabled}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        aria-label="Router URL"
        className="font-mono text-xs md:text-xs"
        value={baseUrl}
        maxLength={2048}
        spellCheck={false}
        disabled={disabled}
        aria-invalid={normalized === null}
        onChange={(event) => setBaseUrl(event.target.value)}
      />
      <Input
        aria-label="Replacement router API key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={apiKey}
        placeholder={
          connection.secret.configured
            ? "New key (leave blank to keep the saved key)"
            : "API key (optional for a local router)"
        }
        maxLength={4096}
        disabled={disabled || clearKey}
        onChange={(event) => setApiKey(event.target.value)}
      />
      {keyRequired && (
        <p role="alert" className="text-[11px] text-warning">
          Enter the key again or remove it: a saved key is never sent to a new
          address.
        </p>
      )}
      {connection.secret.configured && (
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Switch
            aria-label="Remove the saved API key"
            checked={clearKey}
            disabled={disabled}
            onCheckedChange={(checked) => {
              setClearKey(checked)
              if (checked) setApiKey("")
            }}
          />
          Remove the saved API key
        </label>
      )}
      <label className="flex items-start gap-2 text-[11px] text-muted-foreground">
        <Switch
          aria-label="Use 9Router token saver"
          checked={tokenSaver}
          disabled={disabled}
          onCheckedChange={setTokenSaver}
        />
        <span>
          Token saver: 9Router compresses tool output to save tokens. Turn it
          off when the agent needs exact file contents and command output.
        </span>
      </label>
      <div className="flex gap-2">
        <Button size="xs" disabled={!canSave}>
          Save and check
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

function ConnectionModels({
  connection,
  disabled,
  onSetHidden,
  onSetCustom,
}: {
  connection: NineRouterConnectionView
  disabled: boolean
  onSetHidden: (hiddenModels: string[]) => void
  onSetCustom: (customModels: string[]) => void
}) {
  const [query, setQuery] = useState("")
  const [customDraft, setCustomDraft] = useState("")
  const hidden = useMemo(
    () => new Set(connection.hiddenModels),
    [connection.hiddenModels]
  )
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const byTier = new Map<string, NineRouterConnectionView["models"]>()
    for (const model of connection.models) {
      if (
        needle &&
        !model.slug.toLowerCase().includes(needle) &&
        !model.tier.toLowerCase().includes(needle)
      )
        continue
      byTier.set(model.tier, [...(byTier.get(model.tier) ?? []), model])
    }
    return [...byTier.entries()]
  }, [connection.models, query])
  const customId = customDraft.trim()
  const addCustom = () => {
    if (!customId || connection.customModels.includes(customId)) return
    onSetCustom([...connection.customModels, customId])
    setCustomDraft("")
  }
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      {connection.models.length > 8 && (
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label={`Search ${connection.name} models`}
            className="pl-8 text-xs md:text-xs"
            placeholder="Search models or accounts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {connection.models.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No models yet. Connect accounts or create combos in the 9Router
          dashboard, then check the connection again — or add a model ID below.
        </p>
      )}
      <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
        {groups.map(([tier, models]) => (
          <div key={tier}>
            <p className="mb-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              {tier}
            </p>
            <ul className="space-y-1">
              {models.map((model) => (
                <li
                  key={model.slug}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="min-w-0 flex-1 font-mono text-[11px] break-all">
                    {model.slug}
                  </span>
                  {model.context && (
                    <span className="text-[10px] text-muted-foreground">
                      {model.context}
                    </span>
                  )}
                  {model.isCustom && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove custom model ${model.slug}`}
                      disabled={disabled}
                      onClick={() =>
                        onSetCustom(
                          connection.customModels.filter(
                            (id) => id !== model.slug
                          )
                        )
                      }
                    >
                      <XIcon />
                    </Button>
                  )}
                  <Switch
                    aria-label={`Show ${model.slug} in the model picker`}
                    checked={!hidden.has(model.slug)}
                    disabled={disabled}
                    onCheckedChange={(visible) =>
                      onSetHidden(
                        visible
                          ? connection.hiddenModels.filter(
                              (id) => id !== model.slug
                            )
                          : [...connection.hiddenModels, model.slug]
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
        {groups.length === 0 && connection.models.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            No model matches “{query.trim()}”.
          </p>
        )}
      </div>
      <form
        className="flex gap-2"
        aria-label={`Add a custom model to ${connection.name}`}
        onSubmit={(event) => {
          event.preventDefault()
          addCustom()
        }}
      >
        <Input
          aria-label="Custom model ID"
          className="font-mono text-xs md:text-xs"
          placeholder="Model ID, e.g. cx/gpt-5.5(xhigh) or a combo name"
          value={customDraft}
          maxLength={256}
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => setCustomDraft(event.target.value)}
        />
        <Button size="sm" variant="outline" disabled={disabled || !customId}>
          <PlusIcon />
          Add
        </Button>
      </form>
      <p className="text-[11px] text-muted-foreground">
        Custom IDs are sent to 9Router unchanged. A suffix like{" "}
        <code className="font-mono">(high)</code> pins the thinking level.
      </p>
    </div>
  )
}

/** Stateful wrapper: loads the view, runs actions, and tells the picker. */
export function NineRouterSettings({
  onToggleProvider,
}: {
  onToggleProvider: (enabled: boolean) => Promise<void>
}) {
  const [view, setView] = useState<NineRouterProviderView | null>(null)
  const [detection, setDetection] = useState<NineRouterDetectResult | null>(
    null
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mutation = useRef(false)
  const confirm = useConfirm()

  const load = useCallback(async () => {
    try {
      const next = await getNineRouter({ includeHidden: true })
      if (!mutation.current) {
        setView(next)
        setError(null)
      }
    } catch (e) {
      if (!mutation.current)
        setError(
          e instanceof Error ? e.message : "Could not load 9Router connections."
        )
    }
  }, [])

  const detect = useCallback(async () => {
    try {
      setDetection(await detectNineRouter())
    } catch {
      setDetection(null)
    }
  }, [])

  useEffect(() => {
    void load()
    void detect()
  }, [load, detect])

  const run = async (
    key: string,
    operation: () => Promise<unknown>
  ): Promise<boolean> => {
    if (mutation.current) return false
    mutation.current = true
    setBusy(key)
    setError(null)
    try {
      await operation()
      mutation.current = false
      await load()
      notifyNineRouterUpdated()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save 9Router.")
      return false
    } finally {
      mutation.current = false
      setBusy(null)
    }
  }

  return (
    <NineRouterSettingsPanel
      view={view}
      detection={detection}
      busy={busy}
      error={error}
      onToggleProvider={(enabled) =>
        void run("provider", () => onToggleProvider(enabled))
      }
      onDetect={() => void detect()}
      onAdd={async (draft) => {
        const ok = await run("add", () =>
          addNineRouterConnection({
            name: draft.name.trim(),
            baseUrl: draft.baseUrl.trim(),
            ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          })
        )
        if (ok) void detect()
        return ok
      }}
      onEdit={(id, edit) => run(id, () => updateNineRouterConnection(id, edit))}
      onToggleConnection={(id, enabled) =>
        void run(id, () => updateNineRouterConnection(id, { enabled }))
      }
      onTest={(id) => void run(id, () => testNineRouterConnection(id))}
      onRemove={(id) =>
        void (async () => {
          const name =
            view?.connections.find((connection) => connection.id === id)
              ?.name ?? "this connection"
          const ok = await confirm({
            title: `Remove ${name}?`,
            description:
              "Its saved API key and model settings are deleted. Chats that used it need another model.",
            confirmLabel: "Remove connection",
            destructive: true,
          })
          if (!ok) return
          await run(id, async () => {
            await removeNineRouterConnection(id)
            void detect()
          })
        })()
      }
      onSetHidden={(id, hiddenModels) =>
        void run(id, () => updateNineRouterConnection(id, { hiddenModels }))
      }
      onSetCustom={(id, customModels) =>
        void run(id, () => updateNineRouterConnection(id, { customModels }))
      }
      onOpenExternal={(url) => void window.electronAPI?.openExternal?.(url)}
    />
  )
}
