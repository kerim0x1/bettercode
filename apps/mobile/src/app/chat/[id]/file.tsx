import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FlatList, StyleSheet, Text, View } from "react-native"
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router"
import { ArrowLeft, Pencil, WrapText } from "lucide-react-native"
import { REMOTE_FEATURES } from "@betterc0de/schema/remote-protocol"
import { ActionButton } from "@/components/action-button"
import { Screen, StateView } from "@/components/layout"
import { IconButton } from "@/components/icon-button"
import { colors, font, radius, spacing, type } from "@/design/theme"
import { MAX_EDITABLE_BYTES } from "@/editor/protocol"
import { draftFor } from "@/lib/editor-drafts"
import { effectiveThreadRoot, relativePathWithinRoot } from "@/lib/endpoint"
import { remoteErrorMessage } from "@/lib/remote-errors"
import { useAppStore } from "@/store/app-store"
import {
  useFeature,
  useReadOnly,
  useRemoteApi,
} from "@/transport/use-transport"

export default function FileScreen() {
  const params = useLocalSearchParams<{
    id: string | string[]
    path: string | string[]
    /** From a search: the line to show, counted from 1. */
    line?: string | string[]
  }>()
  const threadId = Array.isArray(params.id) ? params.id[0] : params.id
  const absolutePath = Array.isArray(params.path) ? params.path[0] : params.path
  const targetLine =
    Number(Array.isArray(params.line) ? params.line[0] : params.line) || 0
  const listRef = useRef<FlatList<string>>(null)
  const router = useRouter()
  const api = useRemoteApi()
  const thread = useAppStore((state) =>
    state.threads.find((item) => item.id === threadId)
  )
  const root = thread ? effectiveThreadRoot(thread) : ""
  const [content, setContent] = useState<string | null>(null)
  const [binary, setBinary] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wrap, setWrap] = useState(true)
  const [size, setSize] = useState(0)
  const [hasDraft, setHasDraft] = useState(false)
  const readOnly = useReadOnly()
  const canSaveSafely = useFeature(REMOTE_FEATURES.workspaceWriteIfMatch)
  const lines = useMemo(
    () => (content ?? "").replace(/\r\n/g, "\n").split("\n"),
    [content]
  )

  // Read again whenever the screen shows, so a save in the editor shows too.
  const load = useCallback(() => {
    if (!api || !root || !absolutePath) return
    setLoading(true)
    setError(null)
    setBinary(false)
    try {
      relativePathWithinRoot(root, absolutePath)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "File path is outside the chat's project."
      )
      setLoading(false)
      return
    }
    let cancelled = false
    void api
      .readFile(root, absolutePath)
      .then((result) => {
        if (cancelled) return
        // Desktops that report it tell a text file from a binary one;
        // showing binary bytes as text is only noise.
        setBinary(result.isUtf8 === false)
        setContent(result.content)
        setSize(result.size ?? new TextEncoder().encode(result.content).length)
        setHasDraft(
          draftFor(root, relativePathWithinRoot(root, absolutePath)) !== null
        )
      })
      .catch((caught) => {
        if (!cancelled) setError(remoteErrorMessage(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [absolutePath, api, root])
  useFocusEffect(load)

  // A search opens the file at its match: scroll there once it is shown.
  useEffect(() => {
    if (content === null || binary || targetLine < 1) return
    if (targetLine > lines.length) return
    const timer = setTimeout(() => {
      listRef.current?.scrollToIndex({
        index: targetLine - 1,
        viewPosition: 0.3,
        animated: false,
      })
    }, 0)
    return () => clearTimeout(timer)
  }, [binary, content, lines.length, targetLine])

  const editable =
    !readOnly &&
    canSaveSafely &&
    content !== null &&
    !binary &&
    size <= MAX_EDITABLE_BYTES
  const edit = () =>
    router.push({
      pathname: "/chat/[id]/edit",
      params: { id: threadId ?? "", path: absolutePath ?? "" },
    })

  const name = fileName(absolutePath ?? "File")
  const relative = root && absolutePath ? safeRelative(root, absolutePath) : ""

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton
          icon={ArrowLeft}
          label="Back"
          onPress={() => router.back()}
        />
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>
            {extension(name).toUpperCase() || "TEXT"}
            {editable ? "" : " · READ ONLY"}
          </Text>
          <Text style={styles.title} numberOfLines={1}>
            {name}
          </Text>
        </View>
        <IconButton
          icon={WrapText}
          label={wrap ? "Do not wrap lines" : "Wrap lines"}
          tone={wrap ? "mint" : "default"}
          onPress={() => setWrap(!wrap)}
        />
        {editable ? (
          <IconButton
            icon={Pencil}
            label="Edit"
            testID="file-edit"
            onPress={edit}
          />
        ) : null}
      </View>
      <View style={styles.pathBar}>
        <Text style={styles.path} numberOfLines={1}>
          /{relative}
        </Text>
        {content !== null ? (
          <Text style={styles.lineCount}>
            {lines.length} {lines.length === 1 ? "line" : "lines"}
          </Text>
        ) : null}
      </View>
      {hasDraft && editable ? (
        <View style={styles.draft} testID="file-draft">
          <Text style={styles.draftText}>
            You have unsaved changes to this file on this phone.
          </Text>
          <ActionButton label="Continue editing" onPress={edit} />
        </View>
      ) : null}
      {!thread ? (
        <StateView
          title="Chat not loaded"
          message="Open the chat again to browse its files."
          actionLabel="Back"
          onAction={() => router.back()}
        />
      ) : loading ? (
        <StateView
          loading
          title="Loading file"
          message="Reading it from the desktop."
        />
      ) : error ? (
        <StateView title="File not readable" message={error} />
      ) : binary ? (
        <StateView
          title="Not a text file"
          message="This file is binary, so it is not shown here. Open it on the desktop."
        />
      ) : (
        <FlatList
          ref={listRef}
          data={lines}
          keyExtractor={(_, index) => String(index)}
          initialNumToRender={40}
          windowSize={15}
          // Lines have no fixed height (they wrap): jump near the line by
          // the average height, then to the line once it is rendered.
          onScrollToIndexFailed={(info) => {
            listRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: false,
            })
            setTimeout(() => {
              listRef.current?.scrollToIndex({
                index: info.index,
                viewPosition: 0.3,
                animated: false,
              })
            }, 50)
          }}
          renderItem={({ item, index }) => (
            <View
              style={[
                styles.line,
                index === targetLine - 1 && styles.targetLine,
              ]}
              testID={index === targetLine - 1 ? "file-target-line" : undefined}
            >
              <Text style={styles.number}>{index + 1}</Text>
              <Text
                selectable
                style={styles.code}
                numberOfLines={wrap ? undefined : 1}
              >
                {item || " "}
              </Text>
            </View>
          )}
          contentContainerStyle={styles.codeList}
        />
      )}
    </Screen>
  )
}

