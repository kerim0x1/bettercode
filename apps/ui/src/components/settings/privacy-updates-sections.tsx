import { useEffect, useState } from "react"
import {
  BugIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderOpenIcon,
  RadioTowerIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SettingsRow, SettingsSection } from "@/components/settings/atoms"
import { useSettingsStore } from "@/lib/settings-store"
import type {
  ElectronAppInfo,
  ElectronUpdateStatus,
  UpdatesDisabledReason,
} from "@/types/electron-api"
import { getElectronApi, hasElectronApi } from "@/services/ipc-facade"

/** App info from the desktop shell; null outside Electron or on IPC errors. */
function useDesktopAppInfo(): ElectronAppInfo | null {
  const [info, setInfo] = useState<ElectronAppInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    const api = getElectronApi()
    if (!api?.getAppInfo) return
    api
      .getAppInfo()
      .then((value) => {
        if (!cancelled) setInfo(value ?? null)
      })
      .catch(() => {
        if (!cancelled) setInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return info
}

function openExternal(url: string) {
  void getElectronApi()
    ?.openExternal?.(url)
    .catch(() => {})
}

/**
 * Settings → Privacy & Diagnostics. Automatic crash reports and the usage ping
 * are both off until the user turns them on. The Electron main process reads
 * these values from settings.json, so a change applies to the next report
 * (crash reports) or the next app start (usage ping).
 */
export function SettingsPrivacySection() {
  const settings = useSettingsStore()
  const info = useDesktopAppInfo()
  // The desktop shell is the only place these settings have an effect, and
  // paired remote devices may not change them.
  if (!hasElectronApi()) return null

  return (
    <SettingsSection
      title="Privacy & Diagnostics"
      description="Nothing is sent to betterc0de.com unless you turn it on here. Bug reports you send yourself are not affected."
    >
      <SettingsRow
        icon={<BugIcon />}
        label="Send crash reports automatically"
        description="When BetterC0de hits an unexpected error, send the error, its stack trace, a device summary and the most recent app log lines. Keys, tokens, email addresses and your home folder path are removed first."
      >
        <Switch
          checked={settings.crashReportsEnabled}
          aria-label="Send crash reports automatically"
          onCheckedChange={(value) =>
            settings.update({ crash_reports_enabled: value })
          }
        />
      </SettingsRow>
      <SettingsRow
        icon={<RadioTowerIcon />}
        label="Send a usage ping"
        description="Once per app start, send a random installation ID, the app version and your operating system. Turning this off deletes the installation ID the next time BetterC0de starts."
      >
        <Switch
          checked={settings.usagePingEnabled}
          aria-label="Send a usage ping"
          onCheckedChange={(value) =>
            settings.update({ usage_ping_enabled: value })
          }
        />
      </SettingsRow>
      {info?.logsDir ? (
        <SettingsRow
          icon={<FileTextIcon />}
          label="Application logs"
          description="BetterC0de keeps the last few megabytes of redacted app and backend logs on this computer. Attach them to a bug report if you are asked to."
        >
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={() => {
              const logsDir = info.logsDir
              if (logsDir)
                void getElectronApi()
                  ?.openPath(logsDir)
                  .catch(() => {})
            }}
          >
            <FolderOpenIcon aria-hidden="true" className="size-3.5" />
            Open logs folder
          </Button>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  )
}

const REASON_TEXT: Record<UpdatesDisabledReason, string> = {
  "unsigned-build":
    "This build is not code-signed, so it cannot install updates by itself. BetterC0de checks for new versions and links to the download.",
  "package-manager":
    "BetterC0de was installed as a system package. Update it with your package manager or install the new package from the release page.",
  "unsupported-package":
    "This package type cannot update itself. BetterC0de checks for new versions and links to the download.",
  "updater-unavailable":
    "The update component is missing from this build. Download new versions from the release page.",
  "development-build": "Development builds do not check for updates.",
}

export function describeUpdateStatus(updates: ElectronUpdateStatus): string {
  if (updates.status === "available" && updates.availableVersion) {
    return updates.mode === "auto"
      ? `Version ${updates.availableVersion} is downloading and will be installed when you quit.`
      : `Version ${updates.availableVersion} is available.`
  }
  if (updates.status === "downloaded") {
    return "An update has been downloaded and will be installed when you quit BetterC0de."
  }
  const mode =
    updates.mode === "auto"
      ? "Updates download automatically and install when you quit."
      : updates.reason
        ? REASON_TEXT[updates.reason]
        : "Automatic updates are off."
  if (updates.status === "up-to-date")
    return `${mode} You have the latest version.`
  if (updates.status === "error") return `${mode} The last update check failed.`
  return mode
}

/** Settings → General → Updates: version, update mode and download link. */
export function SettingsUpdatesSection() {
  const info = useDesktopAppInfo()
  const updates = info?.updates
  if (!updates) return null
  const downloadUrl =
    updates.status === "available" ? updates.downloadUrl : null
  const releasesUrl = updates.releasesUrl

  return (
    <SettingsSection title="Updates">
      <SettingsRow
        icon={<DownloadIcon />}
        label={`BetterC0de ${updates.currentVersion}`}
        description={describeUpdateStatus(updates)}
      >
        {downloadUrl ? (
          <Button
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={() => openExternal(downloadUrl)}
          >
            <DownloadIcon aria-hidden="true" className="size-3.5" />
            Download {updates.availableVersion}
          </Button>
        ) : releasesUrl && updates.mode !== "auto" ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={() => openExternal(releasesUrl)}
          >
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
            Releases
          </Button>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  )
}
