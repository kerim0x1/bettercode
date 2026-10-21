import { TerminalIcon } from "lucide-react"
import { assetUrl } from "@/lib/asset-url"
import { cn } from "@/lib/utils"

/** A shell's mark at text size: its own logo where one ships, else a prompt. */
export function ShellIcon({
  shell,
  className,
}: {
  shell: string | undefined
  className?: string
}) {
  const cls = cn("size-3.5 shrink-0", className)
  switch (shell) {
    case "powershell":
    case "pwsh":
      return (
        <img
          src={assetUrl("icons/shells/powershell.svg")}
          alt=""
          className={cn(cls, "dark:invert")}
        />
      )
    case "gitbash":
      return (
        <img src={assetUrl("icons/shells/git.svg")} alt="" className={cls} />
      )
    case "wsl":
      return (
        <img src={assetUrl("icons/shells/linux.svg")} alt="" className={cls} />
      )
    case "bash":
      return (
        <img
          src={assetUrl("icons/shells/gnubash.svg")}
          alt=""
          className={cls}
        />
      )
    default:
      return (
        <TerminalIcon
          className={cn(cls, "text-muted-foreground")}
          aria-hidden="true"
        />
      )
  }
}
