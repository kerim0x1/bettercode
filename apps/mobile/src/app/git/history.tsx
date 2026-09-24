import { useCallback, useState } from "react"
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native"
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router"
import { ArrowLeft, GitCommitHorizontal } from "lucide-react-native"
import { IconButton } from "@/components/icon-button"
import { Screen, StateView } from "@/components/layout"
import { colors, font, spacing, type } from "@/design/theme"
import { formatShortDateTime } from "@/lib/format"
import { gitLogDate } from "@/lib/git-review"
import { remoteErrorMessage } from "@/lib/remote-errors"
import { useReadOnly, useRemoteApi } from "@/transport/use-transport"
import type { GitLogEntry } from "@/transport/types"

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}

/** The latest 30 commits of the checked-out branch, as the desktop's log. */
export default function GitHistoryScreen() {
  const params = useLocalSearchParams<{
    root?: string | string[]
    name?: string | string[]
  }>()
  const root = firstParam(params.root)
  const name = firstParam(params.name)
  const router = useRouter()
  const api = useRemoteApi()
  const readOnly = useReadOnly()
  const [commits, setCommits] = useState<GitLogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!api || !root || readOnly) return
    setLoading(true)
    try {
      setCommits(await api.gitLog(root, 30))
      setError(null)
    } catch (caught) {
      setError(remoteErrorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [api, readOnly, root])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load])
  )

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton
          icon={ArrowLeft}
          label="Back"
          onPress={() => router.back()}
        />
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>HISTORY</Text>
          <Text style={styles.title} numberOfLines={1}>
            {name || "Commits"}
          </Text>
        </View>
      </View>
      {readOnly ? (
        <StateView
          title="This phone can only watch"
          message="Pair it again over your Wi-Fi, Tailscale or HTTPS to see the history."
        />
      ) : error && !commits ? (
        <StateView
          title="History unavailable"
          message={error}
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : (
        <FlatList
          testID="git-log"
          data={commits ?? []}
          keyExtractor={(commit) => commit.hash}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              tintColor={colors.mint}
              colors={[colors.mint]}
              onRefresh={() => void load()}
            />
          }
          renderItem={({ item }) => {
            const date = gitLogDate(item.date)
            return (
              <View style={styles.commit}>
                <GitCommitHorizontal size={16} color={colors.textMuted} />
                <View style={styles.copy}>
                  <Text style={styles.message} numberOfLines={2}>
                    {item.message || "(no message)"}
                  </Text>
                  <View style={styles.meta}>
                    <Text style={styles.hash}>{item.hash.slice(0, 7)}</Text>
                    {item.author ? (
                      <Text style={styles.metaText} numberOfLines={1}>
                        {item.author}
                      </Text>
                    ) : null}
                    {date ? (
                      <Text style={styles.metaText}>
                        {formatShortDateTime(date.toISOString())}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>
            )
          }}
          ListEmptyComponent={
            <StateView
              loading={loading}
              title={loading ? "Loading commits" : "No commits"}
              message="This branch has no commits yet."
            />
          }
        />
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: {
    minHeight: 68,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  headerCopy: { flex: 1, minWidth: 0, marginHorizontal: 2 },
  eyebrow: {
    color: colors.mint,
    fontSize: 10,
    fontFamily: font.bold,
    letterSpacing: 1.1,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontFamily: font.bold,
    marginTop: 2,
  },
  list: { paddingVertical: spacing.xs, flexGrow: 1 },
  commit: {
    minHeight: 64,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  copy: { flex: 1, minWidth: 0 },
  message: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: type.small,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: 4,
  },
  hash: {
    color: colors.textSecondary,
    fontFamily: type.mono,
    fontSize: type.micro,
  },
  metaText: {
    flexShrink: 1,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
})
