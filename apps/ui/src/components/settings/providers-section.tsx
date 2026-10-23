import { isRecord } from "@betterc0de/schema"
import {
  normalizeProviderInstanceConfig,
  normalizeProviderDriver as normalizeDriver,
  isValidEnvironmentDraft,
  changedProviderConfigFields,
} from "@/lib/provider-instance-settings"
import { useState, useCallback, useEffect, useRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { SettingsRow } from "@/components/settings/atoms"
import { getSettings, updateSettings } from "@/services/backend/coreApi"
import {
  validateProviderKey,
  getCliStatus,
  listLmStudioModels,
  listProviderCatalog,
  listProviderSettingsModels,
  refreshModels,
  listProviderInstances,
  refreshProviderInstance,
  updateProviderInstance,
  type CliStatus,
} from "@/services/backend/providersApi"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import {
  Loader2Icon,
  XIcon,
  ExternalLinkIcon,
  CheckCircle2Icon,
  AlertTriangleIcon,
  PlusIcon,
  Trash2Icon,
  RefreshCwIcon,
  ArrowUpCircleIcon,
  ChevronDownIcon,
  LockIcon,
  LockOpenIcon,
  RotateCcwIcon,
  ServerIcon,
} from "lucide-react"
import { toast } from "sonner"
import { createLogger } from "@/lib/logger"
import type {
  ProviderCatalogEntry,
  ProviderAuthMethod,
} from "@/types/electron-api"
import type {
  ProviderInstanceConfig,
  ProviderInstanceSnapshot,
  SecretState,
} from "@betterc0de/schema"
import { handleError } from "@/lib/errors"
import { SETTINGS_UPDATED_EVENT } from "@/lib/settings-store"
import { ProviderApiKeys } from "./api-key-settings"
import { apiKeyProviderSchema } from "@betterc0de/schema"
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  dismissProviderUpdateNotification,
  getProviderUpdateInitialView,
  isProviderUpdateActive,
  isProviderUpdateNotificationDismissed,
  providerUpdateNotificationKey,
  type ProviderUpdateCandidate,
  type ProviderUpdateView,
} from "@/lib/provider-update-notification"
import { getElectronApi } from "@/services/ipc-facade"
import { useProviderStatus } from "@/hooks/use-provider-status"
import { providerBrand, type ProviderAccess } from "@/lib/provider-brand"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  MENU_ITEM,
  MENU_ITEM_HINT,
  MENU_PANEL,
} from "@/components/ui/menu-chrome"
import {
  InlineCode,
  ProviderCard,
  type ProviderStatusTone,
} from "./provider-card"

const log = createLogger("settings-providers")

type ProviderInstancesMap = Record<string, ProviderInstanceConfig>
type ProviderInstanceDriver =
  | "codex"
  | "claude"
  | "cursor"
  | "betterc0de"
  | "opencode-cli"
type KeyStatus = "idle" | "checking" | "valid" | "invalid" | "unverified"

/** What a CLI card knows about its CLI: install, sign-in and version. */
type CliState =
  | { kind: "checking" }
  | { kind: "error" }
  | { kind: "missing" }
  | { kind: "signed-out"; version: string | null }
  | {
      kind: "ready"
      version: string | null
      /** Signed-in account and plan, when the CLI reports them. */
      account: string | null
      plan: string | null
      /** False when the CLI runs but could not confirm the sign-in. */
      verified: boolean
    }

type LmStudioState =
  | { kind: "checking" }
  | { kind: "running"; models: number }
  | { kind: "stopped" }

function notifySettingsUpdated() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT))
  }
}

/** The system browser in the desktop app, a new tab in a paired browser. */
function openExternalUrl(url: string) {
  const api = getElectronApi()
  if (api?.openExternal) void api.openExternal(url)
  else window.open(url, "_blank", "noopener,noreferrer")
}

/**
 * How a catalog provider is reached, or null when the backend cannot use it
 * yet: DeepSeek has a catalog entry but no adapter, so its key and models
 * would be saved and never used. DeepSeek models stay available through
 * OpenRouter.
 */
function providerAccess(provider: ProviderCatalogEntry): ProviderAccess | null {
  if (provider.id === "deepseek") return null
  if (provider.authMethods.some((method) => method.type === "cli")) return "cli"
  if (provider.authMethods.some((method) => method.type === "local-server"))
    return "local"
  return "api"
}

const PROVIDER_GROUPS: ReadonlyArray<{
  access: ProviderAccess
  title: string
  description: string
}> = [
  {
    access: "cli",
    title: "CLI accounts",
    description:
      "Uses the login of a CLI installed on this computer. No API key: usage runs through that account.",
  },
  {
    access: "api",
    title: "API keys",
    description: "Direct API access with your own key, billed by the provider.",
  },
  {
    access: "local",
    title: "Local models",
    description: "Models served by an app on this computer.",
  },
]

/**
 * A CLI card's state. The provider instance snapshot comes first: it has the
 * adapter's own sign-in probe (the only one that knows about Cursor). The
 * `/cli/status` reading covers a disabled or missing instance.
 */
function resolveCliState(
  snapshot: ProviderInstanceSnapshot | undefined,
  status: CliStatus | undefined,
  failed: boolean
): CliState {
  if (snapshot && snapshot.enabled !== false) {
    if (!snapshot.installed) return { kind: "missing" }
    const auth = snapshot.auth?.status
    if (
      auth === "unauthenticated" ||
      (!snapshot.configured && auth !== "authenticated")
    ) {
      return { kind: "signed-out", version: snapshot.version ?? null }
    }
    return {
      kind: "ready",
      version: snapshot.version ?? null,
      account: snapshot.auth?.email ?? null,
      plan: snapshot.auth?.label ?? null,
      verified: auth === "authenticated",
    }
  }
  if (status) {
    if (!status.installed) return { kind: "missing" }
    if (!status.authenticated)
      return { kind: "signed-out", version: status.version ?? null }
    return {
      kind: "ready",
      version: status.version ?? null,
      account: null,
      plan: null,
      verified: true,
    }
  }
  return failed ? { kind: "error" } : { kind: "checking" }
}

function cliStatusPill(state: CliState): {
  label: string
  tone: ProviderStatusTone
} {
  switch (state.kind) {
    case "checking":
      return { label: "Checking…", tone: "checking" }
    case "error":
      return { label: "Couldn't check", tone: "warning" }
    case "missing":
      return { label: "Not installed", tone: "muted" }
    case "signed-out":
      return { label: "Not signed in", tone: "warning" }
    case "ready":
      return { label: state.verified ? "Signed in" : "Ready", tone: "ready" }
  }
}

/**
 * Settings UI for provider configuration.
 *
 * The catalog lives in `apps/backend/src/provider/catalog/` and is served
 * through `/providers/catalog`. Providers are grouped by how they are
 * reached: CLI accounts (a signed-in local CLI), API keys (billed by the
 * provider) and local model servers, each card with its brand mark and
 * live status. CLI instances follow as the advanced section.
 */

