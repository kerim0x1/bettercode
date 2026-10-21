import { lazy, Suspense, useEffect } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { assetUrl } from "@/lib/asset-url"
import { useOnboardingStore } from "@/lib/onboarding-store"
import { CheckIcon } from "lucide-react"
import { STEPS } from "./onboarding/shared"
import { WelcomeStep } from "./onboarding/step-welcome"
import { AppearanceStep } from "./onboarding/step-appearance"
import { MarketplaceStep } from "./onboarding/step-marketplace"
import { ImportStep } from "./onboarding/step-import"
import { DetectStep } from "./onboarding/step-detect"
import { DoneStep } from "./onboarding/step-done"

// The conversation import loads only for the setup step that offers it.
const ConversationsStep = lazy(() =>
  import("./onboarding/step-conversations").then((module) => ({
    default: module.ConversationsStep,
  }))
)

export function Onboarding() {
  const { step, done, checked, checkDone } = useOnboardingStore()

  useEffect(() => {
    checkDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!checked || done) return null

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-sidebar text-sidebar-foreground">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-sidebar-border px-5 py-3">
        <img src={assetUrl("favicon.svg")} alt="" className="size-5" />
        <span className="text-sm font-semibold">Setup</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-1.5">
              <div
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-[9px] font-bold transition-colors",
                  i < step
                    ? "bg-primary text-primary-foreground"
                    : i === step
                      ? "bg-primary text-primary-foreground"
                      : "bg-sidebar-accent text-muted-foreground"
                )}
              >
                {i < step ? <CheckIcon className="size-2.5" /> : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={cn(
                    "h-px w-3",
                    i < step ? "bg-primary" : "bg-sidebar-border"
                  )}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => useOnboardingStore.getState().complete()}
        >
          Skip
        </Button>
      </div>

      <Progress
        value={(step / (STEPS.length - 1)) * 100}
        className="h-0.5 rounded-none [&>div]:transition-all [&>div]:duration-500"
      />

      {/* Content */}
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        {step === 0 && <WelcomeStep />}
        {step === 1 && <AppearanceStep />}
        {step === 2 && <MarketplaceStep />}
        {step === 3 && <ImportStep />}
        {step === 4 && <DetectStep />}
        {step === 5 && (
          <Suspense fallback={null}>
            <ConversationsStep />
          </Suspense>
        )}
        {step === 6 && <DoneStep />}
      </div>
    </div>
  )
}
