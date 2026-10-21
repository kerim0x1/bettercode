import {
  nativeNotificationPermission,
  requestNativeNotificationPermission,
} from "@/lib/native-notifications"
import { useSettingsStore } from "@/lib/settings-store"
import {
  describeTailscaleConnection,
  describeTailscaleServe,
} from "@/lib/tailscale-serve"
import {
  createRemotePairingLink,
  getRemoteStatus,
  getTailscaleStatus,
  listRemoteSessions,
  setTailscaleServe,
  type RemoteStatus,
  type TailscaleRemoteStatus,
} from "@/services/backend/remoteApi"
import { isRemoteRuntime } from "@/services/backend/runtime"
import { escapeMarkdownTableCell } from "./provider-config"
import { getElectronApi } from "@/services/ipc-facade"

export type SettingsTabId =
  | "general"
  | "appearance"
  | "layout"
  | "chat"
  | "notifications"
  | "models"
  | "plugins"
  | "rules"
  | "skills"
  | "tools"
  | "hooks"
  | "permissions"
  | "remote"
  | "privacy"
  | "betterc0de"
  | "experimental"
  | "docs"

export function openSettingsTab(tab: SettingsTabId): void {
  window.dispatchEvent(
    new CustomEvent("betterc0de:open-settings", { detail: { tab } })
  )
}

export async function executeRemoteAccessCommand(
  args: readonly string[]
): Promise<string> {
  const action = (args[0] ?? "link").trim().toLowerCase()
  if (action === "settings" || action === "open") {
    openSettingsTab("remote")
    return "# Remote Access\n\nOpened **Settings → Remote Access**."
  }

  const desktopRestart = getElectronApi()?.restartBackend
  const remoteBrowser = isRemoteRuntime()
  if (action === "off" || action === "disable") {
    if (remoteBrowser || !desktopRestart) {
      return [
        "# Remote Access",
        "",
        "> Remote hosting can only be disabled from the BetterC0de desktop app.",
        "",
        "Run `/remote settings` on the host to manage it.",
      ].join("\n")
    }
    const status = await getRemoteStatus()
    if (!status.enabled)
      return "# Remote Access\n\nRemote access is already **off**."
    await useSettingsStore.getState().update({ remote_access_enabled: false })
    await desktopRestart()
    return [
      "# Remote Access",
      "",
      "Remote access is now **off**. The backend is listening only on this computer.",
      "Previously paired browser sessions remain stored, but cannot connect while hosting is off.",
    ].join("\n\n")
  }

  if (action === "tailscale" || action === "ts") {
    return executeTailscaleServeCommand(args[1], remoteBrowser)
  }

  if (
    action !== "link" &&
    action !== "pair" &&
    action !== "on" &&
    action !== "enable" &&
    action !== "status"
  ) {
    return [
      "# Remote Access",
      "",
      "Usage: `/remote [on|off|status|link|settings|tailscale on|off]`",
      "",
      "Running `/remote` with no argument enables hosting when needed and creates a fresh one-time pairing link.",
    ].join("\n")
  }

  let status = await getRemoteStatus()
  if (action === "status" || remoteBrowser) {
    const sessionCount = remoteBrowser
      ? null
      : (await listRemoteSessions()).sessions.length
    // Owner-only; a paired browser (or an older backend) simply has no row.
    const tailscale = remoteBrowser
      ? null
      : await getTailscaleStatus().catch(() => null)
    return buildRemoteAccessStatus(
      status,
      sessionCount,
      remoteBrowser,
      tailscale
    )
  }

  if (!status.enabled) {
    if (!desktopRestart) {
      return [
        "# Remote Access",
        "",
        "> Start this command from the BetterC0de desktop app to enable the network listener.",
        "",
        "You can also use **Settings → Remote Access**.",
      ].join("\n")
    }
    await useSettingsStore.getState().update({ remote_access_enabled: true })
    await desktopRestart()
    status = await getRemoteStatus()
  }

  if (!status.listeningOnNetwork) {
    return [
      "# Remote Access",
      "",
      "> Remote access is on, but no other device can reach this computer yet.",
      "",
      "Run `/remote tailscale on` to publish it over Tailscale HTTPS, or turn on **Local network** in `/remote settings`.",
    ].join("\n")
  }

  const grant = await createRemotePairingLink("Chat command pairing", 10)
  const link =
    grant.links.find((candidate) => candidate.isDefault) ?? grant.links[0]
  const alternatives = grant.links
    .filter((candidate) => candidate !== link)
    .map(
      (candidate) =>
        `- ${escapeMarkdownTableCell(candidate.label)}: ${candidate.url}`
    )

  return [
    "# Remote Access",
    "",
    "Remote access is **on**. Open this one-time link on the trusted phone or browser you want to pair:",
    "",
    link
      ? `[Pair this device with BetterC0de](${link.url})`
      : "No reachable endpoint was discovered.",
    "",
    `**One-time code:** \`${grant.credential}\``,
    `**Expires:** ${new Date(grant.expiresAt).toLocaleString()}`,
    ...(alternatives.length > 0
      ? ["", "Other reachable endpoints:", ...alternatives]
      : []),
    "",
    "> Pairing grants full access to this host's chats, projects, files, terminals, and provider sessions. Share this link only with a device you trust.",
    "",
    "Use `/remote settings` to copy another endpoint or revoke a paired device.",
  ].join("\n")
}

