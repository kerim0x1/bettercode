import { Pressable, StyleSheet, Text, View } from "react-native"
import {
  ChevronRight,
  File,
  FileCode2,
  Folder,
  Link2,
} from "lucide-react-native"
import type { DirectoryEntry } from "@/types/remote"
import { colors, font, radius, spacing, type } from "@/design/theme"

export function FileRow({
  entry,
  onPress,
}: {
  entry: DirectoryEntry
  onPress: () => void
}) {
  const Icon = entry.isDir ? Folder : isCodeFile(entry.name) ? FileCode2 : File
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.isDir ? "Folder" : "File"} ${entry.name}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
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
          {entry.isSymlink ? <Link2 size={13} color={colors.warning} /> : null}
        </View>
        <Text style={styles.meta}>
          {entry.isDir ? "Ordner" : formatBytes(entry.size)}
        </Text>
      </View>
      <ChevronRight size={18} color={colors.textMuted} />
    </Pressable>
  )
}

function isCodeFile(name: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|lua|css|scss|html|vue|svelte|json|ya?ml|toml|md|sql|sh|ps1)$/i.test(
    name
  )
}

function formatBytes(size: number | null): string {
  if (size === null) return "File"
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2)
    return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`
  return `${(size / 1024 ** 2).toFixed(1)} MB`
}

const styles = StyleSheet.create({
  row: {
    minHeight: 66,
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
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
