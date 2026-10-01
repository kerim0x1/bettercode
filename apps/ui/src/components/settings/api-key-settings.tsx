import { useCallback, useEffect, useRef, useState } from "react"
import type { ApiKeyPoolView, ApiKeyProvider } from "@betterc0de/schema"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  addApiKey,
  editApiKey,
  listApiKeys,
  removeApiKey,
  reorderApiKeys,
  retryApiKey,
  testApiKey,
  restoreExternalApiKeySource,
} from "@/services/backend/providersApi"

const statusLabels = {
  untested: "Not checked",
  ready: "Available",
  invalid: "Invalid key",
  quota: "Billing required",
  cooldown: "Waiting",
  disabled: "Disabled",
}

export function ProviderApiKeys({
  provider,
  onChanged,
}: {
  provider: ApiKeyProvider
  onChanged: () => void
}) {
  const [view, setView] = useState<ApiKeyPoolView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState("")
  const [draftKey, setDraftKey] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState("")
  const [replacement, setReplacement] = useState("")
  const mutation = useRef(false)
  const generation = useRef(0)
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const requestGeneration = generation.current
      try {
        const next = await listApiKeys(provider, signal)
        if (
          !signal?.aborted &&
          !mutation.current &&
          generation.current === requestGeneration
        ) {
          setView(next)
          setError(null)
        }
      } catch (e) {
        if (
          !signal?.aborted &&
          !mutation.current &&
          generation.current === requestGeneration
        )
          setError(e instanceof Error ? e.message : "Could not load API keys.")
      }
    },
    [provider]
  )
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = setInterval(() => void refresh(controller.signal), 15_000)
    const onSettingsChanged = () => void refresh(controller.signal)
    window.addEventListener("betterc0de:settings-updated", onSettingsChanged)
    return () => {
      controller.abort()
      clearInterval(timer)
      window.removeEventListener(
        "betterc0de:settings-updated",
        onSettingsChanged
      )
    }
  }, [refresh])

  const run = async (
    operation: () => Promise<ApiKeyPoolView>,
    done?: () => void
  ) => {
    if (mutation.current) return
    mutation.current = true
    generation.current++
    setBusy(true)
    setError(null)
    try {
      setView(await operation())
      done?.()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save API keys.")
    } finally {
      mutation.current = false
      setBusy(false)
    }
  }
  return (
    <ApiKeySettingsPanel
      view={view}
      busy={busy}
      error={error}
      label={label}
      draftKey={draftKey}
      editing={editing}
      editLabel={editLabel}
      replacement={replacement}
      onLabelChange={setLabel}
      onKeyChange={setDraftKey}
      onEditLabelChange={setEditLabel}
      onReplacementChange={setReplacement}
      onEdit={(id) => {
        setEditing(id)
        setEditLabel(view?.keys.find((key) => key.id === id)?.label ?? "")
        setReplacement("")
      }}
      onAdd={() =>
        void run(
          () => addApiKey(provider, label.trim(), draftKey.trim()),
          () => {
            setDraftKey("")
            setLabel("")
          }
        )
      }
      onSave={(id) =>
        void run(
          () =>
            editApiKey(provider, id, {
              label: editLabel.trim(),
              ...(replacement.trim() ? { apiKey: replacement.trim() } : {}),
            }),
          () => {
            setEditing(null)
            setReplacement("")
          }
        )
      }
      onEnable={(id, enabled) =>
        void run(() => editApiKey(provider, id, { enabled }))
      }
      onRemove={(id) =>
        void run(
          () => removeApiKey(provider, id),
          () => {
            if (editing === id) {
              setEditing(null)
              setReplacement("")
            }
          }
        )
      }
      onTest={(id) => void run(() => testApiKey(provider, id))}
      onRetry={(id) => void run(() => retryApiKey(provider, id))}
      onUseExternal={() =>
        void run(
          () => restoreExternalApiKeySource(provider),
          () => {
            setEditing(null)
            setReplacement("")
          }
        )
      }
      onMove={(id, direction) => {
        const ids = view?.keys.map((key) => key.id) ?? []
        const index = ids.indexOf(id)
        if (
          index < 0 ||
          index + direction < 0 ||
          index + direction >= ids.length
        )
          return
        ;[ids[index], ids[index + direction]] = [
          ids[index + direction],
          ids[index],
        ]
        void run(() => reorderApiKeys(provider, ids))
      }}
    />
  )
}

