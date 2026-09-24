import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Alert, Modal, StyleSheet, Text, View } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { SafeAreaView } from "react-native-safe-area-context"
import { ArrowLeft, Redo2, Save, Undo2, WrapText, X } from "lucide-react-native"
import { parseGitDiff } from "@betterc0de/schema/git-diff"
import { REMOTE_FEATURES } from "@betterc0de/schema/remote-protocol"
import { ActionButton } from "@/components/action-button"
import { CodeEditor, type CodeEditorHandle } from "@/components/code-editor"
import { DiffView } from "@/components/diff-view"
import { IconButton } from "@/components/icon-button"
import { Screen, StateView } from "@/components/layout"
import { colors, font, radius, spacing, type } from "@/design/theme"
import {
  editorLanguageFor,
  MAX_EDITABLE_BYTES,
  type EditorEvent,
} from "@/editor/protocol"
import { clearDraft, draftFor, saveDraft } from "@/lib/editor-drafts"
import { effectiveThreadRoot, relativePathWithinRoot } from "@/lib/endpoint"
import { formatShortDateTime } from "@/lib/format"
import { unifiedFileDiff } from "@/lib/line-diff"
import { describeRemoteError, remoteErrorMessage } from "@/lib/remote-errors"
import { useAppStore } from "@/store/app-store"
import { RemoteApiError } from "@/transport/live/http"
import {
  useFeature,
  useReadOnly,
  useRemoteApi,
} from "@/transport/use-transport"

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ""
}

function fileName(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop() || value
}

/** Seconds after the last change before the draft is written. */
const DRAFT_DELAY_MS = 1_000

const isConflict = (error: unknown) =>
  error instanceof RemoteApiError &&
  error.status === 409 &&
  error.code === "WORKSPACE_PATH_CHANGED"

interface Opened {
  /** The text the editor starts with: the file, or a restored draft. */
  text: string
  /** The SHA-256 of the desktop's file the edits are made on. */
  baseSha256: string
  /** Opened with a draft's changes, which the editor cannot know. */
  restored: boolean
}

// `opened` changes only when a text is to be loaded into the editor (a file
// opened, or the desktop's version taken): the editor loads it again then.

interface Conflict {
  theirs: string
  theirsSha256: string
  mine: string
}

/**
 * Editing a file of the chat's project. Saving sends the SHA-256 of the
 * file the edits were made on, so the desktop refuses when the file changed
 * there meanwhile; the phone then offers to compare, to take the desktop's
 * version or to overwrite it. Unsaved edits are kept on the phone as a
 * draft (src/lib/editor-drafts.ts).
 */
