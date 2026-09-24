import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleDashed,
} from "lucide-react-native"
import type { ProviderHandoffEntry } from "@betterc0de/schema"
import { formatProviderActivityLabel } from "@betterc0de/schema/provider-label"
import { colors, font, radius, spacing } from "@/design/theme"
import { MarkdownText } from "./markdown-text"

function providerName(providerKind: string): string {
  return formatProviderActivityLabel({ providerKind }).replace(/ CLI$/, "")
}

/**
 * Where the desktop hands a chat to another provider: the context is
 * compacted, and the internal messages that carry it are hidden. Ported
 * from the desktop's ProviderHandoffStatus: the same states and words, and
 * the summary behind "Context Compacted".
 */
export function ProviderHandoffNotice({
  entry,
}: {
  entry: ProviderHandoffEntry
}) {
  const [open, setOpen] = useState(false)
  const transition =
    entry.sourceProvider && entry.targetProvider
      ? `${providerName(entry.sourceProvider)} → ${providerName(entry.targetProvider)}`
      : null
  const prefix = transition ? `${transition} · ` : ""

  if (entry.status === "compacting") {
    return (
      <View style={[styles.pill, styles.standalone]} accessibilityRole="text">
        <CircleDashed size={14} color={colors.textSecondary} />
        <Text style={styles.pillText}>
          {prefix}Compacting previous context…
        </Text>
      </View>
    )
  }
  if (entry.status === "failed" || entry.status === "interrupted") {
    return (
      <View style={[styles.pill, styles.standalone]} accessibilityRole="text">
        <CircleAlert size={14} color={colors.textSecondary} />
        <Text style={styles.pillText}>
          {prefix}
          {entry.status === "failed"
            ? "Context handoff failed"
            : "Context handoff interrupted"}
        </Text>
      </View>
    )
  }
  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: !entry.summary }}
        disabled={!entry.summary}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
      >
        <Check size={14} color={colors.textSecondary} />
        <Text style={styles.pillText}>Context Compacted</Text>
        {entry.summary ? (
          <ChevronDown
            size={14}
            color={colors.textMuted}
            style={open ? styles.chevronOpen : undefined}
          />
        ) : null}
      </Pressable>
      {open && entry.summary ? (
        <View
          style={styles.overview}
          accessibilityLabel="Previous context overview"
        >
          {entry.sourceProvider && entry.targetProvider ? (
            <View style={styles.overviewHeader}>
              <Text style={styles.overviewName} numberOfLines={1}>
                {providerName(entry.sourceProvider)}
              </Text>
              <ArrowRight size={14} color={colors.textMuted} />
              <Text style={styles.overviewName} numberOfLines={1}>
                {providerName(entry.targetProvider)}
              </Text>
            </View>
          ) : null}
          <MarkdownText content={entry.summary} />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  standalone: { marginHorizontal: spacing.md, marginBottom: spacing.md },
  pill: {
    alignSelf: "flex-start",
    minHeight: 32,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pillText: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontFamily: font.medium,
    fontSize: 12,
  },
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  overview: {
    padding: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  overviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  overviewName: {
    flexShrink: 1,
    color: colors.text,
    fontFamily: font.medium,
    fontSize: 13,
  },
  pressed: { opacity: 0.72 },
})
