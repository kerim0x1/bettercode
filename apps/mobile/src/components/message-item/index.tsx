/**
 * Chat transcript rows, ported 1:1 from the desktop AI-Elements design:
 * user turns are compact secondary-colored bubbles on the right, assistant
 * turns are plain prose under a model-badge meta row (provider logo + pretty
 * model name + time), reasoning is the desktop's "Thought for Ns" disclosure.
 * Tool calls and file diffs render from the sibling modules.
 */

import { memo, useState } from "react"
import { readBrowserElementAttachment } from "@betterc0de/schema"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { formatTime } from "@/lib/format"
import {
  Brain,
  ChevronDown,
  CircleDashed,
  Globe,
  Paperclip,
} from "lucide-react-native"
import type { ChatMessage } from "@/types/remote"
import type { StreamState } from "@/store/app-store"
import { colors, font, radius, spacing, type } from "@/design/theme"
import { MarkdownText } from "../markdown-text"
import { ProviderLogo, providerKindFromModelId } from "../provider-logo"
import { FileChanges } from "./file-changes"
import { ToolCallGroup } from "./tool-calls"

/**
 * Chat transcript rows, ported 1:1 from the desktop AI-Elements design:
 * user turns are compact secondary-colored bubbles on the right, assistant
 * turns are plain prose under a model-badge meta row (provider logo + pretty
 * model name + time), reasoning is the desktop's "Thought for Ns" disclosure,
 * tool calls fold into one "N steps · 12s" dropdown whose rows reuse the
 * desktop presentation derivation, and file diffs render as the desktop's
 * FileChangeItem rows (+/− counts, expandable diff lines).
 */
// Memoised: the list re-renders on every streamed delta of the *current*
// turn, and the rows above it derive tool presentation and diff groups
// from their message on each render.
export const MessageItem = memo(function MessageItem({
  message,
}: {
  message: ChatMessage
}) {
  const isUser = message.role === "user"
  const isSystem = message.role === "system"

  if (isUser) {
    return (
      <View style={styles.userWrap}>
        <View style={styles.userBubble}>
          {message.content ? (
            <Text selectable style={styles.userText}>
              {message.content}
            </Text>
          ) : null}
          <MetaBadges message={message} />
        </View>
        {message.dispatchStatus === "pending" ? (
          <Text style={styles.dispatchNote}>Sending…</Text>
        ) : null}
        {message.dispatchFailed ? (
          <Text style={[styles.dispatchNote, styles.dispatchFailed]}>
            Failed to send
          </Text>
        ) : null}
      </View>
    )
  }

  const modelKind = providerKindFromModelId(message.modelId)
  return (
    <View style={[styles.assistantWrap, isSystem && styles.systemWrap]}>
      <View style={styles.metaRow}>
        {!isSystem && modelKind ? (
          <ProviderLogo kind={modelKind} size={12} />
        ) : null}
        <Text style={styles.metaText}>
          {isSystem ? "System" : prettyModelName(message.modelId)}
        </Text>
        <Text style={styles.metaTime}>{formatTime(message.createdAt)}</Text>
      </View>
      {message.reasoning ? (
        <Reasoning
          content={message.reasoning}
          durationMs={message.reasoningDurationMs}
        />
      ) : null}
      {message.toolCalls?.length ? (
        <ToolCallGroup tools={message.toolCalls} />
      ) : null}
      {message.content ? <MarkdownText content={message.content} /> : null}
      {message.diffs?.length ? <FileChanges diffs={message.diffs} /> : null}
      <MetaBadges message={message} />
    </View>
  )
})

/**
 * The reply while it streams. `tools` are the turn's tool steps so far,
 * built from its activities like the finished message's.
 */
export function StreamingMessage({
  stream,
  tools = [],
}: {
  stream: StreamState
  tools?: NonNullable<ChatMessage["toolCalls"]>
}) {
  return (
    <View style={styles.assistantWrap}>
      <View style={styles.metaRow}>
        <View style={[styles.liveDot, !stream.running && styles.liveDotIdle]} />
        <Text style={styles.metaText}>
          {stream.running ? "Working…" : "Turn finished"}
        </Text>
        <Text style={styles.metaTime}>{formatTime(stream.startedAt)}</Text>
      </View>
      {stream.reasoning ? (
        <Reasoning
          content={stream.reasoning}
          defaultOpen
          streaming={stream.running && stream.isReasoning === true}
        />
      ) : null}
      {tools.length ? <ToolCallGroup tools={tools} /> : null}
      {stream.content ? (
        <MarkdownText content={stream.content} />
      ) : stream.running ? (
        <View style={styles.thinkingRow}>
          <CircleDashed size={15} color={colors.textMuted} />
          <Text style={styles.thinkingText}>
            {stream.isReasoning ? "Thinking…" : "Working…"}
          </Text>
        </View>
      ) : null}
      {stream.error ? (
        <Text style={styles.errorText}>{stream.error}</Text>
      ) : null}
    </View>
  )
}

