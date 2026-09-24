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
import { sha256Hex } from "@/lib/sha256"
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
  /**
   * Unsaved changes the editor started with (a draft's, or the newest text
   * after its page restarted), until they are saved or replaced.
   */
  const [restored, setRestored] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /** How often the editor's page said it is ready: again when it restarted. */
  const [pageStarts, setPageStarts] = useState(0)
  const pageStartsRef = useRef(0)
  const [dirty, setDirty] = useState(false)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const [wrap, setWrap] = useState(true)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [comparing, setComparing] = useState(false)
  const baseSha256 = useRef("")
  /**
   * The newest text the phone has of the file (opened, drafted or saved),
   * which goes back into the editor when its page restarts. `asked` orders
   * the page's answers: a slow one does not replace a newer text.
   */
  const latest = useRef({ asked: 0, text: "" })
  const asks = useRef(0)
  /** The desktop's text as the phone knows it; null for a draft's base. */
  const desktopText = useRef<string | null>(null)
  /** Read when the text is loaded; a change is sent on its own (setWrap). */
  const wrapRef = useRef(wrap)
  wrapRef.current = wrap
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unsaved = dirty || restored

  /** Puts a text into the editor: the file, a draft, or the desktop's. */
  const show = useCallback((next: Opened) => {
    baseSha256.current = next.baseSha256
    asks.current += 1
    latest.current = { asked: asks.current, text: next.text }
    desktopText.current = next.restored ? null : next.text
    setRestored(next.restored)
    setOpened(next)
  }, [])

  /** The editor's text now, kept as the newest the phone has. */
  const editorText = useCallback(async () => {
    const handle = editor.current
    if (!handle) throw new Error("The editor is not open.")
    asks.current += 1
    const asked = asks.current
    const text = await handle.text()
    if (asked > latest.current.asked) latest.current = { asked, text }
    return text
  }, [])

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
        const draft = draftFor(root, relative)
        if (!draft || draft.text === file.content) {
          if (draft) clearDraft(root, relative)
          show({ text: file.content, baseSha256: sha256, restored: false })
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
                show({
                  text: file.content,
                  baseSha256: sha256,
                  restored: false,
                })
              },
            },
            {
              text: "Continue",
              onPress: () =>
                show({
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
  }, [absolutePath, api, canSaveSafely, readOnly, relative, root, show])

  // Hand the text to the editor once both are there, and again when its
  // page restarted: the newest text the phone has.
  useEffect(() => {
    if (!pageStarts || !opened) return
    editor.current?.send({
      type: "load",
      text: latest.current.text,
      language: editorLanguageFor(name),
      readOnly: false,
      wrap: wrapRef.current,
      ...(line ? { line } : {}),
    })
  }, [line, name, opened, pageStarts])

  // A restarted page gets the wrapping with its text (above).
  const pageReady = pageStarts > 0
  useEffect(() => {
    if (pageReady) editor.current?.send({ type: "setWrap", wrap })
  }, [pageReady, wrap])

  const writeDraft = useCallback(async () => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current)
      draftTimer.current = null
    }
    const text = await editorText()
    saveDraft({
      root,
      path: relative,
      text,
      baseSha256: baseSha256.current,
      savedAt: new Date().toISOString(),
    })
  }, [editorText, relative, root])

  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current)
    },
    []
  )

  const onEvent = useCallback(
    (event: Exclude<EditorEvent, { type: "text" }>) => {
      if (event.type === "ready") {
        // Ready again: the page restarted and lost its text. The newest
        // text the phone has goes back in (above), unsaved unless it is
        // the desktop's.
        if (pageStartsRef.current > 0 && latest.current.asked > 0) {
          setRestored(latest.current.text !== desktopText.current)
        }
        pageStartsRef.current += 1
        setPageStarts(pageStartsRef.current)
      } else if (event.type === "error") {
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

  /**
   * Saved: the desktop has `text` now, and the draft is done. The next save
   * is made over the text's own hash, not over the file read again: that
   * could be a change made on the desktop since, which the next save would
   * then overwrite.
   */
  const saved = (text: string, sha256 = sha256Hex(text)) => {
    baseSha256.current = sha256
    desktopText.current = text
    setConflict(null)
    setRestored(false)
    editor.current?.send({ type: "markSaved", text })
    clearDraft(root, relative)
  }

  const write = async (text: string, expectedSha256: string) => {
    try {
      await api!.writeFile(root, relative, text, expectedSha256)
      saved(text)
    } catch (caught) {
      if (!isConflict(caught)) throw caught
      const theirs = await api!.readFile(root, absolutePath)
      // The desktop's file changed to this very text: nothing to choose.
      if (theirs.content === text && theirs.sha256) {
        saved(text, theirs.sha256)
        return
      }
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
      const text = await editorText()
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
    show({
      text: conflict.theirs,
      baseSha256: conflict.theirsSha256,
      restored: false,
    })
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
