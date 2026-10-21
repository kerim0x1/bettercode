import { useState } from "react"
import {
  CircleAlertIcon,
  CopyIcon,
  InfoIcon,
  RotateCwIcon,
  WebhookIcon,
} from "lucide-react"
import type {
  AutomationView,
  AutomationWebhookEndpoint,
} from "@betterc0de/schema"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { Button } from "@/components/ui/button"
import { appUiActions } from "@/lib/app-ui-store"
import {
  automationWebhookUrls,
  webhookReachableFromOutside,
} from "@/lib/automations"
import { copyText } from "@/lib/clipboard"
import { toast } from "@/lib/toast"
import { rotateAutomationWebhook } from "@/services/backend/automations-api"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A webhook automation's URLs, one per address this desktop can be reached
 * at (the recommended one first), each with a copy button; whether GitHub
 * signatures are checked; Rotate URL; and, while Remote Access is off, why
 * only this computer can call it.
 */
export function AutomationWebhookCard({
  automation,
  endpoints,
  remoteAccessEnabled,
  onRotated,
}: {
  automation: AutomationView
  endpoints: readonly AutomationWebhookEndpoint[] | null
  remoteAccessEnabled: boolean | null
  onRotated: (automation: AutomationView) => void
}) {
  const confirm = useConfirm()
  const [rotating, setRotating] = useState(false)
  const [rotateError, setRotateError] = useState<string | null>(null)
  if (automation.trigger.type !== "webhook" || !automation.webhook) return null
  const urls = automationWebhookUrls(endpoints ?? [], automation.webhook.path)
  const signature = automation.trigger.verifyGithubSignature

  const rotate = async () => {
    const ok = await confirm({
      title: "Rotate the webhook URL?",
      description:
        "The current URL stops working at once. Update it wherever it is used, such as the webhook settings on GitHub.",
      confirmLabel: "Rotate URL",
      destructive: true,
    })
    if (!ok) return
    setRotating(true)
    setRotateError(null)
    try {
      const { automation: rotated } = await rotateAutomationWebhook(
        automation.id
      )
      onRotated(rotated)
      toast.success("Webhook URL rotated")
    } catch (error) {
      setRotateError(errorMessage(error))
    } finally {
      setRotating(false)
    }
  }

  return (
    <div className="rounded-xl border border-border/50 bg-card/30">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05]">
          <WebhookIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground"
            strokeWidth={1.5}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">Webhook</p>
          <p className="text-[11px] text-muted-foreground">
            POST JSON, a form or text, up to 256 KB.{" "}
            {signature
              ? "GitHub signatures are checked."
              : "Anyone with the URL can start a run."}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 rounded-lg text-[12px]"
          disabled={rotating}
          aria-busy={rotating}
          onClick={() => void rotate()}
        >
          <RotateCwIcon
            aria-hidden="true"
            className={
              rotating ? "size-3.5 motion-safe:animate-spin" : "size-3.5"
            }
          />
          Rotate URL
        </Button>
      </div>
      <div className="flex flex-col gap-2 border-t border-border/40 bg-foreground/[0.015] px-4 py-3">
        {automation.webhook.path === null ? (
          <p
            role="alert"
            className="flex items-start gap-2 text-[12px] text-destructive"
          >
            <CircleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            This URL can&apos;t be read on this computer. Rotate it to make a
            new one.
          </p>
        ) : endpoints === null ? (
          <p className="text-[12px] text-muted-foreground">
            Loading addresses…
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {urls.map((entry) => (
              <li
                key={entry.id}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/60 py-1 pr-1 pl-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                    {entry.label}
                    {entry.isDefault && urls.length > 1 ? (
                      <span className="rounded bg-success/10 px-1 text-success">
                        Recommended
                      </span>
                    ) : null}
                  </p>
                  <p
                    className="truncate font-mono text-[11.5px] text-foreground"
                    title={entry.url}
                  >
                    {entry.url}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 rounded-md text-muted-foreground"
                  aria-label={`Copy the ${entry.label} URL`}
                  title="Copy URL"
                  onClick={() => {
                    void copyText(entry.url).then((copied) => {
                      if (copied) toast.success("Webhook URL copied")
                    })
                  }}
                >
                  <CopyIcon aria-hidden="true" className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {remoteAccessEnabled === false ? (
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              Remote Access is off, so only apps on this computer can call this
              URL. Turn it on to receive webhooks from GitHub or other services.
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                const ui = appUiActions()
                ui.setSettingsTab("remote")
                ui.setSettingsOpen(true)
              }}
            >
              Open Remote Access
            </Button>
          </div>
        ) : endpoints && !webhookReachableFromOutside(endpoints) ? (
          <p className="flex items-start gap-2 text-[12px] text-muted-foreground">
            <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            No address outside this computer is available yet. Turn on Local
            network or Tailscale HTTPS, or set a custom URL in Remote Access.
          </p>
        ) : remoteAccessEnabled &&
          !endpoints?.some((endpoint) => endpoint.reachability === "public") ? (
          <p className="text-[11px] leading-snug text-muted-foreground/80">
            GitHub and other hosted services need an address they can reach: a
            public HTTPS custom URL, such as a tunnel, set in Remote Access.
            Addresses on your network or tailnet work for senders there.
          </p>
        ) : null}
        {rotateError ? (
          <p role="alert" className="text-[11px] text-destructive">
            {rotateError}
          </p>
        ) : null}
      </div>
    </div>
  )
}
