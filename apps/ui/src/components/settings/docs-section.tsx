import {
  BookOpenIcon,
  ExternalLinkIcon,
  KeyboardIcon,
  RocketIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { toast } from "@/lib/toast"
import { getElectronApi } from "@/services/ipc-facade"

/** The product guide in the public repository. */
const PRODUCT_GUIDE_URL =
  "https://github.com/kerim0x1/bettercode/blob/main/PRODUCT_GUIDE.md"

/** The system browser in the desktop app, a new tab in a paired browser. */
function openExternalUrl(url: string) {
  const api = getElectronApi()
  if (api?.openExternal) {
    void api.openExternal(url).catch(() => {
      toast.error("Couldn't open the product guide", { description: url })
    })
  } else {
    window.open(url, "_blank", "noopener,noreferrer")
  }
}

/**
 * "Docs" settings tab content — three entry points for reference
 * material: the getting-started primer, the product guide on GitHub, and
 * the keyboard-shortcuts reference. The first and third open dialogs owned
 * by the settings page; the product guide opens in the browser.
 */
export function SettingsDocsSection({
  onOpenGettingStarted,
  onOpenShortcuts,
}: {
  onOpenGettingStarted: () => void
  onOpenShortcuts: () => void
}) {
  return (
    <SettingsSection title="Documentation">
      <SettingsRow
        label="Getting Started"
        description="Learn the basics of BetterC0de in five steps."
        icon={<RocketIcon />}
      >
        <Button
          variant="outline"
          size="sm"
          aria-label="Open Getting Started"
          onClick={onOpenGettingStarted}
        >
          Open
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Product guide"
        description="How projects, providers, views and reviews fit together, on GitHub."
        icon={<BookOpenIcon />}
      >
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          aria-label="Open the product guide on GitHub"
          onClick={() => openExternalUrl(PRODUCT_GUIDE_URL)}
        >
          Open
          <ExternalLinkIcon aria-hidden="true" className="size-3" />
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Keyboard Shortcuts"
        description="View all available shortcuts."
        icon={<KeyboardIcon />}
      >
        <Button
          variant="outline"
          size="sm"
          aria-label="Open Keyboard Shortcuts"
          onClick={onOpenShortcuts}
        >
          Open
        </Button>
      </SettingsRow>
    </SettingsSection>
  )
}