export function SettingsProvidersSection() {
  const [providerSettings, setProviderSettings] = useState<
    Record<string, Record<string, unknown>>
  >({})
  const [keyStatus, setKeyStatus] = useState<Record<string, KeyStatus>>({})
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([])
  const [catalogState, setCatalogState] = useState<
    "loading" | "ready" | "error"
  >("loading")
  const [models, setModels] = useState<
    Array<{ provider: string; slug: string }>
  >([])
  const [refreshingModels, setRefreshingModels] = useState(false)
  const { status: providerStatus } = useProviderStatus()
  const refreshProviderModels = useCallback(async (force = false) => {
    if (force) setRefreshingModels(true)
    try {
      if (force) await refreshModels()
      setModels(await listProviderSettingsModels())
    } catch (error) {
      log.warn("Failed to load provider models", error)
      if (force) handleError(error, { source: "provider-models-refresh" })
    } finally {
      if (force) setRefreshingModels(false)
    }
  }, [])
  const refreshSavedSettings = useCallback(async () => {
    try {
      const saved = await getSettings()
      if (isRecord(saved.providers))
        setProviderSettings(
          saved.providers as Record<string, Record<string, unknown>>
        )
      notifySettingsUpdated()
      void refreshProviderModels()
    } catch (error) {
      log.warn("Failed to refresh provider settings", error)
    }
  }, [refreshProviderModels])
  const [cliStatus, setCliStatus] = useState<Record<string, CliStatus>>({})
  const [cliFailed, setCliFailed] = useState(false)
  const [recheckingCli, setRecheckingCli] = useState<string | null>(null)
  const [lmStudio, setLmStudio] = useState<LmStudioState>({ kind: "checking" })
  const [providerInstances, setProviderInstances] =
    useState<ProviderInstancesMap>({})
  const [instanceSnapshots, setInstanceSnapshots] = useState<
    ProviderInstanceSnapshot[]
  >([])
  const [updatingInstanceId, setUpdatingInstanceId] = useState<string | null>(
    null
  )

  const refreshProviderInstances = useCallback(async () => {
    try {
      setInstanceSnapshots(await listProviderInstances())
    } catch (e) {
      log.warn("Failed to load provider instances", e)
    }
  }, [])

  const runProviderInstanceUpdate = useCallback(
    async (instanceId: string) => {
      setUpdatingInstanceId(instanceId)
      try {
        const result = await updateProviderInstance(instanceId)
        setInstanceSnapshots([...result.providers])
        notifySettingsUpdated()
      } catch (e) {
        log.warn("Failed to update provider instance", e)
        toast.error(`Couldn't update ${instanceId}`, {
          description: e instanceof Error ? e.message : undefined,
        })
        await refreshProviderInstances()
      } finally {
        setUpdatingInstanceId(null)
      }
    },
    [refreshProviderInstances]
  )

  const refreshCliStatus = useCallback(async (refresh = false) => {
    try {
      const res = await getCliStatus({ refresh })
      if (res?.cli && typeof res.cli === "object") setCliStatus(res.cli)
      setCliFailed(false)
    } catch (e) {
      log.warn("Failed to load CLI status", e)
      setCliFailed(true)
    }
  }, [])

  // Recheck asks both sources again: the CLI probe without its cache, and
  // the instance's own sign-in probe.
  const recheckCli = useCallback(
    async (providerId: string) => {
      setRecheckingCli(providerId)
      try {
        await Promise.allSettled([
          refreshCliStatus(true),
          refreshProviderInstance(providerId),
        ])
        await refreshProviderInstances()
      } finally {
        setRecheckingCli(null)
      }
    },
    [refreshCliStatus, refreshProviderInstances]
  )

  const checkLmStudio = useCallback(async () => {
    setLmStudio({ kind: "checking" })
    try {
      const result = await listLmStudioModels()
      setLmStudio(
        result.error || !Array.isArray(result.data)
          ? { kind: "stopped" }
          : { kind: "running", models: result.data.length }
      )
    } catch {
      setLmStudio({ kind: "stopped" })
    }
  }, [])

  const loadCatalog = useCallback(async () => {
    setCatalogState("loading")
    try {
      const list = await listProviderCatalog()
      setCatalog(Array.isArray(list) ? list : [])
      setCatalogState("ready")
    } catch (e) {
      log.warn("Failed to load provider catalog", e)
      setCatalogState("error")
    }
  }, [])

  // Load provider settings + catalog on mount
  useEffect(() => {
    getSettings()
      .then(
        (
          s:
            | {
                providers?: Record<string, Record<string, unknown>>
                provider_instances?: ProviderInstancesMap
                providerInstances?: ProviderInstancesMap
              }
            | null
            | undefined
        ) => {
          if (s?.providers) setProviderSettings(s.providers)
          setProviderInstances(
            normalizeProviderInstancesMap(
              s?.provider_instances ?? s?.providerInstances ?? {}
            )
          )
        }
      )
      .catch((e) => {
        log.warn("Failed to load provider settings", e)
      })

    void loadCatalog()
    void refreshCliStatus()
    void refreshProviderInstances()
    void refreshProviderModels()
    void checkLmStudio()
  }, [
    checkLmStudio,
    loadCatalog,
    refreshCliStatus,
    refreshProviderInstances,
    refreshProviderModels,
  ])

  // Only an explicit rejection means a bad key; a rate limit, an outage or
  // no network leaves the key unverified rather than "invalid".
  const validateKey = useCallback(
    async (providerId: string, apiKey: string) => {
      if (!apiKey) {
        setKeyStatus((prev) => ({ ...prev, [providerId]: "idle" }))
        return
      }
      setKeyStatus((prev) => ({ ...prev, [providerId]: "checking" }))
      try {
        const res = await validateProviderKey(providerId, apiKey)
        setKeyStatus((prev) => ({
          ...prev,
          [providerId]: res.valid
            ? "valid"
            : res.status === 401 || res.status === 403
              ? "invalid"
              : "unverified",
        }))
      } catch {
        setKeyStatus((prev) => ({ ...prev, [providerId]: "unverified" }))
      }
    },
    []
  )

  const saveKey = useCallback(
    async (providerId: string, key: string, value: unknown) => {
      const nextProviders = {
        ...providerSettings,
        [providerId]: {
          ...(providerSettings[providerId] ?? {}),
          [key]: value,
        },
      }
      const patch = { providers: { [providerId]: { [key]: value } } }
      try {
        const saved = await updateSettings(patch)
        const savedProviders = saved.providers
        setProviderSettings(
          isRecord(savedProviders)
            ? (savedProviders as Record<string, Record<string, unknown>>)
            : nextProviders
        )
        notifySettingsUpdated()
        if (key === "api_key") {
          if (isSecretSetPatch(value)) void validateKey(providerId, value.set)
          else setKeyStatus((prev) => ({ ...prev, [providerId]: "idle" }))
        }
      } catch (e) {
        log.warn("Failed to save provider setting:", providerId, key, e)
        handleError(e, { source: "provider-settings-save" })
      }
    },
    [providerSettings, validateKey]
  )

  const saveProviderInstances = useCallback(
    async (next: ProviderInstancesMap) => {
      const previous = providerInstances
      const normalized = normalizeProviderInstancesMap(next)
      setProviderInstances(normalized)
      try {
        const removedProviderInstanceIds = Object.keys(previous).filter(
          (instanceId) => !(instanceId in normalized)
        )
        const saved = await updateSettings({
          provider_instances: normalized,
          ...(removedProviderInstanceIds.length > 0
            ? { remove_provider_instance_ids: removedProviderInstanceIds }
            : {}),
        })
        const savedInstances = isRecord(saved.provider_instances)
          ? (saved.provider_instances as ProviderInstancesMap)
          : normalized
        setProviderInstances(normalizeProviderInstancesMap(savedInstances))
        notifySettingsUpdated()
        await refreshProviderInstances()
      } catch (e) {
        setProviderInstances(previous)
        log.warn("Failed to save provider instances", e)
        handleError(e, { source: "provider-instance-settings-save" })
      }
    },
    [providerInstances, refreshProviderInstances]
  )

  if (catalogState !== "ready") {
    return catalogState === "error" ? (
      <div className="flex items-center gap-3 rounded-xl border border-border/50 px-4 py-3 text-xs text-muted-foreground">
        <span className="flex-1">Couldn't load the provider list.</span>
        <Button variant="outline" size="xs" onClick={() => void loadCatalog()}>
          <RefreshCwIcon />
          Retry
        </Button>
      </div>
    ) : (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" />
        Loading providers…
      </p>
    )
  }

  const apiStatus = (
    provider: ProviderCatalogEntry,
    access: ProviderAccess
  ): { label: string; tone: ProviderStatusTone } | null => {
    if (access === "local") {
      return lmStudio.kind === "checking"
        ? { label: "Checking…", tone: "checking" }
        : lmStudio.kind === "running"
          ? { label: "Running", tone: "ready" }
          : { label: "Not running", tone: "muted" }
    }
    const config = providerSettings[provider.id] ?? {}
    if (config.enabled === false) return { label: "Off", tone: "muted" }
    const status = providerStatus.get(provider.id)
    if (!status) return null
    return status.configured
      ? { label: "Ready", tone: "ready" }
      : { label: "No key", tone: "warning" }
  }

  return (
    <div className="space-y-8">
      {PROVIDER_GROUPS.map((group) => {
        const items = catalog.filter(
          (provider) => providerAccess(provider) === group.access
        )
        if (items.length === 0) return null
        return (
          <section key={group.access} aria-label={group.title}>
            <div className="mb-3">
              <h3 className="text-[13px] font-semibold text-foreground">
                {group.title}
              </h3>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                {group.description}
              </p>
            </div>
            <div className="space-y-2">
              {items.map((provider) => {
                const cli =
                  group.access === "cli"
                    ? resolveCliState(
                        instanceSnapshots.find(
                          (snapshot) => snapshot.instanceId === provider.id
                        ),
                        cliStatus[provider.id],
                        cliFailed
                      )
                    : null
                return (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    access={group.access}
                    status={
                      cli
                        ? cliStatusPill(cli)
                        : apiStatus(provider, group.access)
                    }
                    config={providerSettings[provider.id] ?? {}}
                    keyStatus={keyStatus[provider.id] ?? "idle"}
                    cli={cli}
                    rechecking={recheckingCli === provider.id}
                    lmStudio={lmStudio}
                    models={[
                      ...new Set([
                        ...provider.defaultModels,
                        ...models
                          .filter((model) => model.provider === provider.id)
                          .map((model) => model.slug),
                      ]),
                    ]}
                    refreshingModels={refreshingModels}
                    onKeysChanged={() => void refreshSavedSettings()}
                    onRefreshModels={() => void refreshProviderModels(true)}
                    onSaveKey={saveKey}
                    onRecheckCli={() => void recheckCli(provider.id)}
                    onCheckLmStudio={() => void checkLmStudio()}
                  />
                )
              })}
            </div>
          </section>
        )
      })}
      <ProviderInstancesSection
        instances={providerInstances}
        snapshots={instanceSnapshots}
        updatingInstanceId={updatingInstanceId}
        onChange={(next) => void saveProviderInstances(next)}
        onRefresh={refreshProviderInstances}
        onUpdate={runProviderInstanceUpdate}
      />
    </div>
  )
}

