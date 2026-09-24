import type { ComponentType } from "react"
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type ViewStyle,
} from "react-native"
import type { LucideProps } from "lucide-react-native"
import {
  colors,
  font,
  minTouchTarget,
  radius,
  spacing,
  type,
} from "@/design/theme"

/**
 * A labelled button in the desktop's styles: `primary` is the filled
 * near-white button, `secondary` the bordered one, `danger` a bordered
 * button in the destructive colour. `busy` shows a spinner in its place.
 */
export function ActionButton({
  label,
  icon: Icon,
  onPress,
  tone = "secondary",
  disabled = false,
  busy = false,
  accessibilityLabel,
  testID,
  style,
}: {
  label: string
  icon?: ComponentType<LucideProps>
  onPress: () => void
  tone?: "primary" | "secondary" | "danger"
  disabled?: boolean
  busy?: boolean
  accessibilityLabel?: string
  testID?: string
  style?: ViewStyle
}) {
  const foreground =
    tone === "primary"
      ? colors.primaryForeground
      : tone === "danger"
        ? colors.danger
        : colors.text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      testID={testID}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        tone === "primary" && styles.primary,
        tone === "danger" && styles.danger,
        pressed && styles.pressed,
        (disabled || busy) && styles.disabled,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : Icon ? (
        <Icon size={16} strokeWidth={2} color={foreground} />
      ) : null}
      <Text style={[styles.label, { color: foreground }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  primary: { backgroundColor: colors.primary, borderColor: colors.primary },
  danger: { borderColor: "rgba(248,113,113,0.45)" },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
  label: { fontFamily: font.semibold, fontSize: type.small },
})