function fileName(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop() || value
}

function extension(value: string): string {
  const match = value.match(/\.([^.]+)$/)
  return match?.[1] ?? ""
}

function safeRelative(root: string, value: string): string {
  try {
    return relativePathWithinRoot(root, value)
  } catch {
    return ""
  }
}

const styles = StyleSheet.create({
  draft: {
    margin: spacing.sm,
    padding: spacing.sm,
    gap: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.45)",
    backgroundColor: colors.surface,
  },
  draftText: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  targetLine: { backgroundColor: "rgba(251,191,36,0.14)" },
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
    minHeight: 38,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  path: {
    flex: 1,
    color: colors.textMuted,
    fontFamily: type.mono,
    fontSize: type.micro,
  },
  lineCount: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  codeList: { paddingVertical: spacing.sm },
  line: {
    minHeight: 21,
    flexDirection: "row",
    alignItems: "flex-start",
    paddingRight: spacing.sm,
  },
  number: {
    width: 52,
    paddingRight: spacing.sm,
    color: colors.textMuted,
    fontFamily: type.mono,
    fontSize: 12,
    lineHeight: 21,
    textAlign: "right",
    backgroundColor: colors.surface,
  },
  code: {
    flex: 1,
    paddingLeft: spacing.sm,
    color: "#CFD8D2",
    fontFamily: type.mono,
    fontSize: 13,
    lineHeight: 21,
  },
})