async function executeTailscaleServeCommand(
  arg: string | undefined,
  remoteBrowser: boolean
): Promise<string> {
  if (remoteBrowser) {
    return [
      "# Remote Access",
      "",
      "> Tailscale Serve can only be changed from the BetterC0de desktop app.",
    ].join("\n")
  }
  const current = await getTailscaleStatus()
  const wanted = (arg ?? "").trim().toLowerCase()
  if (wanted !== "on" && wanted !== "off") {
    const summary = describeTailscaleServe(current, true)
    return [
      "# Tailscale",
      "",
      `**${summary.headline}** — ${summary.detail}`,
      "",
      "Usage: `/remote tailscale on|off`",
    ].join("\n")
  }
  const next = await setTailscaleServe(wanted === "on")
  const summary = describeTailscaleServe(next, true)
  return [
    "# Tailscale",
    "",
    wanted === "on"
      ? `Serving through Tailscale HTTPS: **${summary.headline}** — ${summary.detail}`
      : "Tailscale Serve mapping removed.",
    "",
    wanted === "on" && next.serveActive
      ? "Run `/remote link` to create a one-time pairing link for a device on your tailnet."
      : "Run `/remote status` to review the advertised endpoints.",
  ].join("\n")
}

function buildRemoteAccessStatus(
  status: RemoteStatus,
  sessionCount: number | null,
  remoteBrowser: boolean,
  tailscale: TailscaleRemoteStatus | null = null
): string {
  const endpoints = status.endpoints.length
    ? status.endpoints.map(
        (endpoint) =>
          `| ${endpoint.isDefault ? "Default" : "Alternative"} | ${escapeMarkdownTableCell(endpoint.label)} | \`${escapeMarkdownTableCell(endpoint.httpBaseUrl)}\` |`
      )
    : ["| — | No network endpoints advertised | — |"]
  return [
    "# Remote Access Status",
    "",
    `| Hosting | ${status.enabled ? "On" : "Off"} |`,
    `| Reachable from other devices | ${status.listeningOnNetwork ? `Yes, port ${status.port}` : "No, this computer only"} |`,
    `| This client | ${remoteBrowser ? "Paired browser" : "Desktop host"} |`,
    ...(sessionCount === null ? [] : [`| Paired sessions | ${sessionCount} |`]),
    ...(tailscale
      ? [
          `| Tailscale | ${escapeMarkdownTableCell(tailscaleConnectionLine(tailscale, status.enabled))} |`,
          `| Tailscale HTTPS | ${escapeMarkdownTableCell(describeTailscaleServe(tailscale, status.enabled).headline)} |`,
        ]
      : []),
    "",
    "| Endpoint | Name | Address |",
    "| --- | --- | --- |",
    ...endpoints,
    "",
    remoteBrowser
      ? "New pairing links and listener changes are restricted to the desktop host."
      : "Run `/remote` to create a fresh one-time link, or `/remote settings` to manage devices.",
  ].join("\n")
}

/** "Connected · desk.tail1234.ts.net · 100.101.102.103", or the problem. */
function tailscaleConnectionLine(
  tailscale: TailscaleRemoteStatus,
  hostingEnabled: boolean
): string {
  const connection = describeTailscaleConnection(tailscale, hostingEnabled)
  return connection.headline === "Connected"
    ? `${connection.headline} · ${connection.detail}`
    : connection.headline
}

