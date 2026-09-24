import { useMemo, useRef, useState } from "react"
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import {
  ArrowUp,
  Brain,
  ChevronDown,
  Square,
  Zap,
  ZapOff,
} from "lucide-react-native"
import type { ModelOption } from "@/types/remote"
import { colors, font, radius, spacing, type } from "@/design/theme"
import {
  supportsFastMode,
  thinkingLabelFor,
  thinkingOptionsFor,
} from "@/lib/model-capabilities"
import { DropdownRow, DropdownSheet } from "./dropdown-sheet"
import { ProviderLogo } from "./provider-logo"

/**
 * Composer, ported from the desktop AI-Elements PromptInput: one rounded
 * card with the multiline input on top and a footer of pill controls exactly
 * like the desktop minimal footer — Model, Thinking and Fast Mode dropdowns
 * on the left, circular primary send (ArrowUp) on the right. Thinking levels
 * and the Fast toggle mirror the desktop capability rules per provider/model.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  onChooseModel,
  model,
  running,
  disabled,
  thinkingMode,
  onThinkingModeChange,
  fastMode,
  onFastModeChange,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onChooseModel: () => void
  model: ModelOption | null
  running: boolean
  disabled: boolean
  thinkingMode: string | null
  onThinkingModeChange: (mode: string | null) => void
  fastMode: boolean
  onFastModeChange: (fastMode: boolean) => void
}) {
  const inputRef = useRef<TextInput>(null)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [fastOpen, setFastOpen] = useState(false)
  const goalCommand = /^\/goal(?:\s|$)/i.test(value.trim())
  const showStop = running && !goalCommand
  const canSend =
    value.trim().length > 0 &&
    !disabled &&
    (!running || goalCommand) &&
    Boolean(model)
  const thinkingOptions = useMemo(() => thinkingOptionsFor(model), [model])
  const thinkingLabel = thinkingLabelFor(thinkingOptions, thinkingMode)
  const showThinking = thinkingOptions.length > 0
  const showFast = supportsFastMode(model)
  const isClaude = (model?.providerKind ?? "").toLowerCase().includes("claude")

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.shell}>
        <View style={styles.card}>
          <TextInput
            ref={inputRef}
            accessibilityLabel="Message"
            value={value}
            onChangeText={onChange}
            placeholder="Message the desktop agent…"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            multiline
            maxLength={100_000}
            editable={!disabled}
            textAlignVertical="top"
          />
          <View style={styles.footer}>
            <View style={styles.pills}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Choose provider and model"
                onPress={onChooseModel}
                style={({ pressed }) => [
                  styles.pill,
                  pressed && styles.pressed,
                ]}
              >
                {model ? (
                  <ProviderLogo kind={model.providerKind} size={13} />
                ) : null}
                <Text style={styles.pillText} numberOfLines={1}>
                  {model ? model.modelLabel : "Select model"}
                </Text>
                <ChevronDown size={13} color={colors.textMuted} />
              </Pressable>
              {showThinking ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Thinking: ${thinkingLabel}`}
                  onPress={() => setThinkingOpen(true)}
                  style={({ pressed }) => [
                    styles.pill,
                    pressed && styles.pressed,
                  ]}
                >
                  <Brain
                    size={13}
                    color={thinkingMode ? colors.text : colors.textSecondary}
                  />
                  <Text style={styles.pillText} numberOfLines={1}>
                    {thinkingLabel}
                  </Text>
                </Pressable>
              ) : null}
              {showFast ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    fastMode ? "Fast Mode: on" : "Fast Mode: off"
                  }
                  onPress={() => setFastOpen(true)}
                  style={({ pressed }) => [
                    styles.pill,
                    pressed && styles.pressed,
                  ]}
                >
                  <Zap
                    size={13}
                    color={fastMode ? colors.warning : colors.textSecondary}
                    fill={fastMode ? colors.warning : "none"}
                  />
                  <Text
                    style={[styles.pillText, fastMode && styles.pillTextFast]}
                    numberOfLines={1}
                  >
                    {fastMode ? "Fast" : "Off"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={showStop ? "Stop response" : "Send message"}
              accessibilityState={{ disabled: showStop ? false : !canSend }}
              disabled={showStop ? false : !canSend}
              onPress={showStop ? onStop : onSend}
              style={({ pressed }) => [
                styles.send,
                pressed && styles.pressed,
                !showStop && !canSend && styles.disabled,
              ]}
            >
              {showStop ? (
                <Square
                  size={14}
                  fill={colors.primaryForeground}
                  color={colors.primaryForeground}
                />
              ) : (
                <ArrowUp size={18} color={colors.primaryForeground} />
              )}
            </Pressable>
          </View>
        </View>
      </View>

      {/* Thinking dropdown — desktop's Brain menu, one row per effort level. */}
      <DropdownSheet
        visible={thinkingOpen}
        onClose={() => setThinkingOpen(false)}
        title="Thinking"
      >
        {thinkingOptions.map((option) => (
          <DropdownRow
            key={option.mode ?? "off"}
            icon={
              <Brain
                size={15}
                color={
                  option.mode === null ? colors.textMuted : colors.textSecondary
                }
              />
            }
            label={option.label}
            active={
              option.mode === null
                ? thinkingMode === null
                : normalize(option.mode) === normalize(thinkingMode)
            }
            onPress={() => {
              onThinkingModeChange(option.mode)
              setThinkingOpen(false)
            }}
          />
        ))}
      </DropdownSheet>

      {/* Fast Mode dropdown — desktop's Zap menu with explanation rows. */}
      <DropdownSheet
        visible={fastOpen}
        onClose={() => setFastOpen(false)}
        title="Fast Mode"
      >
        <DropdownRow
          icon={<Zap size={15} color={colors.warning} fill={colors.warning} />}
          label="Fast Mode: On"
          sublabel={
            isClaude
              ? "Sets settings.fastMode in the Claude Agent SDK (priority compute)."
              : 'Routes via OpenAI serviceTier "fast" (priority compute).'
          }
          active={fastMode}
          onPress={() => {
            onFastModeChange(true)
            setFastOpen(false)
          }}
        />
        <DropdownRow
          icon={<ZapOff size={15} color={colors.textMuted} />}
          label="Fast Mode: Off"
          sublabel="Default routing."
          active={!fastMode}
          onPress={() => {
            onFastModeChange(false)
            setFastOpen(false)
          }}
        />
      </DropdownSheet>
    </KeyboardAvoidingView>
  )
}

function normalize(value: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
}

const styles = StyleSheet.create({
  shell: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: Platform.OS === "android" ? spacing.sm : spacing.xs,
    backgroundColor: colors.canvas,
  },
  card: {
    borderRadius: radius.xxl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
    gap: spacing.xxs,
  },
  input: {
    minHeight: 44,
    maxHeight: 150,
    paddingHorizontal: spacing.xxs,
    paddingTop: 8,
    paddingBottom: 4,
    color: colors.text,
    fontFamily: font.regular,
    fontSize: type.body,
    lineHeight: 22,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.xs,
  },
  pills: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  pill: {
    flexShrink: 1,
    minHeight: 30,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.pill,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  pillText: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontFamily: font.medium,
    fontSize: 11,
  },
  pillTextFast: { color: colors.warning },
  send: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
})
