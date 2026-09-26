import { isRecord } from "@betterc0de/schema"
import { normalizeProviderInstanceConfig, normalizeProviderDriver as normalizeDriver, isValidEnvironmentDraft, changedProviderConfigFields } from "@/lib/provider-instance-settings"
import { defaultInstanceIdForDriver, normalizeProviderDriverKind } from "@/lib/provider-instances"
import { useState, useCallback, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { SettingsSection, SettingsRow } from "@/components/settings/atoms"
import { useSettingsStore } from "@/lib/settings-store"
import {
  getSettings,
  updateSettings,
  validateProviderKey,
} from "@/services/backend"
import {
  getCliStatus,
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
  KeyRoundIcon,
  AlertTriangleIcon,
  TerminalIcon,
  PlusIcon,
  Trash2Icon,
  RefreshCwIcon,
  ArrowUpCircleIcon,
} from "lucide-react"
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

const log = createLogger("settings-providers")

type ProviderInstancesMap = Record<string, ProviderInstanceConfig>
type ProviderInstanceDriver =
  | "codex"
  | "claude"
  | "cursor"
  | "betterc0de"
  | "opencode-cli"

function notifySettingsUpdated() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT))
  }
}

/**
 * Settings UI for provider configuration.
 *
 * Pre-PR1 this was a 305-line hardcoded array of {id, name, envVar, models}
 * objects. Post-PR1 the catalog lives in `apps/backend/src/provider/catalog/`
 * (one file per provider) and is served to the renderer via the
 * `provider:list` IPC channel. Adding a provider in the catalog
 * auto-renders here — no UI edit needed.
 *
 * PR3/PR4 add OAuth support: providers whose `authMethods` include an
 * `oauth` entry get a "Sign in with X" button that delegates to the local
 * OAuth callback server in apps/shell/oauth/.
 */

