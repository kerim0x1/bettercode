import { useCallback, useState } from "react"
import { Alert, StyleSheet, Text, View } from "react-native"
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router"
import {
  ArrowLeft,
  Check,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  X,
} from "lucide-react-native"
import {
  parseGitDiff,
  type DiffHunk,
  type DiffLine,
} from "@betterc0de/schema/git-diff"
import { ActionButton } from "@/components/action-button"
import { DiffView } from "@/components/diff-view"
import { IconButton } from "@/components/icon-button"
import { Screen, StateView } from "@/components/layout"
import { colors, font, spacing, type } from "@/design/theme"
import { pathWithinRoot } from "@/lib/endpoint"
import {
  discardConfirmation,
  discardHunkConfirmation,
  type Confirmation,
} from "@/lib/git-review"
import { describeRemoteError, remoteErrorMessage } from "@/lib/remote-errors"
import { useReadOnly, useRemoteApi } from "@/transport/use-transport"

type Source = "staged" | "unstaged" | "untracked"

interface Review {
  lines: DiffLine[]
  hunks: DiffHunk[]
  additions: number
  deletions: number
  /** Why there is nothing to show, when there is nothing. */
  note: string | null
}

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}

function ask(confirmation: Confirmation, run: () => void) {
  Alert.alert(confirmation.title, confirmation.message, [
    { text: "Cancel", style: "cancel" },
    { text: confirmation.action, style: "destructive", onPress: run },
  ])
}

/** A new file, shown as git shows it: every line added. */
function addedLines(content: string): DiffLine[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines.map((line, index) => ({
    type: "add",
    content: line,
    newNum: index + 1,
  }))
}

/**
 * One file's staged or unstaged diff, hunk by hunk, with the desktop's
 * hunk actions; a new (untracked) file shows its lines as added.
 */
