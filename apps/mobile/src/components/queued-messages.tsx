import { useMemo } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { Image as ImageIcon, ListOrdered, Play, X } from "lucide-react-native"
import { colors, font, radius, spacing } from "@/design/theme"
import { useQueueStore } from "@/store/queue-store"

/**
 * The chat's queued messages, ported from the desktop's QueuedMessages:
 * how many wait, whether they send after the current turn or are paused
 * (after a failure, or a restart), Resume, and a remove button per message.
 */
export function QueuedMessages({ threadId }: { threadId: string }) {
  const all = useQueueStore((state) => state.messages)
  const messages = useMemo(
    () => all.filter((message) => message.threadId === threadId),
    [all, threadId]
  )
  if (messages.length === 0) return null
  const paused = messages.some(
    (message) => message.status === "paused" || message.status === "failed"
  )
  return (
    <View
      style={styles.panel}
      accessibilityLabel="Queued messages"
      testID="queued-messages"
    >
      <View style={styles.header}>
        <ListOrdered size={14} color={colors.textSecondary} />
        <Text style={styles.summary}>
          {messages.length} queued ·{" "}
          {paused ? "Paused" : "Send after the current turn"}
        </Text>
        {paused ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Resume the queue"
            testID="queue-resume"
            onPress={() => useQueueStore.getState().resume(threadId)}
            style={({ pressed }) => [styles.resume, pressed && styles.pressed]}
          >
            <Play size={12} color={colors.text} />
            <Text style={styles.resumeText}>Resume</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView style={styles.list} nestedScrollEnabled>
        {messages.map((message, index) => (
          <View key={message.id} style={styles.item}>
            <Text style={styles.index}>{index + 1}.</Text>
            <View style={styles.copy}>
              <Text style={styles.text} numberOfLines={2}>
                {message.payload.text}
              </Text>
              {message.payload.attachments?.length ? (
                <View style={styles.photos}>
                  <ImageIcon size={12} color={colors.textMuted} />
                  <Text style={styles.photosText}>
                    {photoCount(message.payload.attachments.length)}
                  </Text>
                </View>
              ) : null}
              {message.error ? (
                <Text style={styles.error}>{message.error}</Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove queued message ${index + 1}`}
              accessibilityState={{ disabled: message.status === "sending" }}
              disabled={message.status === "sending"}
              onPress={() => useQueueStore.getState().remove(message.id)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.remove,
                pressed && styles.pressed,
                message.status === "sending" && styles.disabled,
              ]}
            >
              <X size={14} color={colors.textMuted} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

function photoCount(count: number): string {
  return count === 1 ? "1 photo" : `${count} photos`
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: spacing.sm,
    marginBottom: spacing.xxs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  header: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  summary: {
    flex: 1,
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: 12,
  },
  resume: {
    minHeight: 28,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surfaceActive,
  },
  resumeText: { color: colors.text, fontFamily: font.medium, fontSize: 12 },
  list: { maxHeight: 144 },
  item: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
    paddingVertical: 4,
  },
  index: {
    paddingTop: 1,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
  },
  copy: { flex: 1, minWidth: 0 },
  text: { color: colors.text, fontFamily: font.regular, fontSize: 13 },
  photos: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  photosText: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
  },
  error: {
    marginTop: 2,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 12,
  },
  remove: { padding: 4, borderRadius: radius.sm },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
})
