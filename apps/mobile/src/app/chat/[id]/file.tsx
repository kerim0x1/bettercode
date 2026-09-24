import { useEffect, useMemo, useState } from "react"
import { FlatList, StyleSheet, Text, View } from "react-native"
import { Redirect, useLocalSearchParams, useRouter } from "expo-router"
import { ArrowLeft, WrapText } from "lucide-react-native"
import { Screen, StateView } from "@/components/layout"
import { IconButton } from "@/components/icon-button"
import { colors, font, spacing, type } from "@/design/theme"
import { effectiveThreadRoot, relativePathWithinRoot } from "@/lib/endpoint"
import { remoteApi } from "@/lib/remote-api"
import { useAppStore } from "@/store/app-store"
import { useSessionStore } from "@/store/session-store"

export default function FileScreen() {
  const params = useLocalSearchParams<{
    id: string | string[]
    path: string | string[]
  }>()
  const threadId = Array.isArray(params.id) ? params.id[0] : params.id
  const absolutePath = Array.isArray(params.path) ? params.path[0] : params.path
  const router = useRouter()
  const profile = useSessionStore((state) => state.profile)
  const thread = useAppStore((state) =>
    state.threads.find((item) => item.id === threadId)
  )
  const root = thread ? effectiveThreadRoot(thread) : ""
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [wrap, setWrap] = useState(true)
  const lines = useMemo(
    () => (content ?? "").replace(/\r\n/g, "\n").split("\n"),
    [content]
  )

  useEffect(() => {
    if (!profile || !root || !absolutePath) return
    setLoading(true)
    setError(null)
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
    void remoteApi(profile)
      .readFile(root, absolutePath)
      .then((result) => {
        if (!cancelled) setContent(result.content)
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : "Failed to read file."
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [absolutePath, profile, root])

  if (!profile) return <Redirect href="/pair" />
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
            {extension(name).toUpperCase() || "TEXT"} · NUR LESEN
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
      </View>
      <View style={styles.pathBar}>
        <Text style={styles.path} numberOfLines={1}>
          /{relative}
        </Text>
        {content !== null ? (
          <Text style={styles.lineCount}>{lines.length} Zeilen</Text>
        ) : null}
      </View>
      {loading ? (
        <StateView
          loading
          title="Loading file"
          message="Inhalt kommt direkt vom Desktop-Workspace."
        />
      ) : error ? (
        <StateView title="File not readable" message={error} />
      ) : (
        <FlatList
          data={lines}
          keyExtractor={(_, index) => String(index)}
          initialNumToRender={40}
          windowSize={15}
          renderItem={({ item, index }) => (
            <View style={styles.line}>
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
