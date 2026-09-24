import { useEffect, useState } from "react"
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { useRouter } from "expo-router"
import {
  CheckCircle2,
  Clock3,
  Eye,
  EyeOff,
  Laptop2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Unplug,
  Wifi,
} from "lucide-react-native"
import { ConnectionPill, Screen, TopBar } from "@/components/layout"
import {
  colors,
  font,
  minTouchTarget,
  radius,
  spacing,
  type,
} from "@/design/theme"
import { isSecureEndpoint } from "@/lib/endpoint"
import { remoteApi } from "@/lib/remote-api"
import { useSessionStore } from "@/store/session-store"
import type { RemoteStatus } from "@/types/remote"

export default function HostScreen() {
  const router = useRouter()
  const profile = useSessionStore((state) => state.profile)
  const state = useSessionStore((store) => store.state)
  const socketState = useSessionStore((store) => store.socketState)
  const error = useSessionStore((store) => store.error)
  const check = useSessionStore((store) => store.check)
  const logout = useSessionStore((store) => store.logout)
  const forget = useSessionStore((store) => store.forget)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [loading, setLoading] = useState(false)
  // Endpoint and identity values are masked until explicitly revealed so a
  // glance (or a screenshot) doesn't leak the host address or session ids.
  const [revealed, setRevealed] = useState(false)

  const refresh = async () => {
    if (!profile) return
    setLoading(true)
    try {
      const [, nextStatus] = await Promise.all([
        check(),
        remoteApi(profile).status(),
      ])
      setStatus(nextStatus)
    } catch {
      // Connection error is already surfaced by the session store.
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
    // The endpoint identity is the stable trigger; refresh itself is intentionally local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.environmentId])

  const confirmLogout = () => {
    Alert.alert("Disconnect?", "The session will be revoked on the desktop.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: () => void logout().then(() => router.replace("/pair")),
      },
    ])
  }

  const forgetOffline = () => {
    Alert.alert(
      "Forget local connection?",
      "The device can then only reconnect with a new pairing code.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => void forget().then(() => router.replace("/pair")),
        },
      ]
    )
  }

  const conceal = (value: string | undefined | null): string => {
    if (!value) return "–"
    return revealed ? value : "••••••••••••"
  }

  return (
    <Screen>
      <TopBar title="Host" right={<ConnectionPill />} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.heroCard}>
          <View
            style={[
              styles.hostIcon,
              state !== "online" && styles.hostIconOffline,
            ]}
          >
            <Laptop2
              size={22}
              color={state === "online" ? colors.success : colors.warning}
            />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.hostLabel}>CONNECTED HOST</Text>
            <Text style={styles.hostUrl} numberOfLines={1}>
              {profile ? conceal(profile.baseUrl) : "Not connected"}
            </Text>
            <Text style={styles.hostMeta}>
              {status?.listeningOnNetwork
                ? "Reachable on the network"
                : "Checking connection status"}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              revealed ? "Hide sensitive info" : "Reveal sensitive info"
            }
            onPress={() => setRevealed(!revealed)}
            style={({ pressed }) => [
              styles.revealButton,
              pressed && styles.pressed,
            ]}
          >
            {revealed ? (
              <EyeOff size={17} color={colors.textSecondary} />
            ) : (
              <Eye size={17} color={colors.textSecondary} />
            )}
          </Pressable>
        </View>

        {error ? (
          <View style={styles.errorCard}>
            <Unplug size={18} color={colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>STATUS</Text>
        <View style={styles.panel}>
          <InfoRow
            icon={<Wifi size={16} color={colors.success} />}
            label="Live channel"
            value={socketStateLabel(socketState)}
          />
          <InfoRow
            icon={<ShieldCheck size={16} color={colors.info} />}
            label="Transport"
            value={
              profile && isSecureEndpoint(profile.baseUrl)
                ? "HTTPS / WSS"
                : "Local HTTP / WS"
            }
          />
          <InfoRow
            icon={<CheckCircle2 size={16} color={colors.success} />}
            label="Remote access"
            value={
              status?.enabled
                ? "Active"
                : state === "online"
                  ? "Active"
                  : "Unknown"
            }
          />
          <InfoRow
            icon={<Clock3 size={16} color={colors.warning} />}
            label="Session valid until"
            value={formatDate(profile?.session.expiresAt)}
            last
          />
        </View>

        <Text style={styles.sectionTitle}>IDENTITY</Text>
        <View style={styles.panel}>
          <KeyValue label="Device" value={profile?.session.label ?? "–"} />
          <KeyValue
            label="Environment"
            value={conceal(profile?.environmentId)}
            mono
          />
          <KeyValue
            label="Session"
            value={conceal(profile?.session.id)}
            mono
            last
          />
        </View>

        {profile && !isSecureEndpoint(profile.baseUrl) ? (
          <View style={styles.notice}>
            <ShieldCheck size={19} color={colors.warning} />
            <Text style={styles.noticeText}>
              This LAN connection is not TLS-encrypted. Use it only on a trusted
              network or behind your HTTPS tunnel.
            </Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={() => void refresh()}
          style={({ pressed }) => [styles.refresh, pressed && styles.pressed]}
        >
          <RefreshCw size={16} color={colors.text} />
          <Text style={styles.refreshText}>
            {loading ? "Checking…" : "Check connection"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={state === "offline" ? forgetOffline : confirmLogout}
          style={({ pressed }) => [styles.logout, pressed && styles.pressed]}
        >
          <LogOut size={16} color={colors.danger} />
          <Text style={styles.logoutText}>
            {state === "offline"
              ? "Forget connection locally"
              : "Revoke session"}
          </Text>
        </Pressable>
      </ScrollView>
    </Screen>
  )
}

function InfoRow({
  icon,
  label,
  value,
  last = false,
}: {
  icon: React.ReactNode
  label: string
  value: string
  last?: boolean
}) {
  return (
    <View style={[styles.infoRow, last && styles.last]}>
      {icon}
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

function KeyValue({
  label,
  value,
  mono = false,
  last = false,
}: {
  label: string
  value: string
  mono?: boolean
  last?: boolean
}) {
  return (
    <View style={[styles.keyRow, last && styles.last]}>
      <Text style={styles.keyLabel}>{label}</Text>
      <Text
        selectable
        style={[styles.keyValue, mono && styles.mono]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  )
}

function socketStateLabel(value: string): string {
  if (value === "live") return "Live"
  if (value === "reconnecting" || value === "connecting") return "Connecting"
  if (value === "error") return "Interrupted"
  return "Ready"
}

function formatDate(value?: string): string {
  if (!value) return "–"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "–"
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const styles = StyleSheet.create({
  content: { padding: spacing.sm, paddingBottom: spacing.xxl, gap: spacing.sm },
  heroCard: {
    padding: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  hostIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceActive,
    alignItems: "center",
    justifyContent: "center",
  },
  hostIconOffline: { backgroundColor: "rgba(251,191,36,0.12)" },
  heroCopy: { flex: 1, minWidth: 0 },
  hostLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontFamily: font.semibold,
    letterSpacing: 1.2,
  },
  hostUrl: {
    color: colors.text,
    fontFamily: type.mono,
    fontSize: 13,
    marginTop: 4,
  },
  hostMeta: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
    marginTop: 3,
  },
  revealButton: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceActive,
  },
  errorCard: {
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(248,113,113,0.28)",
    backgroundColor: "rgba(248,113,113,0.07)",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
  },
  errorText: {
    flex: 1,
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: type.small,
    lineHeight: 20,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: font.semibold,
    letterSpacing: 1.2,
    marginTop: spacing.xs,
  },
  panel: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  infoRow: {
    minHeight: 46,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  infoLabel: {
    flex: 1,
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: 13,
  },
  infoValue: {
    maxWidth: "45%",
    color: colors.text,
    fontSize: 13,
    fontFamily: font.medium,
    textAlign: "right",
  },
  keyRow: {
    minHeight: 46,
    paddingHorizontal: spacing.sm,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    justifyContent: "center",
  },
  keyLabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 10,
    marginBottom: 2,
  },
  keyValue: { color: colors.text, fontSize: 13, fontFamily: font.medium },
  mono: { fontFamily: type.mono, fontSize: 12 },
  last: { borderBottomWidth: 0 },
  notice: {
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.25)",
    backgroundColor: "rgba(251,191,36,0.06)",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  noticeText: {
    flex: 1,
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
  },
  refresh: {
    minHeight: minTouchTarget,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  refreshText: {
    color: colors.text,
    fontSize: 13,
    fontFamily: font.semibold,
  },
  logout: {
    minHeight: minTouchTarget,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(248,113,113,0.3)",
    backgroundColor: "rgba(248,113,113,0.05)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  logoutText: {
    color: colors.danger,
    fontSize: 13,
    fontFamily: font.semibold,
  },
  pressed: { opacity: 0.68 },
})
