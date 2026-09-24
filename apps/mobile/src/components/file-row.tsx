import { Pressable, StyleSheet, Text, View } from "react-native"
import { formatBytes } from "@/lib/format"
import {
  ChevronRight,
  File,
  FileCode2,
  Folder,
  Link2,
  MoreVertical,
} from "lucide-react-native"
import type { DirectoryEntry } from "@/types/remote"
import { colors, font, radius, spacing, type } from "@/design/theme"
import { IconButton } from "./icon-button"

/**
 * A file or folder in the browser. With `onMore`, a button beside it (not
 * inside it, so screen readers reach both) offers rename and delete.
 */
export function FileRow({
  entry,
  onPress,
  onMore,
}: {
  entry: DirectoryEntry
  onPress: () => void
  onMore?: () => void
}) {
  const Icon = entry.isDir ? Folder : isCodeFile(entry.name) ? FileCode2 : File
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${entry.isDir ? "Folder" : "File"} ${entry.name}`}
        testID={`file-row-${entry.name}`}
        onPress={onPress}
        style={({ pressed }) => [styles.open, pressed && styles.pressed]}
      >
        <View style={[styles.icon, entry.isDir && styles.folderIcon]}>
          <Icon
            size={20}
            color={entry.isDir ? colors.mint : colors.textSecondary}
          />
        </View>
        <View style={styles.copy}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {entry.name}
            </Text>
            {entry.isSymlink ? (
              <Link2 size={13} color={colors.warning} />
            ) : null}
          </View>
          <Text style={styles.meta}>
            {entry.isDir ? "Folder" : formatBytes(entry.size) || "File"}
          </Text>
        </View>
        <ChevronRight size={18} color={colors.textMuted} />
      </Pressable>
      {onMore ? (
        <IconButton
          icon={MoreVertical}
          label={`More for ${entry.name}`}
          testID={`file-more-${entry.name}`}
          onPress={onMore}
        />
      ) : null}
    </View>
  )
}

function isCodeFile(name: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|lua|css|scss|html|vue|svelte|json|ya?ml|toml|md|sql|sh|ps1)$/i.test(
    name
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: 66,
    marginHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
  },
  open: {
    flex: 1,
    minWidth: 0,
    minHeight: 66,
    paddingHorizontal: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  pressed: { backgroundColor: colors.surface },
  icon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  folderIcon: { backgroundColor: colors.surfaceActive },
  copy: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: {
    flexShrink: 1,
    color: colors.text,
    fontSize: type.body,
    fontFamily: font.semibold,
  },
  meta: {
    color: colors.textMuted,
    fontFamily: font.regular,
    fontSize: type.micro,
    marginTop: 3,
  },
})
