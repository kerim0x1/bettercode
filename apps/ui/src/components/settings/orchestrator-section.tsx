import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { MoleculesIcon } from "@hugeicons/core-free-icons"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/lib/settings-store"
import { BrandMarks } from "./brand-mark"
import { SettingsRow, SettingsSection } from "./atoms"

/**
 * The CLIs an orchestrating chat can hand tasks to. The row icon is
 * Orchestration's own hub mark (Hugeicons MoleculesIcon), as in the composer.
 */
const WORKER_BRANDS = ["claude", "codex", "grok-cli"] as const

export function SettingsOrchestratorSection() {
  const enabled = useSettingsStore((state) => state.orchestratorEnabled)
  const loaded = useSettingsStore((state) => state.loaded)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mutation = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function toggle(value: boolean) {
    if (mutation.current) return
    mutation.current = true
    setBusy(true)
    setError(null)
    try {
      await useSettingsStore.getState().update({ orchestrator_enabled: value })
    } catch {
      if (mounted.current) setError("Couldn't save. Try again.")
    } finally {
      mutation.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <SettingsSection
      title="Orchestration"
      description="Let the model in your chat delegate work to other providers."
    >
      <SettingsRow
        label="Experimental orchestration"
        icon={<HugeiconsIcon icon={MoleculesIcon} strokeWidth={2} />}
        description={
          <>
            The model you chat with leads and can hand tasks to Claude Code,
            Codex or Grok CLI. Choose them under + → Orchestration.
            <span className="mt-1.5 flex">
              <BrandMarks ids={WORKER_BRANDS} />
            </span>
          </>
        }
      >
        <Switch
          aria-label="Experimental orchestration"
          checked={enabled}
          disabled={!loaded || busy}
          onCheckedChange={(value) => void toggle(value)}
        />
      </SettingsRow>
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Workers share the project and keep your normal approval requirements.
        Disabling this experiment stops workers and revokes their tools.
      </p>
      {error && (
        <p role="alert" className="px-4 py-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </SettingsSection>
  )
}
