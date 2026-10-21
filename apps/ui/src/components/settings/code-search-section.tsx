import { useEffect, useRef, useState } from "react"
import { secretStateSchema } from "@betterc0de/schema"
import { getSettings, updateSettings } from "@/services/backend/coreApi"
import { SETTINGS_UPDATED_EVENT } from "@/lib/settings-store"
import { isRemoteRuntime } from "@/services/backend/runtime"
import { KeyRoundIcon, SearchCodeIcon } from "lucide-react"
import { SettingsRow, SettingsSection } from "./atoms"
import { BrandMarks } from "./brand-mark"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

/**
 * Who receives the search tools: Claude Code and Codex directly, Cursor and
 * Grok CLI over ACP, and the direct API providers (backend
 * services/code-search/README.md).
 */
const CODE_SEARCH_BRANDS = ["claude", "codex", "cursor", "grok-cli"] as const

interface SearchSettings {
  enabled: boolean
  configured: boolean
  storage: "encrypted" | "plaintext"
}

function readSettings(settings: Record<string, unknown>): SearchSettings {
  const key = secretStateSchema.optional().parse(settings.jev_api_key)
  if (typeof settings.jev_search_enabled !== "boolean")
    throw new Error("Invalid code search settings")
  return {
    enabled: settings.jev_search_enabled,
    configured: key?.configured ?? false,
    storage: key?.storage ?? "plaintext",
  }
}

/** Credentials remain write-only; the renderer only receives configured/storage metadata. */
export function SettingsCodeSearchSection() {
  const [settings, setSettings] = useState<SearchSettings | null>(null)
  const [draftKey, setDraftKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revision = useRef(0)
  const mutationPending = useRef(false)

  useEffect(() => {
    let active = true
    const refresh = () => {
      if (mutationPending.current) return
      const current = ++revision.current
      void getSettings()
        .then((result) => {
          if (active && current === revision.current) {
            setSettings(readSettings(result))
            setError(null)
          }
        })
        .catch(() => {
          if (active && current === revision.current)
            setError("Could not load code search settings.")
        })
    }
    refresh()
    window.addEventListener(SETTINGS_UPDATED_EVENT, refresh)
    return () => {
      active = false
      window.removeEventListener(SETTINGS_UPDATED_EVENT, refresh)
    }
  }, [])

  async function save(patch: Record<string, unknown>, clearDraft = false) {
    if (mutationPending.current) return
    mutationPending.current = true
    ++revision.current
    setSaving(true)
    setError(null)
    try {
      const result = await updateSettings(patch)
      setSettings(readSettings(result))
      if (clearDraft) setDraftKey("")
      mutationPending.current = false
      window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT))
    } catch {
      // Only the host owner can change this setting (see the backend's
      // services/code-search/README.md); on the host itself a failure is
      // just a failure.
      setError(
        isRemoteRuntime()
          ? "Couldn't save. Change this setting on the host device."
          : "Couldn't save. Try again."
      )
    } finally {
      mutationPending.current = false
      setSaving(false)
    }
  }

  return (
    <CodeSearchSettingsPanel
      settings={settings}
      draftKey={draftKey}
      saving={saving}
      error={error}
      onKeyChange={setDraftKey}
      onEnabledChange={(enabled) => void save({ jev_search_enabled: enabled })}
      onSaveKey={() =>
        void save({ jev_api_key: { set: draftKey.trim() } }, true)
      }
      onRemoveKey={() =>
        void save(
          { jev_api_key: { clear: true }, jev_search_enabled: false },
          true
        )
      }
    />
  )
}

export function CodeSearchSettingsPanel({
  settings,
  draftKey,
  saving,
  error,
  onKeyChange,
  onEnabledChange,
  onSaveKey,
  onRemoveKey,
}: {
  readonly settings: SearchSettings | null
  readonly draftKey: string
  readonly saving: boolean
  readonly error: string | null
  readonly onKeyChange: (key: string) => void
  readonly onEnabledChange: (enabled: boolean) => void
  readonly onSaveKey: () => void
  readonly onRemoveKey: () => void
}) {
  return (
    <SettingsSection
      title="Jev code search"
      description={
        <>
          Smarter code search for your CLI and API providers. Off by default.
          <span className="mt-1.5 flex">
            <BrandMarks ids={CODE_SEARCH_BRANDS} />
          </span>
        </>
      }
    >
      <SettingsRow
        label="Enable Jev code search"
        icon={<SearchCodeIcon />}
        description="Search sends your question, selected file paths and short code excerpts to TypeSafe AI for relevance ranking. File maps are built locally without calling Jev. New sessions receive the tools; turning this off immediately revokes existing access."
      >
        <Switch
          aria-label="Enable Jev code search"
          checked={settings?.enabled ?? false}
          disabled={
            !settings || saving || (!settings.configured && !settings.enabled)
          }
          onCheckedChange={onEnabledChange}
        />
      </SettingsRow>
      <div className="space-y-2 px-4 py-3">
        <label
          htmlFor="jev-api-key"
          className="flex items-center gap-3 text-sm font-medium"
        >
          <KeyRoundIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          TypeSafe API key
        </label>
        <p className="text-xs text-muted-foreground">
          {settings?.configured
            ? settings.storage === "encrypted"
              ? "Key saved and encrypted on this device."
              : "Key saved in plaintext on this device; encrypted storage is unavailable."
            : "Save a TypeSafe API key before enabling search. Jev usage is billed by TypeSafe AI."}
        </p>
        <div className="flex gap-2">
          <Input
            id="jev-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              settings?.configured ? "Replace saved key" : "Enter API key"
            }
            value={draftKey}
            maxLength={4096}
            disabled={!settings || saving}
            onChange={(event) => onKeyChange(event.target.value)}
          />
          <Button
            disabled={!settings || saving || !draftKey.trim()}
            onClick={onSaveKey}
          >
            Save key
          </Button>
          {settings?.configured && (
            <Button variant="outline" disabled={saving} onClick={onRemoveKey}>
              Remove key
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Jev is TypeSafe AI&apos;s ranking model: BetterC0de finds a bounded
          set of keyword matches locally and Jev orders them by relevance.
          Available in Agent mode; existing tool permissions still apply. If Jev
          fails, tools return local matches with an explicit fallback notice.
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}