interface ProviderRowProps {
  provider: ProviderCatalogEntry
  access: ProviderAccess
  status: { label: string; tone: ProviderStatusTone } | null
  config: Record<string, unknown>
  keyStatus: KeyStatus
  cli: CliState | null
  rechecking: boolean
  lmStudio: LmStudioState
  models: string[]
  refreshingModels: boolean
  onKeysChanged: () => void
  onRefreshModels: () => void
  onSaveKey: (providerId: string, key: string, value: unknown) => Promise<void>
  onRecheckCli: () => void
  onCheckLmStudio: () => void
}

const KEY_STATUS_LOOK: Record<KeyStatus, { dot: string; title: string }> = {
  idle: { dot: "bg-muted-foreground/30", title: "No key" },
  checking: { dot: "", title: "Checking key…" },
  valid: { dot: "bg-success", title: "Key verified" },
  invalid: { dot: "bg-destructive", title: "Key rejected by the provider" },
  unverified: {
    dot: "bg-warning",
    title: "Couldn't verify the key (rate limit or network); it is saved",
  },
}

function ProviderRow({
  provider,
  access,
  status,
  config,
  keyStatus,
  cli,
  rechecking,
  lmStudio,
  models,
  refreshingModels,
  onKeysChanged,
  onRefreshModels,
  onSaveKey,
  onRecheckCli,
  onCheckLmStudio,
}: ProviderRowProps) {
  const apiKeyMethod = provider.authMethods.find(
    (m): m is Extract<ProviderAuthMethod, { type: "api-key" }> =>
      m.type === "api-key"
  )
  const localServerMethod = provider.authMethods.find(
    (m): m is Extract<ProviderAuthMethod, { type: "local-server" }> =>
      m.type === "local-server"
  )
  const cliMethod = provider.authMethods.find(
    (m): m is Extract<ProviderAuthMethod, { type: "cli" }> => m.type === "cli"
  )
  const apiKeyState = readSecretState(config.api_key)
  const hasKey =
    apiKeyState?.configured === true ||
    (typeof config.api_key === "string" && config.api_key.length > 0)
  const customModels = (config.custom_models as string[] | undefined) ?? []
  const hiddenModels = (config.hidden_models as string[] | undefined) ?? []
  const managedProvider = apiKeyProviderSchema.safeParse(provider.id)
  const keyLook =
    keyStatus !== "idle"
      ? KEY_STATUS_LOOK[keyStatus]
      : hasKey
        ? { dot: "bg-warning", title: "Key saved, not checked yet" }
        : KEY_STATUS_LOOK.idle

  // Closed, the card still says what matters: the CLI's sign-in, LM Studio's
  // server, or the catalog line.
  const summary =
    cliMethod && cli ? (
      <CliDescription state={cli} method={cliMethod} />
    ) : localServerMethod ? (
      lmStudio.kind === "running" ? (
        `Running · ${lmStudio.models} model${lmStudio.models === 1 ? "" : "s"} loaded`
      ) : lmStudio.kind === "stopped" ? (
        "Local server not reachable"
      ) : (
        "Looking for LM Studio…"
      )
    ) : undefined

  return (
    <ProviderCard
      id={provider.id}
      name={provider.name}
      description={provider.description}
      summary={summary}
      access={access}
      status={status}
      actions={
        managedProvider.success ? (
          <Switch
            aria-label={`Enable ${provider.name}`}
            title="Offer this provider in the model picker when its keys are usable"
            checked={config.enabled !== false}
            onCheckedChange={(enabled) =>
              void onSaveKey(provider.id, "enabled", enabled)
            }
          />
        ) : null
      }
    >
      {managedProvider.success && (
        <ProviderApiKeys
          provider={managedProvider.data}
          onChanged={onKeysChanged}
        />
      )}
      {managedProvider.success && provider.docsUrl && (
        <SettingsRow
          label="Get an API key"
          description="Create keys in your provider account."
        >
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => openExternalUrl(provider.docsUrl!)}
          >
            <ExternalLinkIcon />
            Open provider console
          </Button>
        </SettingsRow>
      )}
      {/* CLI account: install, sign-in and version. */}
      {cliMethod && cli && (
        <SettingsRow
          label="Account"
          description={<CliDescription state={cli} method={cliMethod} />}
        >
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[10px]"
            disabled={rechecking}
            onClick={onRecheckCli}
            title="Detect the CLI and its sign-in again"
          >
            <RefreshCwIcon
              className={cn("size-3", rechecking && "animate-spin")}
            />
            Recheck
          </Button>
        </SettingsRow>
      )}

      {/* API key method */}
      {apiKeyMethod && !managedProvider.success && (
        <SettingsRow
          label={apiKeyMethod.label}
          description={
            <>
              {apiKeyMethod.envVars && apiKeyMethod.envVars.length > 0 ? (
                <>
                  Or set{" "}
                  <code className="text-[10px]">{apiKeyMethod.envVars[0]}</code>
                </>
              ) : null}
              {provider.docsUrl && (
                <>
                  {apiKeyMethod.envVars && apiKeyMethod.envVars.length > 0
                    ? " · "
                    : ""}
                  <a
                    href={provider.docsUrl}
                    onClick={(e) => {
                      e.preventDefault()
                      openExternalUrl(provider.docsUrl!)
                    }}
                    className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
                  >
                    Get key <ExternalLinkIcon className="size-2.5" />
                  </a>
                </>
              )}
            </>
          }
        >
          <div className="flex w-[280px] items-center gap-2">
            <Input
              // A new key (or a cleared one) remounts the field empty.
              key={hasKey ? "stored" : "empty"}
              type="password"
              aria-label={`${provider.name} API key`}
              className="h-8 flex-1 font-mono text-xs"
              placeholder={
                hasKey ? "Stored API key" : (apiKeyMethod.placeholder ?? "")
              }
              defaultValue={
                apiKeyState
                  ? ""
                  : ((config.api_key as string | undefined) ?? "")
              }
              onBlur={(e) => {
                const value = e.target.value.trim()
                if (!value) return
                e.target.value = ""
                void onSaveKey(provider.id, "api_key", { set: value })
              }}
            />
            {keyStatus === "checking" ? (
              <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <span
                role="img"
                aria-label={keyLook.title}
                title={keyLook.title}
                className={cn("size-2 shrink-0 rounded-full", keyLook.dot)}
              />
            )}
            {hasKey ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[10px]"
                onClick={() =>
                  void onSaveKey(provider.id, "api_key", { clear: true })
                }
              >
                Clear
              </Button>
            ) : null}
          </div>
        </SettingsRow>
      )}

      {/* Local server (LM Studio): found automatically on this computer. */}
      {localServerMethod && (
        <SettingsRow
          label="Local server"
          description={
            lmStudio.kind === "running"
              ? `Running · ${lmStudio.models} model${lmStudio.models === 1 ? "" : "s"} loaded. BetterC0de finds LM Studio on this computer automatically.`
              : lmStudio.kind === "stopped"
                ? "Not reachable. Start LM Studio's local server (Developer → Start Server) on port 1234."
                : "Looking for LM Studio on this computer…"
          }
        >
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[10px]"
            disabled={lmStudio.kind === "checking"}
            onClick={onCheckLmStudio}
          >
            <RefreshCwIcon
              className={cn(
                "size-3",
                lmStudio.kind === "checking" && "animate-spin"
              )}
            />
            Check
          </Button>
        </SettingsRow>
      )}

      {/* Custom models: LM Studio lists what it has loaded instead. */}
      {access !== "local" && (
        <SettingsRow
          label="Custom Models"
          description="Add model IDs not in the default list"
          className={
            managedProvider.success ? "flex-wrap sm:flex-nowrap" : undefined
          }
        >
          <CustomModelInput
            providerId={provider.id}
            customModels={customModels}
            onChange={(next) =>
              void onSaveKey(provider.id, "custom_models", next)
            }
          />
        </SettingsRow>
      )}

      {/* Visible models: the backend honours these for the managed API
          providers; the Model Visibility section covers the rest. */}
      {managedProvider.success && (
        <SettingsRow
          label="Visible Models"
          description="Toggle models on/off in the dropdown"
          className="flex-wrap items-start sm:flex-nowrap"
        >
          <div className="w-[280px] max-w-full space-y-1">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={refreshingModels}
              onClick={onRefreshModels}
            >
              {refreshingModels ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <RefreshCwIcon />
              )}
              Refresh models
            </Button>
            {models.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                Add an available key to load the account's models.
              </p>
            )}
            {models.map((m) => (
              <div key={m} className="flex items-center gap-2 text-[10px]">
                <Switch
                  aria-label={`Show ${m}`}
                  checked={!hiddenModels.includes(m)}
                  onCheckedChange={(v) => {
                    const next = v
                      ? hiddenModels.filter((h) => h !== m)
                      : [...hiddenModels, m]
                    void onSaveKey(provider.id, "hidden_models", next)
                  }}
                />
                <span className="min-w-0 font-mono break-all text-muted-foreground">
                  {m}
                </span>
              </div>
            ))}
          </div>
        </SettingsRow>
      )}
    </ProviderCard>
  )
}

