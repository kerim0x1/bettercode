import { useEffect, useMemo, useState } from "react"
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileDiff,
  RefreshCw,
} from "lucide-react-native"
import { parseGitDiff } from "@betterc0de/schema/git-diff"
import { Screen, StateView } from "@/components/layout"
import { IconButton } from "@/components/icon-button"
import { colors, font, radius, spacing, type } from "@/design/theme"
import { changeItems } from "@/lib/chat-changes"
import { formatShortDateTime } from "@/lib/format"
import { remoteErrorMessage } from "@/lib/remote-errors"
import { useAppStore } from "@/store/app-store"
import { useRemoteApi } from "@/transport/use-transport"
import type { ThreadDiffs } from "@/types/remote"

export default function ChangesScreen() {
  const params = useLocalSearchParams<{ id: string | string[] }>()
  const threadId = Array.isArray(params.id) ? params.id[0] : params.id
  const router = useRouter()
  const api = useRemoteApi()
  const thread = useAppStore((state) =>
    state.threads.find((item) => item.id === threadId)
  )
  const [diffs, setDiffs] = useState<ThreadDiffs | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = async () => {
    if (!api || !threadId) return
    setLoading(true)
    setError(null)
    try {
      setDiffs(await api.listDiffs(threadId))
    } catch (caught) {
      setError(remoteErrorMessage(caught))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    // The connection and the chat are the stable fetch keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, threadId])

  const items = useMemo(() => changeItems(diffs), [diffs])

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton
          icon={ArrowLeft}
          label="Back"
          onPress={() => router.back()}
        />
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>DIFFS & CHECKPOINTS</Text>
          <Text style={styles.title} numberOfLines={1}>
            {thread?.title ?? "Changes"}
          </Text>
        </View>
        <IconButton
          icon={RefreshCw}
          label="Refresh"
          tone="mint"
          onPress={() => void load()}
        />
      </View>
      {error ? (
        <StateView
          title="Changes unavailable"
          message={error}
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[
            styles.list,
            !items.length && styles.emptyList,
          ]}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              tintColor={colors.mint}
              colors={[colors.mint]}
              onRefresh={() => void load()}
            />
          }
          renderItem={({ item }) => {
            const open = expanded === item.id
            return (
              <View style={styles.card}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  onPress={() => setExpanded(open ? null : item.id)}
                  style={({ pressed }) => [
                    styles.cardHeader,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.diffIcon}>
                    <FileDiff size={20} color={colors.mint} />
                  </View>
                  <View style={styles.copy}>
                    <Text style={styles.cardTitle}>{item.title}</Text>
                    <Text style={styles.cardSub} numberOfLines={1}>
                      {item.subtitle}
                    </Text>
                    <View style={styles.stats}>
                      {item.files !== null ? (
                        <Text style={styles.fileStat}>
                          {item.files} {item.files === 1 ? "file" : "files"}
                        </Text>
                      ) : null}
                      {item.additions !== null ? (
                        <Text style={styles.add}>+{item.additions}</Text>
                      ) : null}
                      {item.deletions !== null ? (
                        <Text style={styles.del}>−{item.deletions}</Text>
                      ) : null}
                      <Text style={styles.date}>
                        {formatShortDateTime(item.createdAt)}
                      </Text>
                    </View>
                  </View>
                  {open ? (
                    <ChevronDown size={19} color={colors.textMuted} />
                  ) : (
                    <ChevronRight size={19} color={colors.textMuted} />
                  )}
                </Pressable>
                {open ? (
                  <DiffFiles
                    diff={item.diff}
                    onOpen={(file) =>
                      router.push({
                        pathname: "/chat/[id]/diff",
                        params: { id: threadId ?? "", item: item.id, file },
                      })
                    }
                  />
                ) : null}
              </View>
            )
          }}
          ListEmptyComponent={
            <StateView
              loading={loading}
              title="No changes yet"
              message="Once the agent edits files or creates a checkpoint, the diff shows up here."
            />
          }
        />
      )}
    </Screen>
  )
}

/** The files of one diff; each opens in full on its own screen. */
function DiffFiles({
  diff,
  onOpen,
}: {
  diff: string
  onOpen: (file: string) => void
}) {
  const files = useMemo(() => parseGitDiff(diff), [diff])
  if (files.length === 0) {
    return <Text style={styles.noFiles}>This diff names no files.</Text>
  }
  return (
    <View style={styles.files}>
      {files.map((file) => (
        <Pressable
          key={file.name}
          accessibilityRole="button"
          accessibilityLabel={`${file.name}, open the diff`}
          testID={`change-file-${file.name}`}
          onPress={() => onOpen(file.name)}
          style={({ pressed }) => [styles.fileRow, pressed && styles.pressed]}
        >
          <Text style={styles.fileName} numberOfLines={1}>
            {file.name}
          </Text>
          {file.additions ? (
            <Text style={styles.add}>+{file.additions}</Text>
          ) : null}
          {file.deletions ? (
            <Text style={styles.del}>−{file.deletions}</Text>
          ) : null}
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
      ))}
    </View>
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
    fontSize: 9,
    fontFamily: font.bold,
    letterSpacing: 1.1,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontFamily: font.bold,
    marginTop: 2,
  },
  list: { padding: spacing.md, paddingBottom: spacing.xxl },
  emptyList: { flexGrow: 1 },
  card: {
    marginBottom: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  cardHeader: {
    minHeight: 86,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  pressed: { opacity: 0.7 },
  diffIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceActive,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, minWidth: 0 },
  cardTitle: { color: colors.text, fontSize: type.body, fontFamily: font.bold },
  cardSub: {
    color: colors.textMuted,
    fontFamily: type.mono,
    fontSize: type.micro,
    marginTop: 3,
  },
  stats: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: 7,
  },
  fileStat: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  add: { color: colors.mint, fontSize: type.micro, fontFamily: font.bold },
  del: { color: colors.danger, fontSize: type.micro, fontFamily: font.bold },
  date: {
    marginLeft: "auto",
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 10,
  },
  files: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  fileRow: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  fileName: {
    flex: 1,
    color: colors.text,
    fontFamily: type.mono,
    fontSize: type.micro,
  },
  noFiles: {
    padding: spacing.md,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
})
