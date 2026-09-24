import { Pressable, ScrollView, StyleSheet, Text } from "react-native"
import { colors, font, minTouchTarget, radius, spacing } from "@/design/theme"
import type { TerminalKey } from "@/terminal/page-protocol"

type KeyAction =
  | { readonly key: TerminalKey }
  | { readonly text: string }
  | { readonly modifier: "ctrl" | "alt" }

const KEYS: ReadonlyArray<
  {
    readonly id: string
    readonly label: string
    readonly name: string
  } & KeyAction
> = [
  { id: "escape", label: "Esc", name: "Escape", key: "escape" },
  { id: "tab", label: "Tab", name: "Tab", key: "tab" },
  {
    id: "ctrl",
    label: "Ctrl",
    name: "Control, for the next key",
    modifier: "ctrl",
  },
  { id: "alt", label: "Alt", name: "Alt, for the next key", modifier: "alt" },
  { id: "left", label: "←", name: "Left", key: "left" },
  { id: "up", label: "↑", name: "Up", key: "up" },
  { id: "down", label: "↓", name: "Down", key: "down" },
  { id: "right", label: "→", name: "Right", key: "right" },
  { id: "home", label: "Home", name: "Home", key: "home" },
  { id: "end", label: "End", name: "End", key: "end" },
  { id: "pageUp", label: "PgUp", name: "Page up", key: "pageUp" },
  { id: "pageDown", label: "PgDn", name: "Page down", key: "pageDown" },
  { id: "pipe", label: "|", name: "Pipe", text: "|" },
  { id: "tilde", label: "~", name: "Tilde", text: "~" },
  { id: "slash", label: "/", name: "Slash", text: "/" },
  { id: "dash", label: "-", name: "Dash", text: "-" },
]

/**
 * The keys a phone's keyboard lacks, above it: Esc, Tab, arrows, Home,
 * End, the page keys and a few symbols, and Ctrl and Alt, which stay down
 * for the next key.
 */
export function TerminalKeys({
  ctrl,
  alt,
  onKey,
  onText,
  onModifier,
}: {
  ctrl: boolean
  alt: boolean
  onKey: (key: TerminalKey) => void
  onText: (text: string) => void
  onModifier: (modifier: "ctrl" | "alt") => void
}) {
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={styles.bar}
      contentContainerStyle={styles.keys}
      testID="terminal-keys"
    >
      {KEYS.map((entry) => {
        const held =
          "modifier" in entry && (entry.modifier === "ctrl" ? ctrl : alt)
        return (
          <Pressable
            key={entry.id}
            accessibilityRole="button"
            accessibilityLabel={entry.name}
            accessibilityState={
              "modifier" in entry ? { selected: held } : undefined
            }
            testID={`terminal-key-${entry.id}`}
            onPress={() => {
              if ("modifier" in entry) onModifier(entry.modifier)
              else if ("key" in entry) onKey(entry.key)
              else onText(entry.text)
            }}
            style={({ pressed }) => [
              styles.key,
              held && styles.held,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.label, held && styles.heldLabel]}>
              {entry.label}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexGrow: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  keys: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xxs,
    gap: spacing.xxs,
  },
  key: {
    minWidth: minTouchTarget,
    height: minTouchTarget,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceActive,
  },
  held: { backgroundColor: colors.primary },
  pressed: { opacity: 0.72 },
  label: { color: colors.text, fontFamily: font.semibold, fontSize: 14 },
  heldLabel: { color: colors.primaryForeground },
})
