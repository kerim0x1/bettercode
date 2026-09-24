import { useEffect, useState } from "react"
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { colors, font, radius, spacing, type } from "@/design/theme"

/** Renaming a chat: its title, edited in place, saved on the desktop. */
export function RenameSheet({
  visible,
  title,
  onCancel,
  onSave,
}: {
  visible: boolean
  title: string
  onCancel: () => void
  /** Resolves once the desktop has the new title. */
  onSave: (title: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (visible) setDraft(title)
  }, [title, visible])
  const next = draft.trim()
  const canSave = next.length > 0 && next !== title.trim() && !saving

  const save = async () => {
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
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.wrap}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.backdrop}
          onPress={onCancel}
        />
        <View style={styles.card}>
          <Text style={styles.heading}>Rename chat</Text>
          <TextInput
            testID="rename-input"
            accessibilityLabel="Chat title"
            value={draft}
            onChangeText={setDraft}
            autoFocus
            selectTextOnFocus
            maxLength={1_024}
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            style={styles.input}
            placeholderTextColor={colors.textMuted}
          />
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
              <Text style={[styles.buttonText, styles.primaryText]}>Save</Text>
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
