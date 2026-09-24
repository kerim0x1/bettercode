import { Pressable, StyleSheet, Text, View } from "react-native"
import { RotateCcw, Send, Trash2, type LucideIcon } from "lucide-react-native"
import { colors, font, radius, spacing } from "@/design/theme"
import type { OutboxEntry } from "@/store/app-store"

/**
 * Under a message the desktop did not take: why, and what can be done.
 * Retry sends the same message again, which the desktop recognises, so it
 * never arrives twice. When the desktop has said it will never take this
 * one, only sending the text again as a new message helps.
 */
export function SendFailure({
  entry,
  onRetry,
  onSendAsNew,
  onDelete,
}: {
  entry: OutboxEntry
  onRetry: () => void
  onSendAsNew: () => void
  onDelete: () => void
}) {
  return (
    <View style={styles.wrap} testID="send-failure">
      <Text style={styles.error}>{entry.error}</Text>
      <View style={styles.actions}>
        {entry.retryable ? (
          <Action
            icon={RotateCcw}
            label="Retry"
            testID="send-retry"
            onPress={onRetry}
          />
        ) : (
          <Action
            icon={Send}
            label="Send as new"
            testID="send-as-new"
            onPress={onSendAsNew}
          />
        )}
        <Action
          icon={Trash2}
          label="Delete"
          testID="send-delete"
          onPress={onDelete}
        />
      </View>
    </View>
  )
}

function Action({
  icon: Icon,
  label,
  testID,
  onPress,
}: {
  icon: LucideIcon
  label: string
  testID: string
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <Icon size={13} color={colors.text} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: "flex-end",
    maxWidth: "86%",
    marginRight: spacing.md,
    marginTop: -spacing.xs,
    marginBottom: spacing.sm,
    alignItems: "flex-end",
    gap: spacing.xxs,
  },
  error: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: 12,
    textAlign: "right",
  },
  actions: { flexDirection: "row", gap: spacing.xs },
  action: {
    minHeight: 30,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  actionText: { color: colors.text, fontFamily: font.medium, fontSize: 12 },
  pressed: { opacity: 0.72 },
})
