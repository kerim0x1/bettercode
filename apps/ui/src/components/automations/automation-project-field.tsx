import { useEffect, useId, useState } from "react"
import { FolderOpenIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  useWorkspaceTrustPromptStore,
  WORKSPACE_TRUST_DESCRIPTION,
} from "@/lib/workspace-trust-prompts"
import {
  getAgentWorkspaceTrust,
  setAgentWorkspaceTrust,
} from "@/services/backend/chatApi"
import { pickFolder } from "@/services/backend/runtime"
import { hasElectronApi } from "@/services/ipc-facade"
import { AutomationField, FIELD_SELECT } from "./automation-fields"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The project an automation runs in: one of the projects BetterC0de knows,
 * or a folder chosen on disk. Automations run only in a project trusted
 * explicitly, so an untrusted choice shows the trust prompt Settings →
 * Permissions uses, with the same confirmation.
 */
export function AutomationProjectField({
  value,
  projects,
  onChange,
  error,
}: {
  value: string
  projects: readonly string[]
  onChange: (projectPath: string) => void
  error?: string
}) {
  const fieldId = useId()
  const confirm = useConfirm()
  const [trust, setTrust] = useState<{
    path: string
    trusted: boolean
  } | null>(null)
  const [trusting, setTrusting] = useState(false)
  const [trustError, setTrustError] = useState<string | null>(null)
  const path = value.trim()

  useEffect(() => {
    if (!path) return
    let cancelled = false
    getAgentWorkspaceTrust(path).then(
      ({ trust: record }) => {
        if (!cancelled) {
          setTrust({
            path,
            trusted: record.state === "trusted" && record.explicit,
          })
        }
      },
      () => {
        if (!cancelled) setTrust(null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [path])

  const trustProject = async () => {
    const ok = await confirm({
      title: "Trust this project?",
      description: `${path}\n\n${WORKSPACE_TRUST_DESCRIPTION}`,
      confirmLabel: "Trust project",
    })
    if (!ok) return
    setTrusting(true)
    setTrustError(null)
    try {
      await setAgentWorkspaceTrust(path, "trusted")
      useWorkspaceTrustPromptStore.getState().resolveWorkspace(path)
      setTrust({ path, trusted: true })
    } catch (failure) {
      setTrustError(errorMessage(failure))
    } finally {
      setTrusting(false)
    }
  }

  const options = [...new Set([path, ...projects].filter(Boolean))]
  const known = trust && trust.path === path ? trust : null

  return (
    <AutomationField
      label="Project"
      htmlFor={fieldId}
      error={error}
      hint="Runs work in this folder, or in a worktree made from it."
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select value={path} onValueChange={onChange}>
          <SelectTrigger
            id={fieldId}
            aria-invalid={error ? true : undefined}
            className={cn(FIELD_SELECT, "min-w-0 flex-1 font-mono")}
          >
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectContent position="popper">
            {options.map((option) => (
              <SelectItem key={option} value={option} className="font-mono">
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasElectronApi() ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 rounded-lg text-[12px]"
            onClick={() => {
              void pickFolder().then((folder) => {
                if (folder) onChange(folder)
              })
            }}
          >
            <FolderOpenIcon aria-hidden="true" className="size-3.5" />
            Choose folder…
          </Button>
        ) : null}
      </div>
      {known && !known.trusted ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[12px] text-foreground">
          <ShieldAlertIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-warning"
          />
          <span className="min-w-0 flex-1">
            This project isn&apos;t trusted. Automations only run in projects
            you trust.
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={trusting}
            aria-busy={trusting}
            onClick={() => void trustProject()}
          >
            <ShieldCheckIcon aria-hidden="true" className="size-3" />
            {trusting ? "Trusting…" : "Trust project"}
          </Button>
        </div>
      ) : known?.trusted ? (
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheckIcon aria-hidden="true" className="size-3 text-success" />
          Trusted project
        </span>
      ) : null}
      {trustError ? (
        <span role="alert" className="text-[11px] text-destructive">
          {trustError}
        </span>
      ) : null}
    </AutomationField>
  )
}