/** Desktop Reasoning trigger: brain icon + "Thought for Ns" + chevron. */
function Reasoning({
  content,
  durationMs,
  defaultOpen = false,
  streaming = false,
}: {
  content: string
  durationMs?: number
  defaultOpen?: boolean
  streaming?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const label = streaming
    ? "Thinking…"
    : typeof durationMs === "number" && durationMs > 0
      ? `Thought for ${Math.max(1, Math.ceil(durationMs / 1000))} seconds`
      : "Thought for a few seconds"
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? "Collapse thoughts" : "Show thoughts"}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [
          styles.disclosureRow,
          pressed && styles.pressed,
        ]}
      >
        <Brain size={14} color={colors.textSecondary} />
        <Text style={styles.disclosureLabel}>{label}</Text>
        <ChevronDown
          size={14}
          color={colors.textMuted}
          style={open ? styles.chevronOpen : undefined}
        />
      </Pressable>
      {open ? (
        <Text selectable style={styles.reasoningText}>
          {content}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * Pretty display name for a bare model id, like the desktop's getModelInfo:
 * "claude-fable-5" → "Claude Fable 5", "gpt-5.6-sol" → "GPT-5.6 Sol",
 * "claude-opus-4-8" → "Claude Opus 4.8".
 */
function prettyModelName(modelId: string | undefined): string {
  if (!modelId) return "Assistant"
  const collapsed = modelId.replace(/(\d)-(\d)/g, "$1.$2")
  return collapsed
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) =>
      part.toLowerCase() === "gpt"
        ? "GPT"
        : /^\d/.test(part)
          ? part
          : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join(" ")
}

function MetaBadges({ message }: { message: ChatMessage }) {
  if (!message.attachments?.length) return null
  const elements = message.attachments.flatMap((attachment) => {
    const element = readBrowserElementAttachment({
      ...attachment,
      type: attachment.type ?? "file",
    })
    return element ? [element] : []
  })
  const fileCount = message.attachments.length - elements.length
  return (
    <View style={styles.metaBadges}>
      {elements.map((element, index) => (
        <View key={`element-${index}`} style={styles.badge}>
          <Globe size={12} color={colors.textSecondary} />
          <Text
            style={styles.badgeText}
          >{`<${element.tagName}> ${element.label}`}</Text>
        </View>
      ))}
      {fileCount > 0 && (
        <View style={styles.badge}>
          <Paperclip size={12} color={colors.textSecondary} />
          <Text style={styles.badgeText}>
            {fileCount} {fileCount === 1 ? "file" : "files"}
          </Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  // User: right-aligned secondary bubble (desktop: rounded-lg bg-secondary
  // px-4 py-3, max-w-[85%]).
  userWrap: {
    alignItems: "flex-end",
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  userBubble: {
    maxWidth: "85%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceActive,
    gap: spacing.xs,
  },
  userText: {
    color: colors.text,
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
  },
  dispatchNote: {
    marginTop: 4,
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 11,
  },
  dispatchFailed: { color: colors.danger },
  // Assistant: plain prose, no card.
  assistantWrap: {
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs,
    maxWidth: 760,
    width: "100%",
  },
  systemWrap: {
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: spacing.sm,
    marginLeft: spacing.md,
    marginRight: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 16,
  },
  metaText: {
    color: colors.textMuted,
    fontFamily: font.medium,
    fontSize: 11,
  },
  metaTime: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: 10,
    opacity: 0.7,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  liveDotIdle: { backgroundColor: colors.textMuted },
  // Shared quiet disclosure rows (reasoning + tool group).
  disclosureRow: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    alignSelf: "flex-start",
    paddingRight: spacing.xs,
  },
  disclosureLabel: {
    color: colors.textSecondary,
    fontFamily: font.medium,
    fontSize: 13,
  },
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  pressed: { opacity: 0.7 },
  reasoningText: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.small,
    lineHeight: 21,
    paddingBottom: spacing.xs,
  },
  metaBadges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  badge: {
    height: 24,
    maxWidth: 210,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  badgeText: {
    color: colors.textSecondary,
    fontFamily: font.medium,
    fontSize: 11,
  },
  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: 32,
  },
  thinkingText: {
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.small,
  },
  errorText: {
    color: colors.danger,
    fontFamily: font.regular,
    fontSize: type.small,
    lineHeight: 20,
  },
})
