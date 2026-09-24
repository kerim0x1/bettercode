import { useEffect, useMemo, useState } from "react"
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { Redirect, useLocalSearchParams, useRouter } from "expo-router"
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileDiff,
  RefreshCw,
} from "lucide-react-native"
import { Screen, StateView } from "@/components/layout"
import { IconButton } from "@/components/icon-button"
import { colors, font, radius, spacing, type } from "@/design/theme"
import { remoteApi } from "@/lib/remote-api"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"
import type { ThreadDiffs } from "@/types/remote"

interface DiffItem {
  id: string
  title: string
  subtitle: string
  diff: string
  additions: number | null
  deletions: number | null
  files: number | null
  createdAt: string
}

export default function ChangesScreen() {
  const params = useLocalSearchParams<{ id: string | string[] }>()
  const threadId = Array.isArray(params.id) ? params.id[0] : params.id
  const router = useRouter()
  const profile = useSessionStore((state) => state.profile)
  const thread = useAppStore((state) =>
    state.threads.find((item) => item.id === threadId)
  )
  const [diffs, setDiffs] = useState<ThreadDiffs | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = async () => {
    if (!profile || !threadId) return
    setLoading(true)
    setError(null)
    try {
      setDiffs(await remoteApi(profile).listDiffs(threadId))
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to load changes."
      )
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    // Thread identity is the stable fetch key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.environmentId, threadId])

  const items = useMemo<DiffItem[]>(() => {
    if (!diffs) return []
    return [
      ...diffs.turnDiffs.map((diff) => ({
        id: `turn-${diff.turnIndex}-${diff.createdAt}`,
        title: `Turn ${diff.turnIndex}`,
        subtitle: "Working tree changes",
        diff: diff.diffText,
        additions: diff.insertions,
        deletions: diff.deletions,
        files: diff.filesChanged,
        createdAt: diff.createdAt,
      })),
      ...diffs.checkpointDiffs.map((diff) => ({
        id: diff.id,
        title: "Checkpoint",
        subtitle: diff.checkpointRef,
        diff: diff.diffContent,
        additions: null,
        deletions: null,
        files: null,
        createdAt: diff.createdAt,
      })),
    ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  }, [diffs])

  if (!profile) return <Redirect href="/pair" />

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
          label="Aktualisieren"
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
                          {item.files} Dateien
                        </Text>
                      ) : null}
                      {item.additions !== null ? (
                        <Text style={styles.add}>+{item.additions}</Text>
                      ) : null}
                      {item.deletions !== null ? (
                        <Text style={styles.del}>−{item.deletions}</Text>
                      ) : null}
                      <Text style={styles.date}>
                        {formatDate(item.createdAt)}
                      </Text>
                    </View>
                  </View>
                  {open ? (
                    <ChevronDown size={19} color={colors.textMuted} />
                  ) : (
                    <ChevronRight size={19} color={colors.textMuted} />
                  )}
                </Pressable>
                {open ? <DiffPreview value={item.diff} /> : null}
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

function DiffPreview({ value }: { value: string }) {
  const lines = value.replace(/\r\n/g, "\n").split("\n")
  const visible = lines.slice(0, 500)
  return (
    <View style={styles.preview}>
      {visible.map((line, index) => (
        <Text
          selectable
          key={index}
          style={[
            styles.diffLine,
            line.startsWith("+") && !line.startsWith("+++") && styles.diffAdd,
            line.startsWith("-") &&
              !line.startsWith("---") &&
              styles.diffDelete,
            line.startsWith("@@") && styles.diffHunk,
          ]}
        >
          {line || " "}
        </Text>
      ))}
      {lines.length > visible.length ? (
        <Text style={styles.capped}>Diff auf 500 Zeilen begrenzt.</Text>
      ) : null}
    </View>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("de-DE", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
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
  preview: {
    padding: spacing.sm,
    backgroundColor: "#080A0C",
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  diffLine: {
    color: "#B7C0BB",
    fontFamily: type.mono,
    fontSize: 11,
    lineHeight: 18,
  },
  diffAdd: { color: "#8DE5A8", backgroundColor: "rgba(113,247,159,0.06)" },
  diffDelete: { color: "#FF9AA7", backgroundColor: "rgba(255,122,138,0.06)" },
  diffHunk: { color: colors.info },
  capped: {
    color: colors.warning,
    fontFamily: font.regular,
    fontSize: type.micro,
    marginTop: spacing.sm,
  },
})
