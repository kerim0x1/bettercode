import { useMemo } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { ChevronRight } from "lucide-react-native"
import { colors, font, spacing } from "@/design/theme"
import { attentionSummary, threadAttention } from "@/lib/attention"
import { useAppStore } from "@/store/app-store"

/**
 * In an open chat, a line for the other chats whose agent waits for an
 * answer: a chat screen has no tab bar with the Chats badge. Tapping it
 * opens the (first) waiting chat.
 */
export function OtherChatsWaiting({ threadId }: { threadId: string }) {
  const router = useRouter()
  const threads = useAppStore((state) => state.threads)
  const requestsByThread = useAppStore((state) => state.requestsByThread)
  const waiting = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.id !== threadId &&
          (requestsByThread[thread.id]?.length ?? 0) > 0
      ),
    [requestsByThread, threadId, threads]
  )
  const first = waiting[0]
  if (!first) return null
  const attention = threadAttention(requestsByThread[first.id])
  const title = first.title || "Another chat"
  const label =
    waiting.length > 1
      ? `${title} and ${waiting.length - 1} more ${waiting.length === 2 ? "chat wait" : "chats wait"} for you`
      : `${title} waits for you${attention ? ` · ${attentionSummary(attention)}` : ""}`
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. Open ${title}.`}
      testID="other-chat-waiting"
      onPress={() =>
        router.push({ pathname: "/chat/[id]", params: { id: first.id } })
      }
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.dot} />
      <Text style={styles.text} numberOfLines={1}>
        {label}
      </Text>
      <ChevronRight size={15} color={colors.warning} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: 38,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: "rgba(251,191,36,0.08)",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(251,191,36,0.2)",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.warning,
  },
  text: {
    flex: 1,
    color: colors.warning,
    fontFamily: font.medium,
    fontSize: 12,
  },
  pressed: { opacity: 0.72 },
})
