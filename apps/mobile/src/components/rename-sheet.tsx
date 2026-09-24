import { useEffect, useRef, useState } from "react"
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { colors, font, radius, spacing, type } from "@/design/theme"

/**
 * A name edited in place and saved on the desktop: a chat's title by
 * default, or a file's or folder's name (new or renamed).
 */
export function RenameSheet({
  visible,
  title,
  onCancel,
  onSave,
  heading = "Rename chat",
  label = "Chat title",
  actionLabel = "Save",
  fileName = false,
  problem,
}: {
  visible: boolean
  title: string
  onCancel: () => void
  /** Resolves once the desktop has the new name. */
  onSave: (title: string) => Promise<void>
  heading?: string
  label?: string
  actionLabel?: string
  /** A file or folder name: typed as is, without capitals or corrections. */
  fileName?: boolean
  /** Why the name typed so far cannot be used, if it cannot. */
  problem?: (name: string) => string | null
}) {
  const [draft, setDraft] = useState(title)
  const draftRef = useRef(title)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (visible) {
      draftRef.current = title
      setDraft(title)
    }
  }, [title, visible])
  const next = draft.trim()
  const invalid = next ? (problem?.(next) ?? null) : null
  const canSave =
    next.length > 0 && next !== title.trim() && !invalid && !saving

  const save = async () => {
    // TextInput can deliver its last change before React renders it. Use the
    // value from that event so a quick Save cannot submit an older name.
    const next = draftRef.current.trim()
    const invalid = next ? (problem?.(next) ?? null) : null
    const canSave =
      next.length > 0 && next !== title.trim() && !invalid && !saving
    if (!canSave) return
    setSaving(true)
    try {
      await onSave(next)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      {/* A modal is a window of its own, which Android (edge to edge) does
          not shrink for the keyboard: the sheet makes room itself there too,
          or the keyboard covers Save on a small phone. */}
      <KeyboardAvoidingView behavior="padding" style={styles.wrap}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.backdrop}
          onPress={onCancel}
        />
        <View style={styles.card}>
          <Text style={styles.heading}>{heading}</Text>
          <TextInput
            testID="rename-input"
            accessibilityLabel={label}
            value={draft}
            onChangeText={(text) => {
              draftRef.current = text
              setDraft(text)
            }}
            autoFocus
            selectTextOnFocus
            maxLength={1_024}
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            style={styles.input}
            placeholderTextColor={colors.textMuted}
            autoCapitalize={fileName ? "none" : "sentences"}
            autoCorrect={!fileName}
          />
          {invalid ? (
            <Text style={styles.problem} accessibilityLiveRegion="polite">
              {invalid}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [
                styles.button,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
              testID="rename-save"
              disabled={!canSave}
              onPress={() => void save()}
              style={({ pressed }) => [
                styles.button,
                styles.primary,
                pressed && styles.pressed,
                !canSave && styles.disabled,
              ]}
            >
              <Text style={[styles.buttonText, styles.primaryText]}>
                {actionLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center", padding: spacing.lg },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.overlay,
  },
  card: {
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  heading: { color: colors.text, fontFamily: font.semibold, fontSize: 16 },
  problem: { color: colors.danger, fontFamily: font.regular, fontSize: 13 },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.canvas,
    color: colors.text,
    fontFamily: font.regular,
    fontSize: type.body,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.xs,
  },
  button: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: colors.primary },
  buttonText: { color: colors.text, fontFamily: font.semibold, fontSize: 14 },
  primaryText: { color: colors.primaryForeground },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.4 },
})