export default function GitDiffScreen() {
  const params = useLocalSearchParams<{
    root?: string | string[]
    path?: string | string[]
    source?: string | string[]
  }>()
  const root = firstParam(params.root)
  const path = firstParam(params.path)
  const requested = firstParam(params.source)
  const source: Source =
    requested === "staged" || requested === "untracked" ? requested : "unstaged"
  const router = useRouter()
  const api = useRemoteApi()
  const readOnly = useReadOnly()
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!api || !root || !path || readOnly) return
    try {
      if (source === "untracked") {
        const file = await api.readFile(root, pathWithinRoot(root, path))
        const binary = file.isUtf8 === false
        const lines = binary ? [] : addedLines(file.content)
        setReview({
          lines,
          hunks: [],
          additions: lines.length,
          deletions: 0,
          note: binary ? "A binary file; there is nothing to show." : null,
        })
      } else {
        const patch = await api.gitDiff(root, source === "staged")
        const file = parseGitDiff(patch.diff).find((item) => item.name === path)
        setReview({
          lines: file?.lines ?? [],
          hunks: file?.hunks ?? [],
          additions: file?.additions ?? 0,
          deletions: file?.deletions ?? 0,
          note: file?.isBinary
            ? "A binary file; there is nothing to show."
            : file
              ? null
              : patch.truncated
                ? "The repository's diff is larger than the desktop sends. Review this file on the desktop."
                : source === "staged"
                  ? "Nothing of this file is staged any more."
                  : "No unstaged changes left in this file.",
        })
      }
      setError(null)
    } catch (caught) {
      setError(remoteErrorMessage(caught))
    }
  }, [api, path, readOnly, root, source])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load])
  )

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy || !api) return
    setBusy(key)
    try {
      await action()
    } catch (caught) {
      const described = describeRemoteError(caught)
      Alert.alert(described.title, described.message)
    } finally {
      setBusy(null)
      await load()
    }
  }

  const hunkAction = (
    hunk: DiffHunk,
    index: number,
    action: "accept" | "reject" | "unstage"
  ) =>
    void run(`hunk:${index}:${action}`, () =>
      api!.gitApplyHunk({
        cwd: root,
        path,
        source: source === "staged" ? "staged" : "unstaged",
        action,
        patch: hunk.patch,
      })
    )

  const header = (
    <View style={styles.fileHeader}>
      <Text style={styles.path} selectable numberOfLines={3}>
        {path}
      </Text>
      <View style={styles.meta}>
        <Text style={styles.sourceLabel}>
          {source === "staged"
            ? "Staged"
            : source === "untracked"
              ? "New file"
              : "Working tree"}
        </Text>
        {review?.additions ? (
          <Text style={styles.add}>+{review.additions}</Text>
        ) : null}
        {review?.deletions ? (
          <Text style={styles.del}>−{review.deletions}</Text>
        ) : null}
      </View>
      {api && !readOnly ? (
        <View style={styles.fileActions}>
          {source === "staged" ? (
            <ActionButton
              label="Unstage file"
              icon={Minus}
              busy={busy === "file"}
              disabled={busy !== null}
              testID="git-diff-unstage-file"
              onPress={() =>
                void run("file", () => api.gitUnstage(root, [path]))
              }
            />
          ) : (
            <ActionButton
              label="Stage file"
              icon={Plus}
              busy={busy === "file"}
              disabled={busy !== null}
              testID="git-diff-stage-file"
              onPress={() => void run("file", () => api.gitStage(root, [path]))}
            />
          )}
          {source === "unstaged" ? (
            <ActionButton
              label="Discard file"
              icon={Undo2}
              tone="danger"
              disabled={busy !== null}
              testID="git-diff-discard-file"
              onPress={() =>
                ask(discardConfirmation(path), () => {
                  void run("discard", () => api.gitDiscard(root, path))
                })
              }
            />
          ) : null}
        </View>
      ) : null}
    </View>
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
          <Text style={styles.eyebrow}>DIFF</Text>
          <Text style={styles.title} numberOfLines={1}>
            {path.split("/").pop() || "File"}
          </Text>
        </View>
        <IconButton
          icon={RefreshCw}
          label="Refresh"
          onPress={() => void load()}
        />
      </View>
      {readOnly ? (
        <StateView
          title="This phone can only watch"
          message="Pair it again over your Wi-Fi, Tailscale or HTTPS to review changes."
        />
      ) : error && !review ? (
        <StateView
          title="Diff unavailable"
          message={error}
          actionLabel="Try again"
          onAction={() => void load()}
        />
      ) : !review ? (
        <StateView loading title="Loading the diff" message={path} />
      ) : (
        <DiffView
          testID="git-diff"
          lines={review.lines}
          hunks={review.hunks}
          header={header}
          empty={
            <Text style={styles.note} testID="git-diff-empty">
              {review.note ?? "The file is empty."}
            </Text>
          }
          renderHunkActions={(hunk, index) =>
            source === "staged" ? (
              <ActionButton
                label="Unstage"
                icon={Undo2}
                busy={busy === `hunk:${index}:unstage`}
                disabled={busy !== null}
                testID={`git-hunk-unstage-${index}`}
                accessibilityLabel={`Unstage change ${index + 1}`}
                onPress={() => hunkAction(hunk, index, "unstage")}
              />
            ) : (
              <>
                <ActionButton
                  label="Stage"
                  icon={Check}
                  busy={busy === `hunk:${index}:accept`}
                  disabled={busy !== null}
                  testID={`git-hunk-stage-${index}`}
                  accessibilityLabel={`Stage change ${index + 1}`}
                  onPress={() => hunkAction(hunk, index, "accept")}
                />
                <ActionButton
                  label="Discard"
                  icon={X}
                  tone="danger"
                  busy={busy === `hunk:${index}:reject`}
                  disabled={busy !== null}
                  testID={`git-hunk-discard-${index}`}
                  accessibilityLabel={`Discard change ${index + 1}`}
                  onPress={() =>
                    ask(discardHunkConfirmation(path), () =>
                      hunkAction(hunk, index, "reject")
                    )
                  }
                />
              </>
            )
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
  sourceLabel: {
    color: colors.text,
    fontFamily: font.semibold,
    fontSize: type.micro,
  },
  add: { color: colors.success, fontFamily: font.bold, fontSize: type.micro },
  del: { color: colors.danger, fontFamily: font.bold, fontSize: type.micro },
  fileActions: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.xxs,
  },
  note: {
    padding: spacing.xl,
    textAlign: "center",
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.small,
  },
})
