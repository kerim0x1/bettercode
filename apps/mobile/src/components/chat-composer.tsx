import { useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import {
  ArrowUp,
  Bot,
  Brain,
  Camera,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  Eye,
  ImagePlus,
  ListPlus,
  MessageCircleQuestion,
  Pencil,
  ShieldOff,
  SlidersHorizontal,
  Square,
  X,
  Zap,
  ZapOff,
  type LucideIcon,
} from "lucide-react-native"
import {
  BYPASS_CONFIRM_ACTION,
  BYPASS_CONFIRM_BODY,
  BYPASS_CONFIRM_TITLE,
  CHAT_MODE_OPTIONS,
  PERMISSION_LEVELS,
  chatModeLabel,
  permissionLevelLabel,
  type KnownChatMode,
  type PermissionLevel,
} from "@betterc0de/schema/chat-controls"
import type { ModelOption } from "@/types/remote"
import { colors, font, radius, spacing, type } from "@/design/theme"
import {
  supportsFastMode,
  thinkingLabelFor,
  thinkingOptionsFor,
} from "@/lib/model-capabilities"
import type { PhotoSource } from "@/lib/photo-picker"
import type { PreparedPhoto } from "@/lib/photos"
import { DropdownRow, DropdownSheet } from "./dropdown-sheet"
import { ProviderLogo } from "./provider-logo"

/**
 * Composer, ported from the desktop AI-Elements PromptInput: one rounded
 * card with the multiline input on top and a footer of pill controls like
 * the desktop minimal footer — Permissions, Mode, Model, Thinking and Fast
 * Mode, scrolling sideways on a narrow screen — with the circular send
 * button (ArrowUp) on the right. While a reply runs, Stop ends it and Queue
 * sends the message after it, as on the desktop. The permission presets,
 * their Bypass warning and the modes come from @betterc0de/schema, so both
 * apps say the same. Photos from the library or the camera sit above the
 * text until the message goes; a message may be photos alone.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onQueue,
  onStop,
  onChooseModel,
  model,
  running,
  disabled,
  thinkingMode,
  onThinkingModeChange,
  fastMode,
  onFastModeChange,
  permissionLevel,
  onPermissionLevelChange,
  chatMode,
  onChatModeChange,
  photos,
  preparingPhotos,
  photoProblem,
  onAddPhotos,
  onRemovePhoto,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onQueue: () => void
  onStop: () => void
  onChooseModel: () => void
  model: ModelOption | null
  running: boolean
  disabled: boolean
  thinkingMode: string | null
  onThinkingModeChange: (mode: string | null) => void
  fastMode: boolean
  onFastModeChange: (fastMode: boolean) => void
  permissionLevel: PermissionLevel
  onPermissionLevelChange: (level: PermissionLevel) => void
  chatMode: KnownChatMode
  onChatModeChange: (mode: KnownChatMode) => void
  photos: readonly PreparedPhoto[]
  /** Photos are being chosen or prepared. */
  preparingPhotos: boolean
  /** Why a chosen photo was not added. */
  photoProblem: string | null
  onAddPhotos: (source: PhotoSource) => void
  onRemovePhoto: (id: string) => void
}) {
  const inputRef = useRef<TextInput>(null)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [fastOpen, setFastOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const goalCommand = /^\/goal(?:\s|$)/i.test(value.trim())
  const showStop = running && !goalCommand
  const hasContent =
    (value.trim().length > 0 || photos.length > 0) &&
    !disabled &&
    !preparingPhotos &&
    Boolean(model)
  const canSend = hasContent && (!running || goalCommand)
  const canQueue = hasContent && showStop
  const canAttach = !disabled && !preparingPhotos
  const thinkingOptions = useMemo(() => thinkingOptionsFor(model), [model])
  const thinkingLabel = thinkingLabelFor(thinkingOptions, thinkingMode)
  const showThinking = thinkingOptions.length > 0
  const showFast = supportsFastMode(model)
  const isClaude = (model?.providerKind ?? "").toLowerCase().includes("claude")
  const PermissionIcon = permissionIcon(permissionLevel)
  const ModeIcon = modeIcon(chatMode)
  const bypass = permissionLevel === "bypass"

  const choosePermission = (level: PermissionLevel) => {
    setPermissionOpen(false)
    if (level === permissionLevel) return
    if (level !== "bypass") {
      onPermissionLevelChange(level)
      return
    }
    Alert.alert(BYPASS_CONFIRM_TITLE, BYPASS_CONFIRM_BODY, [
      { text: "Cancel", style: "cancel" },
      {
        text: BYPASS_CONFIRM_ACTION,
        style: "destructive",
        onPress: () => onPermissionLevelChange("bypass"),
      },
    ])
  }

  return (
    // Padding on Android too: the app is edge to edge, so the window no
    // longer shrinks for the keyboard, which would cover the composer.
    <KeyboardAvoidingView behavior="padding">
      <View style={styles.shell}>
        <View style={styles.card}>
          {photos.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.photos}
              accessibilityLabel="Photos in this message"
              testID="composer-photos"
            >
              {photos.map((photo, index) => (
                <View key={photo.id} style={styles.photo}>
                  <Image
                    source={{ uri: `data:image/jpeg;base64,${photo.base64}` }}
                    style={styles.photoImage}
                    accessibilityLabel={`Photo ${index + 1}`}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove photo ${index + 1}`}
                    testID={`composer-photo-remove-${index}`}
                    hitSlop={10}
                    onPress={() => onRemovePhoto(photo.id)}
                    style={({ pressed }) => [
                      styles.photoRemove,
                      pressed && styles.pressed,
                    ]}
                  >
                    <X size={12} color={colors.text} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}
          {photoProblem ? (
            <Text style={styles.photoProblem} testID="composer-photo-problem">
              {photoProblem}
            </Text>
          ) : null}
          <TextInput
            ref={inputRef}
            accessibilityLabel="Message"
            testID="chat-input"
            value={value}
            onChangeText={onChange}
            placeholder={
              running ? "Queue a message…" : "Message the desktop agent…"
            }
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            multiline
            maxLength={100_000}
            editable={!disabled}
            textAlignVertical="top"
          />
          <View style={styles.footer}>
            {preparingPhotos ? (
              <View
                style={styles.attach}
                accessibilityLabel="Preparing photos"
                testID="composer-photos-preparing"
              >
                <ActivityIndicator size="small" color={colors.textSecondary} />
              </View>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Attach photos"
                  testID="composer-attach"
                  accessibilityState={{ disabled: !canAttach }}
                  disabled={!canAttach}
                  onPress={() => onAddPhotos("library")}
                  style={({ pressed }) => [
                    styles.attach,
                    pressed && styles.pressed,
                    !canAttach && styles.disabled,
                  ]}
                >
                  <ImagePlus size={17} color={colors.textSecondary} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Take a photo"
                  testID="composer-camera"
                  accessibilityState={{ disabled: !canAttach }}
                  disabled={!canAttach}
                  onPress={() => onAddPhotos("camera")}
                  style={({ pressed }) => [
                    styles.attach,
                    pressed && styles.pressed,
                    !canAttach && styles.disabled,
                  ]}
                >
                  <Camera size={17} color={colors.textSecondary} />
                </Pressable>
              </>
            )}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              style={styles.pillsScroll}
              contentContainerStyle={styles.pills}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Permissions: ${permissionLevelLabel(permissionLevel)}`}
                testID="composer-permissions"
                onPress={() => setPermissionOpen(true)}
                style={({ pressed }) => [
                  styles.pill,
                  pressed && styles.pressed,
                ]}
              >
                <PermissionIcon
                  size={13}
                  color={bypass ? colors.danger : colors.textSecondary}
                />
                <Text
                  style={[styles.pillText, bypass && styles.pillTextDanger]}
                  numberOfLines={1}
                >
                  {permissionLevelLabel(permissionLevel)}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Mode: ${chatModeLabel(chatMode)}`}
                testID="composer-mode"
                onPress={() => setModeOpen(true)}
                style={({ pressed }) => [
                  styles.pill,
                  pressed && styles.pressed,
                ]}
              >
                <ModeIcon size={13} color={modeColor(chatMode)} />
                <Text
                  style={[styles.pillText, { color: modeColor(chatMode) }]}
                  numberOfLines={1}
                >
                  {chatModeLabel(chatMode)}
                </Text>
              </Pressable>
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
            </ScrollView>
            {showStop ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Stop response"
                testID="chat-stop"
                onPress={onStop}
                style={({ pressed }) => [
                  styles.round,
                  styles.stop,
                  pressed && styles.pressed,
                ]}
              >
                <Square size={13} fill={colors.text} color={colors.text} />
              </Pressable>
            ) : null}
            {showStop ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Queue message"
                accessibilityHint="Sends it when the current reply is finished"
                testID="chat-queue"
                accessibilityState={{ disabled: !canQueue }}
                disabled={!canQueue}
                onPress={onQueue}
                style={({ pressed }) => [
                  styles.round,
                  styles.send,
                  pressed && styles.pressed,
                  !canQueue && styles.disabled,
                ]}
              >
                <ListPlus size={17} color={colors.primaryForeground} />
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send message"
                testID="chat-send"
                accessibilityState={{ disabled: !canSend }}
                disabled={!canSend}
                onPress={onSend}
                style={({ pressed }) => [
                  styles.round,
                  styles.send,
                  pressed && styles.pressed,
                  !canSend && styles.disabled,
                ]}
              >
                <ArrowUp size={18} color={colors.primaryForeground} />
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {/* Permissions — the desktop's presets, one row each with its line. */}
      <DropdownSheet
        visible={permissionOpen}
        onClose={() => setPermissionOpen(false)}
        title="Permissions"
      >
        {PERMISSION_LEVELS.map((option) => {
          const Icon = permissionIcon(option.id)
          return (
            <DropdownRow
              key={option.id}
              icon={
                <Icon
                  size={15}
                  color={option.danger ? colors.danger : colors.textSecondary}
                />
              }
              label={option.label}
              sublabel={option.desc}
              destructive={option.danger}
              active={option.id === permissionLevel}
              onPress={() => choosePermission(option.id)}
            />
          )
        })}
      </DropdownSheet>

      {/* Mode — Shift+Tab and /plan, /ask on the desktop. */}
      <DropdownSheet
        visible={modeOpen}
        onClose={() => setModeOpen(false)}
        title="Mode"
      >
        {CHAT_MODE_OPTIONS.map((option) => {
          const Icon = modeIcon(option.id)
          return (
            <DropdownRow
              key={option.id}
              icon={<Icon size={15} color={modeColor(option.id)} />}
              label={option.label}
              sublabel={option.desc}
              active={option.id === chatMode}
              onPress={() => {
                setModeOpen(false)
                if (option.id !== chatMode) onChatModeChange(option.id)
              }}
            />
          )
        })}
      </DropdownSheet>

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

/** The desktop's icons: one shape per idea, the active preset's on the pill. */
function permissionIcon(level: PermissionLevel): LucideIcon {
  switch (level) {
    case "ask-on-edit":
      return CircleHelp
    case "allow-edits":
      return Pencil
    case "read-only":
      return Eye
    case "bypass":
      return ShieldOff
    default:
      return SlidersHorizontal
  }
}

function modeIcon(mode: KnownChatMode): LucideIcon {
  if (mode === "plan") return ClipboardList
  if (mode === "ask") return MessageCircleQuestion
  return Bot
}

/** Plan in sky and Ask in red, as the desktop marks a mode that is not Agent. */
function modeColor(mode: KnownChatMode): string {
  if (mode === "plan") return colors.info
  if (mode === "ask") return colors.danger
  return colors.textSecondary
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
    gap: spacing.xs,
  },
  photos: {
    flexDirection: "row",
    gap: spacing.xs,
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.xxs,
  },
  photo: { width: 56, height: 56 },
  photoImage: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceActive,
  },
  photoRemove: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.overlay,
  },
  photoProblem: {
    paddingHorizontal: spacing.xxs,
    paddingTop: spacing.xxs,
    color: colors.warning,
    fontFamily: font.regular,
    fontSize: 12,
  },
  attach: {
    width: 30,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  pillsScroll: { flex: 1, minWidth: 0 },
  pills: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  pill: {
    minHeight: 30,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.pill,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  pillText: {
    color: colors.textSecondary,
    fontFamily: font.medium,
    fontSize: 11,
  },
  pillTextFast: { color: colors.warning },
  pillTextDanger: { color: colors.danger },
  round: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  send: { backgroundColor: colors.primary },
  stop: {
    backgroundColor: colors.surfaceActive,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
})
