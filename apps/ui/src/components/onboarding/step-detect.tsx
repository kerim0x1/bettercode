import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { assetUrl } from "@/lib/asset-url"
import { Badge } from "@/components/ui/badge"
import { useOnboardingStore, type CliStatusInfo } from "@/lib/onboarding-store"
import { CheckIcon, Loader2Icon, TerminalIcon } from "lucide-react"
import { StepHeader, NavFooter } from "./shared"

export function DetectStep() {
  const { cliStatus, scanning, nextStep, prevStep } = useOnboardingStore()

  return (
    <div className="w-full max-w-lg">
      <StepHeader
        title="CLI Tools"
        description="Detected command-line tools on your system."
      />

      <div className="space-y-2">
        <CliCard
          name="Claude CLI"
          icon={
            <img
              src={assetUrl("icons/providers/claude.svg")}
              alt=""
              className="size-5"
            />
          }
          status={cliStatus?.claude}
          scanning={scanning}
        />

        <CliCard
          name="Codex CLI"
          icon={
            <img
              src={assetUrl("icons/providers/openai.svg")}
              alt=""
              className="size-5 dark:invert"
            />
          }
          status={cliStatus?.codex}
          scanning={scanning}
        />

        <CliCard
          name="Grok CLI"
          icon={
            <img
              src={assetUrl("icons/providers/grok.svg")}
              alt=""
              className="size-5 dark:invert"
            />
          }
          status={cliStatus?.["grok-cli"]}
          scanning={scanning}
        />

        {/* Cursor ships no logo asset — the generic terminal glyph is the
            same fallback `ProviderIcon` uses for logo-less providers. */}
        <CliCard
          name="Cursor"
          icon={<TerminalIcon className="size-5 text-muted-foreground" />}
          status={cliStatus?.cursor}
          scanning={scanning}
        />

        {/* opencode ships no logo asset in the repo either — same fallback. */}
        <CliCard
          name="OpenCode CLI"
          icon={<TerminalIcon className="size-5 text-muted-foreground" />}
          status={cliStatus?.["opencode-cli"]}
          scanning={scanning}
        />
      </div>

      <NavFooter onBack={prevStep} onNext={nextStep} />
    </div>
  )
}

function CliCard({
  name,
  icon,
  status,
  scanning,
}: {
  name: string
  icon: ReactNode
  status: CliStatusInfo | undefined
  scanning: boolean
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-4 py-3",
        status?.installed && "border-emerald-500/30"
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{name}</p>
        <p className="text-[10px] text-muted-foreground">
          {!status
            ? "Not checked"
            : status.installed
              ? `v${status.version || "?"} · ${status.authenticated ? `Authenticated (${status.authType})` : "Not authenticated"}`
              : "Not installed"}
        </p>
        {status?.installed && status.binaryPath && (
          <p className="truncate font-mono text-[9px] text-muted-foreground/50">
            {status.binaryPath}
          </p>
        )}
      </div>
      {!status || scanning ? (
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      ) : status.installed ? (
        <Badge
          variant="outline"
          className="gap-1 border-emerald-500/30 text-emerald-500"
        >
          <CheckIcon className="size-3" />
          {status.authenticated ? "Auth" : "Found"}
        </Badge>
      ) : (
        <Badge variant="outline" className="text-muted-foreground/50">
          Not found
        </Badge>
      )}
    </div>
  )
}
