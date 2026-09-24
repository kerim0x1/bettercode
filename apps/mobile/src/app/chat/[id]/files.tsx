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
  FilePlus2,
  FolderPlus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react-native"
import {
  ContentSearchOptions,
  ContentSearchResults,
  DEFAULT_CONTENT_SEARCH,
  type ContentSearchChoices,
} from "@/components/content-search"
import { DropdownRow, DropdownSheet } from "@/components/dropdown-sheet"
import { Screen, StateView } from "@/components/layout"
import { IconButton } from "@/components/icon-button"
import { FileRow } from "@/components/file-row"
import { RenameSheet } from "@/components/rename-sheet"
import {
  colors,
  font,
  minTouchTarget,
  radius,
  spacing,
  type,
} from "@/design/theme"
import {
  effectiveThreadRoot,
  pathWithinRoot,
  relativePathWithinRoot,
} from "@/lib/endpoint"
import {
  childPath,
  deleteConfirmation,
  fileActionError,
  fileNameProblem,
} from "@/lib/file-actions"
import { remoteErrorMessage } from "@/lib/remote-errors"
import { useAppStore } from "@/store/app-store"
import type { ContentSearchResult } from "@/transport/types"
import { useReadOnly, useRemoteApi } from "@/transport/use-transport"
import type { DirectoryEntry } from "@/types/remote"

type Naming =
  | { kind: "file" }
  | { kind: "folder" }
  | { kind: "rename"; entry: DirectoryEntry }

