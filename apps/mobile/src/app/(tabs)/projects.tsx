import { useMemo, useState } from "react"
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { useRouter } from "expo-router"
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  Plus,
} from "lucide-react-native"
import { ConnectionPill, Screen, StateView, TopBar } from "@/components/layout"
import { colors, font, radius, spacing, type } from "@/design/theme"
import { remoteErrorMessage } from "@/lib/remote-errors"
import { useAppStore } from "@/store/app-store"
import { useReadOnly, useRemoteApi } from "@/transport/use-transport"
import type { ProjectSummary } from "@/types/remote"

export default function ProjectsScreen() {
  const router = useRouter()
  const api = useRemoteApi()
  const readOnly = useReadOnly()
  const projects = useAppStore((state) => state.projects)
  const error = useAppStore((state) => state.projectsError)
  const threads = useAppStore((state) => state.threads)
  const loading = useAppStore((state) => state.loadingProjects)
  const refreshProjects = useAppStore((state) => state.refreshProjects)
  const createThread = useAppStore((state) => state.createThread)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [creating, setCreating] = useState<string | null>(null)

  const threadsByProject = useMemo(() => {
    const map: Record<string, typeof threads> = {}
    for (const thread of threads) {
      const key = thread.projectPath || thread.projectName
      ;(map[key] ??= []).push(thread)
    }
    return map
  }, [threads])

  const startChat = async (project: ProjectSummary) => {
    if (!api) return
    setCreating(project.path)
    try {
      const thread = await createThread(api, project)
      router.push({ pathname: "/chat/[id]", params: { id: thread.id } })
    } catch (error) {
      Alert.alert("Could not create chat", remoteErrorMessage(error))
    } finally {
      setCreating(null)
    }
  }
  const refresh = () => api && void refreshProjects(api).catch(() => undefined)

  return (
    <Screen>
      <TopBar title="Projects" right={<ConnectionPill />} />
      <FlatList
        data={projects}
        keyExtractor={(item) => item.path || item.name}
        contentContainerStyle={[
          styles.list,
          !projects.length && styles.emptyList,
        ]}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            tintColor={colors.mint}
            colors={[colors.mint]}
            onRefresh={refresh}
          />
        }
        renderItem={({ item }) => {
          const key = item.path || item.name
          const projectThreads = threadsByProject[key] ?? []
          const open = expanded === key
          return (
            <View style={styles.card}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                onPress={() => setExpanded(open ? null : key)}
                style={({ pressed }) => [
                  styles.cardHeader,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.folder}>
                  <FolderGit2 size={16} color={colors.textSecondary} />
                </View>
                <View style={styles.copy}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.path} numberOfLines={1}>
                    {item.path}
                  </Text>
                </View>
                <Text style={styles.threadCount}>{projectThreads.length}</Text>
                {open ? (
                  <ChevronDown size={16} color={colors.textMuted} />
                ) : (
                  <ChevronRight size={16} color={colors.textMuted} />
                )}
              </Pressable>
              {open ? (
                <View style={styles.expanded}>
                  {projectThreads.slice(0, 5).map((thread) => (
                    <Pressable
                      key={thread.id}
                      accessibilityRole="button"
                      onPress={() =>
                        router.push({
                          pathname: "/chat/[id]",
                          params: { id: thread.id },
                        })
                      }
                      style={({ pressed }) => [
                        styles.thread,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View style={styles.threadCopy}>
                        <Text style={styles.threadTitle} numberOfLines={1}>
                          {thread.title}
                        </Text>
                        <View style={styles.threadMeta}>
                          {thread.branch ? (
                            <GitBranch size={12} color={colors.textMuted} />
                          ) : null}
                          <Text style={styles.threadMetaText} numberOfLines={1}>
                            {thread.branch ||
                              `${thread.messageCount ?? 0} messages`}
                          </Text>
                        </View>
                      </View>
                      <ChevronRight size={17} color={colors.textMuted} />
                    </Pressable>
                  ))}
                  {projectThreads.length > 5 ? (
                    <Text style={styles.more}>
                      + {projectThreads.length - 5} more threads
                    </Text>
                  ) : null}
                  {readOnly ? null : (
                    <Pressable
                      accessibilityRole="button"
                      disabled={creating !== null}
                      onPress={() => void startChat(item)}
                      style={({ pressed }) => [
                        styles.create,
                        pressed && styles.pressed,
                      ]}
                    >
                      {creating === item.path ? (
                        <ActivityIndicator color={colors.primaryForeground} />
                      ) : (
                        <Plus size={15} color={colors.primaryForeground} />
                      )}
                      <Text style={styles.createText}>New chat</Text>
                    </Pressable>
                  )}
                </View>
              ) : null}
            </View>
          )
        }}
        ListEmptyComponent={
          error ? (
            <StateView
              title="Projects unavailable"
              message={error}
              actionLabel="Try again"
              onAction={refresh}
            />
          ) : (
            <StateView
              loading={loading}
              title="No projects"
              message="Open a project on the desktop; it will appear here automatically."
              actionLabel="Refresh"
              onAction={refresh}
            />
          )
        }
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  list: { padding: spacing.sm, paddingBottom: spacing.xxl },
  emptyList: { flexGrow: 1 },
  card: {
    marginBottom: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  cardHeader: {
    minHeight: 52,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  folder: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceActive,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, minWidth: 0 },
  name: {
    color: colors.text,
    fontSize: 14,
    fontFamily: font.semibold,
    letterSpacing: -0.2,
  },
  path: {
    color: colors.textMuted,
    fontFamily: type.mono,
    fontSize: 10,
    marginTop: 2,
  },
  threadCount: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: font.medium,
    paddingHorizontal: 2,
  },
  expanded: {
    padding: spacing.xs,
    paddingTop: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  thread: {
    minHeight: 42,
    paddingHorizontal: spacing.xs,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  threadCopy: { flex: 1, minWidth: 0 },
  threadTitle: {
    color: colors.text,
    fontSize: 13,
    fontFamily: font.medium,
  },
  threadMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  threadMetaText: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
  },
  more: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
    padding: spacing.xs,
  },
  create: {
    minHeight: 34,
    marginTop: spacing.xs,
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  createText: {
    color: colors.primaryForeground,
    fontSize: 12,
    fontFamily: font.semibold,
  },
  pressed: { opacity: 0.7 },
})