/** The CLI account row's text for each state, with its next step. */
function CliDescription({
  state,
  method,
}: {
  state: CliState
  method: Extract<ProviderAuthMethod, { type: "cli" }>
}) {
  const version = (value: string | null) => (value ? ` v${value}` : "")
  switch (state.kind) {
    case "checking":
      return <>Checking the CLI…</>
    case "error":
      return <>Couldn't check this CLI. Try Recheck.</>
    case "missing":
      return (
        <>
          Not installed
          {method.installHint ? (
            <>
              . Install: <InlineCode text={`\`${method.installHint}\``} />
            </>
          ) : null}
        </>
      )
    case "signed-out":
      return (
        <>
          Installed{version(state.version)}, not signed in
          {method.loginCommand ? (
            <>
              . Run <InlineCode text={`\`${method.loginCommand}\``} /> in a
              terminal
            </>
          ) : null}
        </>
      )
    case "ready":
      return (
        <>
          {state.verified ? "Signed in" : "Ready (sign-in not confirmed)"}
          {state.account ? ` as ${state.account}` : ""}
          {state.plan ? ` · ${state.plan}` : ""}
          {state.version ? ` · v${state.version}` : ""}
        </>
      )
  }
}

interface CustomModelInputProps {
  providerId: string
  customModels: string[]
  onChange: (next: string[]) => void
}