export function SettingsProvidersSection() {
  const _settings = useSettingsStore()
  const [providerSettings, setProviderSettings] = useState<
    Record<string, Record<string, unknown>>
  >({})
  const [, setSaving] = useState(false)
  const [keyStatus, setKeyStatus] = useState<
    Record<string, "idle" | "checking" | "valid" | "invalid">
  >({})
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([])
  const [authStatus, setAuthStatus] = useState<
    Record<string, "oauth" | "api" | "wellknown">
  >({})
  const [oauthBusy, setOauthBusy] = useState<Record<string, boolean>>({})
  const [cliStatus, setCliStatus] = useState<Record<string, CliStatus>>({})
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
        await refreshProviderInstances()
      } finally {
        setUpdatingInstanceId(null)
      }
    },
    [refreshProviderInstances]
  )

  const refreshCliStatus = useCallback(async () => {
    try {
      const res = await getCliStatus()
      if (res?.cli && typeof res.cli === "object") setCliStatus(res.cli)
    } catch (e) {
      log.warn("Failed to load CLI status", e)
    }
  }, [])

  const refreshAuthStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI?.providerAuthStatus?.()
      if (status && typeof status === "object")
        setAuthStatus(status as Record<string, "oauth" | "api" | "wellknown">)
    } catch (e) {
      log.warn("Failed to load provider auth status", e)
    }
  }, [])

  // Load provider settings + catalog + auth status on mount
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

    void window.electronAPI
      ?.providerList?.()
      .then((list) => {
        if (Array.isArray(list)) setCatalog(list)
      })
      .catch((e) => log.warn("Failed to load provider catalog", e))

    void refreshAuthStatus()
    void refreshCliStatus()
    void refreshProviderInstances()
  }, [refreshAuthStatus, refreshCliStatus, refreshProviderInstances])

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
          [providerId]: res.valid ? "valid" : "invalid",
        }))
      } catch {
        setKeyStatus((prev) => ({ ...prev, [providerId]: "invalid" }))
      }
    },
    []
  )

  const saveKey = useCallback(
    async (providerId: string, key: string, value: unknown) => {
      setSaving(true)
      const nextProviders = {
        ...providerSettings,
        [providerId]: {
          ...(providerSettings[providerId] ?? {}),
          [key]: value,
        },
      }
      const patch = { providers: nextProviders }
      try {
        const saved = await updateSettings(patch)
        const savedProviders = saved.providers
        setProviderSettings(
          isRecord(savedProviders)
            ? (savedProviders as Record<string, Record<string, unknown>>)
            : nextProviders
        )
        notifySettingsUpdated()
        if (key === "api_key" && isSecretSetPatch(value))
          validateKey(providerId, value.set)
      } catch (e) {
        log.warn("Failed to save provider setting:", providerId, key, e)
        handleError(e, { source: "provider-settings-save" })
      }
      setSaving(false)
    },
    [providerSettings, validateKey]
  )

  const saveProviderInstances = useCallback(
    async (next: ProviderInstancesMap) => {
      const previous = providerInstances
      const normalized = normalizeProviderInstancesMap(next)
      setProviderInstances(normalized)
      setSaving(true)
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
      } finally {
        setSaving(false)
      }
    },
    [providerInstances, refreshProviderInstances]
  )

  const startOauth = useCallback(
    async (providerId: string, handler: string) => {
      setOauthBusy((p) => ({ ...p, [providerId]: true }))
      try {
        await window.electronAPI?.providerOauthStart?.(providerId, handler)
        await refreshAuthStatus()
      } catch (e) {
        log.warn("OAuth flow failed:", providerId, e)
      } finally {
        setOauthBusy((p) => ({ ...p, [providerId]: false }))
      }
    },
    [refreshAuthStatus]
  )

  const clearAuth = useCallback(
    async (providerId: string) => {
      try {
        await window.electronAPI?.providerAuthClear?.(providerId)
        await refreshAuthStatus()
      } catch (e) {
        log.warn("Failed to clear credential:", providerId, e)
      }
    },
    [refreshAuthStatus]
  )

  if (catalog.length === 0) {
    return <p className="text-xs text-muted-foreground">Loading providers…</p>
  }

  return (
    <>
      <p className="mb-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        API Keys & Providers
      </p>
      {catalog.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          config={providerSettings[provider.id] ?? {}}
          authType={authStatus[provider.id]}
          oauthBusy={!!oauthBusy[provider.id]}
          keyStatus={keyStatus[provider.id] ?? "idle"}
          cliStatus={cliStatus[provider.id]}
          liveModels={
            instanceSnapshots.find(
              (snapshot) =>
                snapshot.instanceId ===
                defaultInstanceIdForDriver(
                  normalizeProviderDriverKind(provider.id)
                )
            )?.models ?? []
          }
          onSaveKey={saveKey}
          onStartOauth={startOauth}
          onClearAuth={clearAuth}
          onRefreshCli={refreshCliStatus}
        />
      ))}
      <ProviderInstancesSection
        instances={providerInstances}
        snapshots={instanceSnapshots}
        updatingInstanceId={updatingInstanceId}
        onChange={(next) => void saveProviderInstances(next)}
        onRefresh={refreshProviderInstances}
        onUpdate={runProviderInstanceUpdate}
      />
    </>
  )
}

interface ProviderRowProps {
  provider: ProviderCatalogEntry
  config: Record<string, unknown>
  authType: "oauth" | "api" | "wellknown" | undefined
  oauthBusy: boolean
  keyStatus: "idle" | "checking" | "valid" | "invalid"
  cliStatus: CliStatus | undefined
  /** Live model slugs from the default instance's runtime inventory, merged
   *  into the Visible Models list so CLI inventories (OpenCode, Cursor…)
   *  stay toggled without re-shipping a static default list. */
  liveModels: ProviderInstanceSnapshot["models"]
  onSaveKey: (providerId: string, key: string, value: unknown) => Promise<void>
  onStartOauth: (providerId: string, handler: string) => Promise<void>
  onClearAuth: (providerId: string) => Promise<void>
  onRefreshCli: () => Promise<void>
}

