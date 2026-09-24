import { memo, useMemo, type ReactElement, type ReactNode } from "react"
import { FlatList, StyleSheet, Text, View } from "react-native"
import type { DiffHunk, DiffLine } from "@betterc0de/schema/git-diff"
import { colors, font, spacing, type } from "@/design/theme"

/**
 * One file's diff as the desktop's review shows it: each hunk under its own
 * header ("Change 2 · Line 14"), lines with their old and new numbers.
 * The list is virtualized, so a long diff scrolls without a line limit.
 */

type DiffRow =
  | { key: string; kind: "hunk"; index: number; hunk: DiffHunk | null }
  | { key: string; kind: "line"; line: DiffLine }

function rowsOf(lines: DiffLine[], hunks: DiffHunk[]): DiffRow[] {
  return lines.map((line, position) =>
    line.type === "header"
      ? {
          key: `h${position}`,
          kind: "hunk",
          index: line.hunkIndex ?? 0,
          hunk: hunks[line.hunkIndex ?? 0] ?? null,
        }
      : { key: `l${position}`, kind: "line", line }
  )
}

export function DiffView({
  lines,
  hunks = [],
  renderHunkActions,
  header,
  empty,
  testID,
}: {
  lines: DiffLine[]
  hunks?: DiffHunk[]
  /** Buttons for one hunk (stage, discard, unstage). */
  renderHunkActions?: (hunk: DiffHunk, index: number) => ReactNode
  header?: ReactElement
  empty?: ReactElement
  testID?: string
}) {
  const rows = useMemo(() => rowsOf(lines, hunks), [lines, hunks])
  return (
    <FlatList
      testID={testID}
      data={rows}
      keyExtractor={(row) => row.key}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      contentContainerStyle={styles.content}
      initialNumToRender={40}
      maxToRenderPerBatch={40}
      windowSize={11}
      renderItem={({ item }) =>
        item.kind === "hunk" ? (
          <HunkHeader
            index={item.index}
            hunk={item.hunk}
            actions={
              item.hunk && renderHunkActions
                ? renderHunkActions(item.hunk, item.index)
                : null
            }
          />
        ) : (
          <DiffLineRow line={item.line} />
        )
      }
    />
  )
}

function HunkHeader({
  index,
  hunk,
  actions,
}: {
  index: number
  hunk: DiffHunk | null
  actions: ReactNode
}) {
  const line = hunk ? hunk.newStart || hunk.oldStart : null
  return (
    <View style={styles.hunk} testID={`diff-hunk-${index}`}>
      <View
        style={styles.hunkCopy}
        accessible
        accessibilityRole="header"
        accessibilityLabel={`Change ${index + 1}${line ? `, line ${line}` : ""}`}
      >
        <Text style={styles.hunkTitle}>Change {index + 1}</Text>
        {line ? <Text style={styles.hunkLine}>Line {line}</Text> : null}
      </View>
      {actions ? <View style={styles.hunkActions}>{actions}</View> : null}
    </View>
  )
}

const DiffLineRow = memo(function DiffLineRow({ line }: { line: DiffLine }) {
  const added = line.type === "add"
  const removed = line.type === "remove"
  return (
    <View
      style={[
        styles.line,
        added && styles.lineAdd,
        removed && styles.lineRemove,
      ]}
    >
      <Text style={styles.number}>{line.oldNum ?? ""}</Text>
      <Text style={styles.number}>{line.newNum ?? ""}</Text>
      <Text
        style={[
          styles.code,
          added && styles.codeAdd,
          removed && styles.codeRemove,
        ]}
        selectable
      >
        {added ? "+" : removed ? "−" : " "}
        {line.content || " "}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl },
  hunk: {
    marginTop: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  hunkCopy: { flex: 1, minWidth: 0 },
  hunkTitle: {
    color: colors.text,
    fontFamily: font.bold,
    fontSize: type.small,
  },
  hunkLine: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  hunkActions: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  line: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#080A0C",
  },
  lineAdd: { backgroundColor: "rgba(113,247,159,0.08)" },
  lineRemove: { backgroundColor: "rgba(255,122,138,0.08)" },
  number: {
    width: 38,
    paddingRight: 6,
    textAlign: "right",
    color: colors.textMuted,
    fontFamily: type.mono,
    fontSize: 11,
    lineHeight: 19,
  },
  code: {
    flex: 1,
    paddingRight: spacing.sm,
    color: "#B7C0BB",
    fontFamily: type.mono,
    fontSize: 12,
    lineHeight: 19,
  },
  codeAdd: { color: "#8DE5A8" },
  codeRemove: { color: "#FF9AA7" },
})
