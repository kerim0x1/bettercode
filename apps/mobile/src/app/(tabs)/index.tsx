import { useMemo, useState } from "react"
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useRouter } from "expo-router"
import { MessageSquarePlus, Plus, Search, X } from "lucide-react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { ConnectionPill, Screen, StateView, TopBar } from "@/components/layout"
import { ThreadRow } from "@/components/thread-row"
import { threadAttention } from "@/lib/attention"
import {
  colors,
  font,
  minTouchTarget,
  radius,
  spacing,
  type,
} from "@/design/theme"
import { remoteErrorMessage } from "@/lib/remote-errors"
import { useAppStore } from "@/store/app-store"
import { useReadOnly, useRemoteApi } from "@/transport/use-transport"
import type { ProjectSummary } from "@/types/remote"

type Filter = "all" | "active"

export default function ChatsScreen() {
  const router = useRouter()
  const api = useRemoteApi()
  const readOnly = useReadOnly()
  const threads = useAppStore((state) => state.threads)
  const projects = useAppStore((state) => state.projects)
  const streams = useAppStore((state) => state.streamsByThread)
  const requestsByThread = useAppStore((state) => state.requestsByThread)
  const loading = useAppStore((state) => state.loadingThreads)
  const loadingMore = useAppStore((state) => state.loadingMoreThreads)
  const hasMore = useAppStore((state) => state.nextThreadsCursor !== null)
  const error = useAppStore((state) => state.threadsError)
  const refreshThreads = useAppStore((state) => state.refreshThreads)
  const loadMoreThreads = useAppStore((state) => state.loadMoreThreads)
  const createThread = useAppStore((state) => state.createThread)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return threads.filter((thread) => {
      const active =
        streams[thread.id]?.running || Boolean(thread.session?.activeTurnId)
      if (filter === "active" && !active) return false
      if (!needle) return true
      return `${thread.title} ${thread.projectName} ${thread.branch ?? ""}`
        .toLowerCase()
        .includes(needle)
    })
  }, [filter, query, streams, threads])
  const activeCount = threads.filter(
    (thread) => streams[thread.id]?.running || thread.session?.activeTurnId
  ).length

  const openThread = (id: string) =>
    router.push({ pathname: "/chat/[id]", params: { id } })
  const startThread = async (project: ProjectSummary) => {
    if (!api) return
    setCreating(project.path)
    try {
      const thread = await createThread(api, project)
      setNewChatOpen(false)
      openThread(thread.id)
    } catch (error) {
      Alert.alert("Could not create chat", remoteErrorMessage(error))
    } finally {
      setCreating(null)
    }
  }
  const refresh = () => api && void refreshThreads(api).catch(() => undefined)
  const loadMore = () =>
    api && hasMore && void loadMoreThreads(api).catch(() => undefined)

  return (
    <Screen testID="chats-screen">
      <TopBar title="Chats" right={<ConnectionPill />} />
      <View style={styles.summary}>
        <Text style={styles.summaryText}>
          {threads.length} {threads.length === 1 ? "thread" : "threads"}
          {activeCount > 0 ? ` · ${activeCount} active` : ""}
        </Text>
        {readOnly ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create new chat"
            onPress={() => setNewChatOpen(true)}
            style={({ pressed }) => [
              styles.newButton,
              pressed && styles.pressed,
            ]}
          >
            <Plus size={16} color={colors.primaryForeground} />
            <Text style={styles.newButtonText}>New</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.controls}>
        <View style={styles.search}>
          <Search size={18} color={colors.textMuted} />
          <TextInput
            accessibilityLabel="Search chats"
            value={query}
            onChangeText={setQuery}
            placeholder="Search chats"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
          />
          {query ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              onPress={() => setQuery("")}
              style={styles.clear}
            >
              <X size={16} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.filters}>
          <FilterButton
            label="All"
            active={filter === "all"}
            onPress={() => setFilter("all")}
          />
          <FilterButton
            label={`Active ${activeCount}`}
            active={filter === "active"}
            onPress={() => setFilter("active")}
          />
        </View>
      </View>
      {error && !threads.length ? (
        <StateView
          title="Chats unavailable"
          message={error}
          actionLabel="Try again"
          onAction={refresh}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          extraData={requestsByThread}
          renderItem={({ item }) => (
            <ThreadRow
              thread={item}
              active={Boolean(
                streams[item.id]?.running || item.session?.activeTurnId
              )}
              attention={threadAttention(requestsByThread[item.id])}
              onPress={() => openThread(item.id)}
            />
          )}
          contentContainerStyle={[
            styles.list,
            !filtered.length && styles.emptyList,
          ]}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              tintColor={colors.mint}
              colors={[colors.mint]}
              onRefresh={refresh}
            />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            hasMore ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Load older chats"
                disabled={loadingMore}
                onPress={loadMore}
                style={styles.loadMore}
              >
                {loadingMore ? (
                  <ActivityIndicator color={colors.textSecondary} />
                ) : (
                  <Text style={styles.loadMoreText}>Load older chats</Text>
                )}
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            <StateView
              loading={loading}
              title={
                query || filter === "active" ? "No matches" : "No chats yet"
              }
              message={
                query || filter === "active"
                  ? "Adjust your search or filter."
                  : "Create a chat for one of your desktop projects."
              }
              actionLabel={
                !query && filter === "all" && !readOnly
                  ? "Create chat"
                  : undefined
              }
              onAction={
                !query && filter === "all" && !readOnly
                  ? () => setNewChatOpen(true)
                  : undefined
              }
            />
          }
        />
      )}

      <Modal
        visible={newChatOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setNewChatOpen(false)}
      >
        <SafeAreaView style={styles.modal} edges={["top", "bottom"]}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalEyebrow}>NEW THREAD</Text>
              <Text style={styles.modalTitle}>Choose a project</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => setNewChatOpen(false)}
              style={styles.modalClose}
            >
              <X size={20} color={colors.text} />
            </Pressable>
          </View>
          <FlatList
            data={projects}
            keyExtractor={(item) => item.path || item.name}
            contentContainerStyle={styles.projectList}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                disabled={creating !== null}
                onPress={() => void startThread(item)}
                style={({ pressed }) => [
                  styles.projectRow,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.projectIcon}>
                  <MessageSquarePlus size={21} color={colors.mint} />
                </View>
                <View style={styles.projectCopy}>
                  <Text style={styles.projectName}>{item.name}</Text>
                  <Text style={styles.projectPath} numberOfLines={1}>
                    {item.path}
                  </Text>
                </View>
                {creating === item.path ? (
                  <ActivityIndicator color={colors.mint} />
                ) : (
                  <Plus size={20} color={colors.textMuted} />
                )}
              </Pressable>
            )}
            ListEmptyComponent={
              <StateView
                title="No projects"
                message="Open a project in the desktop app first."
              />
            }
          />
        </SafeAreaView>
      </Modal>
    </Screen>
  )
}

