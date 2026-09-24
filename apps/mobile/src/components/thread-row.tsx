import { Pressable, StyleSheet, Text, View } from "react-native"
import { formatDay } from "@/lib/format"
import { GitBranch, MessageSquare } from "lucide-react-native"
import type { ChatThread } from "@/types/remote"
import { attentionSummary, type ThreadAttention } from "@/lib/attention"
import { colors, font, radius, spacing, type } from "@/design/theme"

/**
 * Thread list row, styled after the desktop sidebar's thread list: flat and
 * borderless with a rounded active/pressed fill, medium-weight title and a
 * quiet meta line. The active thread carries a small emerald dot instead of
 * the old "AKTIV" pill.
 */
export function ThreadRow({
  thread,
  active,
  attention = null,
  onPress,
}: {
  thread: ChatThread
  active: boolean
  /** What the agent waits for from the user in this chat, if anything. */
  attention?: ThreadAttention | null
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${thread.title}, ${thread.projectName}${
        attention ? `, waiting for you: ${attentionSummary(attention)}` : ""
      }`}
      testID={`thread-row-${thread.id}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        active && styles.rowActive,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.content}>
        <View style={styles.titleRow}>
          {active ? <View style={styles.activeDot} /> : null}
          <Text style={styles.title} numberOfLines={1}>
            {thread.title || "New chat"}
          </Text>
          <Text style={styles.time}>{relativeTime(thread.updatedAt)}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.project} numberOfLines={1}>
            {thread.projectName || "Project"}
          </Text>
          <View style={styles.metaItem}>
            <MessageSquare size={12} color={colors.textMuted} />
            <Text style={styles.metaText}>
              {thread.messageCount ?? thread.messages.length}
            </Text>
          </View>
          {thread.branch ? (
            <View style={styles.metaItem}>
              <GitBranch size={12} color={colors.textMuted} />
              <Text style={styles.metaText} numberOfLines={1}>
                {thread.branch}
              </Text>
            </View>
          ) : null}
        </View>
        {attention ? (
          <View
            style={styles.attention}
            testID={`thread-attention-${thread.id}`}
          >
            <View style={styles.attentionDot} />
            <Text style={styles.attentionText} numberOfLines={1}>
              Waiting for you · {attentionSummary(attention)}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  )
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value)
  if (!Number.isFinite(elapsed)) return ""
  const minutes = Math.max(0, Math.floor(elapsed / 60_000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDay(value)
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    marginHorizontal: spacing.xs,
    marginBottom: 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    justifyContent: "center",
  },
  rowActive: { backgroundColor: colors.surfaceActive },
  pressed: { backgroundColor: colors.surfaceRaised },
  content: { minWidth: 0, gap: 5 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  title: {
    flex: 1,
    color: colors.text,
    fontFamily: font.semibold,
    fontSize: 15,
    letterSpacing: -0.2,
  },
  time: { color: colors.textMuted, fontFamily: font.regular, fontSize: 11 },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  project: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: 130,
  },
  metaText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 11,
  },
  attention: { flexDirection: "row", alignItems: "center", gap: 6 },
  attentionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.warning,
  },
  attentionText: {
    flexShrink: 1,
    color: colors.warning,
    fontFamily: font.medium,
    fontSize: 12,
  },
})