function CustomModelInput({
  providerId,
  customModels,
  onChange,
}: CustomModelInputProps) {
  return (
    <div className="w-[280px] max-w-full">
      <div className="mb-1 flex gap-1.5">
        <Input
          id={`custom-${providerId}`}
          className="h-7 flex-1 font-mono text-[10px]"
          placeholder="model-id"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = (e.target as HTMLInputElement).value.trim()
              if (v) {
                onChange([...customModels, v])
                ;(e.target as HTMLInputElement).value = ""
              }
            }
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[10px]"
          onClick={() => {
            const el = document.getElementById(
              `custom-${providerId}`
            ) as HTMLInputElement | null
            if (el?.value.trim()) {
              onChange([...customModels, el.value.trim()])
              el.value = ""
            }
          }}
        >
          Add
        </Button>
      </div>
      {customModels.map((m, i) => (
        <div
          key={m}
          className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground"
        >
          <span className="flex-1 truncate">{m}</span>
          <button
            type="button"
            onClick={() => onChange(customModels.filter((_, j) => j !== i))}
            className="text-muted-foreground/40 hover:text-destructive"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

interface ProviderInstancesSectionProps {
  instances: ProviderInstancesMap
  snapshots: ProviderInstanceSnapshot[]
  updatingInstanceId: string | null
  onChange: (next: ProviderInstancesMap) => void
  onRefresh: () => Promise<void>
  onUpdate: (instanceId: string) => Promise<void>
}

const INSTANCE_DRIVERS: ReadonlyArray<{
  driver: ProviderInstanceDriver
  label: string
  hint: string
}> = [
  { driver: "codex", label: "Codex", hint: "Another account, home or binary" },
  {
    driver: "claude",
    label: "Claude Code",
    hint: "Another account, home or binary",
  },
  { driver: "cursor", label: "Cursor", hint: "Another binary or ACP endpoint" },
  {
    driver: "betterc0de",
    label: "BetterC0de server",
    hint: "A compatibility server by URL",
  },
  {
    driver: "opencode-cli",
    label: "OpenCode CLI",
    hint: "Another local OpenCode binary (ACP)",
  },
]

/** Inputs in the instance forms: compact, at the settings text size. */
const FIELD_INPUT =
  "h-8 rounded-lg border-border/50 bg-background/50 px-2.5 text-[12px] md:text-[12px] dark:bg-input/30"

function ProviderInstancesSection({
  instances,
  snapshots,
  updatingInstanceId,
  onChange,
  onRefresh,
  onUpdate,
}: ProviderInstancesSectionProps) {
  const confirm = useConfirm()
  const [dismissedUpdateKey, setDismissedUpdateKey] = useState<string | null>(
    null
  )
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [refreshing, setRefreshing] = useState(false)
  const rows = mergedInstanceRows(instances, snapshots)
  const updateCandidates = collectProviderUpdateCandidates(snapshots)
  const updateNotificationKey = providerUpdateNotificationKey(updateCandidates)
  const oneClickUpdateCandidates = updateCandidates.filter((candidate) =>
    canOneClickUpdateProviderCandidate(candidate, snapshots)
  )
  const updateNotificationDismissed =
    dismissedUpdateKey === updateNotificationKey ||
    isProviderUpdateNotificationDismissed(updateNotificationKey)
  const updateView =
    updateCandidates.length > 0
      ? getProviderUpdateInitialView({
          updateProviders: updateCandidates,
          oneClickProviders: oneClickUpdateCandidates,
        })
      : null
  const updateBusy =
    updatingInstanceId !== null || snapshots.some(isProviderUpdateActive)
  const dismissUpdateNotification = () => {
    dismissProviderUpdateNotification(updateNotificationKey)
    setDismissedUpdateKey(updateNotificationKey)
  }
  const runOneClickUpdates = async () => {
    const targets = oneClickUpdateCandidates.map(
      (candidate) => candidate.instanceId
    )
    await Promise.allSettled(targets.map((instanceId) => onUpdate(instanceId)))
  }
  const patchInstance = (
    instanceId: string,
    patch: Partial<ProviderInstanceConfig>
  ) => {
    const current = rows.find(
      (row) => row.config.instanceId === instanceId
    )?.config
    if (!current) return
    onChange({
      ...instances,
      [instanceId]: normalizeProviderInstanceConfig(instanceId, {
        ...current,
        ...patch,
        config: {
          ...(current.config ?? {}),
          ...(patch.config ?? {}),
        },
      }),
    })
  }
  const patchInstanceConfig = (
    instanceId: string,
    patch: Record<string, unknown>
  ) => {
    const current = rows.find(
      (row) => row.config.instanceId === instanceId
    )?.config
    if (!current) return
    const changes = changedProviderConfigFields(current.config ?? {}, patch)
    if (Object.keys(changes).length === 0) return
    patchInstance(instanceId, {
      config: { ...(current.config ?? {}), ...changes },
    })
  }
  const toggleExpanded = (instanceId: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(instanceId)) next.delete(instanceId)
      else next.add(instanceId)
      return next
    })
  const addInstance = (driver: ProviderInstanceDriver) => {
    const baseId = `${driver}-${Object.keys(instances).length + 1}`
    let instanceId = baseId
    let counter = 2
    while (rows.some((row) => row.config.instanceId === instanceId)) {
      instanceId = `${baseId}-${counter++}`
    }
    onChange({
      ...instances,
      [instanceId]: createProviderInstanceConfig(instanceId, driver),
    })
    // A new instance opens on its form, ready to fill in.
    setExpanded((current) => new Set(current).add(instanceId))
  }
  const removeInstance = async (instanceId: string, name: string) => {
    const isDefault = isDefaultInstance(instanceId)
    const ok = await confirm({
      title: isDefault ? `Reset ${name}?` : `Remove ${name}?`,
      description: isDefault
        ? "Its binary, home, models and environment go back to the defaults."
        : "This setup and its settings are removed. The CLI itself and its files stay.",
      confirmLabel: isDefault ? "Reset" : "Remove",
      destructive: true,
    })
    if (!ok) return
    const next = { ...instances }
    delete next[instanceId]
    onChange(next)
  }
  const refreshAll = async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section aria-label="CLI instances" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-foreground">
            CLI instances
          </h3>
          <p className="mt-0.5 max-w-[62ch] text-[12.5px] leading-snug text-muted-foreground">
            Advanced: separate setups of Codex, Claude Code and Cursor (or the
            BetterC0de compatibility server), each with its own binary, config,
            environment and models.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh instance status"
            title="Refresh instance status"
            disabled={refreshing}
            onClick={() => void refreshAll()}
            className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <RefreshCwIcon
              className={cn(
                "size-3.5",
                refreshing && "motion-safe:animate-spin"
              )}
            />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 rounded-lg px-3 text-[12px]"
              >
                <PlusIcon className="size-3.5" />
                Add instance
                <ChevronDownIcon className="size-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={cn(MENU_PANEL, "w-60")}>
              {INSTANCE_DRIVERS.map((item) => (
                <DropdownMenuItem
                  key={item.driver}
                  onSelect={() => addInstance(item.driver)}
                  className={cn(MENU_ITEM, "items-start py-1.5")}
                >
                  <InstanceLogo driver={item.driver} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-[12px]">{item.label}</span>
                    <span className={MENU_ITEM_HINT}>{item.hint}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {updateView && updateNotificationKey && !updateNotificationDismissed ? (
        <ProviderUpdateNotificationBanner
          view={updateView}
          oneClickCandidates={oneClickUpdateCandidates}
          busy={updateBusy}
          onUpdate={() => void runOneClickUpdates()}
          onDismiss={dismissUpdateNotification}
        />
      ) : null}

      <div className="space-y-2">
        {rows.map(({ config, snapshot }) => {
          const updating =
            updatingInstanceId === config.instanceId ||
            snapshot?.updateState?.status === "queued" ||
            snapshot?.updateState?.status === "running"
          return (
            <InstanceCard
              key={config.instanceId}
              config={config}
              snapshot={snapshot}
              expanded={expanded.has(config.instanceId)}
              updating={updating}
              onToggle={() => toggleExpanded(config.instanceId)}
              onUpdate={() => void onUpdate(config.instanceId)}
              onRefresh={() =>
                void refreshProviderInstance(config.instanceId)
                  .catch((error: unknown) =>
                    toast.error(
                      `Couldn't refresh ${config.displayName || config.instanceId}`,
                      {
                        description:
                          error instanceof Error ? error.message : undefined,
                      }
                    )
                  )
                  .then(() => onRefresh())
              }
              onRemove={() =>
                void removeInstance(
                  config.instanceId,
                  config.displayName || config.instanceId
                )
              }
              onPatch={(patch) => patchInstance(config.instanceId, patch)}
              onPatchConfig={(patch) =>
                patchInstanceConfig(config.instanceId, patch)
              }
            />
          )
        })}
      </div>
    </section>
  )
}

function InstanceLogo({
  driver,
  className,
}: {
  driver: string
  className?: string
}) {
  const brand = providerBrand(driver)
  if (!brand) {
    return (
      <ServerIcon
        aria-hidden="true"
        className={cn("size-4 shrink-0 text-muted-foreground", className)}
      />
    )
  }
  return (
    <img
      src={brand.logo}
      alt=""
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 object-contain",
        brand.invertDark && "dark:invert",
        className
      )}
    />
  )
}

function instanceStatus(
  config: ProviderInstanceConfig,
  snapshot: ProviderInstanceSnapshot | null | undefined
): { label: string; tone: ProviderStatusTone } {
  if (config.enabled === false) return { label: "Off", tone: "muted" }
  if (!snapshot) return { label: "Checking…", tone: "checking" }
  if (snapshot.unavailableReason)
    return { label: "Unavailable", tone: "warning" }
  if (snapshot.configured) return { label: "Ready", tone: "ready" }
  return { label: "Needs setup", tone: "warning" }
}

const STATUS_DOT: Record<ProviderStatusTone, string> = {
  ready: "bg-success",
  warning: "bg-warning",
  muted: "bg-muted-foreground/50",
  checking: "bg-muted-foreground/50 motion-safe:animate-pulse",
}

/**
 * One CLI instance: a summary row (logo, name, status, version, what it
 * discovered, and its switch, refresh and update) that opens a labelled
 * form for its name, color, paths, models and environment.
 */
function InstanceCard({
  config,
  snapshot,
  expanded,
  updating,
  onToggle,
  onUpdate,
  onRefresh,
  onRemove,
  onPatch,
  onPatchConfig,
}: {
  config: ProviderInstanceConfig
  snapshot: ProviderInstanceSnapshot | null | undefined
  expanded: boolean
  updating: boolean
  onToggle: () => void
  onUpdate: () => void
  onRefresh: () => void
  onRemove: () => void
  onPatch: (patch: Partial<ProviderInstanceConfig>) => void
  onPatchConfig: (patch: Record<string, unknown>) => void
}) {
  const name = config.displayName || config.instanceId
  const isDefault = isDefaultInstance(config.instanceId)
  const status = instanceStatus(config, snapshot)
  const advisory = snapshot?.versionAdvisory
  const canUpdate = advisory?.canUpdate === true
  const skills = snapshot?.skills?.length ?? 0
  const commands = snapshot?.slashCommands?.length ?? 0
  const metadataErrors = [
    snapshot?.metadata?.skillsError,
    snapshot?.metadata?.slashCommandsError,
  ].filter((entry): entry is string => Boolean(entry))
  const formId = `instance-${config.instanceId}`
  const summary = [
    providerDriverLabel(config.driver),
    snapshot ? formatVersionAdvisory(snapshot) : null,
    snapshot ? `${skills} skills` : null,
    snapshot ? `${commands} commands` : null,
    snapshot?.metadata?.checkedAt
      ? `checked ${formatMetadataCheckedAt(snapshot.metadata.checkedAt)}`
      : null,
  ].filter(Boolean)

  return (
    <article
      aria-label={name}
      className={cn(
        "overflow-hidden rounded-xl border bg-card/30 transition-colors duration-150",
        expanded ? "border-border/70" : "border-border/50"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-foreground/[0.05]"
          style={
            config.accentColor
              ? { boxShadow: `inset 0 0 0 1.5px ${config.accentColor}` }
              : undefined
          }
        >
          <InstanceLogo driver={config.driver} className="size-[18px]" />
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={formId}
          onClick={onToggle}
          className="min-w-0 flex-1 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium">{name}</span>
            {isDefault && (
              <span className="shrink-0 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                Default
              </span>
            )}
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", STATUS_DOT[status.tone])}
              />
              {status.label}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground tabular-nums">
            {summary.join(" · ")}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {canUpdate && (
            <Button
              variant="outline"
              size="sm"
              disabled={updating}
              onClick={onUpdate}
              title={advisory?.updateCommand ?? "Update provider"}
              className="mr-1 h-7 gap-1.5 rounded-lg px-2.5 text-[11px]"
            >
              {updating ? (
                <Loader2Icon className="size-3.5 motion-safe:animate-spin" />
              ) : (
                <ArrowUpCircleIcon className="size-3.5" />
              )}
              {advisory?.latestVersion
                ? `Update to ${advisory.latestVersion}`
                : "Update"}
            </Button>
          )}
          <Switch
            aria-label={`Use ${name}`}
            checked={config.enabled !== false}
            onCheckedChange={(enabled) => onPatch({ enabled })}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Refresh ${name}`}
            title="Refresh this instance"
            onClick={onRefresh}
            className="ml-1 size-7 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={expanded ? `Close ${name}` : `Edit ${name}`}
            aria-expanded={expanded}
            aria-controls={formId}
            onClick={onToggle}
            className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform duration-150",
                expanded && "rotate-180"
              )}
            />
          </Button>
        </div>
      </div>

      {snapshot?.unavailableReason || metadataErrors.length > 0 ? (
        <p className="flex items-start gap-2 border-t border-border/40 bg-warning/[0.04] px-4 py-2 text-[11px] text-warning">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">
            {snapshot?.unavailableReason ?? metadataErrors.join(" · ")}
          </span>
        </p>
      ) : null}
      {snapshot?.updateState ? (
        <p
          className={cn(
            "flex items-start gap-2 border-t border-border/40 px-4 py-2 text-[11px]",
            snapshot.updateState.status === "failed"
              ? "text-destructive"
              : snapshot.updateState.status === "succeeded"
                ? "text-success"
                : "text-muted-foreground"
          )}
        >
          {snapshot.updateState.status === "failed" ? (
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          ) : snapshot.updateState.status === "succeeded" ? (
            <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Loader2Icon className="mt-0.5 size-3.5 shrink-0 motion-safe:animate-spin" />
          )}
          <span className="line-clamp-2">
            Update {snapshot.updateState.status}
            {snapshot.updateState.message
              ? `: ${snapshot.updateState.message}`
              : ""}
          </span>
        </p>
      ) : null}

      {expanded && (
        <div
          id={formId}
          className="space-y-5 border-t border-border/40 bg-foreground/[0.015] px-4 py-4"
        >
          <div className="grid gap-x-4 gap-y-3.5 @[620px]/settings:grid-cols-2">
            <InstanceField label="Name">
              <Input
                className={FIELD_INPUT}
                placeholder={providerDriverLabel(config.driver)}
                defaultValue={config.displayName ?? ""}
                onBlur={(e) =>
                  onPatch({ displayName: e.target.value.trim() || undefined })
                }
              />
            </InstanceField>
            <InstanceField
              label="Accent color"
              hint="Marks this instance in model pickers."
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-8 shrink-0 rounded-lg border border-border/50"
                  style={{
                    background: config.accentColor || "transparent",
                  }}
                />
                <Input
                  className={cn(FIELD_INPUT, "font-mono")}
                  placeholder="#7c3aed"
                  defaultValue={config.accentColor ?? ""}
                  onBlur={(e) =>
                    onPatch({ accentColor: e.target.value.trim() || undefined })
                  }
                />
              </div>
            </InstanceField>
            <InstanceField
              label="Binary"
              hint="Empty uses the one found on your PATH."
              className="@[620px]/settings:col-span-2"
            >
              <Input
                className={cn(FIELD_INPUT, "font-mono")}
                placeholder={defaultBinaryPath(config.driver)}
                defaultValue={readInstanceConfigString(config, "binaryPath")}
                onBlur={(e) => onPatchConfig({ binaryPath: e.target.value })}
              />
            </InstanceField>
            {config.driver === "codex" ? (
              <>
                <InstanceField
                  label="CODEX_HOME"
                  hint="Config, sessions and sign-in of this setup."
                >
                  <Input
                    className={cn(FIELD_INPUT, "font-mono")}
                    placeholder="~/.codex"
                    defaultValue={readInstanceConfigString(config, "homePath")}
                    onBlur={(e) => onPatchConfig({ homePath: e.target.value })}
                  />
                </InstanceField>
                <InstanceField
                  label="Shadow CODEX_HOME"
                  hint="A copy BetterC0de may change instead of yours."
                >
                  <Input
                    className={cn(FIELD_INPUT, "font-mono")}
                    placeholder="Optional"
                    defaultValue={readInstanceConfigString(
                      config,
                      "shadowHomePath"
                    )}
                    onBlur={(e) =>
                      onPatchConfig({ shadowHomePath: e.target.value })
                    }
                  />
                </InstanceField>
              </>
            ) : null}
            {config.driver === "claude" ? (
              <InstanceField
                label="Claude home"
                hint="HOME or a .claude folder for a second account."
                className="@[620px]/settings:col-span-2"
              >
                <Input
                  className={cn(FIELD_INPUT, "font-mono")}
                  placeholder="~/.claude"
                  defaultValue={readInstanceConfigString(config, "homePath")}
                  onBlur={(e) => onPatchConfig({ homePath: e.target.value })}
                />
              </InstanceField>
            ) : null}
            {config.driver === "cursor" ? (
              <InstanceField
                label="ACP endpoint"
                className="@[620px]/settings:col-span-2"
              >
                <Input
                  className={cn(FIELD_INPUT, "font-mono")}
                  placeholder="Optional"
                  defaultValue={readInstanceConfigString(config, "apiEndpoint")}
                  onBlur={(e) => onPatchConfig({ apiEndpoint: e.target.value })}
                />
              </InstanceField>
            ) : null}
            {config.driver === "betterc0de" ? (
              <>
                <InstanceField
                  label="Server URL"
                  className="@[620px]/settings:col-span-2"
                >
                  <Input
                    className={cn(FIELD_INPUT, "font-mono")}
                    placeholder="https://"
                    defaultValue={readInstanceConfigString(config, "serverUrl")}
                    onBlur={(e) => onPatchConfig({ serverUrl: e.target.value })}
                  />
                </InstanceField>
                <InstanceField label="Username">
                  <Input
                    className={FIELD_INPUT}
                    placeholder="Optional"
                    defaultValue={readInstanceConfigString(
                      config,
                      "serverUsername"
                    )}
                    onBlur={(e) =>
                      onPatchConfig({ serverUsername: e.target.value })
                    }
                  />
                </InstanceField>
                <InstanceField label="Password">
                  <SecretValueInput
                    value={readRecordValue(config.config, "serverPassword")}
                    placeholder="Optional"
                    onPatch={(serverPassword) =>
                      onPatchConfig({ serverPassword })
                    }
                  />
                </InstanceField>
              </>
            ) : null}
          </div>

          <InstanceModelsField
            models={readInstanceConfigStringArray(config, "customModels")}
            onChange={(customModels) => onPatchConfig({ customModels })}
          />

          <EnvironmentEditor
            environment={config.environment ?? []}
            onChange={(environment) => onPatch({ environment })}
          />

          <div className="flex justify-end border-t border-border/30 pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemove}
              className="h-7 gap-1.5 rounded-lg px-2.5 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              {isDefault ? (
                <RotateCcwIcon className="size-3.5" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              {isDefault ? "Reset to default" : "Remove instance"}
            </Button>
          </div>
        </div>
      )}
    </article>
  )
}

function InstanceField({
  label,
  hint,
  className,
  children,
}: {
  label: string
  hint?: string
  className?: string
  children: ReactNode
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="text-[10.5px] leading-snug text-muted-foreground/75">
          {hint}
        </span>
      ) : null}
    </label>
  )
}

/** Extra model ids as removable chips, typed into one field (Enter adds). */
function InstanceModelsField({
  models,
  onChange,
}: {
  models: string[]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState("")
  const add = () => {
    const value = draft.trim()
    if (!value) return
    if (!models.includes(value)) onChange([...models, value])
    setDraft("")
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          Extra models
        </span>
        <span className="text-[10.5px] text-muted-foreground/75">
          Model ids it offers besides the ones it reports
        </span>
      </div>
      <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-border/50 bg-background/50 p-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 dark:bg-input/30">
        {models.map((model) => (
          <span
            key={model}
            className="flex items-center gap-1 rounded-md bg-foreground/[0.07] py-0.5 pr-1 pl-2 font-mono text-[11px]"
          >
            {model}
            <button
              type="button"
              aria-label={`Remove ${model}`}
              onClick={() => onChange(models.filter((item) => item !== model))}
              className="rounded-sm text-muted-foreground hover:text-destructive"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
        <input
          aria-label="Add a model id"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault()
              add()
            } else if (
              event.key === "Backspace" &&
              !draft &&
              models.length > 0
            ) {
              onChange(models.slice(0, -1))
            }
          }}
          onBlur={add}
          placeholder={
            models.length ? "Add another" : "e.g. gpt-6-sol, then Enter"
          }
          className="h-6 min-w-[140px] flex-1 bg-transparent px-1.5 font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-muted-foreground/60"
        />
      </div>
    </div>
  )
}

function ProviderUpdateNotificationBanner({
  view,
  oneClickCandidates,
  busy,
  onUpdate,
  onDismiss,
}: {
  view: ProviderUpdateView
  oneClickCandidates: ReadonlyArray<ProviderUpdateCandidate>
  busy: boolean
  onUpdate: () => void
  onDismiss: () => void
}) {
  const canUpdate = oneClickCandidates.length > 0
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-xl border border-border/50 px-4 py-3",
        view.tone === "warning" && "border-warning/30 bg-warning/5",
        view.tone === "error" && "bg-destructive/5",
        view.tone === "success" && "bg-emerald-500/5",
        view.tone === "loading" && "bg-sky-500/5"
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <ProviderUpdateStatusIcon tone={view.tone} busy={busy} />
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">
            {view.title}
          </div>
          <div className="mt-0.5 max-w-[52ch] text-[11px] text-muted-foreground">
            {view.description}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {canUpdate ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[10px]"
            disabled={busy}
            onClick={onUpdate}
          >
            {busy ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <ArrowUpCircleIcon className="size-3" />
            )}
            Update {oneClickCandidates.length > 1 ? "all" : "now"}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[10px]"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}

function ProviderUpdateStatusIcon({
  tone,
  busy,
}: {
  tone: ProviderUpdateView["tone"]
  busy: boolean
}) {
  if (busy || tone === "loading") {
    return (
      <Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin text-sky-500" />
    )
  }
  if (tone === "success") {
    return (
      <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
    )
  }
  return (
    <AlertTriangleIcon
      className={cn(
        "mt-0.5 size-3.5 shrink-0",
        tone === "error" ? "text-destructive" : "text-amber-500"
      )}
    />
  )
}

function formatVersionAdvisory(snapshot: ProviderInstanceSnapshot): string {
  const advisory = snapshot.versionAdvisory
  if (!advisory)
    return snapshot.version ? `v${snapshot.version}` : "Version unknown"
  if (advisory.status === "behind_latest" && advisory.latestVersion) {
    return `${advisory.currentVersion ?? "Unknown"} → ${advisory.latestVersion}`
  }
  if (advisory.currentVersion) return `v${advisory.currentVersion}`
  return "Version unknown"
}

function formatMetadataCheckedAt(value: number | null | undefined): string {
  if (!value) return "Not checked"
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return `${hours}h ago`
}

function EnvironmentEditor({
  environment: savedEnvironment,
  onChange: onSave,
}: {
  environment: ProviderInstanceConfig["environment"]
  onChange: (next: ProviderInstanceConfig["environment"]) => void
}) {
  const [environment, setEnvironment] = useState(savedEnvironment)
  const savedSignature = useRef(JSON.stringify(savedEnvironment))
  useEffect(() => {
    const signature = JSON.stringify(savedEnvironment)
    if (signature === savedSignature.current) return
    savedSignature.current = signature
    setEnvironment(savedEnvironment)
  }, [savedEnvironment])
  const onChange = (next: ProviderInstanceConfig["environment"]) => {
    setEnvironment(next)
    if (isValidEnvironmentDraft(next)) onSave(next)
  }
  const update = (
    index: number,
    patch: Partial<ProviderInstanceConfig["environment"][number]>
  ) => {
    onChange(
      environment.map((item, i) => (i === index ? { ...item, ...patch } : item))
    )
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          Environment
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() =>
            onChange([
              ...environment,
              { name: "", value: "", sensitive: false },
            ])
          }
        >
          <PlusIcon className="size-3" />
          Add variable
        </Button>
      </div>
      {environment.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
          No extra variables. The CLI gets your normal environment.
        </p>
      ) : (
        <div className="space-y-1.5">
          {environment.map((item, index) => (
            <div
              key={`${item.name}-${index}`}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] items-center gap-1.5"
            >
              <Input
                aria-label="Variable name"
                className={cn(FIELD_INPUT, "font-mono uppercase")}
                placeholder="NAME"
                defaultValue={item.name}
                aria-invalid={!isValidEnvironmentDraft([item])}
                onBlur={(e) => update(index, { name: e.target.value.trim() })}
              />
              <Input
                aria-label={`Value of ${item.name || "variable"}`}
                className={cn(FIELD_INPUT, "font-mono")}
                placeholder={item.valueRedacted ? "Stored secret" : "value"}
                type={item.sensitive ? "password" : "text"}
                defaultValue={item.valueRedacted ? "" : item.value}
                onBlur={(e) => {
                  const value = e.target.value
                  if (item.valueRedacted && value.length === 0) return
                  update(index, {
                    value,
                    ...(item.valueRedacted
                      ? { valueRedacted: false, secretState: undefined }
                      : {}),
                  })
                }}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-pressed={item.sensitive ?? false}
                aria-label={
                  item.sensitive ? "Secret: stored hidden" : "Mark as secret"
                }
                title={
                  item.sensitive ? "Secret: stored hidden" : "Mark as secret"
                }
                onClick={() => update(index, { sensitive: !item.sensitive })}
                className={cn(
                  "size-8 rounded-lg",
                  item.sensitive
                    ? "bg-foreground/[0.06] text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {item.sensitive ? (
                  <LockIcon className="size-3.5" />
                ) : (
                  <LockOpenIcon className="size-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${item.name || "variable"}`}
                onClick={() =>
                  onChange(environment.filter((_, i) => i !== index))
                }
                className="size-8 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SecretValueInput({
  value,
  placeholder,
  onPatch,
}: {
  value: unknown
  placeholder: string
  onPatch: (patch: { set: string } | { clear: true }) => void
}) {
  const state = readSecretState(value)
  const configured =
    state?.configured === true ||
    (typeof value === "string" && value.length > 0)
  return (
    <div className="flex items-center gap-1.5">
      <Input
        className={cn(FIELD_INPUT, "flex-1 font-mono")}
        placeholder={configured ? "Stored secret" : placeholder}
        type="password"
        defaultValue={state ? "" : typeof value === "string" ? value : ""}
        onBlur={(event) => {
          const next = event.target.value
          if (!next && configured) return
          onPatch(next ? { set: next } : { clear: true })
        }}
      />
      {configured ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 rounded-lg px-2.5 text-[11px]"
          onClick={() => onPatch({ clear: true })}
        >
          Clear
        </Button>
      ) : null}
    </div>
  )
}

function mergedInstanceRows(
  explicit: ProviderInstancesMap,
  snapshots: ProviderInstanceSnapshot[]
): Array<{
  config: ProviderInstanceConfig
  snapshot?: ProviderInstanceSnapshot
}> {
  const rows = new Map<
    string,
    { config: ProviderInstanceConfig; snapshot?: ProviderInstanceSnapshot }
  >()
  for (const snapshot of snapshots) {
    rows.set(snapshot.instanceId, {
      config: normalizeProviderInstanceConfig(snapshot.instanceId, snapshot),
      snapshot,
    })
  }
  for (const [instanceId, config] of Object.entries(explicit)) {
    rows.set(instanceId, {
      config: normalizeProviderInstanceConfig(instanceId, config),
      snapshot: snapshots.find(
        (snapshot) => snapshot.instanceId === instanceId
      ),
    })
  }
  return [...rows.values()].sort(
    (a, b) =>
      instanceSortRank(a.config.instanceId) -
      instanceSortRank(b.config.instanceId)
  )
}

function normalizeProviderInstancesMap(
  raw: ProviderInstancesMap
): ProviderInstancesMap {
  const out: ProviderInstancesMap = {}
  for (const [instanceId, config] of Object.entries(raw ?? {})) {
    out[instanceId] = normalizeProviderInstanceConfig(instanceId, config)
  }
  return out
}

function createProviderInstanceConfig(
  instanceId: string,
  driver: ProviderInstanceDriver
): ProviderInstanceConfig {
  return normalizeProviderInstanceConfig(instanceId, {
    instanceId,
    driver,
    displayName: providerDriverLabel(driver),
    enabled: true,
    environment: [],
    config: {
      binaryPath: defaultBinaryPath(driver),
      ...(driver === "codex" || driver === "claude" ? { homePath: "" } : {}),
      ...(driver === "codex" ? { shadowHomePath: "" } : {}),
      ...(driver === "cursor" ? { apiEndpoint: "" } : {}),
      ...(driver === "betterc0de"
        ? { serverUrl: "", serverUsername: "", serverPassword: "" }
        : {}),
      customModels: [],
    },
  })
}

function defaultBinaryPath(driver: string): string {
  switch (driver) {
    case "claude":
      return "claude"
    case "cursor":
      return "agent"
    case "betterc0de":
      return "betterc0de"
    case "opencode-cli":
      return "opencode"
    case "codex":
      return "codex"
    default:
      return driver
  }
}

function providerDriverLabel(driver: string | ProviderInstanceDriver): string {
  switch (normalizeDriver(driver)) {
    case "claude":
      return "Claude"
    case "cursor":
      return "Cursor"
    case "betterc0de":
      return "BetterC0de"
    case "opencode-cli":
      return "OpenCode"
    case "codex":
      return "Codex"
    default:
      return driver
  }
}

function readInstanceConfigString(
  config: ProviderInstanceConfig,
  key: string
): string {
  return readRecordString(config.config, key) ?? ""
}

function readInstanceConfigStringArray(
  config: ProviderInstanceConfig,
  key: string
): string[] {
  return readRecordStringArray(config.config, key)
}

function readRecordString(record: unknown, key: string): string | null {
  if (!record || typeof record !== "object" || Array.isArray(record))
    return null
  const value = (record as Record<string, unknown>)[key]
  return typeof value === "string" ? value : null
}

function readRecordValue(record: unknown, key: string): unknown {
  return isRecord(record) ? record[key] : undefined
}

function readSecretState(value: unknown): SecretState | null {
  if (!isRecord(value) || typeof value.configured !== "boolean") return null
  if (value.storage !== "encrypted" && value.storage !== "plaintext")
    return null
  return {
    configured: value.configured,
    storage: value.storage,
  }
}

function isSecretSetPatch(value: unknown): value is { set: string } {
  return isRecord(value) && typeof value.set === "string"
}

function readRecordStringArray(record: unknown, key: string): string[] {
  if (!record || typeof record !== "object" || Array.isArray(record)) return []
  const value = (record as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
}

function isDefaultInstance(instanceId: string): boolean {
  return (
    instanceId === "codex" ||
    instanceId === "claude" ||
    instanceId === "cursor" ||
    instanceId === "betterc0de" ||
    instanceId === "BetterC0de" ||
    instanceId === "opencode-cli"
  )
}

function instanceSortRank(instanceId: string): number {
  if (instanceId === "codex") return 0
  if (instanceId === "claude") return 1
  if (instanceId === "cursor") return 2
  if (instanceId === "betterc0de") return 3
  if (instanceId === "BetterC0de") return 4
  if (instanceId === "opencode-cli") return 5
  return 10
}
