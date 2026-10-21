import { useState } from "react"
import { GlobeIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * A page's favicon, or a globe when it has none or it fails to load. Only
 * https icons are kept by the browser store; the renderer's CSP blocks the
 * rest anyway.
 */
export function BrowserPageIcon({
  src,
  className,
}: {
  src: string | null | undefined
  className?: string
}) {
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src) {
    return (
      <GlobeIcon
        aria-hidden="true"
        strokeWidth={1.75}
        className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      />
    )
  }
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(src)}
      className={cn(
        "size-3.5 shrink-0 rounded-[3px] object-contain",
        className
      )}
    />
  )
}