function ProviderRow({
  provider,
  config,
  authType,
  oauthBusy,
  keyStatus,
  cliStatus,
  liveModels,
  onSaveKey,
  onStartOauth,
  onClearAuth,
  onRefreshCli,
}: ProviderRowProps) {
  const apiKeyMethod = provider.authMethods.find(
    (m): m is Extract<ProviderAuthMethod, { type: "api-key" }> =>
      m.type === "api-key"
  )
  const oauthMethod = provider.authMethods.find(
    (m): m is Extract<ProviderAuthMethod, { type: "oauth" }> =>
      m.type === "oauth"
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

  return (
    <SettingsSection title={provider.name} description={provider.description}>
      {/* CLI-backed method (claude / codex) */}
      {cliMethod && (
        <SettingsRow
          label={cliMethod.label}
          description={
            !cliStatus ? (
              "Detecting…"
            ) : !cliStatus.installed ? (
              <>
                Not installed
                {cliMethod.installHint && (
                  <>
                    :{" "}
                    <code className="text-[10px]">{cliMethod.installHint}</code>
                  </>
                )}
              </>
            ) : !cliStatus.authenticated ? (
              <>
                Installed v{cliStatus.version} but not signed in
                {cliMethod.loginCommand && (
                  <>
                    : run{" "}
                    <code className="text-[10px]">
                      {cliMethod.loginCommand}
                    </code>
                  </>
                )}
              </>
            ) : (
              <>
                Installed v{cliStatus.version} · Signed in (
                {cliStatus.authType ?? "unknown"})
              </>
            )
          }
        >
          <div className="flex items-center gap-2">
            {!cliStatus ? (
              <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
            ) : cliStatus.installed && cliStatus.authenticated ? (
              <CheckCircle2Icon className="size-3.5 text-emerald-500" />
            ) : cliStatus.installed ? (
              <AlertTriangleIcon className="size-3.5 text-amber-500" />
            ) : (
              <TerminalIcon className="size-3.5 text-muted-foreground/50" />
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px]"
              onClick={() => void onRefreshCli()}
              title="Re-detect CLI install + auth"
            >
              Recheck
            </Button>
          </div>
        </SettingsRow>
      )}

      {/* OAuth method (if available) */}
      {oauthMethod && (
        <SettingsRow
          label={oauthMethod.label}
          description={
            authType === "oauth"
              ? "Currently signed in."
              : "Browser-based sign-in. No API key required."
          }
        >
          <div className="flex items-center gap-2">
            {authType === "oauth" ? (
              <>
                <CheckCircle2Icon className="size-3.5 text-emerald-500" />
                <span className="text-[10px] text-muted-foreground">
                  Signed in
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[10px]"
                  onClick={() => void onClearAuth(provider.id)}
                >
                  Sign out
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                className="h-7 px-2 text-[10px]"
                disabled={oauthBusy}
                onClick={() =>
                  void onStartOauth(provider.id, oauthMethod.handler)
                }
              >
                {oauthBusy ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <KeyRoundIcon className="size-3" />
                )}
                <span className="ml-1">
                  {oauthBusy ? "Waiting for browser…" : "Sign in"}
                </span>
              </Button>
            )}
          </div>
        </SettingsRow>
      )}

      {/* API key method */}
      {apiKeyMethod && (
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
                      void window.electronAPI?.openExternal?.(provider.docsUrl!)
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
              type="password"
              className="h-8 flex-1 font-mono text-xs"
              placeholder={
                hasKey ? "Stored API key" : (apiKeyMethod.placeholder ?? "")
              }
              defaultValue={apiKeyState ? "" : ((config.api_key as string | undefined) ?? "")}
              onBlur={(e) => {
                const value = e.target.value.trim()
                if (!value && hasKey) return
                void onSaveKey(
                  provider.id,
                  "api_key",
                  value ? { set: value } : { clear: true }
                )
              }}
            />
            {keyStatus === "checking" ? (
              <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  keyStatus === "valid"
                    ? "bg-emerald-500"
                    : keyStatus === "invalid"
                      ? "bg-red-500"
                      : hasKey
                        ? "bg-amber-500"
                        : "bg-muted-foreground/30"
                )}
                title={
                  keyStatus === "valid"
                    ? "Key verified"
                    : keyStatus === "invalid"
                      ? "Key invalid"
                      : hasKey
                        ? "Key saved, not verified"
                        : "No key"
                }
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

      {/* Local server (LM Studio etc.) */}
      {localServerMethod && (
        <SettingsRow
          label={localServerMethod.label}
          description={localServerMethod.hint ?? "Local model server endpoint."}
        >
          <Input
            className="h-8 w-[280px] font-mono text-xs"
            placeholder={localServerMethod.defaultBaseUrl}
            defaultValue={(config.base_url as string | undefined) ?? ""}
            onBlur={(e) =>
              void onSaveKey(provider.id, "base_url", e.target.value || null)
            }
          />
        </SettingsRow>
      )}

      {/* Custom models */}
      <SettingsRow
        label="Custom Models"
        description="Add model IDs not in the default list"
      >
        <CustomModelInput
          providerId={provider.id}
          customModels={customModels}
          onChange={(next) =>
            void onSaveKey(provider.id, "custom_models", next)
          }
        />
      </SettingsRow>

      {/* Hidden models */}
      {(() => {
        const visibleModelIds = [...provider.defaultModels]
        for (const model of liveModels ?? []) {
          const slug = model.slug?.trim()
          if (slug && !visibleModelIds.includes(slug)) visibleModelIds.push(slug)
        }
        if (visibleModelIds.length === 0) return null
        return (
          <SettingsRow
            label="Visible Models"
            description="Toggle models on/off in the dropdown"
          >
            <div className="w-[280px] space-y-0.5">
              {visibleModelIds.map((m) => (
                <div key={m} className="flex items-center gap-2 text-[10px]">
                  <Switch
                    checked={!hiddenModels.includes(m)}
                    onCheckedChange={(v) => {
                      const next = v
                        ? hiddenModels.filter((h) => h !== m)
                        : [...hiddenModels, m]
                      void onSaveKey(provider.id, "hidden_models", next)
                    }}
                  />
                  <span className="truncate font-mono text-muted-foreground">
                    {m}
                  </span>
                </div>
              ))}
            </div>
          </SettingsRow>
        )
      })()}
    </SettingsSection>
  )
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
    <div className="w-[280px]">
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

function ProviderInstancesSection({
  instances,
  snapshots,
  updatingInstanceId,
  onChange,
  onRefresh,
  onUpdate,
}: ProviderInstancesSectionProps) {
  const [dismissedUpdateKey, setDismissedUpdateKey] = useState<string | null>(
    null
  )
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
  }
  const removeInstance = (instanceId: string) => {
    const next = { ...instances }
    delete next[instanceId]
    onChange(next)
  }

  return (
    <>
      <p className="mt-4 mb-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        CLI Instances
      </p>
      <SettingsSection
        title="Provider Instances"
        description="Separate Codex, Claude, Cursor, and BetterC0de compatibility profiles with their own binary, config, env vars, and models."
      >
        {updateView && updateNotificationKey && !updateNotificationDismissed ? (
          <ProviderUpdateNotificationBanner
            view={updateView}
            oneClickCandidates={oneClickUpdateCandidates}
            busy={updateBusy}
            onUpdate={() => void runOneClickUpdates()}
            onDismiss={dismissUpdateNotification}
          />
        ) : null}
        <SettingsRow
          label="Add Instance"
          description="Create another selectable Codex or Claude target."
        >
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px]"
              onClick={() => addInstance("codex")}
            >
              <PlusIcon className="size-3" />
              Codex
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px]"
              onClick={() => addInstance("claude")}
            >
              <PlusIcon className="size-3" />
              Claude
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px]"
              onClick={() => addInstance("cursor")}
            >
              <PlusIcon className="size-3" />
              Cursor
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px]"
              onClick={() => addInstance("betterc0de")}
            >
              <PlusIcon className="size-3" />
              BetterC0de
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px]"
              onClick={() => addInstance("opencode-cli")}
            >
              <PlusIcon className="size-3" />
              OpenCode
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px]"
              onClick={() => void onRefresh()}
              title="Refresh instance status"
            >
              <RefreshCwIcon className="size-3" />
            </Button>
          </div>
        </SettingsRow>
        {rows.map(({ config, snapshot }) => (
          <SettingsRow
            key={config.instanceId}
            label={config.displayName || config.instanceId}
            description={
              snapshot?.unavailableReason
                ? snapshot.unavailableReason
                : snapshot
                  ? `${config.driver} · ${snapshot.configured ? "ready" : "not configured"}`
                  : config.driver
            }
          >
            <div className="w-[360px] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={config.enabled !== false}
                    onCheckedChange={(enabled) =>
                      patchInstance(config.instanceId, { enabled })
                    }
                  />
                  <span className="text-[10px] text-muted-foreground">
                    {snapshot?.configured ? "Configured" : "Needs setup"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {snapshot?.versionAdvisory?.canUpdate ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[10px]"
                      disabled={
                        updatingInstanceId === config.instanceId ||
                        snapshot.updateState?.status === "queued" ||
                        snapshot.updateState?.status === "running"
                      }
                      onClick={() => void onUpdate(config.instanceId)}
                      title={
                        snapshot.versionAdvisory.updateCommand ??
                        "Update provider"
                      }
                    >
                      {updatingInstanceId === config.instanceId ||
                      snapshot.updateState?.status === "queued" ||
                      snapshot.updateState?.status === "running" ? (
                        <Loader2Icon className="size-3 animate-spin" />
                      ) : (
                        <ArrowUpCircleIcon className="size-3" />
                      )}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[10px]"
                    onClick={() =>
                      void refreshProviderInstance(config.instanceId).then(() =>
                        onRefresh()
                      )
                    }
                    title="Refresh this instance"
                  >
                    <RefreshCwIcon className="size-3" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[10px]"
                    onClick={() => removeInstance(config.instanceId)}
                    title={
                      isDefaultInstance(config.instanceId)
                        ? "Reset to default"
                        : "Remove instance"
                    }
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </div>
              </div>
              {snapshot ? (
                <ProviderMetadataSummary snapshot={snapshot} />
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder="Display name"
                  defaultValue={config.displayName ?? ""}
                  onBlur={(e) =>
                    patchInstance(config.instanceId, {
                      displayName: e.target.value || undefined,
                    })
                  }
                />
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder="#7c3aed"
                  defaultValue={config.accentColor ?? ""}
                  onBlur={(e) =>
                    patchInstance(config.instanceId, {
                      accentColor: e.target.value || undefined,
                    })
                  }
                />
              </div>
              <Input
                className="h-8 font-mono text-xs"
                placeholder={`${providerDriverLabel(config.driver)} binary path`}
                defaultValue={readInstanceConfigString(config, "binaryPath")}
                onBlur={(e) =>
                  patchInstanceConfig(config.instanceId, {
                    binaryPath: e.target.value,
                  })
                }
              />
              {config.driver === "codex" || config.driver === "claude" ? (
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder={
                    config.driver === "claude"
                      ? "HOME or .claude path"
                      : "CODEX_HOME path"
                  }
                  defaultValue={readInstanceConfigString(config, "homePath")}
                  onBlur={(e) =>
                    patchInstanceConfig(config.instanceId, {
                      homePath: e.target.value,
                    })
                  }
                />
              ) : null}
              {config.driver === "codex" ? (
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder="Shadow CODEX_HOME path"
                  defaultValue={readInstanceConfigString(
                    config,
                    "shadowHomePath"
                  )}
                  onBlur={(e) =>
                    patchInstanceConfig(config.instanceId, {
                      shadowHomePath: e.target.value,
                    })
                  }
                />
              ) : null}
              {config.driver === "cursor" ? (
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder="Cursor ACP endpoint"
                  defaultValue={readInstanceConfigString(config, "apiEndpoint")}
                  onBlur={(e) =>
                    patchInstanceConfig(config.instanceId, {
                      apiEndpoint: e.target.value,
                    })
                  }
                />
              ) : null}
              {config.driver === "betterc0de" ||
              config.driver === "opencode-cli" ? (
                <>
                  <Input
                    className="h-8 font-mono text-xs"
                    placeholder="Compatibility server URL"
                    defaultValue={readInstanceConfigString(config, "serverUrl")}
                    onBlur={(e) =>
                      patchInstanceConfig(config.instanceId, {
                        serverUrl: e.target.value,
                      })
                    }
                  />
                  <Input
                    className="h-8 font-mono text-xs"
                    placeholder="Compatibility server username"
                    defaultValue={readInstanceConfigString(
                      config,
                      "serverUsername"
                    )}
                    onBlur={(e) =>
                      patchInstanceConfig(config.instanceId, {
                        serverUsername: e.target.value,
                      })
                    }
                  />
                  <SecretValueInput
                    value={readRecordValue(config.config, "serverPassword")}
                    placeholder="Compatibility server password"
                    onPatch={(serverPassword) =>
                      patchInstanceConfig(config.instanceId, { serverPassword })
                    }
                  />
                </>
              ) : null}
              <CustomModelInput
                providerId={`instance-${config.instanceId}`}
                customModels={readInstanceConfigStringArray(
                  config,
                  "customModels"
                )}
                onChange={(customModels) =>
                  patchInstanceConfig(config.instanceId, { customModels })
                }
              />
              <EnvironmentEditor
                environment={config.environment ?? []}
                onChange={(environment) =>
                  patchInstance(config.instanceId, { environment })
                }
              />
            </div>
          </SettingsRow>
        ))}
      </SettingsSection>
    </>
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
        "flex items-start justify-between gap-3 px-4 py-3",
        view.tone === "warning" && "bg-amber-500/5",
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

function ProviderMetadataSummary({
  snapshot,
}: {
  snapshot: ProviderInstanceSnapshot
}) {
  const skills = snapshot.skills ?? []
  const slashCommands = snapshot.slashCommands ?? []
  const metadata = snapshot.metadata
  const errors = [metadata?.skillsError, metadata?.slashCommandsError].filter(
    (entry): entry is string => Boolean(entry)
  )
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
      <div className="grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
        <div>
          <div className="font-medium text-foreground">{skills.length}</div>
          <div>Skills</div>
        </div>
        <div>
          <div className="font-medium text-foreground">
            {slashCommands.length}
          </div>
          <div>Commands</div>
        </div>
        <div>
          <div className="truncate font-medium text-foreground">
            {formatMetadataCheckedAt(metadata?.checkedAt)}
          </div>
          <div>Metadata</div>
        </div>
      </div>
      {snapshot.versionAdvisory || snapshot.updateState ? (
        <div className="mt-2 rounded border border-border/50 bg-background/40 px-2 py-1.5 text-[10px] text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{formatVersionAdvisory(snapshot)}</span>
            {snapshot.updateState ? (
              <span
                className={cn(
                  "shrink-0 font-medium",
                  snapshot.updateState.status === "failed"
                    ? "text-destructive"
                    : snapshot.updateState.status === "succeeded"
                      ? "text-emerald-500"
                      : "text-muted-foreground"
                )}
              >
                {snapshot.updateState.status}
              </span>
            ) : null}
          </div>
          {snapshot.updateState?.message ? (
            <div className="mt-1 line-clamp-2">
              {snapshot.updateState.message}
            </div>
          ) : null}
        </div>
      ) : null}
      {errors.length > 0 ? (
        <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-600 dark:text-amber-400">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-2">{errors.join(" · ")}</span>
        </div>
      ) : null}
    </div>
  )
}

function formatVersionAdvisory(snapshot: ProviderInstanceSnapshot): string {
  const advisory = snapshot.versionAdvisory
  if (!advisory)
    return snapshot.version ? `v${snapshot.version}` : "Version unknown"
  if (advisory.status === "behind_latest" && advisory.latestVersion) {
    return `${advisory.currentVersion ?? "Unknown"} -> ${advisory.latestVersion}`
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
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground">
          Environment
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={() =>
            onChange([
              ...environment,
              { name: "", value: "", sensitive: false },
            ])
          }
        >
          <PlusIcon className="size-3" />
          Env
        </Button>
      </div>
      {environment.map((item, index) => (
        <div
          key={`${item.name}-${index}`}
          className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-1"
        >
          <Input
            className="h-7 font-mono text-[10px]"
            placeholder="NAME"
            defaultValue={item.name}
            aria-invalid={!isValidEnvironmentDraft([item])}
            onBlur={(e) => update(index, { name: e.target.value.trim() })}
          />
          <Input
            className="h-7 font-mono text-[10px]"
            placeholder={item.valueRedacted ? "stored secret" : "value"}
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
          <Switch
            checked={item.sensitive ?? false}
            onCheckedChange={(sensitive) => update(index, { sensitive })}
          />
          <button
            type="button"
            className="text-muted-foreground/50 hover:text-destructive"
            onClick={() => onChange(environment.filter((_, i) => i !== index))}
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
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
    state?.configured === true || (typeof value === "string" && value.length > 0)
  return (
    <div className="flex items-center gap-1">
      <Input
        className="h-8 flex-1 font-mono text-xs"
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
          className="h-7 px-2 text-[10px]"
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
      ...(driver === "betterc0de" || driver === "opencode-cli"
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
  if (value.storage !== "encrypted" && value.storage !== "plaintext") return null
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
