import { useEffect, useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { ArrowLeft } from "lucide-react-native"
import { parseGitDiff, type DiffFile } from "@betterc0de/schema/git-diff"
import { DiffView } from "@/components/diff-view"
import { IconButton } from "@/components/icon-button"
import { Screen, StateView } from "@/components/layout"
import { colors, font, spacing, type } from "@/design/theme"
import { changeItems } from "@/lib/chat-changes"
import { remoteErrorMessage } from "@/lib/remote-errors"
import { useRemoteApi } from "@/transport/use-transport"

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ""
}

/** One file of a turn's or checkpoint's diff, in full. */
export default function ChangeDiffScreen() {
  const params = useLocalSearchParams<{
    id: string | string[]
    item?: string | string[]
    file?: string | string[]
  }>()
  const threadId = firstParam(params.id)
  const itemId = firstParam(params.item)
  const fileName = firstParam(params.file)
  const router = useRouter()
  const api = useRemoteApi()
  const [file, setFile] = useState<DiffFile | null>(null)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api || !threadId) return
    let active = true
    api
      .listDiffs(threadId)
      .then((diffs) => {
        if (!active) return
        const item = changeItems(diffs).find((entry) => entry.id === itemId)
        const found =
          item &&
          parseGitDiff(item.diff).find((entry) => entry.name === fileName)
        setFile(found ?? null)
        setMissing(!found)
        setError(null)
      })
      .catch((caught: unknown) => {
        if (active) setError(remoteErrorMessage(caught))
      })
    return () => {
      active = false
    }
  }, [api, fileName, itemId, threadId])

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton
          icon={ArrowLeft}
          label="Back"
          onPress={() => router.back()}
        />
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>DIFF</Text>
          <Text style={styles.title} numberOfLines={1}>
            {fileName.split("/").pop() || "File"}
          </Text>
        </View>
      </View>
      {error ? (
        <StateView title="Diff unavailable" message={error} />
      ) : missing ? (
        <StateView
          title="Diff not found"
          message="This change is no longer in the chat's history."
        />
      ) : !file ? (
        <StateView loading title="Loading the diff" message={fileName} />
      ) : (
        <DiffView
          testID="change-diff"
          lines={file.lines}
          hunks={file.hunks}
          header={
            <View style={styles.fileHeader}>
              <Text style={styles.path} selectable>
                {fileName}
              </Text>
              <View style={styles.meta}>
                {file.additions ? (
                  <Text style={styles.add}>+{file.additions}</Text>
                ) : null}
                {file.deletions ? (
                  <Text style={styles.del}>−{file.deletions}</Text>
                ) : null}
              </View>
            </View>
          }
          empty={
            <Text style={styles.note}>
              {file.isBinary
                ? "A binary file; there is nothing to show."
                : "No lines changed."}
            </Text>
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
  fileHeader: { padding: spacing.md, gap: spacing.xs },
  path: {
    color: colors.textSecondary,
    fontFamily: type.mono,
    fontSize: type.micro,
  },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  add: { color: colors.success, fontFamily: font.bold, fontSize: type.micro },
  del: { color: colors.danger, fontFamily: font.bold, fontSize: type.micro },
  note: {
    padding: spacing.xl,
    textAlign: "center",
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.small,
  },
})