export default function EditScreen() {
  const params = useLocalSearchParams<{
    id: string | string[]
    path: string | string[]
    line?: string | string[]
  }>()
  const threadId = firstParam(params.id)
  const absolutePath = firstParam(params.path)
  const line = Number(firstParam(params.line)) || undefined
  const router = useRouter()
  const api = useRemoteApi()
  const readOnly = useReadOnly()
  const canSaveSafely = useFeature(REMOTE_FEATURES.workspaceWriteIfMatch)
  const thread = useAppStore((state) =>
    state.threads.find((item) => item.id === threadId)
  )
  const root = thread ? effectiveThreadRoot(thread) : ""
  const relative = useMemo(() => {
    try {
      return root && absolutePath
        ? relativePathWithinRoot(root, absolutePath)
        : ""
    } catch {
      return ""
    }
  }, [absolutePath, root])
  const name = fileName(absolutePath)

  const editor = useRef<CodeEditorHandle>(null)
  const [opened, setOpened] = useState<Opened | null>(null)
  /** Unsaved changes from a draft, until they are saved or replaced. */
  const [restored, setRestored] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const [wrap, setWrap] = useState(true)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [comparing, setComparing] = useState(false)
  const baseSha256 = useRef("")
  /** Read when the text is loaded; a change is sent on its own (setWrap). */
  const wrapRef = useRef(wrap)
  wrapRef.current = wrap
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unsaved = dirty || restored

  // Open the file, or say why it cannot be edited here.
  useEffect(() => {
    if (!api || !root || !relative) return
    if (readOnly) {
      setProblem("This phone can only watch, so it cannot change files.")
      return
    }
    if (!canSaveSafely) {
      setProblem(
        "Update the desktop to edit files from the phone: this desktop cannot tell when a file changed before a save."
      )
      return
    }
    let active = true
    void api
      .readFile(root, absolutePath)
      .then((file) => {
        if (!active) return
        const size = file.size ?? new TextEncoder().encode(file.content).length
        if (file.isUtf8 === false) {
          setProblem("This file is binary; it is not edited as text.")
          return
        }
        if (size > MAX_EDITABLE_BYTES) {
          setProblem(
            "This file is larger than 1 MB, too large to edit on the phone. Edit it on the desktop."
          )
          return
        }
        if (!file.sha256) {
          setProblem(
            "The desktop did not say which version of the file this is, so a save could overwrite changes."
          )
          return
        }
        const sha256 = file.sha256
        const open = (next: Opened) => {
          baseSha256.current = next.baseSha256
          setRestored(next.restored)
          setOpened(next)
        }
        const draft = draftFor(root, relative)
        if (!draft || draft.text === file.content) {
          if (draft) clearDraft(root, relative)
          open({ text: file.content, baseSha256: sha256, restored: false })
          return
        }
        Alert.alert(
          "Unsaved changes",
          `You changed this file on this phone (${formatShortDateTime(draft.savedAt)}) and did not save it. Continue with those changes?`,
          [
            {
              text: "Discard",
              style: "destructive",
              onPress: () => {
                clearDraft(root, relative)
                open({
                  text: file.content,
                  baseSha256: sha256,
                  restored: false,
                })
              },
            },
            {
              text: "Continue",
              onPress: () =>
                open({
                  text: draft.text,
                  baseSha256: draft.baseSha256,
                  restored: true,
                }),
            },
          ]
        )
      })
      .catch((caught: unknown) => {
        if (active) setProblem(remoteErrorMessage(caught))
      })
    return () => {
      active = false
    }
  }, [absolutePath, api, canSaveSafely, readOnly, relative, root])

  // Hand the text to the editor once both are there.
  useEffect(() => {
    if (!ready || !opened) return
    editor.current?.send({
      type: "load",
      text: opened.text,
      language: editorLanguageFor(name),
      readOnly: false,
      wrap: wrapRef.current,
      ...(line ? { line } : {}),
    })
  }, [line, name, opened, ready])

  useEffect(() => {
    if (ready) editor.current?.send({ type: "setWrap", wrap })
  }, [ready, wrap])

  const writeDraft = useCallback(async () => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current)
      draftTimer.current = null
    }
    const text = await editor.current?.text()
    if (text === undefined) return
    saveDraft({
      root,
      path: relative,
      text,
      baseSha256: baseSha256.current,
      savedAt: new Date().toISOString(),
    })
  }, [relative, root])

  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current)
    },
    []
  )

  const onEvent = useCallback(
    (event: Exclude<EditorEvent, { type: "text" }>) => {
      if (event.type === "ready") setReady(true)
      else if (event.type === "error") {
        Alert.alert("Editor problem", event.message)
      } else {
        setDirty(event.dirty)
        setHistory({ canUndo: event.canUndo, canRedo: event.canRedo })
        if (event.dirty) {
          if (draftTimer.current) clearTimeout(draftTimer.current)
          draftTimer.current = setTimeout(() => {
            void writeDraft().catch(() => undefined)
          }, DRAFT_DELAY_MS)
        }
      }
    },
    [writeDraft]
  )

  /** Saved: the desktop's file is now the phone's, and the draft is done. */
  const saved = async () => {
    const fresh = await api!.readFile(root, absolutePath)
    baseSha256.current = fresh.sha256 ?? baseSha256.current
    setRestored(false)
    editor.current?.send({ type: "markSaved" })
    clearDraft(root, relative)
  }

  const write = async (text: string, expectedSha256: string) => {
    try {
      await api!.writeFile(root, relative, text, expectedSha256)
      setConflict(null)
      await saved()
    } catch (caught) {
      if (!isConflict(caught)) throw caught
      const theirs = await api!.readFile(root, absolutePath)
      setConflict({
        theirs: theirs.content,
        theirsSha256: theirs.sha256 ?? "",
        mine: text,
      })
    }
  }

  const save = async () => {
    if (!api || saving) return
    setSaving(true)
    try {
      const text = await editor.current!.text()
      await write(text, baseSha256.current)
    } catch (caught) {
      const described = describeRemoteError(caught)
      Alert.alert(described.title, described.message)
    } finally {
      setSaving(false)
    }
  }

  const overwrite = async () => {
    if (!conflict || saving) return
    setSaving(true)
    try {
      await write(conflict.mine, conflict.theirsSha256)
    } catch (caught) {
      const described = describeRemoteError(caught)
      Alert.alert(described.title, described.message)
    } finally {
      setSaving(false)
    }
  }

  const takeTheirs = () => {
    if (!conflict) return
    clearDraft(root, relative)
    setConflict(null)
    setDirty(false)
    setRestored(false)
    setOpened({
      text: conflict.theirs,
      baseSha256: conflict.theirsSha256,
      restored: false,
    })
    baseSha256.current = conflict.theirsSha256
  }

  const leave = async () => {
    // A leave keeps the edits as a draft; nothing is lost.
    if (unsaved) await writeDraft().catch(() => undefined)
    router.back()
  }

  const comparison = useMemo(() => {
    if (!conflict) return null
    return (
      parseGitDiff(
        unifiedFileDiff(relative, conflict.theirs, conflict.mine)
      )[0] ?? null
    )
  }, [conflict, relative])

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton
          icon={ArrowLeft}
          label="Back"
          onPress={() => void leave()}
        />
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>
            EDITING{unsaved ? " · UNSAVED" : ""}
          </Text>
          <Text style={styles.title} numberOfLines={1}>
            {name || "File"}
          </Text>
        </View>
      </View>
      {problem ? (
        <StateView title="Not editable here" message={problem} />
      ) : !opened ? (
        <StateView loading title="Opening the file" message={relative} />
      ) : (
        <>
          <View style={styles.toolbar}>
            <IconButton
              icon={Undo2}
              label="Undo"
              disabled={!history.canUndo}
              testID="editor-undo"
              onPress={() => editor.current?.send({ type: "undo" })}
            />
            <IconButton
              icon={Redo2}
              label="Redo"
              disabled={!history.canRedo}
              testID="editor-redo"
              onPress={() => editor.current?.send({ type: "redo" })}
            />
            <IconButton
              icon={WrapText}
              label={wrap ? "Do not wrap lines" : "Wrap lines"}
              tone={wrap ? "mint" : "default"}
              onPress={() => setWrap(!wrap)}
            />
            <ActionButton
              label="Save"
              icon={Save}
              tone="primary"
              busy={saving}
              disabled={!unsaved || conflict !== null}
              testID="editor-save"
              onPress={() => void save()}
              style={styles.save}
            />
          </View>
          {conflict ? (
            <View style={styles.conflict} testID="editor-conflict">
              <Text style={styles.conflictTitle}>Changed on the desktop</Text>
              <Text style={styles.conflictText}>
                This file changed on the desktop since you opened it. Your
                changes are still here.
              </Text>
              <View style={styles.conflictActions}>
                <ActionButton
                  label="Compare"
                  testID="editor-compare"
                  onPress={() => setComparing(true)}
                />
                <ActionButton
                  label="Take desktop's"
                  tone="danger"
                  testID="editor-take-theirs"
                  onPress={takeTheirs}
                />
                <ActionButton
                  label="Overwrite"
                  tone="danger"
                  busy={saving}
                  testID="editor-overwrite"
                  onPress={() => void overwrite()}
                />
              </View>
            </View>
          ) : null}
          <CodeEditor ref={editor} onEvent={onEvent} />
        </>
      )}
      <Modal
        visible={comparing && comparison !== null}
        animationType="slide"
        onRequestClose={() => setComparing(false)}
      >
        <SafeAreaView style={styles.compare} edges={["top", "bottom"]}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>DESKTOP → YOURS</Text>
              <Text style={styles.title} numberOfLines={1}>
                {name}
              </Text>
            </View>
            <IconButton
              icon={X}
              label="Close"
              testID="editor-compare-close"
              onPress={() => setComparing(false)}
            />
          </View>
          {comparison ? (
            <DiffView
              testID="editor-comparison"
              lines={comparison.lines}
              hunks={comparison.hunks}
            />
          ) : null}
        </SafeAreaView>
      </Modal>
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
  toolbar: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xxs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  save: { marginLeft: "auto" },
  conflict: {
    margin: spacing.sm,
    padding: spacing.sm,
    gap: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.45)",
    backgroundColor: colors.surface,
  },
  conflictTitle: {
    color: colors.warning,
    fontFamily: font.bold,
    fontSize: type.small,
  },
  conflictText: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  conflictActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  compare: { flex: 1, backgroundColor: colors.canvas },
})