const NAMING_WORDS = {
  file: { heading: "New file", label: "File name", action: "Create" },
  folder: { heading: "New folder", label: "Folder name", action: "Create" },
  rename: { heading: "Rename", label: "Name", action: "Rename" },
} as const

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
  const readOnly = useReadOnly()
  /** File names (the desktop's quick search) or the text inside files. */
  const [mode, setMode] = useState<"names" | "contents">("names")
  const [choices, setChoices] = useState<ContentSearchChoices>(
    DEFAULT_CONTENT_SEARCH
  )
  const [found, setFound] = useState<ContentSearchResult | null>(null)
  const [creating, setCreating] = useState(false)
  const [menuEntry, setMenuEntry] = useState<DirectoryEntry | null>(null)
  const [naming, setNaming] = useState<Naming | null>(null)

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
        setFound(null)
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

  const runSearch = async (searchMode = mode) => {
    if (!api) return
    const needle = query.trim()
    if (!needle) {
      await loadDirectory(currentPath, showHidden)
      return
    }
    setLoading(true)
    setError(null)
    try {
      if (searchMode === "contents") {
        const include = choices.include.trim()
        setFound(
          await api.searchContent(root, needle, {
            caseSensitive: choices.caseSensitive,
            wholeWord: choices.wholeWord,
            regex: choices.regex,
            ...(include ? { include } : {}),
          })
        )
        return
      }
      setFound(null)
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

  /** A match opens its file at the line. */
  const openMatch = (path: string, line: number) =>
    router.push({
      pathname: "/chat/[id]/file",
      params: {
        id: threadId ?? "",
        path: pathWithinRoot(root, path),
        line: String(line),
      },
    })

  /** Creates or renames; the sheet stays open when the desktop refuses. */
  const saveName = async (name: string) => {
    if (!api || !naming) return
    const folder = safeRelative(root, currentPath)
    try {
      if (naming.kind === "file") {
        // Never over an existing file: the desktop refuses when it exists.
        await api.writeFile(root, childPath(folder, name), "", null)
      } else if (naming.kind === "folder") {
        await api.createFolder(root, childPath(folder, name))
      } else {
        const from = relativePathWithinRoot(root, naming.entry.path)
        const slash = from.lastIndexOf("/")
        await api.movePath(
          root,
          from,
          childPath(slash === -1 ? "" : from.slice(0, slash), name)
        )
      }
      setNaming(null)
      await refreshVisible()
    } catch (caught) {
      const problem = fileActionError(
        caught,
        naming.kind === "rename" ? "rename" : "create"
      )
      Alert.alert(problem.title, problem.message)
    }
  }

  /** The desktop Explorer's question, then the file or the whole folder. */
  const removeEntry = (entry: DirectoryEntry) => {
    const confirmation = deleteConfirmation(entry)
    Alert.alert(confirmation.title, confirmation.message, [
      { text: "Cancel", style: "cancel" },
      {
        text: confirmation.action,
        style: "destructive",
        onPress: () => {
          void (async () => {
            if (!api) return
            try {
              await api.deletePath(
                root,
                relativePathWithinRoot(root, entry.path),
                entry.isDir
              )
            } catch (caught) {
              const problem = fileActionError(caught, "delete")
              Alert.alert(problem.title, problem.message)
            }
            await refreshVisible()
          })()
        },
      },
    ])
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
        {readOnly ? null : (
          <IconButton
            icon={Plus}
            label="New file or folder"
            testID="files-new"
            onPress={() => setCreating(true)}
          />
        )}
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
          testID="files-search"
          returnKeyType="search"
          placeholder={
            mode === "contents"
              ? "Search text in the chat's project"
              : "Search files in the chat's project"
          }
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
      <View style={styles.modes} accessibilityRole="tablist">
        {(["names", "contents"] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === value }}
            testID={`files-mode-${value}`}
            onPress={() => {
              setMode(value)
              setFound(null)
              if (query.trim()) void runSearch(value)
            }}
            style={({ pressed }) => [
              styles.mode,
              mode === value && styles.modeOn,
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[styles.modeText, mode === value && styles.modeTextOn]}
            >
              {value === "names" ? "File names" : "Contents"}
            </Text>
          </Pressable>
        ))}
      </View>
      {mode === "contents" ? (
        <ContentSearchOptions
          value={choices}
          onChange={setChoices}
          onSubmit={() => void runSearch()}
        />
      ) : null}
      {truncated && !found ? (
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
      ) : found ? (
        <ContentSearchResults
          search={found}
          loading={loading}
          onRefresh={() => void refreshVisible()}
          onOpen={openMatch}
        />
      ) : (
        <FlatList
          data={sortedEntries}
          keyExtractor={(item) => item.path}
          renderItem={({ item }) => (
            <FileRow
              entry={item}
              onPress={() => openEntry(item)}
              onMore={readOnly ? undefined : () => setMenuEntry(item)}
            />
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
      <DropdownSheet
        visible={creating}
        onClose={() => setCreating(false)}
        title="New"
      >
        <DropdownRow
          icon={<FilePlus2 size={16} color={colors.text} />}
          label="New file"
          onPress={() => {
            setCreating(false)
            setNaming({ kind: "file" })
          }}
        />
        <DropdownRow
          icon={<FolderPlus size={16} color={colors.text} />}
          label="New folder"
          onPress={() => {
            setCreating(false)
            setNaming({ kind: "folder" })
          }}
        />
      </DropdownSheet>
      <DropdownSheet
        visible={menuEntry !== null}
        onClose={() => setMenuEntry(null)}
        title={menuEntry?.name}
      >
        <DropdownRow
          icon={<Pencil size={16} color={colors.text} />}
          label="Rename"
          onPress={() => {
            const entry = menuEntry
            setMenuEntry(null)
            if (entry) setNaming({ kind: "rename", entry })
          }}
        />
        <DropdownRow
          icon={<Trash2 size={16} color={colors.danger} />}
          label="Delete"
          destructive
          onPress={() => {
            const entry = menuEntry
            setMenuEntry(null)
            if (entry) removeEntry(entry)
          }}
        />
      </DropdownSheet>
      <RenameSheet
        visible={naming !== null}
        title={naming?.kind === "rename" ? naming.entry.name : ""}
        heading={
          naming?.kind === "rename"
            ? `Rename ${naming.entry.isDir ? "folder" : "file"}`
            : NAMING_WORDS[naming?.kind ?? "file"].heading
        }
        label={NAMING_WORDS[naming?.kind ?? "file"].label}
        actionLabel={NAMING_WORDS[naming?.kind ?? "file"].action}
        fileName
        problem={fileNameProblem}
        onCancel={() => setNaming(null)}
        onSave={saveName}
      />
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
  modes: {
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
  mode: {
    minHeight: minTouchTarget,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  modeOn: {
    backgroundColor: colors.surfaceActive,
    borderColor: colors.borderStrong,
  },
  modeText: {
    color: colors.textSecondary,
    fontFamily: font.semibold,
    fontSize: type.micro,
  },
  modeTextOn: { color: colors.text },
  pressed: { opacity: 0.7 },
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
