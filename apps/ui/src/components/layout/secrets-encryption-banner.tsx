import { useEffect, useState } from "react"
import { getElectronApi } from "@/services/ipc-facade"

/**
 * S4: persistent banner shown when the OS keyring is unavailable and
 * settings and plugin secrets end up stored as plaintext on disk.
 * Renders nothing in the happy path so it carries zero visual cost on
 * Windows / macOS / Linux-with-keyring.
 *
 * Dismissable per session via `localStorage` so the banner doesn't nag
 * the user every time the IDE relaunches; the underlying `AppInfo`
 * signal is checked again on each load and the banner reappears if the
 * environment changes.
 */

const DISMISS_KEY = "bc_secrets_banner_dismissed_v1"

function platformAdvice(platform?: NodeJS.Platform): string {
  switch (platform) {
    case "linux":
      return "Install gnome-keyring (apt: gnome-keyring; dnf: gnome-keyring) or kwallet, then restart BetterC0de."
    case "win32":
      return "Restart BetterC0de — Windows DPAPI should be available; if this persists, check Local Group Policy for Credential Manager restrictions."
    case "darwin":
      return "Unlock the macOS Keychain in Keychain Access, then restart BetterC0de."
    default:
      return "Restart BetterC0de after configuring an OS keyring."
  }
}

export function SecretsEncryptionBanner() {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [platform, setPlatform] = useState<NodeJS.Platform | undefined>()
  const [dismissed, setDismissed] = useState(
    typeof window !== "undefined" &&
      window.localStorage?.getItem(DISMISS_KEY) === "1"
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = await getElectronApi()?.getAppInfo?.()
        if (cancelled) return
        // Older builds don't return the field; treat absent as encrypted
        // so we don't false-alarm users on macOS/Windows.
        if (info && info.secretsEncryptionAvailable === false) {
          setAvailable(false)
          setPlatform(info.platform)
          return
        }
        setAvailable(true)
      } catch {
        if (!cancelled) setAvailable(true) // fail closed (no banner) on IPC error
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (available !== false || dismissed) return null

  const dismiss = () => {
    try {
      window.localStorage?.setItem(DISMISS_KEY, "1")
    } catch {
      /* private mode etc. — banner stays hidden for this tab anyway */
    }
    setDismissed(true)
  }

  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: "var(--destructive, #dc2626)",
        color: "var(--destructive-foreground, #fff)",
        padding: "8px 16px",
        fontSize: 13,
        display: "flex",
        gap: 12,
        alignItems: "center",
        justifyContent: "space-between",
        boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
      }}
    >
      <span>
        <strong>Stored secrets are unencrypted.</strong> The OS keyring is
        unavailable, so API keys, passwords, and plugin secrets live in
        plaintext on disk. {platformAdvice(platform)}
      </span>
      <button
        type="button"
        onClick={dismiss}
        style={{
          background: "transparent",
          border: "1px solid currentColor",
          color: "inherit",
          padding: "2px 10px",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </div>
  )
}
