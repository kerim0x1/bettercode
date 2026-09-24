import type { ReactNode } from "react"
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Check } from "lucide-react-native"
import { colors, font, radius, spacing } from "@/design/theme"

/**
 * Mobile counterpart of the desktop `SimpleDropdown`: a bottom sheet card in
 * the desktop popover style — dark raised surface, hairline border, slim rows
 * with icon + label + primary check mark. Used for the composer's model,
 * thinking and fast-mode menus.
 */
export function DropdownSheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean
  onClose: () => void
  title?: string
  children: ReactNode
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      {/* A modal is a window of its own, which neither iOS nor Android (edge
          to edge) shrinks for the keyboard: the sheet makes room itself, or
          the keyboard covers a field in it (the model search). Where room is
          short, the sheet shrinks, below the status bar, and its list
          scrolls. */}
      <KeyboardAvoidingView behavior="padding" style={styles.backdropWrap}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          style={styles.backdrop}
          onPress={onClose}
        />
        <SafeAreaView edges={["top", "bottom"]} style={styles.sheetSafe}>
          <View style={styles.sheet}>
            <View style={styles.grabber} />
            {title ? <Text style={styles.title}>{title}</Text> : null}
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  )
}

export function DropdownRow({
  icon,
  label,
  sublabel,
  active = false,
  destructive = false,
  onPress,
  testID,
}: {
  icon?: ReactNode
  label: string
  sublabel?: string
  active?: boolean
  destructive?: boolean
  onPress: () => void
  testID?: string
}) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={{ selected: active }}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        active && styles.rowActive,
        pressed && styles.rowPressed,
      ]}
    >
      {icon ? <View style={styles.rowIcon}>{icon}</View> : null}
      <View style={styles.rowCopy}>
        <Text
          style={[styles.rowLabel, destructive && styles.rowLabelDestructive]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {sublabel ? (
          <Text style={styles.rowSublabel} numberOfLines={2}>
            {sublabel}
          </Text>
        ) : null}
      </View>
      {active ? <Check size={15} color={colors.text} /> : null}
    </Pressable>
  )
}

export function DropdownSectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>
}

const styles = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.overlay,
  },
  sheetSafe: { flexShrink: 1, backgroundColor: colors.transparent },
  sheet: {
    marginHorizontal: spacing.xs,
    marginBottom: spacing.xs,
    maxHeight: 480,
    flexShrink: 1,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  grabber: {
    alignSelf: "center",
    width: 32,
    height: 4,
    borderRadius: 2,
    marginTop: 8,
    marginBottom: 2,
    backgroundColor: colors.borderStrong,
  },
  title: {
    color: colors.textMuted,
    fontFamily: font.semibold,
    fontSize: 11,
    letterSpacing: 0.4,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
  },
  scroll: { flexGrow: 0, flexShrink: 1 },
  scrollContent: {
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  row: {
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  rowActive: { backgroundColor: colors.surfaceActive },
  rowPressed: { backgroundColor: colors.surfaceRaised },
  rowIcon: { width: 18, alignItems: "center" },
  rowCopy: { flex: 1, minWidth: 0 },
  rowLabel: {
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 14,
  },
  rowLabelDestructive: { color: colors.danger },
  rowSublabel: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: 4,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: 4,
    marginHorizontal: spacing.xs,
  },
})
