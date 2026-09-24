import type { ComponentType } from "react"
import { Pressable, StyleSheet, type ViewStyle } from "react-native"
import type { LucideProps } from "lucide-react-native"
import { colors, minTouchTarget, radius } from "@/design/theme"

/**
 * Ghost icon button in the desktop header style: no border or fill at rest,
 * a quiet secondary fill while pressed. `primary` renders the filled
 * near-white variant (desktop primary button) for emphasized actions.
 */
export function IconButton({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  tone = "default",
  style,
  testID,
}: {
  icon: ComponentType<LucideProps>
  label: string
  onPress: () => void
  disabled?: boolean
  tone?: "default" | "primary" | "mint" | "danger"
  style?: ViewStyle
  testID?: string
}) {
  const filled = tone === "primary" || tone === "mint"
  const iconColor = filled
    ? colors.primaryForeground
    : tone === "danger"
      ? colors.danger
      : colors.textSecondary
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        filled && styles.primary,
        pressed && (filled ? styles.pressedFilled : styles.pressedGhost),
        disabled && styles.disabled,
        style,
      ]}
    >
      <Icon size={19} strokeWidth={2} color={iconColor} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    width: minTouchTarget,
    height: minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  primary: { backgroundColor: colors.primary },
  pressedGhost: { backgroundColor: colors.surfaceActive },
  pressedFilled: { opacity: 0.8, transform: [{ scale: 0.97 }] },
  disabled: { opacity: 0.4 },
})
