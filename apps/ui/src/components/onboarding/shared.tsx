import { useState } from "react"
import { Button } from "@/components/ui/button"
import { MARKETPLACE_CATALOG } from "@/lib/marketplace-data"
import {
  ChevronRightIcon,
  ChevronLeftIcon,
  ServerIcon,
  SparklesIcon,
  DownloadIcon,
} from "lucide-react"

export const STEPS = [
  "Welcome",
  "Appearance",
  "Marketplace",
  "Import",
  "CLI Tools",
  "Conversations",
  "Done",
]

export const MARKETPLACE = MARKETPLACE_CATALOG

/** Icon with fallback per category */
export function ItemIcon({
  icon,
  category,
}: {
  icon?: string
  category: string
}) {
  const [failed, setFailed] = useState(false)
  if (icon && !failed) {
    return (
      <img
        src={icon}
        alt=""
        className="size-5 shrink-0 rounded"
        onError={() => setFailed(true)}
      />
    )
  }
  const cls = "size-5 shrink-0 text-muted-foreground"
  if (category === "mcp") return <ServerIcon className={cls} />
  if (category === "skill") return <SparklesIcon className={cls} />
  return <DownloadIcon className={cls} />
}

export function StepHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

export function NavFooter({
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  onBack?: () => void
  onNext: () => void
  nextLabel?: string
  nextDisabled?: boolean
}) {
  return (
    <div className="mt-5 flex items-center gap-2">
      {onBack && (
        <Button variant="outline" size="sm" onClick={onBack}>
          <ChevronLeftIcon className="mr-1 size-3.5" />
          Back
        </Button>
      )}
      <div className="flex-1" />
      <Button
        size="sm"
        className="gap-1"
        onClick={onNext}
        disabled={nextDisabled}
      >
        {nextLabel || "Next"} <ChevronRightIcon className="size-3.5" />
      </Button>
    </div>
  )
}