interface PanelProps {
  view: ApiKeyPoolView | null
  busy: boolean
  error: string | null
  label: string
  draftKey: string
  editing: string | null
  editLabel: string
  replacement: string
  onLabelChange: (value: string) => void
  onKeyChange: (value: string) => void
  onEditLabelChange: (value: string) => void
  onReplacementChange: (value: string) => void
  onEdit: (id: string | null) => void
  onAdd: () => void
  onSave: (id: string) => void
  onEnable: (id: string, enabled: boolean) => void
  onRemove: (id: string) => void
  onTest: (id: string) => void
  onRetry: (id: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onUseExternal: () => void
}

export function ApiKeySettingsPanel(props: PanelProps) {
  const { view, busy, editing } = props
  const [confirmExternal, setConfirmExternal] = useState(false)
  return (
    <div
      className="space-y-3 px-4 py-3 [&_[data-slot=switch-thumb]]:motion-reduce:transition-none [&_button]:transition-[color,background-color,border-color,box-shadow,opacity,translate] [&_button]:motion-reduce:transition-none"
      aria-label="API keys"
      aria-busy={busy}
    >
      <div className="flex items-start gap-2">
        <KeyRoundIcon
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium">API keys & backups</p>
          <p className="text-xs text-muted-foreground">
            Keys are tried in order. Unavailable keys are skipped until you
            check them or their retry delay ends.
          </p>
        </div>
      </div>
      {props.error && (
        <p role="alert" className="text-xs break-words text-destructive">
          {props.error}
        </p>
      )}
      {!view ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading API keys…
        </p>
      ) : (
        <>
          {!view.enabled && (
            <p className="text-xs text-muted-foreground">
              This provider is disabled. Enable it above to use its keys.
            </p>
          )}
          {view.keys.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Add your first key to connect this provider.
            </p>
          )}
          <ol className="space-y-2">
            {view.keys.map((key, index) => {
              const external = key.source !== "settings"
              const waiting = (key.retryAt ?? 0) > Date.now()
              return (
                <li
                  key={key.id}
                  className="rounded-lg border border-border bg-background p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-medium text-muted-foreground">
                      Priority {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 text-xs font-medium break-words">
                      {key.label}
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-[11px]",
                        key.status === "ready"
                          ? "text-success"
                          : key.status === "invalid" || key.status === "quota"
                            ? "text-destructive"
                            : key.status === "cooldown"
                              ? "text-warning"
                              : "text-muted-foreground"
                      )}
                    >
                      {key.status === "ready" && (
                        <CheckCircle2Icon
                          className="size-3"
                          aria-hidden="true"
                        />
                      )}
                      {statusLabels[key.status]}
                    </span>
                    {!external && (
                      <Switch
                        aria-label={`Enable ${key.label}`}
                        checked={key.enabled}
                        disabled={busy}
                        onCheckedChange={(enabled) =>
                          props.onEnable(key.id, enabled)
                        }
                      />
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {external
                      ? "Supplied by environment or CLI configuration"
                      : key.secret.storage === "encrypted"
                        ? "Encrypted on this device"
                        : "Stored in plaintext on this device"}
                  </p>
                  {key.message && (
                    <p className="mt-1 text-[11px] break-words text-muted-foreground">
                      {key.message}
                    </p>
                  )}
                  {waiting && (
                    <p className="mt-1 text-[11px] text-warning">
                      Retry after {new Date(key.retryAt!).toLocaleTimeString()}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy || waiting}
                      onClick={() => props.onTest(key.id)}
                    >
                      Check key
                    </Button>
                    {(key.status === "invalid" || key.status === "quota") && (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={busy}
                        onClick={() => props.onRetry(key.id)}
                      >
                        Retry key
                      </Button>
                    )}
                    {!external && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            props.onEdit(editing === key.id ? null : key.id)
                          }
                        >
                          <PencilIcon />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${key.label} up`}
                          disabled={busy || index === 0}
                          onClick={() => props.onMove(key.id, -1)}
                        >
                          <ArrowUpIcon />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${key.label} down`}
                          disabled={busy || index === view.keys.length - 1}
                          onClick={() => props.onMove(key.id, 1)}
                        >
                          <ArrowDownIcon />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Remove ${key.label}`}
                          disabled={busy}
                          onClick={() => props.onRemove(key.id)}
                        >
                          <Trash2Icon />
                        </Button>
                      </>
                    )}
                  </div>
                  {editing === key.id && (
                    <form
                      className="mt-3 space-y-2 border-t border-border pt-3"
                      onSubmit={(event) => {
                        event.preventDefault()
                        props.onSave(key.id)
                      }}
                    >
                      <Input
                        aria-label="Key name"
                        value={props.editLabel}
                        maxLength={80}
                        disabled={busy}
                        onChange={(event) =>
                          props.onEditLabelChange(event.target.value)
                        }
                      />
                      <Input
                        aria-label="Replacement API key"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={props.replacement}
                        placeholder="New key (leave blank to keep saved key)"
                        maxLength={4096}
                        disabled={busy}
                        onChange={(event) =>
                          props.onReplacementChange(event.target.value)
                        }
                      />
                      <div className="flex gap-2">
                        <Button
                          size="xs"
                          disabled={busy || !props.editLabel.trim()}
                        >
                          Save changes
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          onClick={() => props.onEdit(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                </li>
              )
            })}
          </ol>
          {!view.managed &&
            view.keys.some((key) => key.source !== "settings") && (
              <p className="text-[11px] text-muted-foreground">
                Adding saved keys switches this provider to your saved list.
                External credentials stay in their original configuration.
              </p>
            )}
          <form
            className="space-y-2 border-t border-border pt-3"
            onSubmit={(event) => {
              event.preventDefault()
              props.onAdd()
            }}
          >
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <Input
                aria-label="New key name"
                placeholder="Key name"
                value={props.label}
                maxLength={80}
                disabled={busy || view.keys.length >= 20}
                onChange={(event) => props.onLabelChange(event.target.value)}
              />
              <Input
                aria-label="New API key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={props.draftKey}
                placeholder="Paste API key"
                maxLength={4096}
                disabled={busy || view.keys.length >= 20}
                onChange={(event) => props.onKeyChange(event.target.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={
                busy ||
                !props.label.trim() ||
                !props.draftKey.trim() ||
                view.keys.length >= 20
              }
            >
              {busy ? (
                <Loader2Icon className="motion-safe:animate-spin" />
              ) : (
                <PlusIcon />
              )}
              Add key
            </Button>
          </form>
          <p className="text-[11px] text-muted-foreground">
            Checking a key verifies authentication without generating a paid
            response. It does not confirm remaining credits.
          </p>
          {view.managed && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => setConfirmExternal(true)}
            >
              Use environment or CLI configuration
            </Button>
          )}
          <Dialog open={confirmExternal} onOpenChange={setConfirmExternal}>
            <DialogContent className="motion-reduce:animate-none [&_button]:transition-[color,background-color,border-color,box-shadow,opacity,translate] [&_button]:motion-reduce:transition-none">
              <DialogHeader>
                <DialogTitle>Use external credentials?</DialogTitle>
                <DialogDescription>
                  This removes the saved keys for this provider and uses its
                  environment or CLI configuration instead. Keep a copy of any
                  keys you still need.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmExternal(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    props.onUseExternal()
                    setConfirmExternal(false)
                  }}
                >
                  Use external credentials
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  )
}