export function resolveToggleArg(
  arg: string | undefined,
  current: boolean
): boolean {
  const normalized = arg?.trim().toLowerCase()
  if (normalized === "on" || normalized === "1" || normalized === "true") {
    return true
  }
  if (normalized === "off" || normalized === "0" || normalized === "false") {
    return false
  }
  return !current
}

export async function handleDiffStyleCommand(args: string[]): Promise<string> {
  const settings = useSettingsStore.getState()
  const next = resolveDiffStyleArg(args[0], settings.diffStyle)
  const changed = next !== settings.diffStyle
  if (changed) {
    await settings.update({ diff_style: next })
  }
  return buildDiffStyleOutput(next, changed)
}

export function resolveDiffStyleArg(
  arg: string | undefined,
  current: "auto" | "stacked"
): "auto" | "stacked" {
  const normalized = arg?.trim().toLowerCase()
  if (normalized === "auto" || normalized === "split") return "auto"
  if (
    normalized === "stacked" ||
    normalized === "stack" ||
    normalized === "unified"
  ) {
    return "stacked"
  }
  return current === "stacked" ? "auto" : "stacked"
}

export function buildDiffStyleOutput(
  style: "auto" | "stacked",
  changed: boolean
): string {
  return [
    "# Diff Style\n",
    changed
      ? "Diff layout updated.\n"
      : "Use `/diff-style auto` or `/diff-style stacked`.\n",
    "| Setting | Value |",
    "|:--------|:------|",
    `| **Style** | \`${style}\` |`,
    "",
    style === "stacked"
      ? "> Split diff view is disabled; diffs render as a single stacked column."
      : "> Diff view can use split or unified layout automatically.",
  ].join("\n")
}

export async function handleNotificationsCommand(
  args: string[]
): Promise<string> {
  const settings = useSettingsStore.getState()
  const action = args[0]?.trim().toLowerCase()

  if (action === "request" || action === "permission") {
    const permission = await requestNativeNotificationPermission()
    return buildNativeNotificationsOutput(
      useSettingsStore.getState(),
      permission
    )
  }

  if (action === "on" || action === "off") {
    const next = resolveToggleArg(action, settings.notificationAgent)
    await settings.update({
      notification_agent: next,
      notification_permissions: next,
      notification_errors: next,
    })
    return buildNativeNotificationsOutput(
      useSettingsStore.getState(),
      nativeNotificationPermission()
    )
  }

  if (
    action === "agent" ||
    action === "responses" ||
    action === "permissions" ||
    action === "errors"
  ) {
    const key =
      action === "permissions"
        ? "notification_permissions"
        : action === "errors"
          ? "notification_errors"
          : "notification_agent"
    const localKey =
      action === "permissions"
        ? "notificationPermissions"
        : action === "errors"
          ? "notificationErrors"
          : "notificationAgent"
    const current = useSettingsStore.getState()[
      localKey as keyof ReturnType<typeof useSettingsStore.getState>
    ] as boolean
    const next = resolveToggleArg(args[1], current)
    await settings.update({ [key]: next })
    return buildNativeNotificationsOutput(
      useSettingsStore.getState(),
      nativeNotificationPermission()
    )
  }

  return buildNativeNotificationsOutput(
    settings,
    nativeNotificationPermission()
  )
}

export function buildNativeNotificationsOutput(
  settings: Pick<
    ReturnType<typeof useSettingsStore.getState>,
    "notificationAgent" | "notificationPermissions" | "notificationErrors"
  >,
  permission: string
): string {
  return [
    "# Notifications\n",
    "| Channel | State |",
    "|:--------|:------|",
    `| **Native Permission** | ${escapeMarkdownTableCell(permission)} |`,
    `| **Agent Responses** | ${settings.notificationAgent ? "On" : "Off"} |`,
    `| **Permissions / Input** | ${settings.notificationPermissions ? "On" : "Off"} |`,
    `| **Errors** | ${settings.notificationErrors ? "On" : "Off"} |`,
    "",
    "> Use `/notifications request`, `/notifications agent on`, `/notifications permissions off`, or `/notifications errors on`.",
  ].join("\n")
}
