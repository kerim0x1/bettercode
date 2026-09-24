import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import {
  ArrowLeft,
  ArrowUp,
  Eye,
  EyeOff,
  RefreshCw,
  Search,
  X,
} from "lucide-react-native"
import { Screen, StateView } from "@/components/layout"
import { IconButton } from "@/components/icon-button"
import { FileRow } from "@/components/file-row"
import {
  colors,
  font,
  minTouchTarget,
  radius,
  spacing,
  type,
} from "@/design/theme"
import { effectiveThreadRoot, relativePathWithinRoot } from "@/lib/endpoint"
import { remoteErrorMessage } from "@/lib/remote-errors"
import { useAppStore } from "@/store/app-store"
import { useRemoteApi } from "@/transport/use-transport"
import type { DirectoryEntry } from "@/types/remote"

export default function FilesScreen() {
  const params = useLocalSearchParams<{ id: string | string[] }>()
  const threadId = Array.isArray(params.id) ? params.id[0] : params.id
  const router = useRouter()
  const api = useRemoteApi()
  const thread = useAppStore((state) =>
    state.threads.find((item) => item.id === threadId)
  )
  const root = thread ? effectiveThreadRoot(thread) : ""
  const [currentPath, setCurrentPath] = useState(root)
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  /** Search results keep the desktop's ranking; folders are sorted here. */
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState("")
  const [showHidden, setShowHidden] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

  const loadDirectory = useCallback(
    async (path: string, includeHidden: boolean) => {
      if (!api || !root) return
      setLoading(true)
      setError(null)
      try {
        relativePathWithinRoot(root, path)
        const result = await api.listDirectory(path, includeHidden)
        setCurrentPath(result.path)
        setParent(result.parent)
        setEntries(result.entries)
        setSearching(false)
        setTruncated(result.truncated)
      } catch (caught) {
        setError(remoteErrorMessage(caught))
      } finally {
        setLoading(false)
      }
    },
    [api, root]
  )

  useEffect(() => {
    if (root) {
      setShowHidden(false)
      setCurrentPath(root)
      void loadDirectory(root, false)
    }
  }, [loadDirectory, root])

  const sortedEntries = useMemo(
    () =>
      searching
        ? entries
        : [...entries].sort(
            (a, b) =>
              Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)
          ),
    [entries, searching]
  )

  const runSearch = async () => {
    if (!api) return
    const needle = query.trim()
    if (!needle) {
      await loadDirectory(currentPath, showHidden)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await api.searchFiles(root, needle)
      setEntries(
        result.entries.map((entry) => ({
          ...entry,
          isSymlink: false,
          size: null,
          mtime: null,
        }))
      )
      setSearching(true)
      setTruncated(result.truncated)
    } catch (caught) {
      setError(remoteErrorMessage(caught))
    } finally {
      setLoading(false)
    }
  }

  const refreshVisible = async () => {
    if (query.trim()) await runSearch()
    else await loadDirectory(currentPath, showHidden)
  }

  const openEntry = (entry: DirectoryEntry) => {
    try {
      relativePathWithinRoot(root, entry.path)
    } catch (caught) {
      Alert.alert(
        "Outside the project",
        caught instanceof Error
          ? caught.message
          : "This path is outside the chat's project."
      )
      return
    }
    if (entry.isDir) {
      setQuery("")
      void loadDirectory(entry.path, showHidden)
      return
    }
    router.push({
      pathname: "/chat/[id]/file",
      params: { id: threadId ?? "", path: entry.path },
    })
  }

  const goUp = () => {
    if (!parent) return
    try {
      relativePathWithinRoot(root, parent)
      setQuery("")
      void loadDirectory(parent, showHidden)
    } catch {
      void loadDirectory(root, showHidden)
    }
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton
          icon={ArrowLeft}
          label="Back"
          onPress={() => router.back()}
        />
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>CHAT FILES</Text>
          <Text style={styles.title} numberOfLines={1}>
            {thread?.projectName ?? "Project"}
          </Text>
        </View>
        <IconButton
          icon={showHidden ? EyeOff : Eye}
          label={showHidden ? "Hide hidden files" : "Show hidden files"}
          onPress={() => {
            const next = !showHidden
            setShowHidden(next)
            setQuery("")
            void loadDirectory(currentPath || root, next)
          }}
        />
        <IconButton
          icon={RefreshCw}
          label="Refresh"
          tone="mint"
          onPress={() => void refreshVisible()}
        />
      </View>
      <View style={styles.pathBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Parent folder"
          disabled={currentPath === root}
          onPress={goUp}
          style={[styles.up, currentPath === root && styles.disabled]}
        >
          <ArrowUp size={17} color={colors.textSecondary} />
        </Pressable>
        <View style={styles.pathCopy}>
          <Text style={styles.rootLabel}>ROOT</Text>
          <Text style={styles.path} numberOfLines={1}>
            /{safeRelative(root, currentPath)}
          </Text>
        </View>
      </View>
      <View style={styles.search}>
        <Search size={18} color={colors.textMuted} />
        <TextInput
          accessibilityLabel="Search project files"
          value={query}
          onChangeText={(value) => {
            setQuery(value)
            if (!value) void loadDirectory(currentPath, showHidden)
          }}
          onSubmitEditing={() => void runSearch()}
          returnKeyType="search"
          placeholder="Search files in the chat's project"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
        {query ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            onPress={() => {
              setQuery("")
              void loadDirectory(currentPath, showHidden)
            }}
            style={styles.clear}
          >
            <X size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {truncated ? (
        <Text style={styles.truncated}>
          Showing the first results. Refine the search to see others.
        </Text>
      ) : null}
      {error ? (
        <StateView
          title="Files unavailable"
          message={error}
          actionLabel="Try again"
          onAction={() => void refreshVisible()}
        />
      ) : (
        <FlatList
          data={sortedEntries}
          keyExtractor={(item) => item.path}
          renderItem={({ item }) => (
            <FileRow entry={item} onPress={() => openEntry(item)} />
          )}
          contentContainerStyle={[
            styles.list,
            !sortedEntries.length && styles.emptyList,
          ]}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              tintColor={colors.mint}
              colors={[colors.mint]}
              onRefresh={() => void refreshVisible()}
            />
          }
          ListEmptyComponent={
            <StateView
              loading={loading}
              title={query ? "No matches" : "Folder is empty"}
              message={
                query
                  ? "Try a different file name."
                  : "There are no visible files in this directory."
              }
            />
          }
        />
      )}
    </Screen>
  )
}

function safeRelative(root: string, value: string): string {
  try {
    return relativePathWithinRoot(root, value)
  } catch {
    return ""
  }
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
  pathBar: {
    minHeight: 58,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  up: {
    width: minTouchTarget,
    height: minTouchTarget,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.3 },
  pathCopy: { flex: 1, minWidth: 0 },
  rootLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontFamily: font.bold,
    letterSpacing: 1,
  },
  path: {
    color: colors.textSecondary,
    fontFamily: type.mono,
    fontSize: type.micro,
    marginTop: 3,
  },
  search: {
    height: 50,
    margin: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
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
    fontSize: type.body,
  },
  clear: {
    width: minTouchTarget,
    height: minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  truncated: {
    color: colors.warning,
    fontFamily: font.regular,
    fontSize: type.micro,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
  list: { paddingBottom: spacing.xxl },
  emptyList: { flexGrow: 1 },
})
