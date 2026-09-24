import type { ReactNode } from "react"
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { RefreshCw } from "lucide-react-native"
import {
  colors,
  font,
  minTouchTarget,
  radius,
  spacing,
  type,
} from "@/design/theme"
import { connectionBadge } from "@/lib/connection-status"
import { selectAccessLevel, useSessionStore } from "@/store/session-store"

export function Screen({
  children,
  style,
  edges = ["top"],
  testID,
}: {
  children: ReactNode
  style?: ViewStyle
  edges?: Array<"top" | "right" | "bottom" | "left">
  /** Lets end-to-end flows find the screen. */
  testID?: string
}) {
  return (
    <SafeAreaView style={[styles.screen, style]} edges={edges} testID={testID}>
      {children}
    </SafeAreaView>
  )
}

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <View style={styles.brandRow} accessibilityLabel="BetterC0de Remote">
      <View style={[styles.brandGlyph, compact && styles.brandGlyphCompact]}>
        <Text
          style={[
            styles.brandGlyphText,
            compact && styles.brandGlyphTextCompact,
          ]}
        >
          B/
        </Text>
      </View>
      {!compact ? (
        <View>
          <Text style={styles.brandName}>BetterC0de</Text>
          <Text style={styles.brandSub}>REMOTE</Text>
        </View>
      ) : null}
    </View>
  )
}

export function TopBar({
  title,
  eyebrow,
  right,
}: {
  title: string
  eyebrow?: string
  right?: ReactNode
}) {
  return (
    <View style={styles.topBar}>
      <View style={styles.topBarCopy}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      </View>
      {right ? <View style={styles.topBarRight}>{right}</View> : null}
    </View>
  )
}

export function ConnectionPill() {
  const mode = useSessionStore((store) => store.mode)
  const state = useSessionStore((store) => store.state)
  const socketState = useSessionStore((store) => store.socketState)
  const readOnly = useSessionStore(
    (store) => selectAccessLevel(store) === "read_only"
  )
  const badge = connectionBadge({ mode, state, socketState, readOnly })
  const muted = !badge.healthy
  return (
    <View
      testID={`connection-${badge.kind}`}
      accessible
      accessibilityLabel={`Connection: ${badge.label}`}
      style={[styles.connectionPill, muted && styles.connectionPillMuted]}
    >
      <View
        style={[
          styles.connectionDot,
          badge.kind === "demo" && styles.connectionDotDemo,
          muted && styles.connectionDotMuted,
        ]}
      />
      <Text
        style={[styles.connectionText, muted && styles.connectionTextMuted]}
      >
        {badge.label}
      </Text>
    </View>
  )
}

export function StateView({
  title,
  message,
  loading = false,
  actionLabel,
  onAction,
}: {
  title: string
  message: string
  loading?: boolean
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <View style={styles.stateView}>
      {loading ? <ActivityIndicator color={colors.mint} /> : null}
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateMessage}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          style={({ pressed }) => [
            styles.retryButton,
            pressed && styles.pressed,
          ]}
        >
          <RefreshCw size={17} color={colors.canvas} />
          <Text style={styles.retryText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  brandRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  brandGlyph: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.mint,
  },
  brandGlyphCompact: { width: 36, height: 36, borderRadius: 10 },
  brandGlyphText: {
    color: colors.primaryForeground,
    fontFamily: type.mono,
    fontSize: 18,
    fontWeight: "bold",
    letterSpacing: -1,
  },
  brandGlyphTextCompact: { fontSize: 14 },
  brandName: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 18,
    letterSpacing: -0.4,
  },
  brandSub: {
    color: colors.textMuted,
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 2.2,
  },
  topBar: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  topBarCopy: { flex: 1, minWidth: 0 },
  topBarRight: { marginLeft: spacing.sm, alignItems: "flex-end" },
  eyebrow: {
    color: colors.textMuted,
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  title: {
    color: colors.text,
    fontFamily: font.semibold,
    fontSize: 17,
    letterSpacing: -0.3,
  },
  connectionPill: {
    height: 28,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  connectionPillMuted: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  connectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  connectionDotDemo: { backgroundColor: colors.info },
  connectionDotMuted: { backgroundColor: colors.warning },
  connectionText: {
    color: colors.textSecondary,
    fontFamily: font.semibold,
    fontSize: type.micro,
  },
  connectionTextMuted: { color: colors.textSecondary },
  stateView: {
    flex: 1,
    minHeight: 260,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xxl,
    gap: spacing.sm,
  },
  stateTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 18,
    textAlign: "center",
  },
  stateMessage: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.body,
    lineHeight: type.lineHeight,
    textAlign: "center",
    maxWidth: 340,
  },
  retryButton: {
    minHeight: minTouchTarget,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.mint,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  retryText: {
    color: colors.primaryForeground,
    fontFamily: font.semibold,
    fontSize: type.small,
  },
  pressed: { opacity: 0.72 },
})