function FilterButton({
  label,
  active,
  onPress,
}: {
  label: string
  active: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.filter, active && styles.filterActive]}
    >
      <Text style={[styles.filterText, active && styles.filterTextActive]}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  summary: {
    minHeight: 52,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  summaryText: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  newButton: {
    marginLeft: "auto",
    minHeight: 36,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  newButtonText: {
    color: colors.primaryForeground,
    fontFamily: font.semibold,
    fontSize: type.micro,
  },
  controls: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  search: {
    height: 42,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingLeft: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  searchInput: {
    flex: 1,
    height: "100%",
    color: colors.text,
    fontFamily: font.regular,
    fontSize: type.small,
  },
  clear: {
    width: minTouchTarget,
    height: minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  filters: { flexDirection: "row", gap: spacing.xs },
  filter: {
    minHeight: 36,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  filterActive: {
    borderColor: colors.mintMuted,
    backgroundColor: colors.surfaceActive,
  },
  filterText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: type.micro,
  },
  filterTextActive: { color: colors.text },
  list: { paddingTop: spacing.xs, paddingBottom: spacing.xxl },
  loadMore: {
    minHeight: minTouchTarget,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  loadMoreText: {
    color: colors.textSecondary,
    fontFamily: font.medium,
    fontSize: type.small,
  },
  emptyList: { flexGrow: 1 },
  pressed: { opacity: 0.7 },
  modal: { flex: 1, backgroundColor: colors.canvas },
  modalHeader: {
    minHeight: 78,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modalEyebrow: {
    color: colors.textMuted,
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  modalTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: 20,
    letterSpacing: -0.4,
  },
  modalClose: {
    width: minTouchTarget,
    height: minTouchTarget,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  projectList: { padding: spacing.md, flexGrow: 1 },
  projectRow: {
    minHeight: 76,
    padding: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  projectIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceActive,
    alignItems: "center",
    justifyContent: "center",
  },
  projectCopy: { flex: 1, minWidth: 0 },
  projectName: {
    color: colors.text,
    fontFamily: font.semibold,
    fontSize: type.body,
  },
  projectPath: {
    color: colors.textMuted,
    fontFamily: type.mono,
    fontSize: type.micro,
    marginTop: 4,
  },
})
