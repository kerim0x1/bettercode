import { useMemo } from "react"
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { FileText } from "lucide-react-native"
import {
  colors,
  font,
  minTouchTarget,
  radius,
  spacing,
  type,
} from "@/design/theme"
import type { ContentSearchResult } from "@/transport/types"

/** The desktop's content search options, as the phone offers them. */
export interface ContentSearchChoices {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  /** Glob patterns, comma separated. */
  include: string
}

export const DEFAULT_CONTENT_SEARCH: ContentSearchChoices = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: "",
}

function Toggle({
  label,
  on,
  onPress,
  testID,
}: {
  label: string
  on: boolean
  onPress: () => void
  testID: string
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toggle,
        on && styles.toggleOn,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.toggleText, on && styles.toggleTextOn]}>
        {label}
      </Text>
    </Pressable>
  )
}

export function ContentSearchOptions({
  value,
  onChange,
  onSubmit,
}: {
  value: ContentSearchChoices
  onChange: (next: ContentSearchChoices) => void
  onSubmit: () => void
}) {
  return (
    <View style={styles.options}>
      <View style={styles.toggles}>
        <Toggle
          label="Match case"
          on={value.caseSensitive}
          testID="search-case"
          onPress={() =>
            onChange({ ...value, caseSensitive: !value.caseSensitive })
          }
        />
        <Toggle
          label="Whole word"
          on={value.wholeWord}
          testID="search-word"
          onPress={() => onChange({ ...value, wholeWord: !value.wholeWord })}
        />
        <Toggle
          label="Regex"
          on={value.regex}
          testID="search-regex"
          onPress={() => onChange({ ...value, regex: !value.regex })}
        />
      </View>
      <TextInput
        testID="search-include"
        accessibilityLabel="Only files matching"
        value={value.include}
        onChangeText={(include) => onChange({ ...value, include })}
        onSubmitEditing={onSubmit}
        returnKeyType="search"
        placeholder="Only files matching, e.g. src/**, *.ts"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.include}
      />
    </View>
  )
}

type Row =
  | { key: string; kind: "file"; path: string; count: number }
  | {
      key: string
      kind: "match"
      path: string
      match: ContentSearchResult["results"][number]["matches"][number]
    }

/** Matches file by file; a match opens its file at its line. */
export function ContentSearchResults({
  search,
  loading,
  onRefresh,
  onOpen,
}: {
  search: ContentSearchResult
  loading: boolean
  onRefresh: () => void
  onOpen: (path: string, line: number) => void
}) {
  const rows = useMemo<Row[]>(
    () =>
      search.results.flatMap((file) => [
        {
          key: `f:${file.path}`,
          kind: "file" as const,
          path: file.path,
          count: file.matches.length,
        },
        ...file.matches.map((match, index) => ({
          key: `m:${file.path}:${index}`,
          kind: "match" as const,
          path: file.path,
          match,
        })),
      ]),
    [search]
  )
  const total = search.results.reduce(
    (sum, file) => sum + file.matches.length,
    0
  )
  return (
    <FlatList
      testID="content-search-results"
      data={rows}
      keyExtractor={(row) => row.key}
      contentContainerStyle={[styles.list, !rows.length && styles.empty]}
      refreshControl={
        <RefreshControl
          refreshing={loading}
          tintColor={colors.mint}
          colors={[colors.mint]}
          onRefresh={onRefresh}
        />
      }
      ListHeaderComponent={
        rows.length ? (
          <Text style={styles.summary} accessibilityLiveRegion="polite">
            {total} {total === 1 ? "match" : "matches"} in{" "}
            {search.results.length}{" "}
            {search.results.length === 1 ? "file" : "files"}
            {search.truncated
              ? ". The search stopped early; narrow it to see more."
              : ""}
          </Text>
        ) : null
      }
      ListEmptyComponent={
        <Text style={styles.none}>
          {loading ? "Searching…" : "No file contains that."}
        </Text>
      }
      renderItem={({ item }) =>
        item.kind === "file" ? (
          <View style={styles.file} accessibilityRole="header">
            <FileText size={15} color={colors.textSecondary} />
            <Text style={styles.filePath} numberOfLines={1}>
              {item.path}
            </Text>
            <Text style={styles.count}>{item.count}</Text>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Line ${item.match.line}: ${item.match.preview}`}
            testID={`search-match-${item.path}-${item.match.line}`}
            onPress={() => onOpen(item.path, item.match.line)}
            style={({ pressed }) => [styles.match, pressed && styles.pressed]}
          >
            <Text style={styles.line}>{item.match.line}</Text>
            <Text style={styles.preview} numberOfLines={2}>
              {item.match.preview.slice(0, item.match.previewColumn - 1)}
              <Text style={styles.hit}>
                {item.match.preview.slice(
                  item.match.previewColumn - 1,
                  item.match.previewColumn - 1 + item.match.previewLength
                )}
              </Text>
              {item.match.preview.slice(
                item.match.previewColumn - 1 + item.match.previewLength
              )}
            </Text>
          </Pressable>
        )
      }
    />
  )
}

const styles = StyleSheet.create({
  options: { paddingHorizontal: spacing.md, gap: spacing.xs },
  toggles: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  toggle: {
    minHeight: minTouchTarget,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  toggleOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  toggleText: {
    color: colors.textSecondary,
    fontFamily: font.semibold,
    fontSize: type.micro,
  },
  toggleTextOn: { color: colors.primaryForeground },
  include: {
    minHeight: minTouchTarget,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.input,
    color: colors.text,
    fontFamily: type.mono,
    fontSize: type.micro,
  },
  pressed: { opacity: 0.7 },
  list: { paddingBottom: spacing.xxl },
  empty: { flexGrow: 1 },
  summary: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.micro,
  },
  none: {
    padding: spacing.xl,
    textAlign: "center",
    color: colors.textSecondary,
    fontFamily: font.regular,
    fontSize: type.small,
  },
  file: {
    minHeight: 40,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.surface,
  },
  filePath: {
    flex: 1,
    color: colors.text,
    fontFamily: type.mono,
    fontSize: type.micro,
  },
  count: {
    color: colors.textMuted,
    fontFamily: font.semibold,
    fontSize: type.micro,
  },
  match: {
    minHeight: minTouchTarget,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  line: {
    width: 40,
    textAlign: "right",
    color: colors.textMuted,
    fontFamily: type.mono,
    fontSize: type.micro,
  },
  preview: {
    flex: 1,
    color: colors.textSecondary,
    fontFamily: type.mono,
    fontSize: type.micro,
  },
  hit: {
    color: colors.text,
    backgroundColor: "rgba(251,191,36,0.25)",
  },
})
